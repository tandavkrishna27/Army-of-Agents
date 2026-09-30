// Staged cutover proof (multi-tenant cloud, C4): seed a PRE-0188 multi-user shape
// (users + companies + active company_memberships, NO org memberships), then run
// the 0195 member-backfill, then assert every prior (user,company) passes
// cloud_auth assertCompanyAccess (server/src/routes/authz.ts). Without the
// backfill each non-admin member 403s (Phase A); with it every pair resolves
// (Phase B). Harness = organizations-backfill.integration.test.ts; authz shape =
// assert-company-access-tenant.test.ts. Linux-only; Windows flip + revert.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  type Db,
  companyMemberships,
  organizationMemberships,
} from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { assertCompanyAccess } from "../routes/authz.js";
import { __resetTenantCache } from "../routes/authz-tenant.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

// Toggle: false proves Phase B fails without the backfill (RED); true = GREEN.
const RUN_BACKFILL = true;

// Keep in sync with 0195_provider_org_scoped_uniqueness.sql (member-backfill INSERT).
const MEMBER_BACKFILL_SQL = `
INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status", "joined_at")
SELECT DISTINCT c."organization_id", cm."principal_id", 'member', 'active', now()
FROM "company_memberships" cm
JOIN "companies" c ON c."id" = cm."company_id"
JOIN "user" u ON u."id" = cm."principal_id"
WHERE cm."principal_type" = 'user'
  AND cm."status" = 'active'
ON CONFLICT ("organization_id", "user_id") DO NOTHING`;

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as any).rows) as any[];

const ORG = DEFAULT_ORGANIZATION_ID;
// (user, company) pairs to seed. u1 spans two companies (exercises DISTINCT).
const SEED = [
  { user: "cut-u1", company: "co-a" },
  { user: "cut-u1", company: "co-b" },
  { user: "cut-u2", company: "co-a" },
];
const companyIds: Record<string, string> = {};

async function actorFor(userId: string) {
  const orgs = await db
    .select({ organizationId: organizationMemberships.organizationId })
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, "active")));
  const comps = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
    ));
  return {
    type: "board" as const,
    source: "session" as const,
    userId,
    organizationIds: orgs.map((r) => r.organizationId),
    companyIds: comps.map((r) => r.companyId),
  };
}

beforeAll(async () => {
  setDeploymentMode("cloud_auth");
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mt-cutover-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false });
    await pg.initialise();
    await pg.start();
    const url = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);

    // Seed the PRE-0188 multi-user shape via raw SQL (no service auto-creates an
    // org membership): users + companies on the sentinel org + active company
    // memberships, and deliberately NO organization_memberships.
    const users = [...new Set(SEED.map((s) => s.user))];
    for (const u of users) {
      await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (${u}, ${u}, ${u + "@x.invalid"}, now(), now())`);
    }
    const companies = [...new Set(SEED.map((s) => s.company))];
    let prefixSeq = 0;
    for (const c of companies) {
      const prefix = `C${prefixSeq++}X`;
      const id = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES (${c}, ${prefix}, ${ORG}) RETURNING id`))[0].id;
      companyIds[c] = id;
    }
    for (const { user, company } of SEED) {
      await db.execute(sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status) VALUES (${companyIds[company]}, 'user', ${user}, 'active')`);
    }
    __resetTenantCache();
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[mt-cutover-access] setup failed:", e);
  }
}, 180_000);

afterAll(async () => {
  setDeploymentMode("local_trusted");
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")("cutover: assertCompanyAccess after 0195 member backfill", () => {
  it("Phase A (regression): a non-admin member is denied BEFORE the backfill", async () => {
    if (setupError) throw new Error(String(setupError));
    const req = { actor: await actorFor("cut-u2") } as any;
    await expect(assertCompanyAccess(db, req, companyIds["co-a"])).rejects.toThrow();
  }, 90_000);

  it("Phase B: after the backfill, every prior (user,company) passes assertCompanyAccess", async () => {
    if (RUN_BACKFILL) {
      await db.execute(sql.raw(MEMBER_BACKFILL_SQL));
    }
    __resetTenantCache();
    for (const { user, company } of SEED) {
      const req = { actor: await actorFor(user) } as any;
      await expect(assertCompanyAccess(db, req, companyIds[company])).resolves.toBeUndefined();
    }
  }, 90_000);

  it("idempotent: re-running the backfill leaves each user with exactly one org membership", async () => {
    if (RUN_BACKFILL) {
      await db.execute(sql.raw(MEMBER_BACKFILL_SQL));
    }
    const c = rows(await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'cut-u1'`))[0].c;
    expect(c).toBe(RUN_BACKFILL ? 1 : 0);
  }, 90_000);
});
