import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  ensureMembership: vi.fn(),
  ensureRealOperator: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
  companyPortabilityService: () => mockPortabilityService,
  accessService: () => mockAccessService,
  logActivity: vi.fn(),
}));

// The D2 hardening gates the WHOLE existing-company import on founder/team_lead
// via assertRole -> permissionService(db).getEffectiveRole. db is {} here, so
// mock the permission service the rbac middleware imports and resolve a founder:
// these tests assert the completion-policy (tasks:assign) gates, not the role
// gate, so a founder lets the blanket role gate pass and preserves every
// tasks:assign assertion below.
vi.mock("../services/permissions.js", () => ({
  permissionService: () => ({ getEffectiveRole: vi.fn(async () => "founder") }),
}));

function createApp(actorOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId,
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any, { deploymentMode: "authenticated" }));
  app.use(errorHandler);
  return app;
}

function importBody(
  include?: { company?: boolean; projects?: boolean },
  options: { withGovernance?: boolean } = {},
) {
  const includesCompany = include?.company ?? true;
  const withGovernance = options.withGovernance ?? true;
  return {
    source: {
      type: "inline",
      manifest: {
        schemaVersion: 2,
        generatedAt: "2026-07-14T00:00:00.000Z",
        source: null,
        includes: { company: includesCompany, agents: false, projects: include?.projects ?? false },
        company: includesCompany
          ? {
              path: "COMPANY.md",
              name: "Imported company",
              description: null,
              brandColor: null,
              requireBoardApprovalForNewAgents: true,
              ...(withGovernance
                ? {
                  agentCompletionPolicyDefault: "agent_can_complete",
                  agentCompletionReviewGuardrail: false,
                }
                : {}),
            }
          : null,
        agents: [],
        projects: include?.projects
          ? [
            {
              slug: "product",
              name: "Product",
              type: "department",
              ...(withGovernance
                ? { agentCompletionPolicyDefault: "agent_can_complete" }
                : {}),
            },
          ]
          : [],
        requiredSecrets: [],
      },
      files: {},
    },
    ...(include ? { include } : {}),
    target: { mode: "existing_company", companyId },
  };
}

describe("company completion-policy authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyService.update.mockResolvedValue({ id: companyId, name: "Updated" });
    mockPortabilityService.importBundle.mockImplementation(
      async (body, _actorUserId, authorize) => {
        const include = {
          company: true,
          projects: false,
          issues: false,
          routines: false,
          workflowTemplates: false,
          ...body.include,
        };
        const manifest = body.source.manifest;
        const changesCompletionPolicy =
          (include.company &&
            !!manifest.company &&
            (manifest.company.agentCompletionPolicyDefault !== undefined ||
              manifest.company.agentCompletionReviewGuardrail !== undefined)) ||
          (include.projects &&
            manifest.projects?.some(
              (project) => project.agentCompletionPolicyDefault !== undefined,
            ));
        await authorize?.({
          changesCompletionPolicy: !!changesCompletionPolicy,
          requiresTaskAssignmentPermission:
            !!changesCompletionPolicy ||
            (include.routines && (manifest.routines?.length ?? 0) > 0) ||
            (include.issues &&
              manifest.issues?.some(
                (issue) => !issue.recurring && !!issue.assigneeAgentSlug,
              )),
          importsWorkflowTemplates:
            include.workflowTemplates && (manifest.workflowTemplates?.length ?? 0) > 0,
        });
        return {
          company: { id: companyId, name: "Imported company", action: "updated" },
          agents: [],
          projects: [],
          issues: [],
          skills: [],
          routines: [],
          requiredSecrets: [],
          warnings: [],
        };
      },
    );
  });

  it("allows an ordinary company update without tasks:assign", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(createApp())
      .patch(`/api/companies/${companyId}`)
      .send({ name: "Updated" });

    expect(res.status).toBe(200);
    expect(mockAccessService.canUser).not.toHaveBeenCalled();
    expect(mockCompanyService.update).toHaveBeenCalledWith(companyId, { name: "Updated" });
  });

  it("rejects company-wide completion governance changes without tasks:assign", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(createApp())
      .patch(`/api/companies/${companyId}`)
      .send({
        agentCompletionPolicyDefault: "agent_can_complete",
        agentCompletionReviewGuardrail: false,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("allows a privileged user to change company completion governance", async () => {
    mockAccessService.canUser.mockResolvedValue(true);

    const res = await request(createApp())
      .patch(`/api/companies/${companyId}`)
      .send({ agentCompletionReviewGuardrail: true });

    expect(res.status).toBe(200);
    expect(mockAccessService.canUser).toHaveBeenCalledWith(companyId, userId, "tasks:assign");
    expect(mockCompanyService.update).toHaveBeenCalledOnce();
  });

  it("rejects company question SLA changes without tasks:assign", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(createApp())
      .patch(`/api/companies/${companyId}`)
      .send({ humanQuestionSlaHours: 12 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("allows company question SLA changes with tasks:assign", async () => {
    mockAccessService.canUser.mockResolvedValue(true);

    const res = await request(createApp())
      .patch(`/api/companies/${companyId}`)
      .send({ humanQuestionSlaHours: 12 });

    expect(res.status).toBe(200);
    expect(mockAccessService.canUser).toHaveBeenCalledWith(companyId, userId, "tasks:assign");
    expect(mockCompanyService.update).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ humanQuestionSlaHours: 12 }),
    );
  });

  it.each([
    { source: "local_implicit", companyIds: [] },
    { isInstanceAdmin: true },
  ])("preserves the privileged bypass for company question SLA changes", async (overrides) => {
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(createApp(overrides))
      .patch(`/api/companies/${companyId}`)
      .send({ humanQuestionSlaHours: 6 });

    expect(res.status).toBe(200);
    expect(mockAccessService.canUser).not.toHaveBeenCalled();
    expect(mockCompanyService.update).toHaveBeenCalledOnce();
  });

  it.each([
    ["company governance", { company: true }],
    ["project governance", { company: false, projects: true }],
    ["default company governance", undefined],
  ])("rejects existing-company imports containing %s without tasks:assign", async (_label, include) => {
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(createApp())
      .post("/api/companies/import")
      .send(importBody(include));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockPortabilityService.importBundle).toHaveBeenCalledOnce();
  });

  it("rejects executable routine imports without tasks:assign even when no policy override exists", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    const body = importBody({ company: false });
    body.include = { company: false, routines: true } as any;
    body.source.manifest.includes.routines = true;
    body.source.manifest.routines = [
      {
        slug: "daily-brief",
        title: "Daily brief",
        description: null,
        status: "active",
        priority: "medium",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        projectSlug: "product",
        assigneeAgentSlug: "researcher",
        variables: [],
        triggers: [],
      },
    ];

    const res = await request(createApp()).post("/api/companies/import").send(body);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
  });

  it.each([
    ["legacy company metadata", { company: true }],
    ["projects without completion defaults", { company: false, projects: true }],
  ])("allows existing-company imports containing %s without tasks:assign", async (_label, include) => {
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(createApp())
      .post("/api/companies/import")
      .send(importBody(include, { withGovernance: false }));

    expect(res.status).toBe(200);
    expect(mockAccessService.canUser).not.toHaveBeenCalled();
    expect(mockPortabilityService.importBundle).toHaveBeenCalledOnce();
  });
});
