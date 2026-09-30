/**
 * REL-003 (E11) Lane E — worker re-enrollment / revocation after restore (DR07
 * enrollment half, I13). Embedded-PG. Drives the REAL wired functions:
 *   * advanceTargetGeneration (re-enrollment gen bump) — positive control: a
 *     matching expected-generation succeeds and returns the next generation.
 *   * revokeExecutionTarget (server, aoa_operator path) writes the DURABLE
 *     execution_target_revocations cutoff row — the B1 correction.
 *   * revokeTargetAuthority (worker-enrollment repo) bumps the generation + flips
 *     execution_targets.status='disabled' + workers.status='revoked', and writes NO
 *     execution_target_revocations row (B1: the cutoff belongs to
 *     revokeExecutionTarget, NOT revokeTargetAuthority).
 *
 * The stale-fence-after-generation-bump half of I13 is proven in the Lane B suite
 * (dr-stale-fence-after-restore.integration.test.ts), which drives the fence gate.
 *
 * Windows CI can't start embedded-postgres on the runneradmin runner (Issue #114) —
 * gated; opt in locally with AOA_RUN_WIN_INTEGRATION=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres, { type Sql } from "postgres";
import {
  applyPendingMigrations,
  createOperatorDbConnection,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { runInTenant } from "../db/tenant-context.js";
import { revokeExecutionTarget } from "../services/execution-targets.js";
import { revokeTenantWorkerAuthority } from "../middleware/worker-session-auth.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "e1100000-0000-4000-8000-000000000001";
const COMPANY = "e1100000-0000-4000-8000-000000000002";
const TARGET = "e1100000-0000-4000-8000-000000000003";
const WORKER = "e1100000-0000-4000-8000-000000000005";
const PASSWORD = "rel-003-lane-e-password";
const AUTHORITY_KEY = `organization:${ORG}`;

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

integration("REL-003 Lane E — re-enrollment / revocation after restore", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let operator: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;

  function ctx() {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!admin || !app || !operator) throw new Error("test setup incomplete");
    return { admin, app, operator };
  }

  /** Reset the target + worker to the initial enrolled state (gen 1, active) and
   * clear any revocation rows, so each test starts from the same restored fixture. */
  async function resetTargetWorker(): Promise<void> {
    const { admin } = ctx();
    await admin`DELETE FROM execution_target_revocations WHERE target_id = ${TARGET}`;
    await admin`UPDATE execution_targets SET status = 'active', device_generation = 1, updated_at = clock_timestamp()
      WHERE id = ${TARGET}`;
    await admin`UPDATE workers SET status = 'enrolled', revoked_at = NULL, device_generation = 1,
      updated_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  async function revocationCount(): Promise<number> {
    const { admin } = ctx();
    const rows = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM execution_target_revocations WHERE target_id = ${TARGET}`;
    return rows[0]!.count;
  }
  async function targetRow(): Promise<{ status: string; generation: number }> {
    const { admin } = ctx();
    const rows = await admin<{ status: string; generation: number }[]>`
      SELECT status, device_generation AS generation FROM execution_targets WHERE id = ${TARGET}`;
    return rows[0]!;
  }
  async function workerStatus(): Promise<string> {
    const { admin } = ctx();
    const rows = await admin<{ status: string }[]>`SELECT status FROM workers WHERE id = ${WORKER}`;
    return rows[0]!.status;
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-dr-lane-e-"));
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
      const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
      await applyPendingMigrations(adminUrl);
      admin = postgres(adminUrl, { max: 4 });
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", PASSWORD));
      app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 16 });
      operator = createOperatorDbConnection(adminUrl.replace("test:test", `aoa_operator:${PASSWORD}`), { max: 8 });
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'REL-003 Lane E org', 'rel-003-lane-e')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'REL-003 Lane E company', 'RLE')`;
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, scope, target_authority_key, device_generation, status)
        VALUES (${TARGET}, ${ORG}, 'rel-003-lane-e-target', 'dedicated_worker', 'dedicated_tenant',
          'organization', ${AUTHORITY_KEY}, 1, 'active')`;
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_generation, label, status,
         device_public_key, device_thumbprint, profile_hash, enrolled_at)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 1, 'REL-003 Lane E worker', 'enrolled',
          'rel-003-lane-e-public-key', ${"4".repeat(64)}, ${"5".repeat(64)}, clock_timestamp())`;
    } catch (error) {
      setupError = error;
      // eslint-disable-next-line no-console
      console.error("[dr-reenroll-revoke] embedded-postgres setup failed:", error);
    }
  }, 180_000);

  afterAll(async () => {
    await operator?.close({ timeoutSeconds: 5 }).catch(() => {});
    await app?.close({ timeoutSeconds: 5 }).catch(() => {});
    await admin?.end().catch(() => {});
    await embedded?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  it("I13a (positive control): advanceTargetGeneration on a matching expected-generation returns the next generation", async () => {
    const { app } = ctx();
    await resetTargetWorker();
    const advanced = await runInTenant(app.db, ORG, (repos) =>
      repos.workerEnrollment.advanceTargetGeneration({
        executionTargetId: TARGET,
        expectedGeneration: 1,
        now: new Date(),
      }));
    expect(advanced).toBe(2);
    expect((await targetRow()).generation).toBe(2);
    // A STALE expected-generation (the restored older generation) does not move it.
    const stale = await runInTenant(app.db, ORG, (repos) =>
      repos.workerEnrollment.advanceTargetGeneration({
        executionTargetId: TARGET,
        expectedGeneration: 1,
        now: new Date(),
      }));
    expect(stale).toBeNull();
  });

  it("I13b (B1): revokeExecutionTarget writes the durable execution_target_revocations cutoff row", async () => {
    const { app, operator } = ctx();
    await resetTargetWorker();
    expect(await revocationCount()).toBe(0);

    const result = await revokeExecutionTarget({
      appDb: app.db,
      operatorDb: operator.db,
      targetId: TARGET,
      organizationId: ORG,
      reason: "rel-003-lane-e-rehearsal",
    });
    expect(result.revoked).toBe(true);
    expect(result.revokedGeneration).toBe(1);
    // The DURABLE operator cutoff row is written HERE (B1) — not by revokeTargetAuthority.
    expect(await revocationCount()).toBe(1);
    const [row] = await ctx().admin<{ revokedGeneration: number; targetScope: string; reason: string }[]>`
      SELECT revoked_generation AS "revokedGeneration", target_scope AS "targetScope", reason
      FROM execution_target_revocations WHERE target_id = ${TARGET}`;
    expect(row!.revokedGeneration).toBe(1);
    expect(row!.targetScope).toBe("organization");
    expect(row!.reason).toBe("rel-003-lane-e-rehearsal");
  });

  it("I13c (B1 contrast): revokeTargetAuthority bumps generation + disables target + revokes worker, and writes NO cutoff row", async () => {
    const { app } = ctx();
    await resetTargetWorker();
    expect(await revocationCount()).toBe(0);

    const newGeneration = await revokeTenantWorkerAuthority({
      appDb: app.db,
      organizationId: ORG,
      executionTargetId: TARGET,
    });
    // Bumped generation + disabled target + revoked worker...
    expect(newGeneration).toBe(2);
    const target = await targetRow();
    expect(target.status).toBe("disabled");
    expect(target.generation).toBe(2);
    expect(await workerStatus()).toBe("revoked");
    // ...but it did NOT write the durable execution_target_revocations cutoff — that
    // is revokeExecutionTarget's job (B1). Asserting a row against revokeTargetAuthority
    // would be asserting a row nothing in this path writes.
    expect(await revocationCount()).toBe(0);
  });
});
