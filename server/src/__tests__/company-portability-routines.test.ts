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

type TriggerRow = {
  id: string;
  companyId: string;
  routineId: string;
  kind: "schedule" | "webhook" | "api";
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  signingMode: "bearer" | "hmac_sha256" | null;
  replayWindowSec: number | null;
  publicId: string;
  secretId: string | null;
};

const SRC_CO_ID = "11111111-1111-4111-8111-111111111111";
const TGT_CO_ID = "22222222-2222-4222-8222-222222222222";

const companyStore: Record<string, { id: string; name: string; requireBoardApprovalForNewAgents?: boolean }> = {
  [SRC_CO_ID]: { id: SRC_CO_ID, name: "Source Co", requireBoardApprovalForNewAgents: true },
  [TGT_CO_ID]: { id: TGT_CO_ID, name: "Target Co", requireBoardApprovalForNewAgents: true },
};

let sourceProjects: ProjectRow[] = [];
let targetProjects: ProjectRow[] = [];
let sourceAgents: AgentRow[] = [];
let targetAgents: AgentRow[] = [];
let sourceRoutines: RoutineRow[] = [];
let sourceTriggers: TriggerRow[] = [];
let targetRoutines: RoutineRow[] = [];
let targetTriggers: TriggerRow[] = [];
const routineCreateCalls: Array<{ companyId: string; input: any; actor: any }> = [];
const routineUpdateCalls: Array<{ id: string; patch: any }> = [];
const triggerCreateCalls: Array<{ routineId: string; input: any }> = [];

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getById: vi.fn(async (id: string) => companyStore[id] ?? null),
    create: vi.fn(async (input: { name: string }) => ({ id: "new-co", name: input.name })),
    update: vi.fn(async (id: string, patch: any) => ({ id, name: patch.name ?? companyStore[id]?.name ?? "Co" })),
  }),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    backfillHumanAtTop: vi.fn(async () => undefined),
    list: vi.fn(async (companyId: string) => {
      if (companyId === SRC_CO_ID) return sourceAgents;
      if (companyId === TGT_CO_ID) return targetAgents;
      return [];
    }),
    create: vi.fn(),
    update: vi.fn(),
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
    create: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    list: vi.fn(async () => []),
    create: vi.fn(),
  }),
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => ({
    listFull: vi.fn(async () => []),
    upsertImportedSkills: vi.fn(async () => []),
  }),
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => ({
    listForExport: vi.fn(async (companyId: string) => {
      if (companyId !== SRC_CO_ID) return [];
      return sourceRoutines.map((routine) => ({
        routine,
        triggers: sourceTriggers.filter((t) => t.routineId === routine.id),
      }));
    }),
    list: vi.fn(async (companyId: string) => {
      if (companyId === TGT_CO_ID) return targetRoutines;
      if (companyId === SRC_CO_ID) return sourceRoutines;
      return [];
    }),
    create: vi.fn(async (companyId: string, input: any, actor: any) => {
      routineCreateCalls.push({ companyId, input, actor });
      const row: RoutineRow = {
        id: `new-routine-${targetRoutines.length + 1}`,
        companyId,
        projectId: input.projectId,
        goalId: input.goalId ?? null,
        parentIssueId: input.parentIssueId ?? null,
        title: input.title,
        description: input.description ?? null,
        assigneeAgentId: input.assigneeAgentId,
        priority: input.priority ?? "medium",
        status: (input.status ?? "active") as RoutineRow["status"],
        concurrencyPolicy: (input.concurrencyPolicy ?? "coalesce_if_active") as RoutineRow["concurrencyPolicy"],
        catchUpPolicy: (input.catchUpPolicy ?? "skip_missed") as RoutineRow["catchUpPolicy"],
        variables: input.variables ?? [],
        latestRevisionId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      targetRoutines.push(row);
      return row;
    }),
    update: vi.fn(async (id: string, patch: any) => {
      routineUpdateCalls.push({ id, patch });
      const row = targetRoutines.find((r) => r.id === id) ?? null;
      if (row) Object.assign(row, patch);
      return row;
    }),
    createTrigger: vi.fn(async (routineId: string, input: any) => {
      triggerCreateCalls.push({ routineId, input });
      const row: TriggerRow = {
        id: `new-trigger-${targetTriggers.length + 1}`,
        companyId: TGT_CO_ID,
        routineId,
        kind: input.kind,
        label: input.label ?? null,
        enabled: true,
        cronExpression: input.kind === "schedule" ? input.cronExpression : null,
        timezone: input.kind === "schedule" ? (input.timezone ?? "UTC") : null,
        signingMode: input.kind === "webhook" ? (input.signingMode ?? "hmac_sha256") : null,
        replayWindowSec: input.kind === "webhook" ? (input.replayWindowSec ?? 300) : null,
        publicId: input.kind === "webhook" ? `pub-${targetTriggers.length + 1}` : "",
        secretId: input.kind === "webhook" ? `secret-${targetTriggers.length + 1}` : null,
      };
      targetTriggers.push(row);
      return { trigger: row, secretMaterial: null };
    }),
  }),
}));

import { companyPortabilityService } from "../services/company-portability.js";
import type { CompanyPortabilityManifest } from "@armyofagents/shared";

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
    createdAt: "2026-04-20T00:00:00Z",
    updatedAt: "2026-04-20T00:00:00Z",
    ...overrides,
  };
}

function makeTrigger(overrides: Partial<TriggerRow> & { id: string; routineId: string; kind: TriggerRow["kind"] }): TriggerRow {
  return {
    companyId: SRC_CO_ID,
    label: null,
    enabled: true,
    cronExpression: null,
    timezone: null,
    signingMode: null,
    replayWindowSec: null,
    publicId: "",
    secretId: null,
    ...overrides,
  };
}

function baseManifest(overrides: Partial<CompanyPortabilityManifest> = {}): CompanyPortabilityManifest {
  return {
    schemaVersion: 2,
    generatedAt: "2026-04-21T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: false, projects: false, issues: false, skills: false, routines: true },
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
  include: Partial<{
    company: boolean;
    agents: boolean;
    projects: boolean;
    issues: boolean;
    skills: boolean;
    routines: boolean;
  }> = { company: true, agents: false, projects: false, issues: false, skills: false, routines: true },
  files: Record<string, string> = { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
  target: { mode: "new_company"; newCompanyName?: string | null } | { mode: "existing_company"; companyId: string } = {
    mode: "new_company" as const,
    newCompanyName: "Imported Co",
  },
  collisionStrategy?: "rename" | "skip" | "replace",
) {
  return {
    source: { type: "inline" as const, manifest, files },
    target,
    include,
    ...(collisionStrategy ? { collisionStrategy } : {}),
  };
}

function resetState() {
  sourceProjects = [];
  targetProjects = [];
  sourceAgents = [];
  targetAgents = [];
  sourceRoutines = [];
  sourceTriggers = [];
  targetRoutines = [];
  targetTriggers = [];
  routineCreateCalls.length = 0;
  routineUpdateCalls.length = 0;
  triggerCreateCalls.length = 0;
}

describe("company-portability routines", () => {
  const svc = companyPortabilityService({ select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as any);

  it("exportBundle with include.routines=true serializes routines with triggers + variables", async () => {
    resetState();
    sourceProjects = [makeProject({ id: "p1", name: "Engineering", type: "department" })];
    sourceAgents = [makeAgent({ id: "a1", name: "Ada" })];
    sourceRoutines = [
      makeRoutine({
        id: "r1",
        title: "Daily digest",
        projectId: "p1",
        assigneeAgentId: "a1",
        description: "Send daily summary",
        agentCompletionPolicyOverride: "agent_can_complete",
        variables: [
          { name: "AUDIENCE", label: "Audience", type: "text", defaultValue: "team", required: true, options: [] },
        ],
      }),
    ];
    sourceTriggers = [
      makeTrigger({
        id: "t1",
        routineId: "r1",
        kind: "schedule",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        label: "Morning run",
      }),
    ];

    const result = await svc.exportBundle(SRC_CO_ID, { include: { routines: true } });
    expect(result.manifest.routines).toHaveLength(1);
    const routine = result.manifest.routines![0]!;
    expect(routine.title).toBe("Daily digest");
    expect(routine.description).toBe("Send daily summary");
    expect(routine.projectSlug).toBe("engineering");
    expect(routine.assigneeAgentSlug).toBe("ada");
    expect(routine.status).toBe("active");
    expect(routine.concurrencyPolicy).toBe("coalesce_if_active");
    expect(routine.catchUpPolicy).toBe("skip_missed");
    expect(routine.agentCompletionPolicyOverride).toBe("agent_can_complete");
    expect(routine.variables).toHaveLength(1);
    expect(routine.variables[0]!.name).toBe("AUDIENCE");
    expect(routine.variables[0]!.defaultValue).toBe("team");
    expect(routine.triggers).toHaveLength(1);
    expect(routine.triggers[0]!.kind).toBe("schedule");
    expect(routine.triggers[0]!.cronExpression).toBe("0 9 * * *");
    expect(routine.triggers[0]!.timezone).toBe("UTC");
  });

  it("exportBundle omits routines by default (DEFAULT_INCLUDE.routines=false)", async () => {
    resetState();
    sourceProjects = [makeProject({ id: "p1", name: "Eng" })];
    sourceAgents = [makeAgent({ id: "a1", name: "Ada" })];
    sourceRoutines = [makeRoutine({ id: "r1", title: "Any", projectId: "p1", assigneeAgentId: "a1" })];
    const result = await svc.exportBundle(SRC_CO_ID, {});
    expect(result.manifest.routines).toBeUndefined();
    expect(result.manifest.includes.routines).toBe(false);
  });

  it("exportBundle bumps schemaVersion to 2 when routines included", async () => {
    resetState();
    sourceProjects = [makeProject({ id: "p1", name: "Eng" })];
    sourceAgents = [makeAgent({ id: "a1", name: "Ada" })];
    sourceRoutines = [makeRoutine({ id: "r1", title: "Any", projectId: "p1", assigneeAgentId: "a1" })];
    const withRoutines = await svc.exportBundle(SRC_CO_ID, { include: { routines: true } });
    expect(withRoutines.manifest.schemaVersion).toBe(2);

    const without = await svc.exportBundle(SRC_CO_ID, {});
    expect(without.manifest.schemaVersion).toBe(1);
  });

  it("exportBundle serializes webhook trigger with signingMode + replayWindowSec", async () => {
    resetState();
    sourceProjects = [makeProject({ id: "p1", name: "Eng" })];
    sourceAgents = [makeAgent({ id: "a1", name: "Ada" })];
    sourceRoutines = [makeRoutine({ id: "r1", title: "Webhook routine", projectId: "p1", assigneeAgentId: "a1" })];
    sourceTriggers = [
      makeTrigger({
        id: "t1",
        routineId: "r1",
        kind: "webhook",
        signingMode: "hmac_sha256",
        replayWindowSec: 300,
        publicId: "pub123",
        secretId: "sec1",
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { routines: true } });
    const trigger = result.manifest.routines![0]!.triggers[0]!;
    expect(trigger.kind).toBe("webhook");
    expect(trigger.signingMode).toBe("hmac_sha256");
    expect(trigger.replayWindowSec).toBe(300);
    expect(trigger.publicId).toBe("pub123");
  });

  it("importBundle creates routines with resolved project + assignee from slug maps", async () => {
    resetState();
    targetProjects = [makeProject({ id: "tp1", companyId: TGT_CO_ID, name: "Engineering" })];
    targetAgents = [makeAgent({ id: "ta1", companyId: TGT_CO_ID, name: "Ada" })];

    const manifest = baseManifest({
      routines: [
        {
          slug: "daily-digest",
          title: "Daily digest",
          description: null,
          status: "active",
          priority: "medium",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          agentCompletionPolicyOverride: "review_required",
          projectSlug: "engineering",
          assigneeAgentSlug: "ada",
          variables: [],
          triggers: [
            {
              kind: "schedule",
              label: null,
              enabled: true,
              cronExpression: "0 9 * * *",
              timezone: "UTC",
            },
          ],
        },
      ],
    });

    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: false, routines: true },
        { "COMPANY.md": "" },
        { mode: "existing_company", companyId: TGT_CO_ID },
      ),
      "user-1",
    );
    expect(routineCreateCalls).toHaveLength(1);
    const createdRoutine = routineCreateCalls[0]!.input;
    expect(createdRoutine.title).toBe("Daily digest");
    expect(createdRoutine.projectId).toBe("tp1");
    expect(createdRoutine.assigneeAgentId).toBe("ta1");
    expect(createdRoutine.status).toBe("active");
    expect(createdRoutine.agentCompletionPolicyOverride).toBe("review_required");
    expect(triggerCreateCalls).toHaveLength(1);
    expect(triggerCreateCalls[0]!.input.kind).toBe("schedule");
    expect(triggerCreateCalls[0]!.input.cronExpression).toBe("0 9 * * *");
    expect(result.routines).toHaveLength(1);
    expect(result.routines[0]!.action).toBe("created");
  });

  it("importBundle preserves variables jsonb roundtrip (Phase A.6 regression check)", async () => {
    resetState();
    targetProjects = [makeProject({ id: "tp1", companyId: TGT_CO_ID, name: "Engineering" })];
    targetAgents = [makeAgent({ id: "ta1", companyId: TGT_CO_ID, name: "Ada" })];

    const manifest = baseManifest({
      routines: [
        {
          slug: "r1",
          title: "R1",
          status: "active",
          priority: "medium",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          projectSlug: "engineering",
          assigneeAgentSlug: "ada",
          variables: [
            { name: "COUNT", label: "How many", type: "number", defaultValue: 5, required: true, options: [] },
            { name: "FLAG", label: null, type: "boolean", defaultValue: false, required: false, options: [] },
            { name: "MODE", label: "Mode", type: "select", defaultValue: "a", required: true, options: ["a", "b"] },
          ],
          triggers: [],
        },
      ],
    });
    await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: false, routines: true },
        { "COMPANY.md": "" },
        { mode: "existing_company", companyId: TGT_CO_ID },
      ),
      "user-1",
    );
    const vars = routineCreateCalls[0]!.input.variables;
    expect(vars).toHaveLength(3);
    expect(vars[0].type).toBe("number");
    expect(vars[0].defaultValue).toBe(5);
    expect(vars[1].type).toBe("boolean");
    expect(vars[1].defaultValue).toBe(false);
    expect(vars[2].type).toBe("select");
    expect(vars[2].options).toEqual(["a", "b"]);
  });

  it("importBundle warns + skips routine when projectSlug unresolved", async () => {
    resetState();
    targetAgents = [makeAgent({ id: "ta1", companyId: TGT_CO_ID, name: "Ada" })];
    const manifest = baseManifest({
      routines: [
        {
          slug: "r1",
          title: "Orphaned",
          status: "active",
          priority: "medium",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          projectSlug: "nonexistent",
          assigneeAgentSlug: "ada",
          variables: [],
          triggers: [],
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: false, routines: true },
        { "COMPANY.md": "" },
        { mode: "existing_company", companyId: TGT_CO_ID },
      ),
      "user-1",
    );
    expect(routineCreateCalls).toHaveLength(0);
    expect(result.routines[0]!.action).toBe("skipped");
    expect(result.warnings.some((w) => /nonexistent/.test(w.message) || /project/.test(w.message))).toBe(true);
  });

  it("importBundle warns + skips routine when assigneeAgentSlug unresolved", async () => {
    resetState();
    targetProjects = [makeProject({ id: "tp1", companyId: TGT_CO_ID, name: "Engineering" })];
    const manifest = baseManifest({
      routines: [
        {
          slug: "r1",
          title: "Orphaned",
          status: "active",
          priority: "medium",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          projectSlug: "engineering",
          assigneeAgentSlug: "ghost",
          variables: [],
          triggers: [],
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: false, routines: true },
        { "COMPANY.md": "" },
        { mode: "existing_company", companyId: TGT_CO_ID },
      ),
      "user-1",
    );
    expect(routineCreateCalls).toHaveLength(0);
    expect(result.routines[0]!.action).toBe("skipped");
    expect(result.warnings.some((w) => /ghost/.test(w.message) || /agent/.test(w.message))).toBe(true);
  });

  it("importBundle with collisionStrategy=skip skips existing routine by (projectSlug,title)", async () => {
    resetState();
    targetProjects = [makeProject({ id: "tp1", companyId: TGT_CO_ID, name: "Engineering" })];
    targetAgents = [makeAgent({ id: "ta1", companyId: TGT_CO_ID, name: "Ada" })];
    targetRoutines = [
      makeRoutine({
        id: "existing-r1",
        companyId: TGT_CO_ID,
        title: "Daily digest",
        projectId: "tp1",
        assigneeAgentId: "ta1",
      }),
    ];

    const manifest = baseManifest({
      routines: [
        {
          slug: "r1",
          title: "Daily digest",
          status: "active",
          priority: "medium",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          projectSlug: "engineering",
          assigneeAgentSlug: "ada",
          variables: [],
          triggers: [],
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: false, routines: true },
        { "COMPANY.md": "" },
        { mode: "existing_company", companyId: TGT_CO_ID },
        "skip",
      ),
      "user-1",
    );
    expect(routineCreateCalls).toHaveLength(0);
    expect(result.routines[0]!.action).toBe("skipped");
  });

  it("importBundle with collisionStrategy=rename creates a renamed routine on collision", async () => {
    resetState();
    targetProjects = [makeProject({ id: "tp1", companyId: TGT_CO_ID, name: "Engineering" })];
    targetAgents = [makeAgent({ id: "ta1", companyId: TGT_CO_ID, name: "Ada" })];
    targetRoutines = [
      makeRoutine({
        id: "existing-r1",
        companyId: TGT_CO_ID,
        title: "Daily digest",
        projectId: "tp1",
        assigneeAgentId: "ta1",
      }),
    ];

    const manifest = baseManifest({
      routines: [
        {
          slug: "r1",
          title: "Daily digest",
          status: "active",
          priority: "medium",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          projectSlug: "engineering",
          assigneeAgentSlug: "ada",
          variables: [],
          triggers: [],
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: false, routines: true },
        { "COMPANY.md": "" },
        { mode: "existing_company", companyId: TGT_CO_ID },
        "rename",
      ),
      "user-1",
    );
    expect(routineCreateCalls).toHaveLength(1);
    expect(routineCreateCalls[0]!.input.title).not.toBe("Daily digest");
    expect(routineCreateCalls[0]!.input.title.startsWith("Daily digest")).toBe(true);
    expect(result.routines[0]!.action).toBe("created");
  });

  it("importBundle with collisionStrategy=replace updates existing routine", async () => {
    resetState();
    targetProjects = [makeProject({ id: "tp1", companyId: TGT_CO_ID, name: "Engineering" })];
    targetAgents = [makeAgent({ id: "ta1", companyId: TGT_CO_ID, name: "Ada" })];
    targetRoutines = [
      makeRoutine({
        id: "existing-r1",
        companyId: TGT_CO_ID,
        title: "Daily digest",
        projectId: "tp1",
        assigneeAgentId: "ta1",
        description: "old desc",
      }),
    ];

    const manifest = baseManifest({
      routines: [
        {
          slug: "r1",
          title: "Daily digest",
          description: "new desc",
          status: "active",
          priority: "medium",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          projectSlug: "engineering",
          assigneeAgentSlug: "ada",
          variables: [],
          triggers: [],
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: false, routines: true },
        { "COMPANY.md": "" },
        { mode: "existing_company", companyId: TGT_CO_ID },
        "replace",
      ),
      "user-1",
    );
    expect(routineUpdateCalls).toHaveLength(1);
    expect(routineUpdateCalls[0]!.id).toBe("existing-r1");
    expect(routineUpdateCalls[0]!.patch.description).toBe("new desc");
    expect(routineUpdateCalls[0]!.patch).not.toHaveProperty("agentCompletionPolicyOverride");
    expect(result.routines[0]!.action).toBe("updated");
  });

  it("importBundle creates a trigger for each trigger entry on routine", async () => {
    resetState();
    targetProjects = [makeProject({ id: "tp1", companyId: TGT_CO_ID, name: "Engineering" })];
    targetAgents = [makeAgent({ id: "ta1", companyId: TGT_CO_ID, name: "Ada" })];
    const manifest = baseManifest({
      routines: [
        {
          slug: "r1",
          title: "Multi-trigger",
          status: "active",
          priority: "medium",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          projectSlug: "engineering",
          assigneeAgentSlug: "ada",
          variables: [],
          triggers: [
            { kind: "schedule", label: "Morning", enabled: true, cronExpression: "0 9 * * *", timezone: "UTC" },
            { kind: "webhook", label: "Hook", enabled: true, signingMode: "hmac_sha256", replayWindowSec: 300 },
            { kind: "api", label: "API", enabled: true },
          ],
        },
      ],
    });
    await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: false, routines: true },
        { "COMPANY.md": "" },
        { mode: "existing_company", companyId: TGT_CO_ID },
      ),
      "user-1",
    );
    expect(triggerCreateCalls).toHaveLength(3);
    expect(triggerCreateCalls.map((c) => c.input.kind)).toEqual(["schedule", "webhook", "api"]);
  });

  it("KNOWN_SECTIONS includes routines (no unknown_section warning for routines)", async () => {
    resetState();
    targetProjects = [makeProject({ id: "tp1", companyId: TGT_CO_ID, name: "Eng" })];
    const manifest = baseManifest({
      routines: [],
    });
    const result = await svc.previewImport(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: false, routines: true },
        { "COMPANY.md": "" },
        { mode: "existing_company", companyId: TGT_CO_ID },
      ),
    );
    expect(result.warnings.some((w) => w.kind === "unknown_section" && w.section === "routines")).toBe(false);
  });
});
