import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  companyMemberships,
  organizationMemberships,
  type Db,
} from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { createSelfServeOrganization } from "../services/organizations.js";
import { organizationAccessService, orgRoleCan } from "../services/organization-access.js";
import { companyService } from "../services/companies.js";
import { accessService } from "../services/access.js";
import { teamService } from "../services/team.js";
import {
  approveHumanJoinRequestTx,
  buildHumanJoinApprovalServices,
  founderApprovalIdentity,
} from "../services/join-approval.js";
import { assertCompanyAccess } from "../routes/authz.js";
import {
  resolveCompanyOrganizationId,
  assertCompanyCreateAuthorized,
} from "../routes/companies.js";
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

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: any[] }).rows) as any[];

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

let A = "", B = "";
let orgA = "", orgB = "";
let a1 = "", a2 = "", b1 = "", b2 = "";
let a2OrgId = "", b1OrgId = "";

/** Rebuild an actor's memberships with the SAME queries the auth middleware runs
 *  (server/src/middleware/auth.ts:67-85) — plus the org role for Fix 2's filter. */
async function rebuildActor(userId: string) {
  const orgRows = await db
    .select({
      organizationId: organizationMemberships.organizationId,
      role: organizationMemberships.role,
    })
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, "active")));
  const companyRows = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    );
  // TEST-LOCAL map: the real auth middleware (middleware/auth.ts) populates only
  // organizationIds/companyIds on req.actor, NOT a per-org role map. This exists
  // solely so the test can mirror Fix 2's UI-side create-capable filter (orgRoleCan).
  // assertCompanyAccess / assertCompanyCreateAuthorized do NOT read it — the latter
  // is DB-authoritative via organizationAccessService.canOrg.
  const organizationRoles: Record<string, string> = {};
  for (const r of orgRows) organizationRoles[r.organizationId] = r.role as string;
  return {
    type: "board" as const,
    source: "session" as const,
    userId,
    organizationIds: orgRows.map((r) => r.organizationId),
    organizationRoles,
    companyIds: companyRows.map((r) => r.companyId),
  };
}

/** Seed invite + pending join_request, then admit via the REAL chokepoint
 *  (writes BOTH company + org membership — join-approval.ts:210,217-219). */
async function admitViaInvite(companyId: string, joiningUserId: string, approverUserId: string) {
  const inviteId = rows(
    await db.execute(sql`
      INSERT INTO invites (company_id, invite_type, token_hash, allowed_join_types, defaults_payload, expires_at)
      VALUES (${companyId}, 'company_join', ${randomUUID()}, 'both', NULL, now() + interval '7 days')
      RETURNING id`),
  )[0].id as string;
  const requestId = rows(
    await db.execute(sql`
      INSERT INTO join_requests (invite_id, company_id, request_type, status, request_ip, requesting_user_id)
      VALUES (${inviteId}, ${companyId}, 'human', 'pending_approval', '127.0.0.1', ${joiningUserId})
      RETURNING id`),
  )[0].id as string;
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    return approveHumanJoinRequestTx(txDb, buildHumanJoinApprovalServices(txDb), {
      companyId,
      requestId,
      requestingUserId: joiningUserId,
      invite: { id: inviteId, defaultsPayload: null },
      ...founderApprovalIdentity({ actorUserId: approverUserId, localImplicit: false }),
    });
  });
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mt-4actor-"));
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
      // Baked in so the suite runs locally on Windows by flipping the
      // describe.skipIf below to `false`. Harmless on Linux CI.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const conn = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(conn);
    db = createDb(conn);
    setDeploymentMode("cloud_auth");

    const access = accessService(db);

    // 1) Two real auth users. "user".created_at/updated_at NOT NULL, no default.
    A = rows(
      await db.execute(sql`INSERT INTO "user" (id, email, name, created_at, updated_at)
        VALUES (gen_random_uuid()::text, 'founder-a@x.io', 'Founder A', now(), now()) RETURNING id`),
    )[0].id;
    B = rows(
      await db.execute(sql`INSERT INTO "user" (id, email, name, created_at, updated_at)
        VALUES (gen_random_uuid()::text, 'founder-b@x.io', 'Founder B', now(), now()) RETURNING id`),
    )[0].id;

    // 2) A self-serves org A, then creates A1 + A2 via the REAL service path.
    //    resolveCompanyOrganizationId (single-org actor) picks orgA, not the
    //    sentinel (companies.ts:49). ensureRealOperator mirrors POST /companies:240.
    orgA = (await createSelfServeOrganization(db, { name: "Org A", ownerUserId: A }, organizationAccessService)).organization.id;
    a1 = (
      await companyService(db).create({
        name: "A One",
        organizationId: resolveCompanyOrganizationId({}, { enforced: true, actorOrganizationIds: [orgA] }),
      })
    ).id;
    await access.ensureRealOperator(a1, A);
    const a2Company = await companyService(db).create({
      name: "A Two",
      organizationId: resolveCompanyOrganizationId({}, { enforced: true, actorOrganizationIds: [orgA] }),
    });
    a2 = a2Company.id;
    a2OrgId = a2Company.organizationId as string;
    await access.ensureRealOperator(a2, A);

    // 3) B mirrors.
    orgB = (await createSelfServeOrganization(db, { name: "Org B", ownerUserId: B }, organizationAccessService)).organization.id;
    const b1Company = await companyService(db).create({ name: "B One", organizationId: orgB });
    b1 = b1Company.id;
    b1OrgId = b1Company.organizationId as string;
    await access.ensureRealOperator(b1, B);
    b2 = (await companyService(db).create({ name: "B Two", organizationId: orgB })).id;
    await access.ensureRealOperator(b2, B);

    // 4) Cross-invite through the real approval path.
    await admitViaInvite(a1, B, A);
    await admitViaInvite(b1, A, B);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[mt-four-actor-journey] setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

// COMMITTED: Linux CI only (Issue #114). Windows-local: flip to skipIf(false),
// run, flip back before committing.
describe.skipIf(process.platform !== "linux")(
  "4-actor multi-tenant journey (cloud_auth, real embedded PG)",
  () => {
    it("boots embedded PG and seeds the two-founder / four-company fixture", () => {
      if (setupError) throw new Error(String(setupError));
      expect([A, B, orgA, orgB, a1, a2, b1, b2].every(Boolean)).toBe(true);
      expect(orgA).not.toBe(orgB);
    });

    it("stamps each company's organizationId to its intended org (A2 is orgA, not the sentinel)", () => {
      if (setupError) throw new Error(String(setupError));
      expect(a2OrgId).toBe(orgA);
      expect(a2OrgId).not.toBe(DEFAULT_ORGANIZATION_ID);
      expect(b1OrgId).toBe(orgB);
      expect(b1OrgId).not.toBe(DEFAULT_ORGANIZATION_ID);
    });

    it("rebuilt cross-invited actors carry both orgs with the correct roles", async () => {
      if (setupError) throw new Error(String(setupError));
      const a = await rebuildActor(A);
      const b = await rebuildActor(B);
      expect(new Set(a.organizationIds)).toEqual(new Set([orgA, orgB]));
      expect(a.organizationRoles).toEqual({ [orgA]: "owner", [orgB]: "member" });
      expect(new Set(b.organizationIds)).toEqual(new Set([orgA, orgB]));
      expect(b.organizationRoles).toEqual({ [orgB]: "owner", [orgA]: "member" });
    });

    it("company boundary: A opens B's invited company but 403s on B's other company", async () => {
      if (setupError) throw new Error(String(setupError));
      const a = await rebuildActor(A);
      const reqA = { actor: a } as any;
      await expect(assertCompanyAccess(db, reqA, b1)).resolves.toBeUndefined();
      await expect(assertCompanyAccess(db, reqA, b2)).rejects.toThrow(/access/i);
    });

    it("Fix 2: create-another-company resolves to A's own create-capable org with no 403", async () => {
      if (setupError) throw new Error(String(setupError));
      const a = await rebuildActor(A);
      const createCapable = a.organizationIds.filter((id) =>
        orgRoleCan(a.organizationRoles[id] as any, "company:create"),
      );
      expect(createCapable).toEqual([orgA]);
      expect(() =>
        resolveCompanyOrganizationId({}, { enforced: true, actorOrganizationIds: a.organizationIds }),
      ).toThrow(/multiple organizations/i);
      const orgId = resolveCompanyOrganizationId(
        { organizationId: createCapable[0] },
        { enforced: true, actorOrganizationIds: a.organizationIds },
      );
      expect(orgId).toBe(orgA);
      await expect(
        assertCompanyCreateAuthorized(organizationAccessService(db), orgId, A),
      ).resolves.toBeUndefined();
      expect(await organizationAccessService(db).canOrg(orgB, A, "company:create")).toBe(false);
      const a3 = await companyService(db).create({ name: "A Three", organizationId: orgId });
      expect(a3.organizationId).toBe(orgA);
    });

    it("Fix 1: direct add-member is rejected in cloud; the invite path grants access", async () => {
      if (setupError) throw new Error(String(setupError));
      const b = await rebuildActor(B);
      await expect(assertCompanyAccess(db, { actor: b } as any, a1)).resolves.toBeUndefined();
      await expect(
        teamService(db).addMember(
          a1,
          { name: "Direct Add", email: "direct-add@x.io", role: "team_member" },
          A,
        ),
      ).rejects.toThrow(/invite/i);
    });
  },
);
