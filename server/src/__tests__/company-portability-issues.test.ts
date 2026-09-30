import { describe, expect, it, vi } from "vitest";

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
  agentCompletionPolicyDefault: "review_required" | "agent_can_complete" | null;
  executionWorkspacePolicy: Record<string, unknown> | null;
  archivedAt: Date | null;
};

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

type IssueLabelRow = { id: string; name: string; color: string };
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
  acceptanceCriteria: string[];
  agentCompletionPolicyOverride: "review_required" | "agent_can_complete" | null;
  agentCompletionPolicy: "review_required" | "agent_can_complete";
  agentCompletionPolicySource: "company" | "department" | "project" | "routine" | "workflow_template" | "task" | "legacy_backfill";
  agentCompletionPolicyResolvedAt: Date;
  dueDate: Date | null;
  labels: IssueLabelRow[];
  labelIds: string[];
};

const SRC_CO_ID = "11111111-1111-4111-8111-111111111111";
const TGT_CO_ID = "22222222-2222-4222-8222-222222222222";

const companyStore: Record<string, {
  id: string;
  name: string;
  requireBoardApprovalForNewAgents?: boolean;
  agentCompletionPolicyDefault?: "review_required" | "agent_can_complete";
  agentCompletionReviewGuardrail?: boolean;
}> = {
  [SRC_CO_ID]: {
    id: SRC_CO_ID,
    name: "Source Co",
    requireBoardApprovalForNewAgents: true,
    agentCompletionPolicyDefault: "agent_can_complete",
    agentCompletionReviewGuardrail: true,
  },
  [TGT_CO_ID]: { id: TGT_CO_ID, name: "Target Co", requireBoardApprovalForNewAgents: true },
};

let sourceIssues: IssueRow[] = [];
let sourceProjects: ProjectRow[] = [];
let sourceAgents: AgentRow[] = [];
let targetProjects: ProjectRow[] = [];
let targetAgents: AgentRow[] = [];
const issueCreateCalls: Array<{ companyId: string; data: any }> = [];
const projectCreateCalls: Array<{ companyId: string; data: any }> = [];
const agentCreateCalls: Array<{ companyId: string; data: any }> = [];
const companyCreateCalls: any[] = [];
let issueCreateError: Error | null = null;

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getById: vi.fn(async (id: string) => companyStore[id] ?? null),
    create: vi.fn(async (input: { name: string }) => {
      companyCreateCalls.push(input);
      return { id: "new-co", ...input };
    }),
    // P3: importBundle now creates via the atomic `createWithOperator`. Mirror
    // the create + operator-provision as one call so `companyCreateCalls` still
    // records the create input.
    createWithOperator: vi.fn(async (input: { name: string }, _opts: any, ownerUserId: any, buildAccess: any) => {
      companyCreateCalls.push(input);
      const company = { id: "new-co", ...input };
      const operatorId = await buildAccess(undefined).ensureRealOperator(company.id, ownerUserId ?? null);
      return { company, operatorId };
    }),
    update: vi.fn(async (id: string, patch: any) => ({ id, name: patch.name ?? companyStore[id]?.name ?? "Co" })),
  }),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    list: vi.fn(async (companyId: string) => {
      if (companyId === SRC_CO_ID) return sourceAgents;
      if (companyId === TGT_CO_ID) return targetAgents;
      return [];
    }),
    create: vi.fn(async (companyId: string, data: any) => {
      agentCreateCalls.push({ companyId, data });
      const row: AgentRow = {
        id: `new-agent-${agentCreateCalls.length}`,
        companyId,
        name: data.name,
        status: "active",
        role: data.role ?? "Engineer",
        title: data.title ?? null,
        icon: data.icon ?? null,
        capabilities: data.capabilities ?? null,
        reportsTo: null,
        parentType: null,
        parentId: null,
        adapterType: data.adapterType ?? "claude_local",
        adapterConfig: data.adapterConfig ?? {},
        runtimeConfig: data.runtimeConfig ?? {},
        permissions: data.permissions ?? {},
        budgetMonthlyCents: data.budgetMonthlyCents ?? 0,
        metadata: data.metadata ?? null,
      };
      targetAgents.push(row);
      return row;
    }),
    update: vi.fn(async (id: string, data: any) => {
      const row = targetAgents.find((a) => a.id === id) ?? null;
      if (row) Object.assign(row, data);
      return row;
    }),
    backfillHumanAtTop: vi.fn(async () => undefined),
  }),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    ensureMembership: vi.fn(async () => undefined),
    ensureRealOperator: vi.fn(async () => "operator-user-id"),
  }),
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => ({
    list: vi.fn(async (companyId: string) => {
      if (companyId === SRC_CO_ID) return sourceProjects;
      if (companyId === TGT_CO_ID) return targetProjects;
      return [];
    }),
    create: vi.fn(async (companyId: string, data: any) => {
      projectCreateCalls.push({ companyId, data });
      const row: ProjectRow = {
        id: `new-proj-${projectCreateCalls.length}`,
        companyId,
        name: data.name,
        type: data.type ?? "department",
        description: data.description ?? null,
        status: data.status ?? "backlog",
        color: data.color ?? null,
        targetDate: data.targetDate ?? null,
        leadAgentId: data.leadAgentId ?? null,
        functionType: data.functionType ?? "general",
        executionWorkspacePolicy: data.executionWorkspacePolicy ?? null,
        archivedAt: null,
      };
      targetProjects.push(row);
      return row;
    }),
    update: vi.fn(async (id: string, data: any) => {
      const row = targetProjects.find((p) => p.id === id) ?? null;
      if (row) Object.assign(row, data);
      return row;
    }),
  }),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    list: vi.fn(async (companyId: string) => {
      if (companyId === SRC_CO_ID) return sourceIssues;
      return [];
    }),
    create: vi.fn(async (companyId: string, data: any) => {
      if (issueCreateError) throw issueCreateError;
      issueCreateCalls.push({ companyId, data });
      return {
        id: `new-issue-${issueCreateCalls.length}`,
        companyId,
        ...data,
      };
    }),
  }),
}));

import { companyPortabilityService } from "../services/company-portability.js";
import type { CompanyPortabilityManifest } from "@armyofagents/shared";

function resetState() {
  sourceIssues = [];
  sourceProjects = [];
  sourceAgents = [];
  targetProjects = [];
  targetAgents = [];
  issueCreateCalls.length = 0;
  projectCreateCalls.length = 0;
  agentCreateCalls.length = 0;
  companyCreateCalls.length = 0;
  issueCreateError = null;
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
    acceptanceCriteria: [],
    agentCompletionPolicyOverride: null,
    agentCompletionPolicy: "review_required",
    agentCompletionPolicySource: "company",
    agentCompletionPolicyResolvedAt: new Date("2026-07-14T00:00:00.000Z"),
    dueDate: null,
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

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
    agentCompletionPolicyDefault: null,
    executionWorkspacePolicy: null,
    archivedAt: null,
    ...overrides,
  };
}

function baseManifest(overrides: Partial<CompanyPortabilityManifest> = {}): CompanyPortabilityManifest {
  return {
    schemaVersion: 2,
    generatedAt: "2026-04-21T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: false, projects: true, issues: true },
    company: {
      path: "COMPANY.md",
      name: "Source Co",
      description: null,
      brandColor: null,
      requireBoardApprovalForNewAgents: true,
    },
    agents: [],
    requiredSecrets: [],
    ...overrides,
  };
}

function buildInlineSource(
  manifest: CompanyPortabilityManifest,
  include: Partial<{ company: boolean; agents: boolean; projects: boolean; issues: boolean }> = {
    company: true,
    agents: false,
    projects: true,
    issues: true,
  },
  files: Record<string, string> = { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
) {
  return {
    source: { type: "inline" as const, manifest, files },
    target: { mode: "new_company" as const, newCompanyName: "Imported Co" },
    include,
  };
}

describe("company-portability issues", () => {
  const svc = companyPortabilityService({ select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as any);

  it("exportBundle with include.issues=true serializes all issues with slugs", async () => {
    resetState();
    sourceProjects = [makeProject({
      id: "p1",
      name: "Engineering",
      type: "department",
      agentCompletionPolicyDefault: "review_required",
    })];
    sourceAgents = [makeAgent({ id: "a1", name: "Alice" })];
    sourceIssues = [
      makeIssue({
        id: "i1",
        title: "Fix login bug",
        identifier: "SRC-1",
        description: "desc",
        status: "todo",
        priority: "high",
        projectId: "p1",
        assigneeAgentId: "a1",
        agentCompletionPolicyOverride: "review_required",
        agentCompletionPolicy: "review_required",
        agentCompletionPolicySource: "department",
        acceptanceCriteria: ["Login succeeds with valid credentials"],
      }),
      makeIssue({
        id: "i2",
        title: "Add signup page",
        identifier: "SRC-2",
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { projects: true, issues: true, agents: true },
    });
    expect(result.manifest.issues).toHaveLength(2);
    expect(result.manifest.company).toMatchObject({
      agentCompletionPolicyDefault: "agent_can_complete",
      agentCompletionReviewGuardrail: true,
    });
    expect(result.manifest.projects?.[0]?.agentCompletionPolicyDefault).toBe("review_required");
    expect(result.manifest.issues!.every((issue) => issue.slug)).toBe(true);
    const fix = result.manifest.issues!.find((issue) => issue.title === "Fix login bug");
    expect(fix).toBeDefined();
    expect(fix!.status).toBe("todo");
    expect(fix!.priority).toBe("high");
    expect(fix!.projectSlug).toBe("engineering");
    expect(fix!.assigneeAgentSlug).toBe("alice");
    expect(fix!.identifier).toBe("SRC-1");
    expect(fix).toMatchObject({
      agentCompletionPolicyOverride: "review_required",
      agentCompletionPolicy: "review_required",
      agentCompletionPolicySource: "department",
      agentCompletionPolicyResolvedAt: "2026-07-14T00:00:00.000Z",
      acceptanceCriteria: ["Login succeeds with valid credentials"],
    });
  });

  it("exportBundle omits issues by default (DEFAULT_INCLUDE.issues=false)", async () => {
    resetState();
    sourceIssues = [makeIssue({ id: "i1", title: "X" })];
    const result = await svc.exportBundle(SRC_CO_ID, {});
    expect(result.manifest.issues).toBeUndefined();
    expect(result.manifest.includes.issues).toBe(false);
  });

  it("exportBundle bumps schemaVersion to 2 when issues are included", async () => {
    resetState();
    sourceIssues = [makeIssue({ id: "i1", title: "X" })];
    const withIssues = await svc.exportBundle(SRC_CO_ID, { include: { issues: true } });
    expect(withIssues.manifest.schemaVersion).toBe(2);

    const withoutIssues = await svc.exportBundle(SRC_CO_ID, {});
    expect(withoutIssues.manifest.schemaVersion).toBe(1);
  });

  it("exportBundle uses slugs (not raw uuids) for projectSlug and assigneeAgentSlug", async () => {
    resetState();
    sourceProjects = [makeProject({ id: "p1-uuid", name: "Ops", type: "department" })];
    sourceAgents = [makeAgent({ id: "a1-uuid", name: "Bob" })];
    sourceIssues = [
      makeIssue({
        id: "i1",
        title: "Deploy",
        projectId: "p1-uuid",
        assigneeAgentId: "a1-uuid",
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: true, projects: true, issues: true },
    });
    const issue = result.manifest.issues![0]!;
    expect(issue.projectSlug).toBe("ops");
    expect(issue.assigneeAgentSlug).toBe("bob");
    expect(issue.projectSlug).not.toContain("-uuid");
  });

  it("exportBundle includes labelNames on issues", async () => {
    resetState();
    sourceIssues = [
      makeIssue({
        id: "i1",
        title: "X",
        labels: [
          { id: "l1", name: "bug", color: "red" },
          { id: "l2", name: "urgent", color: "orange" },
        ],
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { issues: true } });
    expect(result.manifest.issues![0]!.labelNames).toEqual(["bug", "urgent"]);
  });

  it("importBundle creates issues with project + agent linkage via slugs", async () => {
    resetState();
    const manifest = baseManifest({
      includes: { company: true, agents: true, projects: true, issues: true },
      company: {
        path: "COMPANY.md",
        name: "Source Co",
        description: null,
        brandColor: null,
        requireBoardApprovalForNewAgents: true,
        agentCompletionPolicyDefault: "agent_can_complete",
        agentCompletionReviewGuardrail: true,
      },
      agents: [
        {
          slug: "alice",
          name: "Alice",
          path: "agents/alice/AGENTS.md",
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
      projects: [{
        slug: "engineering",
        name: "Engineering",
        type: "department",
        agentCompletionPolicyDefault: "review_required",
      }],
      issues: [
        {
          slug: "src-1",
          title: "Fix login bug",
          status: "todo",
          priority: "high",
          projectSlug: "engineering",
          assigneeAgentSlug: "alice",
          agentCompletionPolicyOverride: null,
          agentCompletionPolicy: "review_required",
          agentCompletionPolicySource: "department",
          agentCompletionPolicyResolvedAt: "2026-07-14T00:00:00.000Z",
          acceptanceCriteria: ["All authentication tests pass"],
        },
      ],
    });
    await svc.importBundle(
      buildInlineSource(manifest, {
        company: true,
        agents: true,
        projects: true,
        issues: true,
      }, {
        "COMPANY.md": "",
        "agents/alice/AGENTS.md": "---\nkind: agent\n---\n",
      }),
      "user-1",
    );
    expect(issueCreateCalls).toHaveLength(1);
    expect(companyCreateCalls[0]).toMatchObject({
      agentCompletionPolicyDefault: "agent_can_complete",
      agentCompletionReviewGuardrail: true,
    });
    const createCall = issueCreateCalls[0]!;
    expect(createCall.data.title).toBe("Fix login bug");
    expect(createCall.data.status).toBe("todo");
    expect(createCall.data.priority).toBe("high");
    // resolved project id should be the newly created project
    expect(createCall.data.projectId).toBe(projectCreateCalls[0]!.data.name === "Engineering" ? "new-proj-1" : null);
    // resolved agent id should be the newly created agent
    expect(createCall.data.assigneeAgentId).toBe("new-agent-1");
    expect(projectCreateCalls[0]!.data.agentCompletionPolicyDefault).toBe("review_required");
    expect(createCall.data.completionPolicySnapshot).toEqual({
      policy: "review_required",
      override: null,
      source: "department",
      sourceId: "new-proj-1",
      resolvedAt: new Date("2026-07-14T00:00:00.000Z"),
    });
    expect(createCall.data.acceptanceCriteria).toEqual(["All authentication tests pass"]);
  });

  it("imports legacy tasks with a conservative completion snapshot", async () => {
    resetState();
    const manifest = baseManifest({
      includes: { company: true, agents: false, projects: false, issues: true },
      issues: [{ slug: "legacy-1", title: "Legacy task" }],
    });

    await svc.importBundle(
      buildInlineSource(manifest, {
        company: true,
        agents: false,
        projects: false,
        issues: true,
      }),
      "user-1",
    );

    expect(issueCreateCalls[0]!.data.completionPolicySnapshot).toEqual({
      policy: "review_required",
      override: null,
      source: "legacy_backfill",
      sourceId: null,
      resolvedAt: null,
    });
  });

  it("downgrades unmappable Routine provenance instead of retaining a dangling source", async () => {
    resetState();
    const manifest = baseManifest({
      includes: { company: true, agents: false, projects: false, issues: true },
      issues: [{
        slug: "routine-task",
        title: "Routine task",
        agentCompletionPolicy: "agent_can_complete",
        agentCompletionPolicySource: "routine",
      }],
    });

    await svc.importBundle(
      buildInlineSource(manifest, {
        company: true,
        agents: false,
        projects: false,
        issues: true,
      }),
      "user-1",
    );

    expect(issueCreateCalls[0]!.data.completionPolicySnapshot).toMatchObject({
      policy: "agent_can_complete",
      source: "legacy_backfill",
      sourceId: null,
    });
  });

  it("downgrades project provenance when the project cannot be remapped", async () => {
    resetState();
    const manifest = baseManifest({
      includes: { company: true, agents: false, projects: false, issues: true },
      issues: [{
        slug: "unmapped-project-task",
        title: "Unmapped project task",
        projectSlug: "missing-project",
        agentCompletionPolicy: "review_required",
        agentCompletionPolicySource: "project",
      }],
    });

    await svc.importBundle(
      buildInlineSource(manifest, {
        company: true,
        agents: false,
        projects: false,
        issues: true,
      }),
      "user-1",
    );

    expect(issueCreateCalls[0]!.data.completionPolicySnapshot).toMatchObject({
      source: "legacy_backfill",
      sourceId: null,
    });
  });

  it("defers policy defaults for projects created in an existing company", async () => {
    resetState();
    const governancePatches: Array<Record<string, unknown>> = [];
    const localSvc = companyPortabilityService({
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      transaction: async (callback: (tx: any) => Promise<unknown>) => callback({
        update: () => ({
          set: (patch: Record<string, unknown>) => {
            governancePatches.push(patch);
            return { where: () => Promise.resolve(undefined) };
          },
        }),
      }),
    } as any);
    const manifest = baseManifest({
      includes: { company: false, agents: false, projects: true, issues: false },
      company: null,
      projects: [{
        slug: "new-department",
        name: "New Department",
        type: "department",
        agentCompletionPolicyDefault: "agent_can_complete",
      }],
      issues: [],
    });

    await localSvc.importBundle({
      source: { type: "inline", manifest, files: {} },
      target: { mode: "existing_company", companyId: TGT_CO_ID },
      include: {
        company: false,
        agents: false,
        projects: true,
        issues: false,
        skills: false,
        routines: false,
        envInputs: false,
        internalAgentConfig: false,
        budgetPolicies: false,
        costEvents: false,
        financeEvents: false,
        quotaWindows: false,
        workflowTemplates: false,
      },
    }, "user-1");

    expect(projectCreateCalls[0]!.data).not.toHaveProperty("agentCompletionPolicyDefault");
    expect(governancePatches).toContainEqual(expect.objectContaining({
      agentCompletionPolicyDefault: "agent_can_complete",
    }));
  });

  it("defers existing-company completion governance changes until the import succeeds", async () => {
    resetState();
    issueCreateError = new Error("later import failure");
    const governanceTransaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback({}));
    const localSvc = companyPortabilityService({
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      transaction: governanceTransaction,
    } as any);
    const manifest = baseManifest({
      includes: { company: true, agents: false, projects: false, issues: true },
      company: {
        path: "COMPANY.md",
        name: "Source Co",
        description: null,
        brandColor: null,
        requireBoardApprovalForNewAgents: true,
        agentCompletionPolicyDefault: "agent_can_complete",
        agentCompletionReviewGuardrail: true,
      },
      issues: [{ slug: "fails-later", title: "Fails later" }],
    });

    await expect(localSvc.importBundle({
      source: { type: "inline", manifest, files: { "COMPANY.md": "" } },
      target: { mode: "existing_company", companyId: TGT_CO_ID },
      include: {
        company: true,
        agents: false,
        projects: false,
        issues: true,
        skills: false,
        routines: false,
        envInputs: false,
        internalAgentConfig: false,
        budgetPolicies: false,
        costEvents: false,
        financeEvents: false,
        quotaWindows: false,
        workflowTemplates: false,
      },
    }, "user-1")).rejects.toThrow("later import failure");

    expect(governanceTransaction).not.toHaveBeenCalled();
  });

  it("importBundle warns when assigneeAgentSlug is not found in bundle's agent list", async () => {
    resetState();
    const manifest = baseManifest({
      includes: { company: true, agents: true, projects: false, issues: true },
      agents: [],
      issues: [
        {
          slug: "src-1",
          title: "Orphan",
          assigneeAgentSlug: "ghost",
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(manifest, {
        company: true,
        agents: true,
        projects: false,
        issues: true,
      }),
      "user-1",
    );
    expect(issueCreateCalls).toHaveLength(1);
    expect(issueCreateCalls[0]!.data.assigneeAgentId).toBeNull();
    expect(result.warnings.some((w) => w.kind === "skipped_update" && /ghost/.test(w.message))).toBe(true);
  });

  it("importBundle warns when assigneeUserEmail does not map to existing user (leaves unassigned)", async () => {
    resetState();
    const manifest = baseManifest({
      includes: { company: true, agents: false, projects: false, issues: true },
      issues: [
        {
          slug: "src-1",
          title: "No user",
          assigneeUserEmail: "unknown@example.com",
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(manifest, {
        company: true,
        agents: false,
        projects: false,
        issues: true,
      }),
      "user-1",
    );
    expect(issueCreateCalls).toHaveLength(1);
    expect(issueCreateCalls[0]!.data.assigneeUserId).toBeNull();
    expect(result.warnings.some((w) => w.kind === "skipped_update" && /unknown@example\.com/.test(w.message))).toBe(true);
  });

  it("importBundle warns and skips recurring issues (routines handled by E.1.4)", async () => {
    resetState();
    const manifest = baseManifest({
      includes: { company: true, agents: false, projects: false, issues: true },
      issues: [
        {
          slug: "daily",
          title: "Daily standup",
          recurring: true,
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(manifest, {
        company: true,
        agents: false,
        projects: false,
        issues: true,
      }),
      "user-1",
    );
    expect(issueCreateCalls).toHaveLength(0);
    expect(result.warnings.some((w) => w.kind === "deprecated_field" && /recurring/i.test(w.message))).toBe(true);
  });

  it("importBundle warns when labelNames are present (labels import deferred)", async () => {
    resetState();
    const manifest = baseManifest({
      includes: { company: true, agents: false, projects: false, issues: true },
      issues: [
        {
          slug: "src-1",
          title: "With labels",
          labelNames: ["bug", "urgent"],
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(manifest, {
        company: true,
        agents: false,
        projects: false,
        issues: true,
      }),
      "user-1",
    );
    expect(issueCreateCalls).toHaveLength(1);
    expect(result.warnings.some((w) => w.kind === "deprecated_field" && /label/i.test(w.message))).toBe(true);
  });

  it("previewImport includes issuePlans entries for each manifest issue", async () => {
    resetState();
    const manifest = baseManifest({
      includes: { company: true, agents: false, projects: false, issues: true },
      issues: [
        { slug: "a", title: "A" },
        { slug: "b", title: "B" },
      ],
    });
    const preview = await svc.previewImport(
      buildInlineSource(manifest, {
        company: true,
        agents: false,
        projects: false,
        issues: true,
      }),
    );
    expect(preview.plan.issuePlans).toHaveLength(2);
    expect(preview.plan.issuePlans.map((p) => p.slug).sort()).toEqual(["a", "b"]);
  });

  it("export → import roundtrip yields zero unknown_section warnings for issues", async () => {
    resetState();
    sourceProjects = [makeProject({ id: "p1", name: "Engineering", type: "department" })];
    sourceAgents = [makeAgent({ id: "a1", name: "Alice" })];
    sourceIssues = [
      makeIssue({
        id: "i1",
        title: "Fix login bug",
        identifier: "SRC-1",
        status: "todo",
        priority: "high",
        projectId: "p1",
        assigneeAgentId: "a1",
      }),
    ];
    const exported = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: true, projects: true, issues: true },
    });
    const result = await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest: exported.manifest,
          files: {
            ...exported.files,
          },
        },
        target: { mode: "new_company", newCompanyName: "Clone Co" },
        include: { company: true, agents: true, projects: true, issues: true },
      },
      "user-1",
    );
    expect(result.warnings.filter((w) => w.kind === "unknown_section" && w.section === "issues")).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.action).toBe("created");
  });

  it("importBundle normalizes invalid status to 'backlog'", async () => {
    resetState();
    const manifest = baseManifest({
      includes: { company: true, agents: false, projects: false, issues: true },
      issues: [
        { slug: "src-1", title: "Weird", status: "not-a-status" },
      ],
    });
    await svc.importBundle(
      buildInlineSource(manifest, {
        company: true,
        agents: false,
        projects: false,
        issues: true,
      }),
      "user-1",
    );
    expect(issueCreateCalls).toHaveLength(1);
    expect(issueCreateCalls[0]!.data.status).toBe("backlog");
  });
});
