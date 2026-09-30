/**
 * DEP-003 (E6 deployment harness) — embedded-PG proof of the rollback-startup gate:
 * an INCOMPATIBLE NEWER schema (the DB was migrated PAST this image, e.g. an older
 * image deployed against a DB a newer image already migrated) must REFUSE to serve.
 * Readiness reports `incompatible/newer` and the gate 503s tenant/app routes while
 * liveness still answers — never a crash, and the marker is never written.
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

function buildGatedApp() {
  const probe = buildReadinessProbe({
    schemaCompatibility: () => loadSchemaCompatibility(url),
    checkPostgres: async () => true,
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

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-migration-rollback-"));
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
    admin = postgres(url, { max: 1 });
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
  "DEP-003 rollback-startup — incompatible newer schema refuses to serve",
  () => {
    it("is compatible before the simulated newer migration is recorded", async () => {
      guard();
      expect(await loadSchemaCompatibility(url)).toEqual({ status: "compatible", schemaCompatible: true });
    });

    it("reports incompatible/newer and 503s the app surface when the DB was migrated PAST the image", async () => {
      const db = guard();
      // Simulate a DB a NEWER image already migrated: record an extra applied
      // migration this image's ledger does not contain.
      await db.unsafe(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('future_image_migration_hash', $1)",
        [Date.now()],
      );
      const compat = await loadSchemaCompatibility(url);
      expect(compat).toEqual({ status: "incompatible", schemaCompatible: false, reason: "newer" });

      const app = buildGatedApp();
      // Refuse to serve tenant/app routes on an incompatible newer schema.
      expect(await status(app, "/api/companies")).toBe(503);
      expect(await status(app, "/api/ready")).toBe(503);
      // Liveness still answers (process up; this is a serving refusal, not a crash).
      expect(await status(app, "/api/health/live")).toBe(200);
    });
  },
);
