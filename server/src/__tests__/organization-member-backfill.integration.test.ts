// Real-Postgres proof for the 0195 cutover member-backfill (multi-tenant cloud).
// 0188 seeded org membership ONLY for instance_admins. cloud_auth
// assertCompanyAccess (server/src/routes/authz.ts:71) needs BOTH an active org
// membership AND a company membership, so every NON-admin member would 403 after
// cutover. 0195 grants each active company member an 'active' 'member' row in the
// company's organization. This test seeds the pre-cutover shape (company members,
// NO org memberships) and re-runs the migration's INSERT verbatim (idempotent),
// exactly as migration-0189-backfill.integration.test.ts re-runs 0189's UPDATE.
//
// Linux-only (skipIf); Windows flip: skipIf(false) + initdbFlags, then revert.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as any).rows) as any[];

// Keep in sync with 0195_provider_org_scoped_uniqueness.sql (the member-backfill INSERT).
const MEMBER_BACKFILL_SQL = `
INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status", "joined_at")
SELECT DISTINCT c."organization_id", cm."principal_id", 'member', 'active', now()
FROM "company_memberships" cm
JOIN "companies" c ON c."id" = cm."company_id"
JOIN "user" u ON u."id" = cm."principal_id"
WHERE cm."principal_type" = 'user'
  AND cm."status" = 'active'
ON CONFLICT ("organization_id", "user_id") DO NOTHING`;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-0195-member-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false });
    await pg.initialise();
    await pg.start();
    const url = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[0195-member-backfill] setup failed:", e);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")("0195 member backfill", () => {
  const ORG = DEFAULT_ORGANIZATION_ID;
  const U_MEMBER = "u-nonadmin-1";
  const U_OWNER = "u-owner-1";

  it("grants every active company member an org 'member' row; keeps existing owners", async () => {
    if (setupError) throw new Error(String(setupError));

    // Seed the pre-cutover shape: users + a company on the sentinel org + active
    // company memberships, and NO org memberships for the non-admin member.
    await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (${U_MEMBER}, 'Member', 'm@x.invalid', now(), now())`);
    await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (${U_OWNER}, 'Owner', 'o@x.invalid', now(), now())`);
    const co = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('Cutover Co', 'CUT', ${ORG}) RETURNING id`))[0].id;
    await db.execute(sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status) VALUES (${co}, 'user', ${U_MEMBER}, 'active')`);
    await db.execute(sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status) VALUES (${co}, 'user', ${U_OWNER}, 'active')`);
    // U_OWNER already has an OWNER org membership (as 0188 would have seeded for an admin).
    await db.execute(sql`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES (${ORG}, ${U_OWNER}, 'owner', 'active')`);

    // Sanity: the non-admin member has NO org membership yet.
    const before = rows(await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = ${U_MEMBER}`));
    expect(before[0].c).toBe(0);

    // Run the migration's backfill statement verbatim.
    await db.execute(sql.raw(MEMBER_BACKFILL_SQL));

    // The non-admin member is now an ACTIVE 'member' of the org.
    const member = rows(await db.execute(sql`SELECT role, status FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = ${U_MEMBER}`));
    expect(member).toHaveLength(1);
    expect(member[0].role).toBe("member");
    expect(member[0].status).toBe("active");

    // The pre-existing owner is NOT downgraded (ON CONFLICT DO NOTHING).
    const owner = rows(await db.execute(sql`SELECT role FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = ${U_OWNER}`));
    expect(owner).toHaveLength(1);
    expect(owner[0].role).toBe("owner");
  }, 90_000);

  it("is idempotent: a second run creates no duplicate rows", async () => {
    await db.execute(sql.raw(MEMBER_BACKFILL_SQL));
    const member = rows(await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = ${U_MEMBER}`));
    expect(member[0].c).toBe(1);
  }, 90_000);
});
