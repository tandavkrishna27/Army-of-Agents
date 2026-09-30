// REAL embedded-postgres proof of TEN-003's mandatory Organization context
// `runInTenant`. It opens a transaction on the NON-OWNER `aoa_app` pool
// (NOSUPERUSER/NOBYPASSRLS), writes the transaction-local `aoa.organization_id`
// GUC, builds the tenant repositories from that transaction, and runs `fn` — so
// forced RLS (TEN-002) filters every query to the Organization in the GUC.
//
// The crux is the POOLED-CONNECTION no-leak proof (transaction-local GUC): the app
// pool is pinned to `max: 1` so every query lands on the SAME physical connection.
// postgres-js defaults to 10 — with the default, interleaved tenants would land on
// DIFFERENT physical connections and a "no leak" assertion would pass VACUOUSLY.
// With max:1, a committed runInTenant, a rolled-back runInTenant, and a raw pool
// query all share one connection, so "the next borrower sees no previous tenant"
// is a REAL assertion.
//
// Assertions:
//   (a) interleaved runInTenant(ORG_A)/runInTenant(ORG_B) return DISJOINT rows.
//   (b) no GUC leak across pooled reuse: after a COMMITTED runInTenant and a
//       ROLLED-BACK one (fn throws), a raw appDb query outside any runInTenant reads
//       `current_setting('aoa.organization_id', true)` EMPTY, and the next
//       runInTenant sees only its own org (no bleed from the prior/rolled-back tx).
//   (c) a nested db.transaction (SAVEPOINT) inherits the outer tenant (same org).
//   (d) a query on appDb OUTSIDE any runInTenant (no GUC) → 0 new-path rows (forced
//       RLS from TEN-002), proving the wrapper is MANDATORY to see anything.
//   (e) runInTenant(appDb, "" | "  ", fn) THROW (empty Organization rejected).
//
// Gate: E2-D05 env-hatch. Runs automatically on Linux CI (process.platform !==
// "win32") and is Windows-runnable in place via AOA_RUN_WIN_INTEGRATION=1 (no source
// edit-and-restore). `describe.skipIf(...)` (not the banned fail-open ternary) keeps
// integration-test-hygiene green. Boot uses initdbFlags UTF8/C; setupError captured
// in beforeAll, re-thrown in the first `it` (fail closed). aoa_app LOGIN is
// provisioned IN-TEST as the superuser (the 0211 migration creates it NOLOGIN),
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
  tenantRepositories,
  type Db,
} from "@armyofagents/db";
import { withTenantTx } from "../db/with-tenant-tx.js";
import { runInTenant } from "../db/tenant-context.js";
import { TENANT_APP_ROLE, provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
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

const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b2";
const CO_A = "00000000-0000-0000-0000-0000000000c1";
const CO_B = "00000000-0000-0000-0000-0000000000c2";

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let adminUrl = "";
let db: Db; // owner/superuser connection (privileged migration/provisioning role stand-in)
let appDb: Db; // NON-OWNER aoa_app serving connection, pinned to max:1 (RLS constrains it)
let setupError: unknown = null;

function rowsOf<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : (res as { rows: T[] }).rows) as T[];
}
function count(res: unknown): number {
  const row = Array.isArray(res) ? (res[0] as { c: number }) : (res as { rows: { c: number }[] }).rows[0];
  return Number(row.c);
}

// drizzle's postgres-js session may wrap the raw PostgresError; walk the cause chain
// for the SQLSTATE (same helper shape as tenant-rls-enforcement.integration.test.ts).
function sqlstate(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 6 && e && typeof e === "object"; i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-tenant-ctx-"));
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

    // Apply the whole chain incl. 0211 (aoa_app NOLOGIN + GRANT + ENABLE + FORCE +
    // tenant policies on the 8 new-path tables).
    await applyPendingMigrations(adminUrl);
    db = createDb(adminUrl);

    // Provision the aoa_app LOGIN credential as the superuser (migration left it
    // NOLOGIN with no committed secret — E2-D01/E2-D03).
    await db.execute(sql.raw(provisionTenantAppRoleLoginSql(TENANT_APP_ROLE, APP_PW)));

    // Two tenants + a company in each + a job in each.
    await db.execute(
      sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG_A}, 'Org A', 'org-a'), (${ORG_B}, 'Org B', 'org-b')`,
    );
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO_A}, 'Co A', 'PPA', ${ORG_A}), (${CO_B}, 'Co B', 'PPB', ${ORG_B})`,
    );
    await db.execute(sql`INSERT INTO jobs (organization_id, company_id) VALUES (${ORG_A}, ${CO_A})`);
    await db.execute(sql`INSERT INTO jobs (organization_id, company_id) VALUES (${ORG_B}, ${CO_B})`);

    // The NON-OWNER serving connection, PINNED to a single physical connection so
    // the pooled-reuse no-leak proof (b) is REAL (not vacuous across 10 conns).
    appDb = createTenantAppDb(adminUrl.replace("test:test", `${TENANT_APP_ROLE}:${APP_PW}`), {
      max: 1,
    });
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[tenant-tx-context] embedded-postgres setup failed:", e);
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

// Read the transaction-local GUC from a RAW appDb query (outside any runInTenant).
async function rawGuc(): Promise<string> {
  const v = rowsOf<{ v: string | null }>(
    await appDb.execute(sql`SELECT current_setting('aoa.organization_id', true) AS v`),
  )[0]?.v;
  return v ?? "";
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "TEN-003 mandatory tenant context (runInTenant over the max:1 aoa_app pool)",
  () => {
    // Runs FIRST so the appDb connection is PRISTINE (no runInTenant has set the GUC
    // yet in this describe): current_setting('aoa.organization_id', true) is NULL, so
    // the policy predicate `organization_id = NULL::uuid` is NULL and every row is
    // excluded — a clean 0 rows. (After a tenant tx has run on a pooled connection,
    // the placeholder GUC's reset value becomes '' and a no-context query fails closed
    // by THROWING on ''::uuid instead — proven separately in (d2).)
    it("(d) a query on a PRISTINE appDb connection OUTSIDE any runInTenant sees 0 new-path rows (forced RLS makes the wrapper mandatory)", async () => {
      guard();
      const c = count(await appDb.execute(sql`SELECT count(*)::int AS c FROM jobs`));
      expect(c).toBe(0);
      // Sanity: the rows DO exist (the superuser owner bypasses RLS and sees both).
      expect(count(await db.execute(sql`SELECT count(*)::int AS c FROM jobs`))).toBe(2);
    });

    it("(a) interleaved runInTenant(ORG_A)/runInTenant(ORG_B) return DISJOINT rows on the same physical connection", async () => {
      guard();
      const aRows = await runInTenant(appDb, ORG_A, (repos) => repos.jobs.listForCompany(CO_A));
      expect(aRows.length).toBe(1);
      expect(aRows.every((r) => r.organizationId === ORG_A)).toBe(true);

      const bRows = await runInTenant(appDb, ORG_B, (repos) => repos.jobs.listForCompany(CO_B));
      expect(bRows.length).toBe(1);
      expect(bRows.every((r) => r.organizationId === ORG_B)).toBe(true);

      // Cross-tenant lookups fail closed: ORG_A context cannot see ORG_B's rows even
      // by the OTHER company id or by direct id (forced RLS, not just the WHERE).
      expect((await runInTenant(appDb, ORG_A, (repos) => repos.jobs.listForCompany(CO_B))).length).toBe(0);
      const bJobId = bRows[0]!.id;
      expect(await runInTenant(appDb, ORG_A, (repos) => repos.jobs.getById(bJobId))).toBeNull();
    });

    it("(b) transaction-local GUC does not leak across pooled reuse (commit + rollback, same max:1 connection)", async () => {
      guard();
      // Baseline: no GUC outside any runInTenant.
      expect(await rawGuc()).toBe("");

      // 1) A COMMITTED runInTenant(ORG_A): its read sees only ORG_A.
      const committed = await runInTenant(appDb, ORG_A, (repos) => repos.jobs.listForCompany(CO_A));
      expect(committed.every((r) => r.organizationId === ORG_A)).toBe(true);

      // After commit, on the SAME physical connection, the GUC is gone.
      expect(await rawGuc()).toBe("");

      // 2) A ROLLED-BACK runInTenant(ORG_B): the read sees only ORG_B, then fn throws.
      const boom = new Error("intentional rollback");
      let sawOnlyOrgB = false;
      await expect(
        runInTenant(appDb, ORG_B, async (repos) => {
          const rows = await repos.jobs.listForCompany(CO_B);
          sawOnlyOrgB = rows.length === 1 && rows.every((r) => r.organizationId === ORG_B);
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(sawOnlyOrgB).toBe(true);

      // After ROLLBACK, on the SAME connection, the ORG_B GUC did NOT persist.
      expect(await rawGuc()).toBe("");

      // 3) The next runInTenant on the same connection sees ONLY its own org — no
      //    bleed from the committed ORG_A nor the rolled-back ORG_B.
      const next = await runInTenant(appDb, ORG_A, (repos) => repos.jobs.listForCompany(CO_A));
      expect(next.length).toBe(1);
      expect(next.every((r) => r.organizationId === ORG_A)).toBe(true);
    });

    it("(b2) the GUC value inside a tenant transaction is exactly this call's org, and empty outside", async () => {
      guard();
      // Direct proof via the primitive runInTenant wraps (withTenantTx exposes tx):
      // current_setting inside == the call's org; outside (raw appDb) == empty.
      const inside = await withTenantTx(appDb, ORG_A, async (tx) =>
        rowsOf<{ v: string | null }>(
          await tx.execute(sql`SELECT current_setting('aoa.organization_id', true) AS v`),
        )[0]?.v ?? "",
      );
      expect(inside).toBe(ORG_A);
      expect(await rawGuc()).toBe("");
    });

    it("(c) a nested db.transaction (SAVEPOINT) inherits the outer tenant (same org visible)", async () => {
      guard();
      // A nested drizzle transaction is a SAVEPOINT on the SAME connection as its
      // parent, so it inherits the transaction-local GUC WITHOUT re-setting it —
      // proving tenant context flows into nested transactions. (runInTenant is
      // withTenantTx + tenantRepositories; the nested SAVEPOINT is opened on the
      // outer tenant transaction's handle, which repos do not expose, so this uses
      // the primitive the wrapper is built from.)
      const result = await withTenantTx(appDb, ORG_A, async (tx) =>
        tx.transaction(async (nested) => {
          const guc = rowsOf<{ v: string | null }>(
            await nested.execute(sql`SELECT current_setting('aoa.organization_id', true) AS v`),
          )[0]?.v;
          const rows = await tenantRepositories(nested as unknown as Db).jobs.listForCompany(CO_A);
          return { guc: guc ?? "", rows };
        }),
      );
      expect(result.guc).toBe(ORG_A); // inherited, not re-set
      expect(result.rows.length).toBe(1);
      expect(result.rows.every((r) => r.organizationId === ORG_A)).toBe(true);
    });

    it("(d2) a no-context query on a REUSED pooled connection FAILS CLOSED (never returns rows)", async () => {
      guard();
      // By now several runInTenant calls have run on this max:1 connection, so the
      // placeholder GUC's reset value is '' (empty string), not NULL. A stray query
      // OUTSIDE runInTenant therefore evaluates `organization_id = ''::uuid`, which
      // fails closed by THROWING (22P02) rather than leaking rows. The robust H-01
      // property is: a no-context query NEVER yields rows — it throws OR returns 0.
      let outcome: number | "threw" = "threw";
      let code: string | undefined;
      try {
        outcome = count(await appDb.execute(sql`SELECT count(*)::int AS c FROM jobs`));
      } catch (e) {
        outcome = "threw";
        code = sqlstate(e);
      }
      expect(outcome === "threw" || outcome === 0).toBe(true); // never > 0 (fail closed)
      if (outcome === "threw") {
        // On this connection the empty-string reset value makes ''::uuid throw 22P02.
        expect(code).toBe("22P02");
      }
    });

    it("(e) runInTenant with an empty or blank organizationId THROWS (empty Organization rejected)", async () => {
      guard();
      await expect(runInTenant(appDb, "", async () => "x")).rejects.toThrow(/non-empty organizationId/i);
      await expect(runInTenant(appDb, "  ", async () => "x")).rejects.toThrow(/non-empty organizationId/i);
      // The rejection is fail-closed BEFORE any DB round-trip: the GUC is untouched.
      expect(await rawGuc()).toBe("");
    });
  },
);
