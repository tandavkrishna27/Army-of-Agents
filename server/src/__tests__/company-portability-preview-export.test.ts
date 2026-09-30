import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const mockCanUser = vi.hoisted(() => vi.fn(async () => true));
const mockAssertRole = vi.hoisted(() => vi.fn(async () => undefined));

type AgentRow = {
  id: string;
  companyId: string;
  name: string;
  status: string;
  role: string;
  title: string | null;
  icon: string | null;
  capabilities: string | null;
  reportsTo: string | null;
  parentType: string | null;
  parentId: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown>;
  budgetMonthlyCents: number;
  metadata: Record<string, unknown> | null;
};

type ProjectRow = {
  id: string;
  companyId: string;
  name: string;
  type: "department" | "project";
  description: string | null;
  status: string;
  color: string | null;
  targetDate: string | null;
  leadAgentId: string | null;
  functionType: string | null;
  executionWorkspacePolicy: Record<string, unknown> | null;
  archivedAt: Date | null;
};

type IssueRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  identifier: string | null;
  billingCode: string | null;
  assigneeAdapterOverrides: Record<string, unknown> | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
  dueDate: Date | null;
  labels: Array<{ id: string; name: string; color: string }>;
  labelIds: string[];
};

type SkillRow = {
  id: string;
  companyId: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  sourceType: string;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: string;
  compatibility: string;
  fileInventory: Array<{ path: string; kind: string }>;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

type RoutineRow = {
  id: string;
  companyId: string;
  projectId: string;
  goalId: string | null;
  parentIssueId: string | null;
  title: string;
  description: string | null;
  assigneeAgentId: string;
  priority: string;
  status: "active" | "paused" | "archived";
  concurrencyPolicy: "coalesce_if_active" | "always_enqueue" | "skip_if_active";
  catchUpPolicy: "skip_missed" | "enqueue_missed_with_cap";
  variables: Array<{
    name: string;
    label: string | null;
    type: "text" | "textarea" | "number" | "boolean" | "select";
    defaultValue: string | number | boolean | null;
    required: boolean;
    options: string[];
  }>;
  latestRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
};

const SRC_CO_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CO_ID = "99999999-9999-4999-8999-999999999999";

const companyStore: Record<string, { id: string; name: string; requireBoardApprovalForNewAgents?: boolean }> = {
  [SRC_CO_ID]: { id: SRC_CO_ID, name: "Source Co", requireBoardApprovalForNewAgents: true },
};

let sourceAgents: AgentRow[] = [];
let sourceProjects: ProjectRow[] = [];
let sourceIssues: IssueRow[] = [];
let sourceSkills: SkillRow[] = [];
let sourceRoutines: RoutineRow[] = [];

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getById: vi.fn(async (id: string) => companyStore[id] ?? null),
    create: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    backfillHumanAtTop: vi.fn(async () => undefined),
    list: vi.fn(async (companyId: string) => (companyId === SRC_CO_ID ? sourceAgents : [])),
    create: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    canUser: mockCanUser,
    ensureMembership: vi.fn(async () => undefined),
    ensureRealOperator: vi.fn(async () => "operator-user-id"),
  }),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: (...args: unknown[]) => mockAssertRole(...args),
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => ({
    list: vi.fn(async (companyId: string) => (companyId === SRC_CO_ID ? sourceProjects : [])),
    create: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    list: vi.fn(async (companyId: string) => (companyId === SRC_CO_ID ? sourceIssues : [])),
    create: vi.fn(),
  }),
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => ({
    listFull: vi.fn(async (companyId: string) => (companyId === SRC_CO_ID ? sourceSkills : [])),
    upsertImportedSkills: vi.fn(async () => []),
  }),
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => ({
    listForExport: vi.fn(async (companyId: string) => {
      if (companyId !== SRC_CO_ID) return [];
      return sourceRoutines.map((routine) => ({ routine, triggers: [] }));
    }),
    list: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
    createTrigger: vi.fn(),
  }),
}));

import { companyPortabilityService } from "../services/company-portability.js";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";
import { forbidden } from "../errors.js";

function makeAgent(overrides: Partial<AgentRow> & { id: string; name: string }): AgentRow {
  return {
    companyId: SRC_CO_ID,
    status: "active",
    role: "Engineer",
    title: null,
    icon: null,
    capabilities: null,
    reportsTo: null,
    parentType: null,
    parentId: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    budgetMonthlyCents: 0,
    metadata: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectRow> & { id: string; name: string }): ProjectRow {
  return {
    companyId: SRC_CO_ID,
    type: "department",
    description: null,
    status: "backlog",
    color: null,
    targetDate: null,
    leadAgentId: null,
    functionType: "general",
    executionWorkspacePolicy: null,
    archivedAt: null,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<IssueRow> & { id: string; title: string }): IssueRow {
  return {
    companyId: SRC_CO_ID,
    projectId: null,
    description: null,
    status: "backlog",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    identifier: null,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceSettings: null,
    dueDate: null,
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillRow> & { id: string; key: string; slug: string; name: string }): SkillRow {
  return {
    companyId: SRC_CO_ID,
    description: null,
    markdown: "# Skill\n",
    sourceType: "builtin",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "trusted",
    compatibility: "any",
    fileInventory: [],
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRoutine(overrides: Partial<RoutineRow> & { id: string; title: string; projectId: string; assigneeAgentId: string }): RoutineRow {
  return {
    companyId: SRC_CO_ID,
    goalId: null,
    parentIssueId: null,
    description: null,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    latestRevisionId: null,
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
    ...overrides,
  };
}

function resetState() {
  sourceAgents = [];
  sourceProjects = [];
  sourceIssues = [];
  sourceSkills = [];
  sourceRoutines = [];
}

describe("company-portability previewExport (service)", () => {
  const svc = companyPortabilityService({ select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as any);

  it("returns agent count with DEFAULT_INCLUDE (company + agents only)", async () => {
    resetState();
    sourceAgents = [
      makeAgent({ id: "a1", name: "Ada" }),
      makeAgent({ id: "a2", name: "Bob" }),
    ];
    const preview = await svc.previewExport(SRC_CO_ID, {});
    expect(preview.counts.agents).toBe(2);
    expect(preview.counts.projects).toBe(0);
    expect(preview.counts.issues).toBe(0);
    expect(preview.counts.skills).toBe(0);
    expect(preview.counts.routines).toBe(0);
    expect(preview.counts.envInputs).toBe(0);
    expect(preview.files.length).toBeGreaterThan(0);
    expect(preview.estimatedBytes).toBeGreaterThan(0);
  });

  it("returns project count when include.projects=true", async () => {
    resetState();
    sourceProjects = [
      makeProject({ id: "p1", name: "Engineering", type: "department" }),
      makeProject({ id: "p2", name: "Auth", type: "project" }),
      makeProject({ id: "p3", name: "Billing", type: "project" }),
    ];
    const preview = await svc.previewExport(SRC_CO_ID, { include: { projects: true } });
    expect(preview.counts.projects).toBe(3);
  });

  it("returns issue count when include.issues=true", async () => {
    resetState();
    sourceProjects = [makeProject({ id: "p1", name: "Eng", type: "department" })];
    sourceIssues = [
      makeIssue({ id: "i1", title: "Task One", projectId: "p1" }),
      makeIssue({ id: "i2", title: "Task Two", projectId: "p1" }),
    ];
    const preview = await svc.previewExport(SRC_CO_ID, { include: { projects: true, issues: true } });
    expect(preview.counts.issues).toBe(2);
  });

  it("returns skill count with file inventory paths listed", async () => {
    resetState();
    sourceSkills = [
      makeSkill({ id: "s1", key: "skill.one", slug: "skill-one", name: "Skill One" }),
      makeSkill({ id: "s2", key: "skill.two", slug: "skill-two", name: "Skill Two" }),
    ];
    const preview = await svc.previewExport(SRC_CO_ID, { include: { skills: true } });
    expect(preview.counts.skills).toBe(2);
    // File inventory should include the SKILL.md paths emitted by exportBundle
    expect(preview.files.some((path) => path.startsWith("skills/skill-one/"))).toBe(true);
    expect(preview.files.some((path) => path.startsWith("skills/skill-two/"))).toBe(true);
  });

  it("returns routine count when include.routines=true", async () => {
    resetState();
    sourceAgents = [makeAgent({ id: "a1", name: "Ada" })];
    sourceProjects = [makeProject({ id: "p1", name: "Eng", type: "department" })];
    sourceRoutines = [
      makeRoutine({ id: "r1", title: "Nightly", projectId: "p1", assigneeAgentId: "a1" }),
    ];
    const preview = await svc.previewExport(SRC_CO_ID, {
      include: { agents: true, projects: true, routines: true },
    });
    expect(preview.counts.routines).toBe(1);
  });

  it("returns envInput count when include.envInputs=true", async () => {
    resetState();
    sourceAgents = [
      makeAgent({
        id: "a1",
        name: "Ada",
        adapterConfig: {
          env: {
            API_BASE_URL: { type: "plain", value: "https://api.example.com" },
            OPENAI_API_KEY: { type: "plain", value: "sk-xxx" },
          },
        },
      }),
    ];
    const preview = await svc.previewExport(SRC_CO_ID, { include: { agents: true, envInputs: true } });
    expect(preview.counts.envInputs).toBe(2);
  });

  it("includes README.md in the file inventory", async () => {
    resetState();
    sourceAgents = [makeAgent({ id: "a1", name: "Ada" })];
    const preview = await svc.previewExport(SRC_CO_ID, {});
    expect(preview.files).toContain("README.md");
  });

  it("does NOT return the manifest or file bodies (only summary fields)", async () => {
    resetState();
    sourceAgents = [makeAgent({ id: "a1", name: "Ada" })];
    const preview = await svc.previewExport(SRC_CO_ID, {});
    // Summary-only response shape
    expect(preview).toHaveProperty("counts");
    expect(preview).toHaveProperty("files");
    expect(preview).toHaveProperty("estimatedBytes");
    // files is a string[] (paths), not a Record with bodies
    expect(Array.isArray(preview.files)).toBe(true);
    for (const entry of preview.files) {
      expect(typeof entry).toBe("string");
    }
  });
});

describe("company-portability previewExport (route)", () => {
  function buildApp(actorOverrides: Partial<any> = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "user-1",
        companyIds: [SRC_CO_ID],
        source: "session",
        isInstanceAdmin: false,
        ...actorOverrides,
      };
      next();
    });
    app.use("/api/companies", companyRoutes({ select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as any, { deploymentMode: "local_trusted" }));
    app.use(errorHandler);
    return app;
  }

  it("POST /companies/:companyId/export/preview returns preview JSON", async () => {
    resetState();
    sourceAgents = [makeAgent({ id: "a1", name: "Ada" })];
    const app = buildApp();
    const res = await request(app)
      .post(`/api/companies/${SRC_CO_ID}/export/preview`)
      .send({ include: { agents: true } });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("counts");
    expect(res.body.counts.agents).toBe(1);
    expect(Array.isArray(res.body.files)).toBe(true);
    expect(typeof res.body.estimatedBytes).toBe("number");
  });

  it("POST /companies/:companyId/export/preview returns 403 for cross-company access", async () => {
    resetState();
    const app = buildApp({ companyIds: [OTHER_CO_ID] });
    const res = await request(app)
      .post(`/api/companies/${SRC_CO_ID}/export/preview`)
      .send({ include: {} });
    expect(res.status).toBe(403);
  });

  it("POST /companies/:companyId/export/preview returns 400 for invalid body", async () => {
    resetState();
    const app = buildApp();
    const res = await request(app)
      .post(`/api/companies/${SRC_CO_ID}/export/preview`)
      .send({ include: "not-an-object" });
    expect(res.status).toBe(400);
  });
});

// Mirror the per-route body-size + global JSON ordering from server/src/app.ts
// so tests can assert the 20MB cap on import paths fires before the global
// default. The verify callback shape MUST match the global mount in app.ts
// (rawBody capture for plugin webhook HMAC).
function buildAppWithImportBodyCap(actorOverrides: Partial<any> = {}) {
  const app = express();
  const captureRawBody = (
    req: express.Request,
    _res: express.Response,
    buf: Buffer,
  ) => {
    if (buf && buf.length > 0) {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    }
  };
  app.use(
    ["/api/companies/import", "/api/companies/import/preview"],
    express.json({ limit: "20mb", verify: captureRawBody }),
  );
  app.use(express.json({ verify: captureRawBody }));
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [SRC_CO_ID],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use(
    "/api/companies",
    companyRoutes(
      { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as any,
      { deploymentMode: "local_trusted" },
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("import body-size cap", () => {
  const validExistingCompanyImport = {
    source: {
      type: "inline" as const,
      manifest: {
        schemaVersion: 2,
        generatedAt: "2026-07-14T00:00:00.000Z",
        source: null,
        includes: { company: false, agents: false },
        company: null,
        agents: [],
        requiredSecrets: [],
      },
      files: {},
    },
    target: { mode: "existing_company" as const, companyId: SRC_CO_ID },
  };

  it("allows a company-scoped agent to preview an existing-company import", async () => {
    const app = buildAppWithImportBodyCap({
      type: "agent",
      agentId: "agent-1",
      companyId: SRC_CO_ID,
    });
    const res = await request(app)
      .post("/api/companies/import/preview")
      .send(validExistingCompanyImport);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("plan");
  });

  it("rejects an agent performing an import", async () => {
    const app = buildAppWithImportBodyCap({
      type: "agent",
      agentId: "agent-1",
      companyId: SRC_CO_ID,
    });
    const res = await request(app)
      .post("/api/companies/import")
      .send(validExistingCompanyImport);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });

  it("requires tasks:assign when importing routines into an existing company", async () => {
    mockCanUser.mockResolvedValueOnce(false);
    const app = buildAppWithImportBodyCap();
    const res = await request(app)
      .post("/api/companies/import")
      .send({
        ...validExistingCompanyImport,
        source: {
          ...validExistingCompanyImport.source,
          manifest: {
            ...validExistingCompanyImport.source.manifest,
            includes: { company: false, agents: false, routines: true },
            routines: [{
              slug: "daily-brief",
              title: "Daily brief",
              status: "active",
              priority: "medium",
              concurrencyPolicy: "coalesce_if_active",
              catchUpPolicy: "skip_missed",
              projectSlug: "product",
              assigneeAgentSlug: "researcher",
              variables: [],
              triggers: [],
            }],
          },
        },
        include: { company: false, agents: false, routines: true },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mockCanUser).toHaveBeenCalledWith(SRC_CO_ID, "user-1", "tasks:assign");
  });

  it("requires tasks:assign when importing issues into an existing company", async () => {
    mockCanUser.mockResolvedValueOnce(false);
    const app = buildAppWithImportBodyCap();
    const res = await request(app)
      .post("/api/companies/import")
      .send({
        ...validExistingCompanyImport,
        source: {
          ...validExistingCompanyImport.source,
          manifest: {
            ...validExistingCompanyImport.source.manifest,
            includes: { company: false, agents: false, issues: true },
            issues: [{
              slug: "prepare-brief",
              title: "Prepare brief",
              assigneeAgentSlug: "researcher",
            }],
          },
        },
        include: { company: false, agents: false, issues: true },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mockCanUser).toHaveBeenCalledWith(SRC_CO_ID, "user-1", "tasks:assign");
  });

  it("requires founder or team-lead role when importing workflow templates", async () => {
    mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder, team_lead"));
    const app = buildAppWithImportBodyCap();
    const res = await request(app)
      .post("/api/companies/import")
      .send({
        ...validExistingCompanyImport,
        source: {
          ...validExistingCompanyImport.source,
          manifest: {
            ...validExistingCompanyImport.source.manifest,
            includes: { company: false, agents: false, workflowTemplates: true },
            workflowTemplates: [{
              slug: "launch",
              name: "Launch",
              description: null,
              workspaceMode: "per_task",
              steps: [],
              dependencies: [],
            }],
          },
        },
        include: { company: false, agents: false, workflowTemplates: true },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("founder, team_lead");
    expect(mockAssertRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      SRC_CO_ID,
      "founder",
      "team_lead",
    );
  });

  it("requires tasks:assign when imported workflow templates override completion policy", async () => {
    mockCanUser.mockResolvedValueOnce(false);
    const app = buildAppWithImportBodyCap();
    const res = await request(app)
      .post("/api/companies/import")
      .send({
        ...validExistingCompanyImport,
        source: {
          ...validExistingCompanyImport.source,
          manifest: {
            ...validExistingCompanyImport.source.manifest,
            includes: { company: false, agents: false, workflowTemplates: true },
            workflowTemplates: [{
              slug: "launch",
              name: "Launch",
              description: null,
              workspaceMode: "per_task",
              agentCompletionPolicyOverride: "agent_can_complete",
              steps: [],
              dependencies: [],
            }],
          },
        },
        include: { company: false, agents: false, workflowTemplates: true },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mockCanUser).toHaveBeenCalledWith(SRC_CO_ID, "user-1", "tasks:assign");
  });

  it("returns 413 for bodies over 20MB on /api/companies/import/preview", async () => {
    const big = JSON.stringify({ __pad: "x".repeat(30 * 1024 * 1024) });
    const app = buildAppWithImportBodyCap();
    const res = await request(app)
      .post("/api/companies/import/preview")
      .set("Content-Type", "application/json")
      .send(big);
    expect(res.status).toBe(413);
  });

  it("returns 413 for bodies over 20MB on /api/companies/import", async () => {
    const big = JSON.stringify({ __pad: "x".repeat(30 * 1024 * 1024) });
    const app = buildAppWithImportBodyCap();
    const res = await request(app)
      .post("/api/companies/import")
      .set("Content-Type", "application/json")
      .send(big);
    expect(res.status).toBe(413);
  });

  it("accepts a 1MB body shape on /api/companies/import/preview without a 413", async () => {
    resetState();
    sourceAgents = [makeAgent({ id: "a1", name: "Ada" })];
    const app = buildAppWithImportBodyCap();
    // Build a payload that's ~1MB but invalid by schema (shape doesn't matter
    // here — we only assert the body-cap gate doesn't 413 a small payload).
    const payload = {
      source: {
        type: "inline",
        manifest: { __pad: "y".repeat(1024 * 1024) },
        files: {},
      },
      target: { mode: "new_company" },
    };
    const res = await request(app)
      .post("/api/companies/import/preview")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));
    expect(res.status).not.toBe(413);
  });

  it("does NOT apply the 20MB cap to non-import routes (global default still 413's)", async () => {
    // Global mount's default is 100KB; a 1MB non-import body should 413 there.
    const big = JSON.stringify({ __pad: "x".repeat(1 * 1024 * 1024) });
    const app = buildAppWithImportBodyCap();
    const res = await request(app)
      .post(`/api/companies/${SRC_CO_ID}/export/preview`)
      .set("Content-Type", "application/json")
      .send(big);
    expect(res.status).toBe(413);
  });
});

describe("import schema array caps", () => {
  it("rejects bundles whose manifest.issues array exceeds the 10000 cap", async () => {
    const app = buildAppWithImportBodyCap();
    const issues = Array.from({ length: 10_001 }, (_, i) => ({
      slug: `i-${i}`,
      title: `Task ${i}`,
    }));
    const payload = {
      source: {
        type: "inline",
        manifest: {
          schemaVersion: 2,
          generatedAt: "2026-04-21T00:00:00.000Z",
          source: null,
          includes: { company: false, agents: false, issues: true },
          company: null,
          agents: [],
          issues,
          requiredSecrets: [],
        },
        files: {},
      },
      target: { mode: "new_company" },
    };
    const res = await request(app)
      .post("/api/companies/import/preview")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
