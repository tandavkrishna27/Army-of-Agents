// REAL embedded-postgres proof of TEN-002's H-01 (tenant isolation) guarantee for
// the 8 new-path distributed-execution tables: a NON-OWNER, NOSUPERUSER,
// NOBYPASSRLS role (`aoa_app`) under FORCE ROW LEVEL SECURITY + per-table tenant
// policies can only read/write rows of the Organization in its transaction-local
// GUC (`aoa.organization_id`), and cannot reach another tenant's rows, the
// platform null-Org rows, or write across tenants.
//
// The serving-role guarantee (E2-D01/E2-F004) is that `aoa_app` is non-owner +
// NOSUPERUSER + NOBYPASSRLS — plain RLS filters it. FORCE is defense-in-depth
// against a NON-SUPERUSER-OWNER serving mistake (superusers/BYPASSRLS bypass RLS
// regardless of FORCE), so FORCE is proved two ways: (a) the catalog flag
// `pg_class.relforcerowsecurity`, and (f) a dedicated NON-superuser owner role that
// is filtered under FORCE with no GUC — the assertion that is impossible against
// the embedded-PG superuser owner.
//
// Gate: E2-D05 env-hatch. Runs automatically on Linux CI (process.platform !==
// "win32") and is Windows-runnable in place via AOA_RUN_WIN_INTEGRATION=1 (no
// source edit-and-restore). It gates with `describe.skipIf(...)` rather than the
// banned fail-open ternary (the shape that swaps in a skipped describe when an env
// var is absent), so it satisfies the integration-test-hygiene meta-test. Boot uses
// initdbFlags UTF8/C; setupError is captured in beforeAll and re-thrown in the first
// `it` (fail closed).
//
// The `aoa_app` LOGIN credential is provisioned IN-TEST as the superuser (the
// migration creates the role NOLOGIN with no committed credential — E2-D01), then
// connected via the cred-swap pattern (rls-canary.integration.test.ts:116).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  createTenantAppDb,
  assertNonOwnerConnection,
  type Db,
} from "@armyofagents/db";
import { withTenantTx } from "../db/with-tenant-tx.js";
import {
  TENANT_APP_ROLE,
  TENANT_RLS_TABLES,
  provisionTenantAppRoleLoginSql,
  buildTenantRlsMigrationSql,
} from "../db/rls-tenant.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

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
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

const APP_PW = "app_pw";
const OWNER_NS_PW = "owner_pw";

const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b2";
const ORG_NONE = "00000000-0000-0000-0000-0000000000cc"; // valid uuid, owns no rows -> wrong org
const CO_A = "00000000-0000-0000-0000-0000000000c1";
const CO_B = "00000000-0000-0000-0000-0000000000c2";
const TARGET_A = "00000000-0000-4000-8000-0000000000d1";
const TARGET_B = "00000000-0000-4000-8000-0000000000d2";
const TARGET_PLATFORM = "00000000-0000-4000-8000-0000000000d3";

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let adminUrl = "";
let db: Db; // owner/superuser connection (stands in for the privileged migration/provisioning role)
let appDb: Db; // NON-OWNER aoa_app serving connection (the role RLS constrains)
let setupError: unknown = null;

// Seeded row ids captured in beforeAll.
let jobA = "";
let jobB = "";
let attemptA = "";
let workerOrgA = "";
let workerPlatform = "";
let serviceA = "";

type PgError = { code?: string; constraint_name?: string; message?: string; cause?: unknown };

// drizzle's postgres-js session may wrap the raw PostgresError, so the SQLSTATE
// `code` can sit on `.cause` rather than the top-level error. Walk the cause chain.
function sqlstate(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 6 && e && typeof e === "object"; i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function count(res: unknown): number {
  const row = Array.isArray(res) ? (res[0] as { c: number }) : (res as { rows: { c: number }[] }).rows[0];
  return Number(row.c);
}
function rowsOf<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : (res as { rows: T[] }).rows) as T[];
}
function firstId(res: unknown): string {
  return rowsOf<{ id: string }>(res)[0]!.id;
}

// Runs a statement expected to be REJECTED by RLS/a constraint and returns the
// error. If it SUCCEEDS (RED state or a regression) this throws — the failing
// signal we want (no silent pass on a bypassed isolation check).
async function expectReject(run: () => Promise<unknown>): Promise<PgError> {
  try {
    await run();
  } catch (e) {
    return e as PgError;
  }
  throw new Error("expected the statement to be rejected by RLS / a constraint, but it succeeded");
}

// SELECT organization_id values from a table as aoa_app under a tenant GUC.
async function orgIdsUnderGuc(table: string, org: string): Promise<string[]> {
  return withTenantTx(appDb, org, async (tx) =>
    rowsOf<{ organization_id: string }>(
      await tx.execute(sql.raw(`SELECT organization_id FROM "${table}"`)),
    ).map((r) => r.organization_id),
  );
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-tenant-rls-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    adminUrl = `postgres://test:test@localhost:${port}/postgres`;

    // Apply the WHOLE chain incl. 0211 (creates aoa_app NOLOGIN + GRANT + ENABLE +
    // FORCE + tenant policies on the 8 new-path tables).
    await applyPendingMigrations(adminUrl);
    db = createDb(adminUrl);

    // Provision the aoa_app LOGIN credential as the superuser (the migration left
    // it NOLOGIN with no committed secret — E2-D01/E2-D03).
    await db.execute(sql.raw(provisionTenantAppRoleLoginSql(TENANT_APP_ROLE, APP_PW)));

    // Two tenants + a company in each.
    await db.execute(
      sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG_A}, 'Org A', 'org-a'), (${ORG_B}, 'Org B', 'org-b')`,
    );
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO_A}, 'Co A', 'PPA', ${ORG_A}), (${CO_B}, 'Co B', 'PPB', ${ORG_B})`,
    );
    await db.execute(sql`INSERT INTO execution_targets
      (id, organization_id, slug, kind, trust_class, status, capabilities, config,
       scope, target_authority_key, device_generation)
      VALUES
      (${TARGET_A}, ${ORG_A}, 'rls-target-a', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
        'organization', ${`organization:${ORG_A}`}, 1),
      (${TARGET_B}, ${ORG_B}, 'rls-target-b', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
        'organization', ${`organization:${ORG_B}`}, 1),
      (${TARGET_PLATFORM}, NULL, 'rls-target-platform', 'pooled_gvisor', 'shared_multitenant', 'active', '{}', '{}',
        'platform', 'platform', 1)`);

    // One row per tenant in each new-path table (workers additionally gets a
    // platform null-Org row).
    jobA = firstId(await db.execute(sql`INSERT INTO jobs (organization_id, company_id) VALUES (${ORG_A}, ${CO_A}) RETURNING id`));
    jobB = firstId(await db.execute(sql`INSERT INTO jobs (organization_id, company_id) VALUES (${ORG_B}, ${CO_B}) RETURNING id`));
    attemptA = firstId(await db.execute(sql`INSERT INTO job_attempts (organization_id, company_id, job_id) VALUES (${ORG_A}, ${CO_A}, ${jobA}) RETURNING id`));
    const attemptB = firstId(await db.execute(sql`INSERT INTO job_attempts (organization_id, company_id, job_id) VALUES (${ORG_B}, ${CO_B}, ${jobB}) RETURNING id`));
    await db.execute(sql`INSERT INTO leases (organization_id, attempt_id, fence) VALUES (${ORG_A}, ${attemptA}, 'fa')`);
    await db.execute(sql`INSERT INTO leases (organization_id, attempt_id, fence) VALUES (${ORG_B}, ${attemptB}, 'fb')`);
    workerOrgA = firstId(await db.execute(sql`INSERT INTO workers
      (scope, organization_id, label, execution_target_id, target_authority_key,
       device_generation, device_public_key, device_thumbprint, profile_hash, enrolled_at)
      VALUES ('organization', ${ORG_A}, 'wa', ${TARGET_A}, ${`organization:${ORG_A}`},
        1, 'rls-key-a', ${"a".repeat(64)}, ${"b".repeat(64)}, now()) RETURNING id`));
    await db.execute(sql`INSERT INTO workers
      (scope, organization_id, label, execution_target_id, target_authority_key,
       device_generation, device_public_key, device_thumbprint, profile_hash, enrolled_at)
      VALUES ('organization', ${ORG_B}, 'wb', ${TARGET_B}, ${`organization:${ORG_B}`},
        1, 'rls-key-b', ${"c".repeat(64)}, ${"d".repeat(64)}, now())`);
    workerPlatform = firstId(await db.execute(sql`INSERT INTO workers
      (scope, organization_id, label, execution_target_id, target_authority_key,
       device_generation, device_public_key, device_thumbprint, profile_hash, enrolled_at)
      VALUES ('platform', NULL, 'wp', ${TARGET_PLATFORM}, 'platform',
        1, 'rls-key-platform', ${"e".repeat(64)}, ${"f".repeat(64)}, now()) RETURNING id`));
    serviceA = firstId(await db.execute(sql`INSERT INTO services (organization_id, company_id) VALUES (${ORG_A}, ${CO_A}) RETURNING id`));
    const serviceB = firstId(await db.execute(sql`INSERT INTO services (organization_id, company_id) VALUES (${ORG_B}, ${CO_B}) RETURNING id`));
    await db.execute(sql`INSERT INTO service_instances (organization_id, company_id, service_id) VALUES (${ORG_A}, ${CO_A}, ${serviceA})`);
    await db.execute(sql`INSERT INTO service_instances (organization_id, company_id, service_id) VALUES (${ORG_B}, ${CO_B}, ${serviceB})`);
    await db.execute(sql`INSERT INTO job_artifacts (organization_id, job_id, identifier) VALUES (${ORG_A}, ${jobA}, 'ida')`);
    await db.execute(sql`INSERT INTO job_artifacts (organization_id, job_id, identifier) VALUES (${ORG_B}, ${jobB}, 'idb')`);
    await db.execute(sql`INSERT INTO job_secret_handles (organization_id, job_id, handle) VALUES (${ORG_A}, ${jobA}, 'ha')`);
    await db.execute(sql`INSERT INTO job_secret_handles (organization_id, job_id, handle) VALUES (${ORG_B}, ${jobB}, 'hb')`);

    // The NON-OWNER serving connection (cred-swap).
    appDb = createTenantAppDb(adminUrl.replace("test:test", `${TENANT_APP_ROLE}:${APP_PW}`));
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[tenant-rls-enforcement] embedded-postgres setup failed:", e);
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

function guard(): void {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "TEN-002 forced-RLS tenant isolation (aoa_app non-owner role)",
  () => {
    it("(a) FORCE + ENABLE row level security are applied to all 8 new-path tables (catalog)", async () => {
      guard();
      const list = TENANT_RLS_TABLES.map((t) => `'${t}'`).join(",");
      const rows = rowsOf<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        await db.execute(
          sql.raw(
            `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relkind='r' AND relname IN (${list})`,
          ),
        ),
      );
      expect(rows.length).toBe(TENANT_RLS_TABLES.length);
      for (const r of rows) {
        expect(r.relrowsecurity, `${r.relname} ENABLE RLS`).toBe(true);
        expect(r.relforcerowsecurity, `${r.relname} FORCE RLS`).toBe(true);
      }
    });

    it("(a2) the 0211 RLS DDL is idempotent: re-apply + re-run every statement is a no-op", async () => {
      guard();
      // Journal-level: a second applyPendingMigrations is a no-op (already recorded).
      await expect(applyPendingMigrations(adminUrl)).resolves.toBeUndefined();

      // Statement-level (the C14 concern — the manual fallback re-runs statements):
      // re-execute every 0211 statement as the privileged role and prove none throws
      // (DO $$ IF NOT EXISTS role guard; GRANT/ENABLE/FORCE no-ops; DROP POLICY IF
      // EXISTS before CREATE POLICY).
      const statements = buildTenantRlsMigrationSql()
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const statement of statements) {
        await db.execute(sql.raw(statement));
      }

      // FORCE still set after the re-run.
      const list = TENANT_RLS_TABLES.map((t) => `'${t}'`).join(",");
      const rows = rowsOf<{ relforcerowsecurity: boolean }>(
        await db.execute(
          sql.raw(`SELECT relforcerowsecurity FROM pg_class WHERE relkind='r' AND relname IN (${list})`),
        ),
      );
      expect(rows.length).toBe(TENANT_RLS_TABLES.length);
      expect(rows.every((r) => r.relforcerowsecurity)).toBe(true);
    });

    it("(b) aoa_app with NO tenant GUC sees zero rows in every new-path table", async () => {
      guard();
      for (const table of TENANT_RLS_TABLES) {
        const c = count(await appDb.execute(sql.raw(`SELECT count(*)::int AS c FROM "${table}"`)));
        expect(c, `${table} with no GUC`).toBe(0);
      }
    });

    it("(c) aoa_app with GUC=ORG_A sees ONLY ORG_A rows in every new-path table", async () => {
      guard();
      for (const table of TENANT_RLS_TABLES) {
        const ids = await orgIdsUnderGuc(table, ORG_A);
        expect(ids.length, `${table} row count for ORG_A`).toBe(1);
        expect(ids.every((o) => o === ORG_A), `${table} all rows == ORG_A`).toBe(true);
      }
    });

    it("(d) aoa_app with a wrong-org GUC (no rows) sees zero rows in every new-path table", async () => {
      guard();
      for (const table of TENANT_RLS_TABLES) {
        const ids = await orgIdsUnderGuc(table, ORG_NONE);
        expect(ids.length, `${table} wrong-org`).toBe(0);
      }
    });

    it("(e) aoa_app cross-tenant INSERT (GUC=ORG_A, row=ORG_B) is rejected by the policy WITH CHECK", async () => {
      guard();
      const err = await expectReject(() =>
        withTenantTx(appDb, ORG_A, async (tx) =>
          tx.execute(sql`INSERT INTO jobs (organization_id, company_id) VALUES (${ORG_B}, ${CO_B})`),
        ),
      );
      // 42501 = new row violates row-level security policy (WITH CHECK), NOT an FK
      // violation: (ORG_B, CO_B) is a valid composite, so only RLS rejects it.
      expect(sqlstate(err)).toBe("42501");
    });

    it("(g) aoa_app cannot INSERT or UPDATE a workers row to organization_id IS NULL (WITH CHECK)", async () => {
      guard();
      // INSERT a platform (null-Org) worker: the check constraint is satisfied
      // (platform => org NULL) so the rejection is the RLS WITH CHECK, not the check.
      const insErr = await expectReject(() =>
        withTenantTx(appDb, ORG_A, async (tx) =>
          tx.execute(sql`INSERT INTO workers
            (scope, organization_id, label, execution_target_id, target_authority_key,
             device_generation, device_public_key, device_thumbprint, profile_hash, enrolled_at)
            VALUES ('platform', NULL, 'sneak', ${TARGET_PLATFORM}, 'platform',
              1, 'rls-sneak-key', ${"1".repeat(64)}, ${"2".repeat(64)}, now())`),
        ),
      );
      expect(sqlstate(insErr)).toBe("42501");

      // UPDATE an owned (visible) worker to null-Org: USING admits the ORG_A row,
      // WITH CHECK on the new (org NULL) row rejects it.
      const updErr = await expectReject(() =>
        withTenantTx(appDb, ORG_A, async (tx) =>
          tx.execute(
            sql`UPDATE workers SET organization_id = NULL, scope = 'platform',
              execution_target_id = ${TARGET_PLATFORM}, target_authority_key = 'platform'
              WHERE id = ${workerOrgA}`,
          ),
        ),
      );
      expect(sqlstate(updErr)).toBe("42501");
    });

    it("(h) no tenant GUC ever returns a null-Org platform worker row", async () => {
      guard();
      for (const org of [ORG_A, ORG_B, ORG_NONE]) {
        const nullOrg = await withTenantTx(appDb, org, async (tx) =>
          count(await tx.execute(sql`SELECT count(*)::int AS c FROM workers WHERE organization_id IS NULL`)),
        );
        expect(nullOrg, `null-Org workers visible to GUC=${org}`).toBe(0);
        const byId = await withTenantTx(appDb, org, async (tx) =>
          count(await tx.execute(sql`SELECT count(*)::int AS c FROM workers WHERE id = ${workerPlatform}`)),
        );
        expect(byId, `platform worker by id visible to GUC=${org}`).toBe(0);
      }
      // Superuser (owner, bypasses RLS) confirms the platform row DOES exist.
      expect(count(await db.execute(sql`SELECT count(*)::int AS c FROM workers WHERE id = ${workerPlatform}`))).toBe(1);
    });

    it("(i) assertNonOwnerConnection passes for aoa_app (NOSUPERUSER+NOBYPASSRLS) and throws for the superuser", async () => {
      guard();
      await expect(assertNonOwnerConnection(appDb)).resolves.toBeUndefined();
      await expect(assertNonOwnerConnection(db)).rejects.toThrow(/privileged role/i);
    });

    // Run LAST: transfers ownership of `jobs` away from the superuser.
    it("(f) a NON-superuser owner is filtered by FORCE with no GUC (impossible against the superuser owner)", async () => {
      guard();
      // A distinct non-superuser owner role. No policy names it, so under FORCE its
      // access is default-deny.
      await db.execute(
        sql.raw(
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_owner_ns') THEN ` +
            `CREATE ROLE "aoa_owner_ns" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN PASSWORD '${OWNER_NS_PW}'; END IF; END $$;`,
        ),
      );
      // Make it the (non-superuser) TABLE OWNER of jobs. Under FORCE the owner is NOT
      // exempt from RLS (this is the exemption FORCE removes).
      await db.execute(sql.raw(`ALTER TABLE "jobs" OWNER TO "aoa_owner_ns"`));

      const ownerDb = createDb(adminUrl.replace("test:test", `aoa_owner_ns:${OWNER_NS_PW}`));

      // Sanity: it really is non-superuser (else the proof is vacuous).
      const attrs = rowsOf<{ rolsuper: boolean; rolbypassrls: boolean }>(
        await ownerDb.execute(sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`),
      )[0]!;
      expect(attrs.rolsuper).toBe(false);
      expect(attrs.rolbypassrls).toBe(false);

      // FORCE => the non-superuser owner is filtered by RLS; with no policy for its
      // role and no GUC, it sees 0 rows — the assertion that CANNOT hold against a
      // superuser owner (superusers always bypass RLS regardless of FORCE).
      const ownerVisible = count(await ownerDb.execute(sql`SELECT count(*)::int AS c FROM jobs`));
      expect(ownerVisible).toBe(0);

      // Contrast: the superuser owner-equivalent (bypasses RLS) still sees both jobs.
      expect(count(await db.execute(sql`SELECT count(*)::int AS c FROM jobs`))).toBe(2);
    });
  },
);
