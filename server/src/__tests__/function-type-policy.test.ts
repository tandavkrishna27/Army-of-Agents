import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB table stubs ────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  sql: new Proxy(() => ({ sql: true }), {
    get: () => () => ({ sql: true }),
    apply: () => ({ sql: true }),
  }),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    workflowTemplates: makeTable("workflow_templates"),
    issues: makeTable("issues"),
    taskDependencies: makeTable("task_dependencies"),
  };
});

// ── Mock execution workspace service ─────────────────────────────────────────

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: vi.fn(() => mockExecutionWorkspaceService),
}));

vi.mock("../services/agent-completion-policy.js", () => ({
  resolveAgentCompletionPolicy: vi.fn().mockResolvedValue({
    policy: "review_required",
    source: "company",
    sourceId: "company-1",
    guardrailApplied: false,
    resolvedAt: new Date("2026-07-11T00:00:00.000Z"),
  }),
}));

import { workflowTemplateService } from "../services/workflow-templates.js";

// ── Mock DB helpers ───────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  updates?: MockRow[][];
  deletes?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  let deleteIdx = 0;

  function makeChain(getResult: () => MockRow[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin", "values", "set", "returning"];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  const makeTx = () => ({
    select: (_fields?: unknown) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (_table: unknown) => makeChain(() => config.inserts?.[insertIdx++] ?? []),
    update: (_table: unknown) => makeChain(() => config.updates?.[updateIdx++] ?? []),
    delete: (_table: unknown) => makeChain(() => config.deletes?.[deleteIdx++] ?? []),
    execute: async (..._args: unknown[]) => [],
  });

  return {
    select: (_fields?: unknown) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (_table: unknown) => makeChain(() => config.inserts?.[insertIdx++] ?? []),
    update: (_table: unknown) => makeChain(() => config.updates?.[updateIdx++] ?? []),
    delete: (_table: unknown) => makeChain(() => config.deletes?.[deleteIdx++] ?? []),
    execute: async (..._args: unknown[]) => [],
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const templateId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const goalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const projectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const workspaceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const task1Id = "11111111-1111-4111-8111-111111111111";
const task2Id = "22222222-2222-4222-8222-222222222222";

// ── Suite 1: executionWorkspacePolicy auto-configuration ──────────────────────

/**
 * Mirrors the inline policy-derivation logic from
 * `router.post("/companies/:companyId/projects")`.
 */
function derivePolicyForDepartment(
  functionType: string | undefined,
  existingPolicy?: unknown,
) {
  if (existingPolicy) return existingPolicy;
  if (functionType === "software_development") {
    return {
      enabled: true,
      defaultMode: "isolated_workspace",
      allowIssueOverride: true,
      workspaceStrategy: { type: "git_worktree", baseRef: "main" },
    };
  }
  return {
    enabled: true,
    defaultMode: "isolated_workspace",
    allowIssueOverride: true,
  };
}

describe("executionWorkspacePolicy auto-configuration", () => {
  it("software_development gets git_worktree strategy", () => {
    const policy = derivePolicyForDepartment("software_development") as {
      workspaceStrategy: { type: string; baseRef: string };
    };
    expect(policy.workspaceStrategy).toBeDefined();
    expect(policy.workspaceStrategy.type).toBe("git_worktree");
    expect(policy.workspaceStrategy.baseRef).toBe("main");
  });

  it("marketing gets isolated_workspace without git strategy", () => {
    const policy = derivePolicyForDepartment("marketing") as Record<string, unknown>;
    expect(policy.enabled).toBe(true);
    expect(policy.defaultMode).toBe("isolated_workspace");
    expect(policy.workspaceStrategy).toBeUndefined();
  });

  it("general gets isolated_workspace without git strategy", () => {
    const policy = derivePolicyForDepartment("general") as Record<string, unknown>;
    expect(policy.enabled).toBe(true);
    expect(policy.defaultMode).toBe("isolated_workspace");
    expect(policy.workspaceStrategy).toBeUndefined();
  });

  it("existing policy is not overridden", () => {
    const existing = { enabled: false };
    const policy = derivePolicyForDepartment("software_development", existing);
    expect(policy).toBe(existing);
    expect((policy as { enabled: boolean }).enabled).toBe(false);
  });

  it("undefined functionType gets default policy without git strategy", () => {
    const policy = derivePolicyForDepartment(undefined) as Record<string, unknown>;
    expect(policy.enabled).toBe(true);
    expect(policy.defaultMode).toBe("isolated_workspace");
    expect(policy.allowIssueOverride).toBe(true);
    expect(policy.workspaceStrategy).toBeUndefined();
  });
});

// ── Suite 2: workspaceMode shared ────────────────────────────────────────────

describe("workspaceMode shared creates shared execution workspace on instantiation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates one workspace and links all tasks when workspaceMode is shared", async () => {
    const baseTemplate = {
      id: templateId,
      companyId,
      name: "Feature Pipeline",
      workspaceMode: "shared",
      steps: [
        { order: 1, title: "Design", priority: "medium" },
        { order: 2, title: "Implement", priority: "high" },
      ],
      dependencies: [{ fromStep: 1, toStep: 2 }],
    };

    const db = createSequenceDb({
      // 1st select: fetch template
      selects: [[baseTemplate]],
      // inserts: task 1, task 2, task dependency (template counter goes in updates)
      inserts: [
        [{ id: task1Id, title: "Design" }],
        [{ id: task2Id, title: "Implement" }],
        [{ id: "dep-id" }],
      ],
      updates: [
        // workflowTemplates instantiationCount update (inside tx)
        [{ ...baseTemplate, instantiationCount: 1 }],
        // issues executionWorkspaceId update (outside tx)
        [],
      ],
    });

    const fakeWorkspace = { id: workspaceId, name: "Feature Pipeline" };
    mockExecutionWorkspaceService.create.mockResolvedValueOnce(fakeWorkspace);

    const svc = workflowTemplateService(db as never);
    const result = await svc.instantiate(companyId, templateId, goalId, projectId);

    // Workspace was created with correct shape
    expect(mockExecutionWorkspaceService.create).toHaveBeenCalledOnce();
    const createCall = mockExecutionWorkspaceService.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(createCall.companyId).toBe(companyId);
    expect(createCall.projectId).toBe(projectId);
    expect(createCall.mode).toBe("shared_workspace");
    expect(createCall.strategyType).toBe("project_primary");
    expect(createCall.status).toBe("active");
    expect(createCall.sourceIssueId).toBe(task1Id);

    // Result includes sharedWorkspaceId
    expect(result.sharedWorkspaceId).toBe(workspaceId);
    expect(result.tasksCreated).toHaveLength(2);
  });

  it("does not create shared workspace when workspaceMode is department_default", async () => {
    const baseTemplate = {
      id: templateId,
      companyId,
      name: "Simple Pipeline",
      workspaceMode: "department_default",
      steps: [{ order: 1, title: "Do work", priority: "medium" }],
      dependencies: [],
    };

    const db = createSequenceDb({
      selects: [[baseTemplate]],
      inserts: [
        [{ id: task1Id, title: "Do work" }],
      ],
      updates: [
        [{ ...baseTemplate, instantiationCount: 1 }],
      ],
    });

    const svc = workflowTemplateService(db as never);
    const result = await svc.instantiate(companyId, templateId, goalId, projectId);

    expect(mockExecutionWorkspaceService.create).not.toHaveBeenCalled();
    expect(result.sharedWorkspaceId).toBeUndefined();
    expect(result.tasksCreated).toHaveLength(1);
  });

  it("throws error if workspace creation fails", async () => {
    const baseTemplate = {
      id: templateId,
      companyId,
      name: "Failing Pipeline",
      workspaceMode: "shared",
      steps: [{ order: 1, title: "Step one", priority: "medium" }],
      dependencies: [],
    };

    const db = createSequenceDb({
      selects: [[baseTemplate]],
      inserts: [
        [{ id: task1Id, title: "Step one" }],
      ],
      updates: [
        [{ ...baseTemplate, instantiationCount: 1 }],
      ],
    });

    // Workspace creation returns null → service should throw
    mockExecutionWorkspaceService.create.mockResolvedValueOnce(null);

    const svc = workflowTemplateService(db as never);
    await expect(
      svc.instantiate(companyId, templateId, goalId, projectId),
    ).rejects.toThrow("Failed to create shared execution workspace");
  });

  it("throws notFound when template does not exist", async () => {
    // DB returns empty array for template select → rows[0] is undefined → null
    const db = createSequenceDb({
      selects: [[]],
    });

    const svc = workflowTemplateService(db as never);
    await expect(
      svc.instantiate(companyId, templateId, goalId, projectId),
    ).rejects.toThrow(/not found/i);
  });
});
