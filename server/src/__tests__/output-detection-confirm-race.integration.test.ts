/**
 * Task A-M9 — Real-DB proof that the detected-output confirm/dismiss flow is
 * transactional and serialized under a `FOR NO KEY UPDATE` row lock, so it
 * neither loses concurrent updates to the heartbeat_runs.detectedOutputs JSONB
 * array nor creates duplicate artifact versions on a re-confirm.
 *
 * The confirm/dismiss handlers do a read-modify-write over the WHOLE
 * detectedOutputs JSONB array: read the run row → mutate one index in JS →
 * write the whole array back. Without serialization:
 *   1. Concurrent confirm(0) + confirm(1) both read the same snapshot and the
 *      last write-back clobbers the other → only one index survives as
 *      `confirmed` (lost update).
 *   2. A re-confirm of an already-confirmed index reads a stale, unlocked
 *      `status` and creates a SECOND artifact version.
 *
 * The A-M9 fix wraps each core in db.transaction, takes `FOR NO KEY UPDATE` on
 * the run row first, re-checks the per-index pending guard against the FRESH
 * (locked) read, and performs every service write through a tx-scoped service
 * instance. This test boots embedded-postgres, seeds a company + agent + a
 * heartbeat run whose detectedOutputs has two pending entries, and proves:
 *   - confirm(0) ‖ confirm(1) concurrently → BOTH end up `confirmed`.
 *   - confirm(0) then confirm(0) again → exactly ONE artifact version.
 *
 * Skipped on Windows (embedded-postgres / migration-chain issue — Issue #114);
 * Linux CI is the authoritative gate. Modeled on
 * artifact-add-version-parent.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import {
  confirmDetectedOutputCore,
  dismissDetectedOutputCore,
} from "../routes/output-detection.js";

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
let agentId = "";

const PORT = 59000 + Math.floor(Math.random() * 1000);

// Actor passed to the confirm core. agentId/runId are null so logActivity does
// not depend on FK rows beyond the company.
const ACTOR = {
  actorType: "user" as const,
  actorId: "integration-test",
  agentId: null as string | null,
  runId: null as string | null,
};

const NO_AUTHZ = () => {
  /* authz is exercised by the route/mock tests; the race test bypasses it */
};

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<
    Record<string, unknown>
  >;
}

function firstId(result: unknown): string {
  const rows = rowsOf(result);
  return String(rows[0]?.id ?? "");
}

/** Build a detectedOutputs JSONB array of `n` pending entries. */
function pendingOutputs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    path: `dist/report-${i}.pdf`,
    filename: `report-${i}.pdf`,
    byteSize: 100 + i,
    contentType: "application/pdf",
    // Synthetic asset id — confirm only requires assetId to be non-null and
    // references it in fileUrl; no assets row is needed for the artifact path.
    assetId: `00000000-0000-4000-8000-00000000000${i}`,
    sha256: `sha-${i}`,
    source: "diff" as const,
    label: `Report ${i}`,
    status: "pending" as const,
  }));
}

/**
 * Insert a fresh heartbeat run with `n` pending detected outputs and NO issueId
 * in contextSnapshot (so the task_output upsert path — which validates asset
 * FKs — is skipped; the race concerns only the JSONB write-back + artifact
 * create). Returns the run id.
 */
async function seedRun(n: number): Promise<string> {
  const outputs = JSON.stringify(pendingOutputs(n));
  return firstId(
    await db.execute<{ id: string }>(sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, detected_outputs, context_snapshot)
      VALUES (
        gen_random_uuid(),
        ${companyId},
        ${agentId},
        ${outputs}::jsonb,
        '{}'::jsonb
      )
      RETURNING id
    `),
  );
}

/** Re-read the detectedOutputs JSONB array for a run. */
async function readOutputs(runId: string): Promise<Array<Record<string, unknown>>> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT detected_outputs AS outputs FROM heartbeat_runs WHERE id = ${runId}
    `),
  );
  return (rows[0]?.outputs as Array<Record<string, unknown>>) ?? [];
}

/** Count artifact_versions belonging to a given artifact. */
async function versionCount(artifactId: string): Promise<number> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM artifact_versions WHERE artifact_id = ${artifactId}
    `),
  );
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-output-race-integ-"));
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

    companyId = firstId(
      await db.execute<{ id: string }>(sql`
        INSERT INTO companies (id, name, issue_prefix)
        VALUES (gen_random_uuid(), 'Output Race Co', 'ORC')
        RETURNING id
      `),
    );
    agentId = firstId(
      await db.execute<{ id: string }>(sql`
        INSERT INTO agents (id, company_id, name, kind)
        VALUES (gen_random_uuid(), ${companyId}, 'Race Agent', 'org')
        RETURNING id
      `),
    );
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[output-detection-confirm-race] embedded-postgres setup failed:", err);
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

describe.skipIf(process.platform === "win32")(
  "detected-output confirm/dismiss transactionality (real DB)",
  () => {
    it("concurrent confirm(0) ‖ confirm(1) — both indices end up confirmed (no lost update)", async () => {
      if (setupError) throw new Error(String(setupError));

      const runId = await seedRun(2);

      // Fire both confirms concurrently. Without the FOR NO KEY UPDATE lock,
      // both read the same {0:pending, 1:pending} snapshot and the second
      // write-back clobbers the first → exactly one index survives.
      const [r0, r1] = await Promise.all([
        confirmDetectedOutputCore(db, {
          runId,
          index: 0,
          actor: ACTOR,
          body: {},
          assertAccess: NO_AUTHZ,
        }),
        confirmDetectedOutputCore(db, {
          runId,
          index: 1,
          actor: ACTOR,
          body: {},
          assertAccess: NO_AUTHZ,
        }),
      ]);

      expect(r0.ok).toBe(true);
      expect(r1.ok).toBe(true);

      const outputs = await readOutputs(runId);
      // The whole point: BOTH survive as confirmed under the row lock.
      expect(outputs[0]?.status).toBe("confirmed");
      expect(outputs[1]?.status).toBe("confirmed");
    });

    it("re-confirm of the same index creates exactly ONE artifact version", async () => {
      if (setupError) throw new Error(String(setupError));

      const runId = await seedRun(2);

      const first = await confirmDetectedOutputCore(db, {
        runId,
        index: 0,
        actor: ACTOR,
        body: {},
        assertAccess: NO_AUTHZ,
      });
      expect(first.ok).toBe(true);
      const confirmedArtifactId = first.ok ? first.value.artifactId : "";
      expect(confirmedArtifactId).toBeTruthy();
      expect(await versionCount(confirmedArtifactId)).toBe(1);

      // Re-confirm the same index. The locked re-read sees status=confirmed and
      // rejects with 409 — no second artifact version is created.
      const second = await confirmDetectedOutputCore(db, {
        runId,
        index: 0,
        actor: ACTOR,
        body: {},
        assertAccess: NO_AUTHZ,
      });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.status).toBe(409);
      }

      // Still exactly one version for that index's artifact.
      expect(await versionCount(confirmedArtifactId)).toBe(1);
    });

    it("concurrent confirm(0) ‖ dismiss(1) — both mutations survive", async () => {
      if (setupError) throw new Error(String(setupError));

      const runId = await seedRun(2);

      const [c, d] = await Promise.all([
        confirmDetectedOutputCore(db, {
          runId,
          index: 0,
          actor: ACTOR,
          body: {},
          assertAccess: NO_AUTHZ,
        }),
        dismissDetectedOutputCore(db, { runId, index: 1, assertAccess: NO_AUTHZ }),
      ]);

      expect(c.ok).toBe(true);
      expect(d.ok).toBe(true);

      const outputs = await readOutputs(runId);
      expect(outputs[0]?.status).toBe("confirmed");
      expect(outputs[1]?.status).toBe("dismissed");
    });
  },
);
