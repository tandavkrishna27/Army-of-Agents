/**
 * D2 (H2 + H3) — real-DB integration proof.
 *
 *  H2: importing agents into an EXISTING company must NOT promote the caller.
 *      The caller keeps their member role; the restored org agent parents to the
 *      company's pre-existing human founder.
 *  H3: a new_company import lands in the resolved Organization (opts.organizationId)
 *      or the DEFAULT sentinel when none is threaded (self-hosted), and the importer
 *      is provisioned with company owner membership + founder role + org owner
 *      membership (no self-lockout).
 *
 * Skipped on Windows (embedded-postgres / migration chain — Issue #114). Mirrors
 * w6-org-reporting.integration.test.ts — PREFER reusing that file's seed helpers
 * over the hand-rolled SQL here (see the reviewer note above).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID, type CompanyPortabilityManifest } from "@armyofagents/shared";
import { orgHierarchyService } from "../services/org-hierarchy.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";
import { getDeploymentMode, setDeploymentMode } from "../config/deployment-mode.js";
import { __resetTenantCache } from "../routes/authz-tenant.js";

type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: Pg | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const PORT = 58300 + Math.floor(Math.random() * 1000);

function rows<T = Record<string, unknown>>(r: unknown): T[] {
  return (Array.isArray(r) ? r : (r as { rows?: T[] }).rows ?? []) as T[];
}
function firstId(r: unknown): string {
  const id = rows<{ id: string }>(r)[0]?.id;
  if (!id) throw new Error("firstId: no id returned");
  return id;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-d2-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: new (o: object) => Pg;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      // Baked in so the suite runs locally on Windows by flipping the
      // describe.skipIf below to `false`. Harmless on Linux CI.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const cs = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(cs);
    db = createDb(cs);
  } catch (err) {
    setupError = err;
    console.error("[d2-integration] setup failed:", err);
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

async function seedUser(email: string): Promise<string> {
  return firstId(
    await db.execute(
      sql`INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at)
          VALUES (gen_random_uuid()::text, ${email}, 'U', false, now(), now()) RETURNING id`,
    ),
  );
}

async function seedCompanyWithFounder(): Promise<{ companyId: string; founderId: string }> {
  const companyId = firstId(
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix)
          VALUES (gen_random_uuid(), 'D2 Co', upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)))
          RETURNING id`,
    ),
  );
  const founderId = await seedUser(`f-${companyId.slice(0, 8)}@d2.test`);
  await db.execute(
    sql`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at)
        VALUES (gen_random_uuid(), ${companyId}, 'user', ${founderId}, 'owner', 'active', now(), now())`,
  );
  await db.execute(
    sql`INSERT INTO user_roles (id, company_id, user_id, role) VALUES (gen_random_uuid(), ${companyId}, ${founderId}, 'founder')`,
  );
  return { companyId, founderId };
}

async function seedOrg(): Promise<string> {
  return firstId(
    await db.execute(
      sql`INSERT INTO organizations (id, name, slug, status, plan)
          VALUES (gen_random_uuid(), 'D2 Org', ${"d2-" + Math.random().toString(36).slice(2, 10)}, 'active', 'beta')
          RETURNING id`,
    ),
  );
}

function agentBundleSource(companyName: string) {
  const manifest: CompanyPortabilityManifest = {
    schemaVersion: 2,
    generatedAt: "2026-07-31T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: true },
    company: {
      path: "COMPANY.md",
      name: companyName,
      description: null,
      brandColor: null,
      requireBoardApprovalForNewAgents: true,
    },
    agents: [
      {
        slug: "atlas",
        name: "Atlas",
        path: "agents/atlas/AGENTS.md",
        role: "Engineer",
        title: null,
        icon: null,
        capabilities: null,
        reportsToSlug: null,
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        metadata: null,
      },
    ],
    requiredSecrets: [],
  } as unknown as CompanyPortabilityManifest;
  return {
    type: "inline" as const,
    manifest,
    files: {
      "COMPANY.md": `---\nkind: company\nname: ${companyName}\n---\n`,
      "agents/atlas/AGENTS.md": "---\nname: Atlas\nslug: atlas\n---\nDo the thing.\n",
    },
  };
}

/** Seed an additional company user carrying a single company-scoped role. */
async function seedActorWithRole(
  companyId: string,
  role: "founder" | "team_lead" | "team_member",
): Promise<string> {
  const userId = await seedUser(
    `${role}-${companyId.slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}@d2.test`,
  );
  await db.execute(
    sql`INSERT INTO user_roles (id, company_id, user_id, role) VALUES (gen_random_uuid(), ${companyId}, ${userId}, ${role})`,
  );
  return userId;
}

/** Mount POST /import against the REAL db as a cloud_auth board actor. The actor's
 *  org/company membership is asserted from req.actor (mirrors middleware/auth.ts),
 *  while the ROLE the gate reads is resolved from the seeded user_roles rows — so
 *  the role gate is the only variable under test. Company lives in the DEFAULT org
 *  (seedCompanyWithFounder omits organization_id → column default sentinel). */
function makeImportApp(actorUserId: string, companyId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = {
      type: "board",
      source: "session",
      userId: actorUserId,
      organizationIds: [DEFAULT_ORGANIZATION_ID],
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
    (req as { tenant: unknown }).tenant = { organizationId: null };
    next();
  });
  app.use("/api/companies", companyRoutes(db, { deploymentMode: "cloud_auth" }));
  app.use(errorHandler);
  return app;
}

/** Company-only existing-company import. requireBoardApprovalForNewAgents=false is
 *  the concrete escalation payload a plain member must not be able to apply. */
function companyOnlyImportBody(companyId: string) {
  return {
    source: {
      type: "inline" as const,
      manifest: {
        schemaVersion: 2,
        generatedAt: "2026-07-31T00:00:00.000Z",
        source: null,
        includes: { company: true, agents: false },
        company: {
          path: "COMPANY.md",
          name: "Imported",
          description: null,
          brandColor: null,
          requireBoardApprovalForNewAgents: false,
        },
        agents: [],
        requiredSecrets: [],
      },
      files: {},
    },
    include: { company: true, agents: false },
    target: { mode: "existing_company" as const, companyId },
  };
}

/** internal_agent_config existing-company import — a FOUNDER-only section. */
function internalAgentConfigImportBody(companyId: string) {
  return {
    source: {
      type: "inline" as const,
      manifest: {
        schemaVersion: 2,
        generatedAt: "2026-07-31T00:00:00.000Z",
        source: null,
        includes: { company: false, agents: false, internalAgentConfig: true },
        company: null,
        agents: [],
        internalAgentConfig: {
          executionMode: "cli",
          provider: null,
          model: null,
          cliTool: null,
          autonomyLevel: 1,
          crewAutonomyLevel: 1,
          enabledCapabilities: [],
          notificationPreference: "all",
          contextTokenBudget: 8000,
          budgetMonthlyCents: null,
          proactiveIntervalMinutes: 30,
          metadata: {},
        },
        requiredSecrets: [],
      },
      files: {},
    },
    include: { company: false, agents: false, internalAgentConfig: true },
    target: { mode: "existing_company" as const, companyId },
  };
}

describe.skipIf(process.platform === "win32")("D2 import authz — real DB", () => {
  it("setup harness boots", () => {
    if (setupError) throw new Error(String(setupError));
    expect(db).toBeTruthy();
  });

  it("H2: importing agents into an existing company does NOT promote the caller", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();

    // A non-founder member (the malicious/mistaken importer).
    const memberId = await seedUser(`m-${companyId.slice(0, 8)}@d2.test`);
    await db.execute(
      sql`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at)
          VALUES (gen_random_uuid(), ${companyId}, 'user', ${memberId}, 'member', 'active', now(), now())`,
    );
    await db.execute(
      sql`INSERT INTO user_roles (id, company_id, user_id, role) VALUES (gen_random_uuid(), ${companyId}, ${memberId}, 'team_member')`,
    );

    const result = await companyPortabilityService(db).importBundle(
      {
        source: agentBundleSource("D2 Co"),
        target: { mode: "existing_company", companyId },
        include: { company: false, agents: true },
      } as never,
      memberId, // actorUserId = the member
    );

    // (a) the caller was NOT granted a founder role.
    const founderRows = rows(
      await db.execute(
        sql`SELECT id FROM user_roles WHERE company_id = ${companyId} AND user_id = ${memberId} AND role = 'founder'`,
      ),
    );
    expect(founderRows.length).toBe(0);

    // (b) the caller's company membership was NOT upgraded to owner.
    const memRole = rows<{ membership_role: string }>(
      await db.execute(
        sql`SELECT membership_role FROM company_memberships WHERE company_id = ${companyId} AND principal_type = 'user' AND principal_id = ${memberId}`,
      ),
    )[0]?.membership_role;
    expect(memRole).toBe("member");

    // (c) the caller was NOT made an org owner (company is in the DEFAULT org).
    const orgMem = rows(
      await db.execute(
        sql`SELECT id FROM organization_memberships WHERE organization_id = ${DEFAULT_ORGANIZATION_ID} AND user_id = ${memberId}`,
      ),
    );
    expect(orgMem.length).toBe(0);

    // (d) the restored org agent parents to the PRE-EXISTING founder, not the caller.
    const created = result.agents.find((a) => a.slug === "atlas");
    expect(created?.id).toBeTruthy();
    const parent = rows<{ parent_type: string; parent_id: string }>(
      await db.execute(sql`SELECT parent_type, parent_id FROM agents WHERE id = ${created!.id}`),
    )[0];
    expect(parent.parent_type).toBe("user");
    expect(parent.parent_id).toBe(founderId);
    expect(await orgHierarchyService(db).getFounderUserId(companyId)).toBe(founderId);
  });

  it("H3: new_company import lands in the threaded org + provisions the importer (no lockout)", async () => {
    if (setupError) throw new Error(String(setupError));
    const orgId = await seedOrg();
    const importerId = await seedUser(`imp-${orgId.slice(0, 8)}@d2.test`);

    const result = await companyPortabilityService(db).importBundle(
      {
        source: agentBundleSource("Imported D2 Co"),
        target: { mode: "new_company", newCompanyName: "Imported D2 Co" },
        include: { company: true, agents: true },
      } as never,
      importerId,
      undefined,
      { organizationId: orgId },
    );

    const companyId = result.company.id;
    expect(result.company.action).toBe("created");

    // (a) company placed in the threaded org (NOT the DEFAULT sentinel).
    const orgOnCompany = rows<{ organization_id: string }>(
      await db.execute(sql`SELECT organization_id FROM companies WHERE id = ${companyId}`),
    )[0]?.organization_id;
    expect(orgOnCompany).toBe(orgId);

    // (b) importer got founder role + owner company membership + org owner membership.
    expect(
      rows(
        await db.execute(
          sql`SELECT id FROM user_roles WHERE company_id = ${companyId} AND user_id = ${importerId} AND role = 'founder'`,
        ),
      ).length,
    ).toBe(1);
    expect(
      rows(
        await db.execute(
          sql`SELECT id FROM company_memberships WHERE company_id = ${companyId} AND principal_type = 'user' AND principal_id = ${importerId} AND membership_role = 'owner' AND status = 'active'`,
        ),
      ).length,
    ).toBe(1);
    expect(
      rows(
        await db.execute(
          sql`SELECT id FROM organization_memberships WHERE organization_id = ${orgId} AND user_id = ${importerId} AND role = 'owner'`,
        ),
      ).length,
    ).toBe(1);
  });

  it("H3 self-hosted: new_company import with no threaded org lands in the DEFAULT sentinel", async () => {
    if (setupError) throw new Error(String(setupError));
    const result = await companyPortabilityService(db).importBundle(
      {
        source: agentBundleSource("Self Hosted D2 Co"),
        target: { mode: "new_company", newCompanyName: "Self Hosted D2 Co" },
        include: { company: true, agents: true },
      } as never,
      null, // self-hosted board (no user)
    );
    const orgOnCompany = rows<{ organization_id: string }>(
      await db.execute(sql`SELECT organization_id FROM companies WHERE id = ${result.company.id}`),
    )[0]?.organization_id;
    expect(orgOnCompany).toBe(DEFAULT_ORGANIZATION_ID);
  });

  // D2 (privilege-escalation hardening) — route-level proof through the REAL
  // POST /import handler (assertBoard → assertCompanyAccess → assertRole →
  // importBundle) against embedded PG. Proves the now-reachable escalation is
  // closed: a plain team_member can no longer overwrite company governance by
  // importing a bundle into a company they merely belong to.
  describe("POST /import — existing-company role gate (cloud_auth)", () => {
    let prevMode = getDeploymentMode();
    beforeAll(() => {
      prevMode = getDeploymentMode();
      setDeploymentMode("cloud_auth");
    });
    afterAll(() => {
      setDeploymentMode(prevMode);
      __resetTenantCache();
    });

    it("team_member is 403 importing company settings (blanket founder/team_lead gate)", async () => {
      if (setupError) throw new Error(String(setupError));
      const { companyId } = await seedCompanyWithFounder();
      const member = await seedActorWithRole(companyId, "team_member");
      const res = await request(makeImportApp(member, companyId))
        .post("/api/companies/import")
        .send(companyOnlyImportBody(companyId));
      expect(res.status).toBe(403);
    });

    it("founder may import company settings into an existing company", async () => {
      if (setupError) throw new Error(String(setupError));
      const { companyId, founderId } = await seedCompanyWithFounder();
      const res = await request(makeImportApp(founderId, companyId))
        .post("/api/companies/import")
        .send(companyOnlyImportBody(companyId));
      expect(res.status).toBe(200);
    });

    it("team_lead may import company settings into an existing company", async () => {
      if (setupError) throw new Error(String(setupError));
      const { companyId } = await seedCompanyWithFounder();
      const lead = await seedActorWithRole(companyId, "team_lead");
      const res = await request(makeImportApp(lead, companyId))
        .post("/api/companies/import")
        .send(companyOnlyImportBody(companyId));
      expect(res.status).toBe(200);
    });

    it("team_lead is 403 importing internal_agent_config (founder-only section)", async () => {
      if (setupError) throw new Error(String(setupError));
      const { companyId } = await seedCompanyWithFounder();
      const lead = await seedActorWithRole(companyId, "team_lead");
      const res = await request(makeImportApp(lead, companyId))
        .post("/api/companies/import")
        .send(internalAgentConfigImportBody(companyId));
      expect(res.status).toBe(403);
    });

    it("founder may import internal_agent_config into an existing company", async () => {
      if (setupError) throw new Error(String(setupError));
      const { companyId, founderId } = await seedCompanyWithFounder();
      const res = await request(makeImportApp(founderId, companyId))
        .post("/api/companies/import")
        .send(internalAgentConfigImportBody(companyId));
      expect(res.status).toBe(200);
    });
  });
});
