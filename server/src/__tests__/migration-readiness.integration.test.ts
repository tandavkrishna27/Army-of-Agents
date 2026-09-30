/**
 * DEP-003 (E6 deployment harness) — embedded-PG proof of the readiness serving gate:
 *   - a compatible applied schema is READY (gate serves);
 *   - a DB BEHIND the image (migration job unfinished) is NOT ready -> the gate 503s
 *     tenant/app routes while liveness + readiness still answer (NOT a crash);
 *   - the privileged migration job re-applies the pending tail idempotently (a failed
 *     migration does not loop destructively) and readiness recovers;
 *   - application startup / the readiness path NEVER writes the marker (it stays empty).
 *
 * Windows runs this only under the integration harness (AOA_RUN_WIN_INTEGRATION=1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import postgres, { type Sql } from "postgres";
import { applyPendingMigrations } from "@armyofagents/db";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { loadSchemaCompatibility } from "../services/schema-compatibility.js";
import { runMigrateJob } from "@armyofagents/db/migrate-job";
import {
  buildReadinessProbe,
  readinessRoutes,
  readinessGate,
} from "../routes/readiness.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let url = "";
let admin: Sql | null = null;
let setupError: unknown = null;

function guard(): Sql {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
  if (!admin) throw new Error("database client unavailable");
  return admin;
}

/** Build a minimal app: readiness route (always answers) + the gate + a fake tenant route. */
function buildGatedApp() {
  const probe = buildReadinessProbe({
    schemaCompatibility: () => loadSchemaCompatibility(url),
    checkPostgres: async () => {
      const probeSql = postgres(url, { max: 1 });
      try {
        await probeSql`SELECT 1`;
        return true;
      } catch {
        return false;
      } finally {
        await probeSql.end();
      }
    },
  });
  const app = express();
  app.get("/api/health/live", (_req, res) => res.json({ status: "ok", live: true }));
  app.use("/api", readinessRoutes(probe));
  app.use("/api", readinessGate({ probe, bypass: (p) => p === "/ready" || p === "/health/live" }));
  app.get("/api/companies", (_req, res) => res.json({ served: true }));
  return app;
}

async function status(app: express.Express, path: string): Promise<number> {
  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return (await fetch(`http://127.0.0.1:${port}${path}`)).status;
  } finally {
    server.close();
  }
}

async function markerCount(): Promise<number> {
  const rows = await guard()<{ count: number }[]>`SELECT count(*)::int AS count FROM distributed_cutover_markers`;
  return Number(rows[0]?.count ?? -1);
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-migration-readiness-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    const port = await allocateEmbeddedPgPort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    url = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(url);
    admin = postgres(url, { max: 2 });
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "DEP-003 migration readiness serving gate",
  () => {
    it("serves once the applied schema is compatible, and the marker table starts empty", async () => {
      guard();
      const compat = await loadSchemaCompatibility(url);
      expect(compat).toEqual({ status: "compatible", schemaCompatible: true });
      const app = buildGatedApp();
      expect(await status(app, "/api/companies")).toBe(200);
      expect(await status(app, "/api/ready")).toBe(200);
      expect(await markerCount()).toBe(0);
    });

    it("503s the app surface while the DB is BEHIND the image (schema pending), not a crash", async () => {
      const db = guard();
      // Simulate a DB the migration job has not finished migrating: drop the LAST
      // recorded migration so the tail is 'pending' relative to the image files.
      const before = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      await db.unsafe(
        "DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)",
      );
      const compat = await loadSchemaCompatibility(url);
      expect(compat.schemaCompatible).toBe(false);
      expect(compat.status).toBe("pending");

      const app = buildGatedApp();
      // Tenant/app route is gated (503), but liveness + readiness still answer.
      expect(await status(app, "/api/companies")).toBe(503);
      expect(await status(app, "/api/health/live")).toBe(200);
      expect(await status(app, "/api/ready")).toBe(503);
      // Even while gated, nothing wrote the marker.
      expect(await markerCount()).toBe(0);
      expect(before[0]?.n).toBeGreaterThan(0);
    });

    it("recovers to READY after the privileged migration job re-applies the pending tail idempotently", async () => {
      guard();
      const result = await runMigrateJob({ url, maxAttempts: 3 });
      expect(result.ok).toBe(true);
      const compat = await loadSchemaCompatibility(url);
      expect(compat).toEqual({ status: "compatible", schemaCompatible: true });
      const app = buildGatedApp();
      expect(await status(app, "/api/companies")).toBe(200);
      // App startup / readiness NEVER wrote the marker.
      expect(await markerCount()).toBe(0);
    });

    it("a persistently failing migration does NOT loop destructively (bounded, fail-closed)", async () => {
      let attempts = 0;
      const result = await runMigrateJob({
        url,
        maxAttempts: 3,
        baseDelayMs: 0,
        applyMigrations: async () => {
          attempts += 1;
          throw new Error("simulated migration failure");
        },
        // Force the apply path (report pending so the job attempts to apply).
        inspect: async () => ({ status: "needsMigrations", pendingMigrations: ["9999_fake.sql"] }),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("exhausted_retries");
      // Bounded: exactly maxAttempts, never an unbounded loop.
      expect(attempts).toBe(3);
      expect(result.attempts).toBe(3);
    });
  },
);
