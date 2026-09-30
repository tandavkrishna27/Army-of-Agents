// server/src/__tests__/mt-cross-tenant-service.integration.test.ts
//
// Live version of P3 Task 15's mocked matrix (tenant-isolation-matrix.test.ts):
// seed two real Organizations each with a Company + data, then drive the real
// assertCompanyAccess chokepoint on a real embedded-postgres DB and assert an
// org-2 principal cannot read org-1 across companies, secrets, and the
// storage/company-list surfaces that route through it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { assertCompanyAccess } from "../routes/authz.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as any).rows) as any[];
let ORG1 = "", ORG2 = "", CO1 = "", CO2 = "", U1 = "", U2 = "";

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mt-xtenant-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false });
    await pg.initialise();
    await pg.start();
    const conn = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(conn);
    db = createDb(conn);
    setDeploymentMode("cloud_auth"); // strict tenant path
    ORG1 = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org One', 'org-one') RETURNING id`))[0].id;
    ORG2 = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org Two', 'org-two') RETURNING id`))[0].id;
    CO1 = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('Co One','ONE',${ORG1}) RETURNING id`))[0].id;
    CO2 = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('Co Two','TWO',${ORG2}) RETURNING id`))[0].id;
    // NOTE (plan drift fix): the "user" table's created_at/updated_at columns
    // are NOT NULL with no DB-level default (packages/db/src/migrations/
    // 0014_many_mikhail_rasputin.sql:28-36) — every other integration test
    // that inserts into "user" supplies now(), now() explicitly. The plan's
    // draft INSERT omitted them, which would fail at insert time; fixed here.
    U1 = rows(await db.execute(sql`INSERT INTO "user" (id, email, name, created_at, updated_at) VALUES (gen_random_uuid()::text, 'u1@x.io', 'U1', now(), now()) RETURNING id`))[0].id;
    U2 = rows(await db.execute(sql`INSERT INTO "user" (id, email, name, created_at, updated_at) VALUES (gen_random_uuid()::text, 'u2@x.io', 'U2', now(), now()) RETURNING id`))[0].id;
    await db.execute(sql`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES (${ORG1}, ${U1}, 'owner', 'active')`);
    await db.execute(sql`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES (${ORG2}, ${U2}, 'owner', 'active')`);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[mt-cross-tenant-service] setup failed:", err);
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

const req = (userId: string, orgId: string, companyIds: string[]) =>
  ({ actor: { type: "board", source: "session", userId, companyIds, organizationIds: [orgId] } }) as any;

// Run only on Linux CI (embedded-postgres initdb encoding issue on Windows;
// this mirrors the companies-delete-integration.test.ts harness).
describe.skipIf(process.platform !== "linux")("cross-tenant service isolation (two real orgs, cloud_auth)", () => {
  it("org-1 owner CAN access their own company", async () => {
    if (setupError) throw new Error(String(setupError));
    await expect(assertCompanyAccess(db, req(U1, ORG1, [CO1]), CO1)).resolves.toBeUndefined();
  });
  it("org-2 owner CANNOT access org-1's company (tenant IDOR denied)", async () => {
    await expect(assertCompanyAccess(db, req(U2, ORG2, [CO2]), CO1)).rejects.toThrow(/organization|access/i);
  });
  it("company list is org-scoped: org-2's principal never sees CO1", async () => {
    const visible = rows(await db.execute(sql`SELECT id FROM companies WHERE organization_id = ${ORG2}`)).map((r) => r.id);
    expect(visible).toContain(CO2);
    expect(visible).not.toContain(CO1);
  });
  it("a company_secrets row is only reachable via its own org", async () => {
    await db.execute(sql`INSERT INTO company_secrets (id, company_id, organization_id, name) VALUES (gen_random_uuid(), ${CO1}, ${ORG1}, 'k')`);
    const leak = rows(await db.execute(sql`SELECT count(*)::int AS c FROM company_secrets WHERE company_id = ${CO1} AND organization_id = ${ORG2}`));
    expect(leak[0].c).toBe(0);
  });
});
