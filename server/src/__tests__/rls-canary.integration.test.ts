// Real-Postgres RLS canary proof (Phase 3, Task 11 / M3). DEFENSE-IN-DEPTH ONLY.
//
// Boots embedded-postgres, applies all migrations (incl. 0189's
// company_secrets.organization_id), bootstraps the non-owner `aoa_app` role +
// tenant-isolation policy, and proves:
//   - the table OWNER (superuser — stands in for the real runtime app) is NOT
//     filtered and sees every row (RLS is INERT for the owner; NO FORCE);
//   - the non-owner `aoa_app` role, driven through withTenantTx (transaction-local
//     GUC), sees ONLY its organization's rows;
//   - GUC unset -> zero rows; wrong org -> zero rows;
//   - a cross-tenant INSERT is rejected by the policy WITH CHECK.
//
// Linux-only (skipIf): embedded-postgres has a known Windows initdb encoding
// issue and macOS runners flake on setup/teardown. The Windows-visible unit
// coverage (role validation + withTenantTx GUC shaping) is in rls-canary-unit.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { bootstrapRlsCanary } from "../db/rls-bootstrap.js";
import { withTenantTx } from "../db/with-tenant-tx.js";
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
}) => EmbeddedPostgresInstance;

const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b2";
const ORG_NONE = "00000000-0000-0000-0000-0000000000cc"; // valid uuid, no secrets -> wrong org
const CO_A = "00000000-0000-0000-0000-0000000000c1";
const CO_B = "00000000-0000-0000-0000-0000000000c2";

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let adminUrl = "";
let db: Db; // owner/superuser connection (stands in for the runtime app)
let setupError: unknown = null;

function count(res: unknown): number {
  const row = Array.isArray(res) ? (res[0] as { c: number }) : (res as { rows: { c: number }[] }).rows[0];
  return Number(row.c);
}
function rowsOf<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : (res as { rows: T[] }).rows) as T[];
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-rls-"));
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
    });
    await pg.initialise();
    await pg.start();
    adminUrl = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(adminUrl);
    db = createDb(adminUrl);
    await db.execute(
      sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG_A}, 'Org A', 'org-a'), (${ORG_B}, 'Org B', 'org-b')`,
    );
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO_A}, 'Co A', 'PPA', ${ORG_A}), (${CO_B}, 'Co B', 'PPB', ${ORG_B})`,
    );
    await db.execute(
      sql`INSERT INTO company_secrets (id, company_id, organization_id, name) VALUES (gen_random_uuid(), ${CO_A}, ${ORG_A}, 'secret-a'), (gen_random_uuid(), ${CO_B}, ${ORG_B}, 'secret-b')`,
    );
    await bootstrapRlsCanary(adminUrl, "aoa_app", "app_pw");
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[rls-canary] embedded-postgres setup failed:", e);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    // ignore
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}, 60_000);

describe.skipIf(process.platform !== "linux")("RLS canary — company_secrets isolation (aoa_app role)", () => {
  it("owner is NOT filtered; non-owner sees only its org via withTenantTx; unset/wrong org = 0; cross-tenant write blocked", async () => {
    if (setupError) throw new Error(String(setupError));

    // Owner/superuser (the real runtime app) is EXEMPT from RLS -> sees both rows.
    expect(count(await db.execute(sql`SELECT count(*)::int AS c FROM company_secrets`))).toBe(2);

    // Separate connection AS the non-owner aoa_app role (the role RLS constrains).
    const appDb = createDb(adminUrl.replace("test:test", "aoa_app:app_pw"));

    // GUC unset (no withTenantTx) -> current_setting is NULL -> zero rows.
    expect(count(await appDb.execute(sql`SELECT count(*)::int AS c FROM company_secrets`))).toBe(0);

    // Transaction-local GUC = org A via withTenantTx -> exactly org A's row.
    const aRows = await withTenantTx(appDb, ORG_A, async (tx) =>
      rowsOf<{ organization_id: string }>(await tx.execute(sql`SELECT organization_id FROM company_secrets`)),
    );
    expect(aRows.length).toBe(1);
    expect(aRows[0].organization_id).toBe(ORG_A);

    // Wrong org (no secrets) via withTenantTx -> zero rows.
    const noneRows = await withTenantTx(appDb, ORG_NONE, async (tx) =>
      rowsOf<{ organization_id: string }>(await tx.execute(sql`SELECT organization_id FROM company_secrets`)),
    );
    expect(noneRows.length).toBe(0);

    // Cross-tenant write (GUC = org A, row org B) blocked by the policy WITH CHECK.
    await expect(
      withTenantTx(appDb, ORG_A, async (tx) =>
        tx.execute(
          sql`INSERT INTO company_secrets (id, company_id, organization_id, name) VALUES (gen_random_uuid(), ${CO_B}, ${ORG_B}, 'x')`,
        ),
      ),
    ).rejects.toThrow();
  }, 90_000);
});
