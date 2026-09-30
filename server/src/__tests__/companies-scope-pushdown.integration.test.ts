/**
 * Real-DB integration test for companyService.list()/stats() tenant push-down
 * (Fix 4). Proves the allowed-company set is filtered in SQL:
 *   (i)   a scoped caller sees only their companies + counts,
 *   (ii)  the operator (undefined allow-set) sees ALL,
 *   (iii) an empty allow-set returns NONE.
 *
 * Boots embedded-postgres, applies all migrations, seeds two companies with
 * distinct agent/issue/approval/notification rows, exercises the service.
 *
 * Skipped off Linux (embedded-postgres / migration-chain, Issue #114); Linux CI
 * is the authoritative gate. `initdbFlags` are baked into the EmbeddedPostgres
 * ctor (committed), so the suite is Windows-runnable by temporarily flipping
 * `describe.skipIf(process.platform !== "linux")` to `describe.skipIf(false)`
 * (do NOT commit that edit), then reverting.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { actorMiddleware } from "../middleware/auth.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean; initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let svc: ReturnType<typeof companyService>;
let setupError: unknown = null;

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as any)?.id;
  return (result as any).rows?.[0]?.id;
}

/** Drive the REAL auth middleware (no bearer → session path) to build req.actor
 *  the same way production does, then hand back the resolved actor. Used to
 *  prove the companyIds builder intersects company membership with active-org
 *  ownership in cloud_auth. */
function buildActorViaMiddleware(userId: string): Promise<any> {
  const mw = actorMiddleware(db, {
    deploymentMode: "cloud_auth",
    resolveSession: async () => ({ user: { id: userId } }) as any,
  });
  return new Promise((resolve, reject) => {
    const req: any = { header: () => undefined, method: "GET", originalUrl: "/api/companies" };
    const ret = mw(req, {} as any, (err?: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(req.actor);
    });
    Promise.resolve(ret).catch(reject);
  });
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-companies-scope-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    // Collision-safe port allocation (house helper) — the fixed-random ranges the
    // other integration suites used to hold overlap, causing EADDRINUSE flakes
    // under vitest's parallel file pool.
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
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    svc = companyService(db);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[companies-scope-integration] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")(
  "companyService list()/stats() — real DB tenant push-down",
  () => {
    let companyAId: string;
    let companyBId: string;

    it("setup: seeds two companies with distinct rollup rows", async () => {
      if (setupError) {
        throw new Error(
          `embedded-postgres setup failed; cannot run integration test: ${String(setupError)}`,
        );
      }
      companyAId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO companies (organization_id, id, name, issue_prefix) VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Scope Co A', 'SCA') RETURNING id
      `));
      companyBId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO companies (organization_id, id, name, issue_prefix) VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Scope Co B', 'SCB') RETURNING id
      `));
      expect(companyAId).toBeTruthy();
      expect(companyBId).toBeTruthy();

      // Company A: 1 org agent, 1 unassigned (→ non-crew) issue, 1 pending
      // approval (status defaults 'pending'), 1 unread notification (read_at null).
      await db.execute(sql`INSERT INTO agents (id, company_id, name, kind) VALUES (gen_random_uuid(), ${companyAId}, 'A-agent', 'org')`);
      await db.execute(sql`INSERT INTO issues (id, company_id, title) VALUES (gen_random_uuid(), ${companyAId}, 'A task')`);
      await db.execute(sql`INSERT INTO approvals (id, company_id, type, payload) VALUES (gen_random_uuid(), ${companyAId}, 'test', '{}'::jsonb)`);
      await db.execute(sql`INSERT INTO notifications (id, company_id, user_id, type, title) VALUES (gen_random_uuid(), ${companyAId}, 'u', 'test', 'A note')`);

      // Company B: 2 org agents, 3 issues — distinct counts, 0 approvals/notifications.
      await db.execute(sql`INSERT INTO agents (id, company_id, name, kind) VALUES (gen_random_uuid(), ${companyBId}, 'B-agent-1', 'org')`);
      await db.execute(sql`INSERT INTO agents (id, company_id, name, kind) VALUES (gen_random_uuid(), ${companyBId}, 'B-agent-2', 'org')`);
      await db.execute(sql`INSERT INTO issues (id, company_id, title) VALUES (gen_random_uuid(), ${companyBId}, 'B task 1')`);
      await db.execute(sql`INSERT INTO issues (id, company_id, title) VALUES (gen_random_uuid(), ${companyBId}, 'B task 2')`);
      await db.execute(sql`INSERT INTO issues (id, company_id, title) VALUES (gen_random_uuid(), ${companyBId}, 'B task 3')`);
    });

    it("list([A]) returns only company A (invariant i: caller sees only their own)", async () => {
      if (setupError) throw new Error(String(setupError));
      const rows = await svc.list([companyAId]);
      expect(rows.map((c: any) => c.id)).toEqual([companyAId]);
    });

    it('list("unscoped") returns ALL companies (invariant ii: operator sees all)', async () => {
      if (setupError) throw new Error(String(setupError));
      const ids = (await svc.list("unscoped")).map((c: any) => c.id);
      expect(ids).toContain(companyAId);
      expect(ids).toContain(companyBId);
    });

    it("list([]) returns none (invariant iii: empty allow-set → degrade-to-none)", async () => {
      if (setupError) throw new Error(String(setupError));
      const rows = await svc.list([]);
      expect(rows).toEqual([]);
    });

    it("stats([A]) counts only company A", async () => {
      if (setupError) throw new Error(String(setupError));
      const stats = await svc.stats([companyAId]);
      expect(Object.keys(stats)).toEqual([companyAId]);
      expect(stats[companyAId]).toEqual({
        agentCount: 1,
        issueCount: 1,
        pendingApprovalCount: 1,
        unreadNotificationCount: 1,
      });
    });

    it("stats([A,B]) counts both companies with per-tenant rollups", async () => {
      if (setupError) throw new Error(String(setupError));
      const stats = await svc.stats([companyAId, companyBId]);
      expect(stats[companyAId].agentCount).toBe(1);
      expect(stats[companyBId].agentCount).toBe(2);
      expect(stats[companyBId].issueCount).toBe(3);
    });

    it('stats("unscoped") counts ALL companies (invariant ii: operator sees all)', async () => {
      if (setupError) throw new Error(String(setupError));
      const stats = await svc.stats("unscoped");
      expect(stats[companyAId]).toBeDefined();
      expect(stats[companyBId]).toBeDefined();
    });

    it("stats([]) returns {} (invariant iii: empty allow-set → degrade-to-none)", async () => {
      if (setupError) throw new Error(String(setupError));
      const stats = await svc.stats([]);
      expect(stats).toEqual({});
    });
  },
);

// Bug: /companies (GET) + /companies/stats scope by req.actor.companyIds, which
// the auth middleware built from company_memberships ALONE — unlike
// assertCompanyAccess (routes/authz.ts), which in cloud_auth requires BOTH org
// AND company membership. An org-membership revocation (or imperfect backfill)
// would therefore leak company metadata + stats the detail endpoint correctly
// 403s. This suite drives the REAL middleware to prove companyIds is scoped to
// active-org ownership, closing that half-invariant at the source.
describe.skipIf(process.platform !== "linux")(
  "auth middleware companyIds builder — active-org intersection (cloud_auth)",
  () => {
    let orgOId = "";
    let companyCId = "";
    let userCompanyOnly = ""; // active company membership, NO active org membership
    let userBoth = ""; // active company membership AND active org membership

    beforeAll(() => {
      if (!setupError) setDeploymentMode("cloud_auth");
    });
    afterAll(() => {
      // Restore the module default so nothing downstream inherits cloud_auth.
      setDeploymentMode("local_trusted");
    });

    it("setup: seeds an org-owned company with a company-member who is NOT an org member", async () => {
      if (setupError) throw new Error(String(setupError));
      orgOId = firstId(await db.execute(sql`
        INSERT INTO organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Iso Org', 'iso-org') RETURNING id`));
      companyCId = firstId(await db.execute(sql`
        INSERT INTO companies (id, name, issue_prefix, organization_id)
        VALUES (gen_random_uuid(), 'Iso Co C', 'ISC', ${orgOId}) RETURNING id`));

      // User with an ACTIVE company membership for C but NO org membership.
      userCompanyOnly = firstId(await db.execute(sql`
        INSERT INTO "user" (id, email, name, created_at, updated_at)
        VALUES (gen_random_uuid()::text, 'iso-company-only@x.io', 'Iso CompanyOnly', now(), now()) RETURNING id`));
      await db.execute(sql`
        INSERT INTO company_memberships (id, company_id, principal_type, principal_id, status)
        VALUES (gen_random_uuid(), ${companyCId}, 'user', ${userCompanyOnly}, 'active')`);

      // User with BOTH an active company membership for C AND active org membership for O.
      userBoth = firstId(await db.execute(sql`
        INSERT INTO "user" (id, email, name, created_at, updated_at)
        VALUES (gen_random_uuid()::text, 'iso-both@x.io', 'Iso Both', now(), now()) RETURNING id`));
      await db.execute(sql`
        INSERT INTO company_memberships (id, company_id, principal_type, principal_id, status)
        VALUES (gen_random_uuid(), ${companyCId}, 'user', ${userBoth}, 'active')`);
      await db.execute(sql`
        INSERT INTO organization_memberships (id, organization_id, user_id, role, status)
        VALUES (gen_random_uuid(), ${orgOId}, ${userBoth}, 'member', 'active')`);

      expect([orgOId, companyCId, userCompanyOnly, userBoth].every(Boolean)).toBe(true);
    });

    it("company member WITHOUT active org membership is excluded from companyIds + list + stats (RED before fix)", async () => {
      if (setupError) throw new Error(String(setupError));
      const actor = await buildActorViaMiddleware(userCompanyOnly);
      // Not an active member of C's owning org.
      expect(actor.organizationIds ?? []).not.toContain(orgOId);
      // The bug leaks C here (companyIds built from company_memberships alone).
      expect(actor.companyIds ?? []).not.toContain(companyCId);
      // list()/stats() scope by companyIds — so C must not surface via either.
      const listed = (await svc.list(actor.companyIds ?? [])).map((c: any) => c.id);
      expect(listed).not.toContain(companyCId);
      const stats = await svc.stats(actor.companyIds ?? []);
      expect(stats[companyCId]).toBeUndefined();
    });

    it("company member WITH active org membership keeps the company in companyIds + list (positive)", async () => {
      if (setupError) throw new Error(String(setupError));
      const actor = await buildActorViaMiddleware(userBoth);
      expect(actor.organizationIds ?? []).toContain(orgOId);
      expect(actor.companyIds ?? []).toContain(companyCId);
      const listed = (await svc.list(actor.companyIds ?? [])).map((c: any) => c.id);
      expect(listed).toContain(companyCId);
    });
  },
);
