import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ORGANIZATION_ID, type DeploymentMode } from "@armyofagents/shared";
import { setDeploymentMode } from "../config/deployment-mode.js";

const importBundle = vi.hoisted(() => vi.fn());
const canOrg = vi.hoisted(() => vi.fn());
const getEffectiveRole = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  companyPortabilityService: () => ({ importBundle }),
  accessService: () => ({ ensureMembership: vi.fn(), ensureRealOperator: vi.fn() }),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/organization-access.js", () => ({
  organizationAccessService: () => ({ canOrg }),
}));
// assertCompanyAccess (cloud_auth branch) resolves the company's tenant from the
// DB; with the mock db ({}) that path would 500 before the existing_company
// import ever reaches the importsAgents gate under test. Return the actor's org
// so the membership check (orgs.includes(tenantId) && companyIds.includes(id))
// passes. vi.clearAllMocks() preserves these implementations (it clears call
// history only), so the resolver survives per-test resets. ORG_1 inlined
// because vi.mock is hoisted above the top-level const declarations.
vi.mock("../routes/authz-tenant.js", () => ({
  resolveCompanyTenant: vi.fn(async () => "00000000-0000-0000-0000-0000000000a1"),
  resolveStorageTenant: vi.fn(async () => "00000000-0000-0000-0000-0000000000a1"),
  assertTenantMembership: vi.fn(),
  invalidateCompanyTenant: vi.fn(),
  __resetTenantCache: vi.fn(),
}));
// assertRole -> permissionService(db).getEffectiveRole. db is {} in these route
// tests, so mock the permission service module the rbac middleware imports.
vi.mock("../services/permissions.js", () => ({
  permissionService: () => ({ getEffectiveRole }),
}));
// POST /import never calls these (they are POST / seeders) — stub anyway so
// module load never touches real implementations.
vi.mock("../services/internal-agent/aoa-skills-seeder.js", () => ({
  seedAoaNativeSkills: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/team.js", () => ({
  materializeCompanyProfileFromGlobal: vi.fn().mockResolvedValue(undefined),
  ensureCompanyProfileFromGlobal: vi.fn().mockResolvedValue(undefined),
}));

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";

const ORG_1 = "00000000-0000-0000-0000-0000000000a1";
const ORG_2 = "00000000-0000-0000-0000-0000000000b2";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function makeApp(actor: Record<string, unknown>, deploymentMode: DeploymentMode = "cloud_auth") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "session",
      userId: USER,
      companyIds: [COMPANY],
      organizationIds: [ORG_1],
      isInstanceAdmin: false,
      ...actor,
    };
    (req as any).tenant = { organizationId: null };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any, { deploymentMode }));
  app.use(errorHandler);
  return app;
}

// Mocked importBundle that echoes the real authorize contract for the sections
// under test, then returns a minimal result.
function wireImportBundle(action: "created" | "updated") {
  importBundle.mockImplementation(async (body: any, _actorUserId, authorize) => {
    const include = { company: true, agents: false, ...body.include };
    const manifest = body.source.manifest;
    const agentCount = manifest.agents?.length ?? 0;
    await authorize?.({
      changesCompletionPolicy: false,
      requiresTaskAssignmentPermission: false,
      importsWorkflowTemplates: false,
      importsAgents: include.agents === true && agentCount > 0,
      importsInternalAgentConfig:
        include.internalAgentConfig === true && !!manifest.internalAgentConfig,
      importsBudgetPolicies:
        include.budgetPolicies === true && (manifest.budgetPolicies?.length ?? 0) > 0,
    });
    return {
      company: { id: action === "created" ? "c-new" : COMPANY, name: "Imported", action },
      agents: [],
      projects: [],
      issues: [],
      skills: [],
      routines: [],
      requiredSecrets: [],
      warnings: [],
    };
  });
}

function bundle(
  target: Record<string, unknown>,
  include: Record<string, boolean> = { company: true },
  agents: unknown[] = [],
) {
  return {
    source: {
      type: "inline",
      manifest: {
        schemaVersion: 2,
        generatedAt: "2026-07-31T00:00:00.000Z",
        source: null,
        includes: { company: !!include.company, agents: !!include.agents },
        company: include.company
          ? {
              path: "COMPANY.md",
              name: "Imported",
              description: null,
              brandColor: null,
              requireBoardApprovalForNewAgents: true,
            }
          : null,
        agents,
        projects: [],
        requiredSecrets: [],
      },
      files: {},
    },
    include,
    target,
  };
}

const AGENT = {
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
};

describe("POST /import — agent-import authz (H2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDeploymentMode("cloud_auth");
    wireImportBundle("updated");
  });

  it("403: a team_member cannot escalate by importing agents into an existing company", async () => {
    getEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp({}))
      .post("/api/companies/import")
      .send(bundle({ mode: "existing_company", companyId: COMPANY }, { company: false, agents: true }, [AGENT]));
    expect(res.status).toBe(403);
    expect(getEffectiveRole).toHaveBeenCalledWith(COMPANY, USER);
  });

  it("200: a founder may import agents into an existing company", async () => {
    getEffectiveRole.mockResolvedValue("founder");
    const res = await request(makeApp({}))
      .post("/api/companies/import")
      .send(bundle({ mode: "existing_company", companyId: COMPANY }, { company: false, agents: true }, [AGENT]));
    expect(res.status).toBe(200);
    expect(importBundle).toHaveBeenCalledOnce();
  });

  it("403: a team_member cannot import into an existing company even with no agents (blanket founder/team_lead gate)", async () => {
    // D2 hardening: the WHOLE existing-company import is now gated on
    // founder/team_lead — a plain member could otherwise overwrite company
    // settings (e.g. requireBoardApprovalForNewAgents), skills, etc. via a bundle.
    getEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp({}))
      .post("/api/companies/import")
      .send(bundle({ mode: "existing_company", companyId: COMPANY }, { company: true, agents: false }));
    expect(res.status).toBe(403);
    expect(getEffectiveRole).toHaveBeenCalledWith(COMPANY, USER);
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("200: a founder may import company settings (no agents) into an existing company", async () => {
    getEffectiveRole.mockResolvedValue("founder");
    const res = await request(makeApp({}))
      .post("/api/companies/import")
      .send(bundle({ mode: "existing_company", companyId: COMPANY }, { company: true, agents: false }));
    expect(res.status).toBe(200);
    expect(importBundle).toHaveBeenCalledOnce();
  });
});

describe("POST /import — new_company org placement (H3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDeploymentMode("cloud_auth");
    wireImportBundle("created");
  });

  it("lands in the actor's single org (auto-pick) and passes it to importBundle", async () => {
    canOrg.mockResolvedValue(true);
    const res = await request(makeApp({ organizationIds: [ORG_1] }))
      .post("/api/companies/import")
      .send(bundle({ mode: "new_company", newCompanyName: "New Co" }));
    expect(res.status).toBe(200);
    expect(canOrg).toHaveBeenCalledWith(ORG_1, USER, "company:create");
    // 4th arg: the resolved org is threaded to the service.
    expect(importBundle.mock.calls[0][3]).toMatchObject({ organizationId: ORG_1 });
    expect(importBundle.mock.calls[0][3].organizationId).not.toBe(DEFAULT_ORGANIZATION_ID);
  });

  it("honors an explicit target.organizationId and authorizes against it", async () => {
    canOrg.mockResolvedValue(true);
    const res = await request(makeApp({ organizationIds: [ORG_1, ORG_2] }))
      .post("/api/companies/import")
      .send(bundle({ mode: "new_company", newCompanyName: "New Co", organizationId: ORG_2 }));
    expect(res.status).toBe(200);
    expect(canOrg).toHaveBeenCalledWith(ORG_2, USER, "company:create");
    expect(importBundle.mock.calls[0][3]).toMatchObject({ organizationId: ORG_2 });
  });

  it("403 when canOrg('company:create') is false", async () => {
    canOrg.mockResolvedValue(false);
    const res = await request(makeApp({ organizationIds: [ORG_1] }))
      .post("/api/companies/import")
      .send(bundle({ mode: "new_company", newCompanyName: "New Co" }));
    expect(res.status).toBe(403);
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("403 when the actor belongs to multiple orgs and omits organizationId (ambiguous)", async () => {
    const res = await request(makeApp({ organizationIds: [ORG_1, ORG_2] }))
      .post("/api/companies/import")
      .send(bundle({ mode: "new_company", newCompanyName: "New Co" }));
    expect(res.status).toBe(403);
    expect(canOrg).not.toHaveBeenCalled();
    expect(importBundle).not.toHaveBeenCalled();
  });
});

describe("POST /import — self-hosted new_company unchanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireImportBundle("created");
  });

  it("authenticated local_implicit import lands in the DEFAULT sentinel and never calls canOrg", async () => {
    setDeploymentMode("authenticated");
    const res = await request(
      makeApp({ source: "local_implicit", userId: null, organizationIds: [] }, "authenticated"),
    )
      .post("/api/companies/import")
      .send(bundle({ mode: "new_company", newCompanyName: "Legacy Co" }));
    expect(res.status).toBe(200);
    expect(canOrg).not.toHaveBeenCalled();
    expect(importBundle.mock.calls[0][3]).toMatchObject({ organizationId: DEFAULT_ORGANIZATION_ID });
  });
});
