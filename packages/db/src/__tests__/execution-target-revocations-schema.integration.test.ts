/**
 * JOB-007 — embedded-PG proof of the operator-metadata target-revocation fanout
 * record + its RLS matrix (mirrors the DEP-003 cutover-marker proof; same
 * operator-metadata shape):
 *   - the table exists with FORCE ROW LEVEL SECURITY;
 *   - `aoa_operator` can WRITE (INSERT + UPDATE the scan/cursor state) + read-back;
 *   - `aoa_app` is READ-ONLY (SELECT works outside a tenant tx; INSERT/UPDATE denied);
 *   - tenants see NONE — an aoa_app query WITH the tenant GUC set returns zero rows;
 *   - the (target_id, revoked_generation) uniqueness / idempotency key holds;
 *   - the scope/organization_id + generation CHECK constraints hold.
 *
 * Windows runs this only under the integration harness (AOA_RUN_WIN_INTEGRATION=1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import { applyPendingMigrations } from "../client.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "85000000-0000-4000-8000-000000000001";
const TARGET = "85000000-0000-4000-8000-000000000009";
const PLATFORM_TARGET = "85000000-0000-4000-8000-00000000000a";
const PASSWORD = "job-007-revocation-rls";

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let admin: Sql | null = null;
let app: Sql | null = null;
let operator: Sql | null = null;
let setupError: unknown = null;

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) =>
        error
          ? reject(error)
          : !address || typeof address === "string"
            ? reject(new Error("port allocation failed"))
            : resolve(address.port));
    });
    server.on("error", reject);
  });
}

function clients() {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
  if (!admin || !app || !operator) throw new Error("database clients unavailable");
  return { admin, app, operator };
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-target-revocation-rls-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    const port = await allocatePort();
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
    const url = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(url);
    admin = postgres(url, { max: 1 });
    await admin.unsafe(`ALTER ROLE aoa_app LOGIN PASSWORD '${PASSWORD}'`);
    await admin.unsafe(`ALTER ROLE aoa_operator LOGIN PASSWORD '${PASSWORD}'`);
    app = postgres(url.replace("test:test", `aoa_app:${PASSWORD}`), { max: 1 });
    operator = postgres(url.replace("test:test", `aoa_operator:${PASSWORD}`), { max: 1 });
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await operator?.end(); } catch { /* ignore */ }
  try { await app?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-007 execution_target_revocations table + RLS matrix",
  () => {
    it("exists with FORCE ROW LEVEL SECURITY enabled", async () => {
      const { admin } = clients();
      const rows = await admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relname = 'execution_target_revocations'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.relrowsecurity).toBe(true);
      expect(rows[0]?.relforcerowsecurity).toBe(true);
    });

    it("has exactly the operator_write + app_read policies", async () => {
      const { admin } = clients();
      const policies = await admin<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies
        WHERE tablename = 'execution_target_revocations' ORDER BY policyname
      `;
      expect(policies.map((p) => p.policyname)).toEqual([
        "execution_target_revocations_app_read",
        "execution_target_revocations_operator_write",
      ]);
    });

    it("lets aoa_operator WRITE + UPDATE the record and read it back", async () => {
      const { operator } = clients();
      await operator`
        INSERT INTO execution_target_revocations
          (target_id, revoked_generation, target_scope, organization_id, status, reason)
        VALUES (${TARGET}, 1, 'organization', ${ORG}, 'pending', 'compromised')
      `;
      // Operator advances the bounded scan/cursor state.
      await operator`
        UPDATE execution_target_revocations SET status = 'converging'
        WHERE target_id = ${TARGET} AND revoked_generation = 1
      `;
      const rows = await operator<{ status: string }[]>`
        SELECT status FROM execution_target_revocations
        WHERE target_id = ${TARGET} AND revoked_generation = 1
      `;
      expect(rows).toEqual([{ status: "converging" }]);
    });

    it("lets aoa_app READ the record OUTSIDE a tenant transaction", async () => {
      const { app } = clients();
      const rows = await app<{ target_id: string }[]>`
        SELECT target_id FROM execution_target_revocations WHERE target_id = ${TARGET}
      `;
      expect(rows).toEqual([{ target_id: TARGET }]);
    });

    it("denies aoa_app writes (read-only)", async () => {
      const { app } = clients();
      await expect(
        app`INSERT INTO execution_target_revocations
          (target_id, revoked_generation, target_scope, organization_id, status)
          VALUES (${PLATFORM_TARGET}, 1, 'platform', NULL, 'pending')`,
      ).rejects.toThrow(/permission denied/i);
      await expect(
        app`UPDATE execution_target_revocations SET status = 'completed' WHERE target_id = ${TARGET}`,
      ).rejects.toThrow(/permission denied/i);
    });

    it("makes the record INVISIBLE to a tenant (aoa_app WITH the org GUC set sees zero rows)", async () => {
      const { app } = clients();
      const visible = await app.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('aoa.organization_id', $1, true)", [ORG]);
        return tx.unsafe("SELECT target_id FROM execution_target_revocations");
      });
      expect(visible).toHaveLength(0);
    });

    it("enforces (target_id, revoked_generation) uniqueness (the idempotency key)", async () => {
      const { operator } = clients();
      await expect(
        operator`INSERT INTO execution_target_revocations
          (target_id, revoked_generation, target_scope, organization_id, status)
          VALUES (${TARGET}, 1, 'organization', ${ORG}, 'pending')`,
      ).rejects.toThrow(/duplicate key|unique/i);
      // A DIFFERENT generation for the same target is a distinct, allowed cutoff.
      await operator`INSERT INTO execution_target_revocations
        (target_id, revoked_generation, target_scope, organization_id, status)
        VALUES (${TARGET}, 2, 'organization', ${ORG}, 'pending')`;
    });

    it("enforces the scope/organization_id CHECK (platform => null org, org/owner => non-null)", async () => {
      const { operator } = clients();
      // platform scope must have NULL organization_id.
      await expect(
        operator`INSERT INTO execution_target_revocations
          (target_id, revoked_generation, target_scope, organization_id, status)
          VALUES (${PLATFORM_TARGET}, 1, 'platform', ${ORG}, 'pending')`,
      ).rejects.toThrow(/scope_check/i);
      // organization scope must have a non-null organization_id.
      await expect(
        operator`INSERT INTO execution_target_revocations
          (target_id, revoked_generation, target_scope, organization_id, status)
          VALUES (${PLATFORM_TARGET}, 1, 'organization', NULL, 'pending')`,
      ).rejects.toThrow(/scope_check/i);
      // A well-formed platform record is accepted.
      await operator`INSERT INTO execution_target_revocations
        (target_id, revoked_generation, target_scope, organization_id, status)
        VALUES (${PLATFORM_TARGET}, 1, 'platform', NULL, 'pending')`;
    });

    it("enforces the generation > 0 CHECK", async () => {
      const { operator } = clients();
      await expect(
        operator`INSERT INTO execution_target_revocations
          (target_id, revoked_generation, target_scope, organization_id, status)
          VALUES (${"85000000-0000-4000-8000-0000000000ff"}, 0, 'platform', NULL, 'pending')`,
      ).rejects.toThrow(/generation_check/i);
    });
  },
);
