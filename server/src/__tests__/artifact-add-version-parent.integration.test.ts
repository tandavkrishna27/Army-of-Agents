/**
 * Task A-M8 — Real-DB proof that artifactService.addVersion rejects a
 * parentVersionId that belongs to a DIFFERENT artifact (cross-artifact /
 * cross-company branch attempt) and accepts a same-artifact parent.
 *
 * The FK on artifact_versions.parent_version_id (-> artifact_versions.id,
 * onDelete set null) permits ANY version row, so the real database alone does
 * NOT prevent branching off another artifact's version. This boots
 * embedded-postgres, applies all migrations, seeds two artifacts A and B each
 * with one version, then proves the service-level guard:
 *   1. addVersion(A, { parentVersionId: <B's version> }) → rejected, no new row
 *   2. addVersion(A, { parentVersionId: <A's own version> }) → succeeds
 *
 * Skipped on Windows (embedded-postgres / migration-chain issue — Issue #114);
 * Linux CI is the authoritative gate. Modeled on
 * thread-commit-idempotency.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { artifactService } from "../services/artifacts.js";
import { HttpError } from "../errors.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

let companyId = "";
// Artifact A (the one being versioned) + its own version id.
let artifactAId = "";
let artifactAVersionId = "";
// Artifact B (a sibling) + its version id — the foreign parent.
let artifactBVersionId = "";

const PORT = 59000 + Math.floor(Math.random() * 1000);

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<
    Record<string, unknown>
  >;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-artifact-parent-integ-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);

    // Seed a company (eager Commander/config).
    const company = await companyService(db).create({ name: "Artifact Parent Co" } as never);
    companyId = company.id;

    const svc = artifactService(db);

    // Artifact A with one version (versionNumber 1).
    const artifactA = await svc.create(companyId, "integration-test", {
      title: "Artifact A",
      type: "document",
      source: "agent",
      content: "# A v1",
    });
    artifactAId = artifactA.id;
    artifactAVersionId = artifactA.versions[0].id;

    // Artifact B (sibling) with one version. Its version id is a valid
    // artifact_versions.id and therefore satisfies the FK, but it does NOT
    // belong to A — the exact foreign-parent case the guard must reject.
    const artifactB = await svc.create(companyId, "integration-test", {
      title: "Artifact B",
      type: "document",
      source: "agent",
      content: "# B v1",
    });
    artifactBVersionId = artifactB.versions[0].id;
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[artifact-add-version-parent] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}, 60_000);

async function versionCount(artifactId: string): Promise<number> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM artifact_versions WHERE artifact_id = ${artifactId}
    `),
  );
  return Number(rows[0]?.n ?? 0);
}

describe.skipIf(process.platform === "win32")("addVersion parentVersionId ownership (real DB)", () => {
  it("rejects a parentVersionId owned by a DIFFERENT artifact and writes no row", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = artifactService(db);

    const before = await versionCount(artifactAId);

    let caught: unknown;
    try {
      await svc.addVersion(artifactAId, {
        source: "agent",
        content: "# A v2 (foreign branch)",
        parentVersionId: artifactBVersionId, // belongs to B, not A
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);

    // Transaction rolled back — no new version row for A.
    const after = await versionCount(artifactAId);
    expect(after).toBe(before);
  });

  it("rejects a parentVersionId that resolves to no row (missing parent)", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = artifactService(db);
    const before = await versionCount(artifactAId);

    let caught: unknown;
    try {
      await svc.addVersion(artifactAId, {
        source: "agent",
        content: "# ghost branch",
        // A syntactically-valid UUID that does not exist in artifact_versions.
        parentVersionId: "00000000-0000-4000-8000-000000000000",
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(HttpError);
    expect(await versionCount(artifactAId)).toBe(before);
  });

  it("accepts a parentVersionId owned by the SAME artifact", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = artifactService(db);
    const before = await versionCount(artifactAId);

    const version = await svc.addVersion(artifactAId, {
      source: "agent",
      content: "# A v2 (own branch)",
      parentVersionId: artifactAVersionId, // A's own version
    });

    expect(version.parentVersionId).toBe(artifactAVersionId);
    expect(version.artifactId).toBe(artifactAId);
    expect(await versionCount(artifactAId)).toBe(before + 1);
  });

  it("accepts addVersion with no parentVersionId (regression)", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = artifactService(db);
    const before = await versionCount(artifactAId);

    const version = await svc.addVersion(artifactAId, {
      source: "founder",
      content: "# A next (linear)",
    });

    expect(version.parentVersionId).toBeNull();
    expect(await versionCount(artifactAId)).toBe(before + 1);
  });
});
