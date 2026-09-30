import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueCreate = vi.fn();
const mockMemoryCreate = vi.fn();
const mockFeedbackRunAllDetectors = vi.fn();
const {
  mockEmitHubItem,
  mockBuildSuggestionHubEmit,
  mockReconcile,
} = vi.hoisted(() => ({
  mockEmitHubItem: vi.fn(),
  mockBuildSuggestionHubEmit: vi.fn((suggestion) => ({ sourceType: "suggestion", sourceId: suggestion.id })),
  mockReconcile: vi.fn(),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
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
    agents: makeTable("agents"),
    companies: makeTable("companies"),
    goals: makeTable("goals"),
    issues: makeTable("issues"),
    memoryFeedbackPatterns: makeTable("memory_feedback_patterns"),
    memoryItems: makeTable("memory_items"),
    projects: makeTable("projects"),
    suggestions: makeTable("suggestions"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  desc: (..._args: unknown[]) => "desc",
  eq: (..._args: unknown[]) => "eq",
  inArray: (..._args: unknown[]) => "inArray",
  isNull: (..._args: unknown[]) => "isNull",
  lt: (..._args: unknown[]) => "lt",
  notInArray: (..._args: unknown[]) => "notInArray",
  or: (..._args: unknown[]) => "or",
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    create: mockIssueCreate,
  }),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: () => ({
    create: mockMemoryCreate,
  }),
}));

vi.mock("../services/memory-feedback.js", () => ({
  memoryFeedbackService: () => ({
    runAllDetectors: mockFeedbackRunAllDetectors,
  }),
}));

vi.mock("../services/hub-source-producers.js", () => ({
  buildSuggestionHubEmit: mockBuildSuggestionHubEmit,
  emitHubItem: mockEmitHubItem,
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: () => ({
    reconcile: mockReconcile,
  }),
}));

import { suggestionService } from "../services/suggestions.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  updates?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  const insertValues: unknown[] = [];
  const updateSets: unknown[] = [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "groupBy", "orderBy", "limit", "values", "set", "onConflictDoNothing", "returning"]) {
      chain[method] = (...args: unknown[]) => {
        if (method === "values") insertValues.push(args[0]);
        if (method === "set") updateSets.push(args[0]);
        return chain;
      };
    }
    chain.then = (resolve: (value: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  const db = {
    select: (..._args: unknown[]) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => config.inserts?.[insertIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => config.updates?.[updateIdx++] ?? []),
    transaction: async (callback: (tx: any) => unknown) => callback(db),
    __insertValues: insertValues,
    __updateSets: updateSets,
  };

  return db;
}

describe("suggestionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFeedbackRunAllDetectors.mockResolvedValue({ patternsCreated: 0, suggestionsCreated: 0 });
    mockIssueCreate.mockResolvedValue({ id: "issue-created" });
    mockMemoryCreate.mockResolvedValue({ id: "memory-created" });
    mockEmitHubItem.mockResolvedValue({ id: "hub-1", version: 0 });
    mockReconcile.mockResolvedValue({ healed: 1, closed: 1, refreshed: 0 });
  });

  it("detects memory gaps for departments with no domain items", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "dept-1", name: "Engineering" }],
        [],
        [{ id: "identity-1" }],
        [],
        [],
      ],
    });

    const svc = suggestionService(db as any);
    const result = await svc.detectMemoryGaps("co-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      category: "memory_gap",
      actionType: "suggest_memory",
      title: "No domain memory exists for Engineering",
    });
  });

  it("detects patterns when feedback reaches three occurrences", async () => {
    const db = createSequenceDb({
      selects: [
        [
          {
            id: "pattern-1",
            patternType: "tone_correction",
            occurrenceCount: 4,
            sourceAgentId: "agent-1",
          },
        ],
        [{ id: "agent-1", name: "Writer" }],
      ],
    });

    const svc = suggestionService(db as any);
    const result = await svc.detectPatternDetected("co-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      category: "pattern_detected",
      actionType: "suggest_memory",
    });
    expect(result[0].title).toContain("4 times");
  });

  it("does not create duplicate pending suggestions", async () => {
    const db = createSequenceDb({
      // [0] self-heal pending scan (empty → no collapse), [1] existingPending
      // pre-filter — an already-pending goal_gap:goal-1 finding.
      selects: [
        [],
        [{ category: "goal_gap", dedupeKey: "goal_gap:goal-1", actionPayload: { goalId: "goal-1" } }],
      ],
    });

    const svc = suggestionService(db as any);
    vi.spyOn(svc, "detectGoalGaps").mockResolvedValue([
      {
        category: "goal_gap",
        actionType: "create_task",
        dedupeKey: "goal_gap:goal-1",
        title: "gap",
        evidence: null,
        actionPayload: { goalId: "goal-1" },
      },
    ] as any);
    vi.spyOn(svc, "detectPipelineBottlenecks").mockResolvedValue([]);
    vi.spyOn(svc, "detectMemoryGaps").mockResolvedValue([]);
    vi.spyOn(svc, "detectPatternDetected").mockResolvedValue([]);
    vi.spyOn(svc, "detectBudgetOptimization").mockResolvedValue([]);
    vi.spyOn(svc, "detectRecurringWork").mockResolvedValue([]);
    vi.spyOn(svc, "detectRiskFlags").mockResolvedValue([]);
    vi.spyOn(svc, "detectWorkloadBalance").mockResolvedValue([]);

    const result = await svc.runAllDetectors("co-1");

    expect(result).toEqual({ detected: 1, created: 0 });
    expect((db as any).__insertValues).toHaveLength(0);
  });

  it("accept executes create_task payload correctly", async () => {
    const db = createSequenceDb({
      selects: [[
        {
          id: "sug-1",
          companyId: "co-1",
          category: "goal_gap",
          actionType: "create_task",
          actionPayload: { title: "Create kickoff task", priority: "high" },
          title: "gap",
          evidence: null,
          status: "pending",
        },
      ]],
      updates: [[{ id: "sug-1", status: "accepted" }]],
    });

    const svc = suggestionService(db as any);
    const result = await svc.accept("co-1", "sug-1");

    expect(mockIssueCreate).toHaveBeenCalledWith(
      "co-1",
      expect.objectContaining({ title: "Create kickoff task", priority: "high" }),
      expect.anything(),
    );
    expect(result.execution).toEqual({
      actionType: "create_task",
      entityType: "issue",
      entityId: "issue-created",
    });
  });

  it("dismiss updates suggestion status", async () => {
    const db = createSequenceDb({
      selects: [[
        {
          id: "sug-1",
          companyId: "co-1",
          category: "goal_gap",
          actionType: "create_task",
          actionPayload: { title: "x" },
          title: "gap",
          evidence: null,
          status: "pending",
        },
      ]],
      updates: [[{ id: "sug-1", status: "dismissed" }]],
    });

    const svc = suggestionService(db as any);
    const result = await svc.dismiss("co-1", "sug-1");

    expect(result).toEqual({ id: "sug-1", status: "dismissed" });
  });

  it("runAllDetectors aggregates detector output", async () => {
    const db = createSequenceDb({
      // [0] self-heal scan (empty), [1] existingPending pre-filter (empty).
      selects: [[], []],
      inserts: [[]],
    });

    const svc = suggestionService(db as any);
    vi.spyOn(svc, "detectGoalGaps").mockResolvedValue([
      {
        category: "goal_gap",
        actionType: "create_task",
        title: "goal",
        evidence: null,
        actionPayload: { goalId: "goal-1" },
      },
    ] as any);
    vi.spyOn(svc, "detectPipelineBottlenecks").mockResolvedValue([]);
    vi.spyOn(svc, "detectMemoryGaps").mockResolvedValue([
      {
        category: "memory_gap",
        actionType: "suggest_memory",
        title: "memory",
        evidence: null,
        actionPayload: { title: "Guideline", content: "X", category: "reference" },
      },
    ] as any);
    vi.spyOn(svc, "detectPatternDetected").mockResolvedValue([]);
    vi.spyOn(svc, "detectBudgetOptimization").mockResolvedValue([]);
    vi.spyOn(svc, "detectRecurringWork").mockResolvedValue([]);
    vi.spyOn(svc, "detectRiskFlags").mockResolvedValue([]);
    vi.spyOn(svc, "detectWorkloadBalance").mockResolvedValue([]);

    const result = await svc.runAllDetectors("co-1");

    expect(result).toEqual({ detected: 2, created: 2 });
    expect((db as any).__insertValues).toHaveLength(1);
  });

  it("runAllDetectors emits hub rows for inserted pending suggestions", async () => {
    const insertedSuggestion = {
      id: "sug-1",
      companyId: "co-1",
      category: "goal_gap",
      actionType: "create_task",
      actionPayload: { goalId: "goal-1" },
      title: "goal",
      evidence: null,
      status: "pending",
      updatedAt: new Date("2026-06-29T00:00:00Z"),
    };
    const db = createSequenceDb({
      // [0] self-heal scan (empty), [1] existingPending pre-filter (empty).
      selects: [[], []],
      inserts: [[insertedSuggestion]],
    });

    const svc = suggestionService(db as any);
    vi.spyOn(svc, "detectGoalGaps").mockResolvedValue([
      {
        category: "goal_gap",
        actionType: "create_task",
        title: "goal",
        evidence: null,
        actionPayload: { goalId: "goal-1" },
      },
    ] as any);
    vi.spyOn(svc, "detectPipelineBottlenecks").mockResolvedValue([]);
    vi.spyOn(svc, "detectMemoryGaps").mockResolvedValue([]);
    vi.spyOn(svc, "detectPatternDetected").mockResolvedValue([]);
    vi.spyOn(svc, "detectBudgetOptimization").mockResolvedValue([]);
    vi.spyOn(svc, "detectRecurringWork").mockResolvedValue([]);
    vi.spyOn(svc, "detectRiskFlags").mockResolvedValue([]);
    vi.spyOn(svc, "detectWorkloadBalance").mockResolvedValue([]);

    await svc.runAllDetectors("co-1");

    expect(mockBuildSuggestionHubEmit).toHaveBeenCalledWith(insertedSuggestion);
    expect(mockEmitHubItem).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "suggestion",
      sourceId: "sug-1",
    });
  });

  it("runAllDetectors reconciles expired suggestion hub rows", async () => {
    const db = createSequenceDb({
      // [0] self-heal scan (empty → no self-heal updates), [1] existingPending.
      selects: [[], []],
      // Only update issued: expireOldPendingSuggestions → one expired row.
      updates: [[{ id: "sug-expired" }]],
    });

    const svc = suggestionService(db as any);
    vi.spyOn(svc, "detectGoalGaps").mockResolvedValue([]);
    vi.spyOn(svc, "detectPipelineBottlenecks").mockResolvedValue([]);
    vi.spyOn(svc, "detectMemoryGaps").mockResolvedValue([]);
    vi.spyOn(svc, "detectPatternDetected").mockResolvedValue([]);
    vi.spyOn(svc, "detectBudgetOptimization").mockResolvedValue([]);
    vi.spyOn(svc, "detectRecurringWork").mockResolvedValue([]);
    vi.spyOn(svc, "detectRiskFlags").mockResolvedValue([]);
    vi.spyOn(svc, "detectWorkloadBalance").mockResolvedValue([]);

    await svc.runAllDetectors("co-1");

    expect(mockReconcile).toHaveBeenCalledWith("co-1", {
      sourceType: "suggestion",
      sourceId: "sug-expired",
    });
  });

  it("accept and dismiss reconcile suggestion hub rows after status changes", async () => {
    const pending = {
      id: "sug-1",
      companyId: "co-1",
      category: "goal_gap",
      actionType: "create_task",
      actionPayload: { title: "x" },
      title: "gap",
      evidence: null,
      status: "pending",
    };

    await suggestionService(
      createSequenceDb({
        selects: [[pending]],
        updates: [[{ ...pending, status: "accepted" }]],
      }) as any,
    ).accept("co-1", "sug-1");
    await suggestionService(
      createSequenceDb({
        selects: [[pending]],
        updates: [[{ ...pending, status: "dismissed" }]],
      }) as any,
    ).dismiss("co-1", "sug-1");

    expect(mockReconcile).toHaveBeenCalledTimes(2);
    expect(mockReconcile).toHaveBeenCalledWith("co-1", {
      sourceType: "suggestion",
      sourceId: "sug-1",
    });
  });

  it("returns empty arrays when detectors have no data", async () => {
    const db = createSequenceDb({
      selects: [[], []],
    });

    const svc = suggestionService(db as any);
    await expect(svc.detectGoalGaps("co-1")).resolves.toEqual([]);
    await expect(svc.detectPatternDetected("co-1")).resolves.toEqual([]);
  });

  // ---- H4: stable per-finding dedupe key ------------------------------------

  it("emits a stable dedupeKey per finding, identical across runs", async () => {
    // Same inputs on two independent detector runs must yield byte-identical
    // dedupe keys — that stability is what lets the DB partial-unique index and
    // the in-memory pre-filter agree and reject the second insert.
    const buildDb = () =>
      createSequenceDb({
        selects: [
          [{ id: "dept-1", name: "Engineering" }], // departments
          [], // approved domain rows
          [], // approved identity rows (none → identity gap)
          [], // stale rows
          [], // approved memory rows (merge conflicts)
        ],
      });

    const run1 = await suggestionService(buildDb() as any).detectMemoryGaps("co-1");
    const run2 = await suggestionService(buildDb() as any).detectMemoryGaps("co-1");

    const keys1 = run1.map((s) => (s as any).dedupeKey).sort();
    const keys2 = run2.map((s) => (s as any).dedupeKey).sort();

    expect(keys1).toEqual(keys2);
    // Identity gap + missing-domain gap, both keyed deterministically.
    expect(keys1).toContain("memory_gap:identity");
    expect(keys1).toContain("memory_gap:domain:dept-1");
  });

  it("goal_gap and workload_balance dedupe keys are entity-scoped and stable", async () => {
    // goal_gap:no_tasks:<goalId>
    const goalDb = createSequenceDb({
      selects: [
        [{ id: "goal-1", title: "Ship v1", status: "active", updatedAt: new Date() }],
        [], // issues linked to goals (none → no_tasks gap)
      ],
    });
    const goalResult = await suggestionService(goalDb as any).detectGoalGaps("co-1");
    expect(goalResult).toHaveLength(1);
    expect((goalResult[0] as any).dedupeKey).toBe("goal_gap:no_tasks:goal-1");

    // workload_balance:<sorted agent id pair> — order-independent.
    const workloadDb = createSequenceDb({
      selects: [
        [
          { assigneeAgentId: "agent-b", count: 9 },
          { assigneeAgentId: "agent-a", count: 1 },
        ],
        [
          { id: "agent-a", name: "A" },
          { id: "agent-b", name: "B" },
        ],
      ],
    });
    const workloadResult = await suggestionService(workloadDb as any).detectWorkloadBalance("co-1");
    expect(workloadResult).toHaveLength(1);
    expect((workloadResult[0] as any).dedupeKey).toBe("workload_balance:agent-a:agent-b");
  });

  it("runAllDetectors self-heals a pre-existing pending duplicate pair and reconciles the loser", async () => {
    // Two pending rows share the same finding (identity gap). Self-heal keeps
    // the newest (dup-new, listed first because the scan is createdAt DESC),
    // dismisses the older (dup-old), and reconciles dup-old's hub item in the
    // same transaction.
    const db = createSequenceDb({
      selects: [
        // [0] self-heal pending scan (createdAt DESC): newest first.
        [
          {
            id: "dup-new",
            category: "memory_gap",
            dedupeKey: "memory_gap:identity",
            actionPayload: { layer: "identity" },
            createdAt: new Date("2026-07-03T00:00:00Z"),
          },
          {
            id: "dup-old",
            category: "memory_gap",
            dedupeKey: "memory_gap:identity",
            actionPayload: { layer: "identity" },
            createdAt: new Date("2026-07-01T00:00:00Z"),
          },
        ],
        // [1] existingPending pre-filter (survivor blocks re-insertion).
        [{ category: "memory_gap", dedupeKey: "memory_gap:identity", actionPayload: { layer: "identity" } }],
      ],
      // Self-heal dismiss update (loser) — expireOldPendingSuggestions returns none.
      updates: [[{ id: "dup-old" }], []],
    });

    const svc = suggestionService(db as any);
    vi.spyOn(svc, "detectGoalGaps").mockResolvedValue([]);
    vi.spyOn(svc, "detectPipelineBottlenecks").mockResolvedValue([]);
    vi.spyOn(svc, "detectMemoryGaps").mockResolvedValue([]);
    vi.spyOn(svc, "detectPatternDetected").mockResolvedValue([]);
    vi.spyOn(svc, "detectBudgetOptimization").mockResolvedValue([]);
    vi.spyOn(svc, "detectRecurringWork").mockResolvedValue([]);
    vi.spyOn(svc, "detectRiskFlags").mockResolvedValue([]);
    vi.spyOn(svc, "detectWorkloadBalance").mockResolvedValue([]);

    await svc.runAllDetectors("co-1");

    // The superseded loser's hub item is reconciled.
    expect(mockReconcile).toHaveBeenCalledWith("co-1", {
      sourceType: "suggestion",
      sourceId: "dup-old",
    });
  });

  it("runAllDetectors rewrites reconstructable legacy dedupe keys before pre-filtering", async () => {
    const staleKey = "goal_gap:deadbeef";
    const db = createSequenceDb({
      selects: [
        // [0] self-heal pending scan: a migration-era row carrying a key that
        // does not match the runtime detector's explicit goal-gap key.
        [
          {
            id: "legacy-goal-gap",
            category: "goal_gap",
            actionType: "create_task",
            title: 'Goal "Launch" has no tasks yet',
            dedupeKey: staleKey,
            actionPayload: { goalId: "goal-1", title: "Kick off work for goal: Launch" },
            createdAt: new Date("2026-07-01T00:00:00Z"),
          },
        ],
        // [1] existingPending pre-filter sees the corrected key and blocks a
        // duplicate detector insert.
        [
          {
            category: "goal_gap",
            actionType: "create_task",
            title: 'Goal "Launch" has no tasks yet',
            dedupeKey: "goal_gap:no_tasks:goal-1",
            actionPayload: { goalId: "goal-1", title: "Kick off work for goal: Launch" },
          },
        ],
      ],
      // [0] keeper key rewrite, [1] expireOldPendingSuggestions returns none.
      updates: [[{ id: "legacy-goal-gap" }], []],
    });

    const svc = suggestionService(db as any);
    vi.spyOn(svc, "detectGoalGaps").mockResolvedValue([
      {
        category: "goal_gap",
        actionType: "create_task",
        dedupeKey: "goal_gap:no_tasks:goal-1",
        title: 'Goal "Launch" has no tasks yet',
        evidence: "No tasks are linked to this active goal.",
        actionPayload: { goalId: "goal-1", title: "Kick off work for goal: Launch" },
      } as any,
    ]);
    vi.spyOn(svc, "detectPipelineBottlenecks").mockResolvedValue([]);
    vi.spyOn(svc, "detectMemoryGaps").mockResolvedValue([]);
    vi.spyOn(svc, "detectPatternDetected").mockResolvedValue([]);
    vi.spyOn(svc, "detectBudgetOptimization").mockResolvedValue([]);
    vi.spyOn(svc, "detectRecurringWork").mockResolvedValue([]);
    vi.spyOn(svc, "detectRiskFlags").mockResolvedValue([]);
    vi.spyOn(svc, "detectWorkloadBalance").mockResolvedValue([]);

    const result = await svc.runAllDetectors("co-1");

    expect(result).toEqual({ detected: 1, created: 0 });
    expect((db as any).__updateSets).toContainEqual(
      expect.objectContaining({ dedupeKey: "goal_gap:no_tasks:goal-1" }),
    );
    expect((db as any).__insertValues).toHaveLength(0);
  });

  it("runAllDetectors compares detector keys against legacy payload fallback keys", async () => {
    const payload = {
      title: "Resolve bottleneck for: Ship checkout",
      description: 'Investigate why "Ship checkout" is blocked and define the unblock step.',
      goalId: "goal-1",
      priority: "high",
      status: "backlog",
      source: "manual",
    };
    const db = createSequenceDb({
      selects: [
        [],
        [
          {
            category: "pipeline_bottleneck",
            actionType: "create_task",
            title: 'Task "Ship checkout" has been blocked for 8 days',
            dedupeKey: null,
            actionPayload: payload,
          },
        ],
      ],
    });

    const svc = suggestionService(db as any);
    vi.spyOn(svc, "detectGoalGaps").mockResolvedValue([]);
    vi.spyOn(svc, "detectPipelineBottlenecks").mockResolvedValue([
      {
        category: "pipeline_bottleneck",
        actionType: "create_task",
        dedupeKey: "pipeline_bottleneck:blocked:issue-1",
        title: 'Task "Ship checkout" has been blocked for 8 days',
        evidence: "The task has stayed blocked.",
        actionPayload: payload,
      } as any,
    ]);
    vi.spyOn(svc, "detectMemoryGaps").mockResolvedValue([]);
    vi.spyOn(svc, "detectPatternDetected").mockResolvedValue([]);
    vi.spyOn(svc, "detectBudgetOptimization").mockResolvedValue([]);
    vi.spyOn(svc, "detectRecurringWork").mockResolvedValue([]);
    vi.spyOn(svc, "detectRiskFlags").mockResolvedValue([]);
    vi.spyOn(svc, "detectWorkloadBalance").mockResolvedValue([]);

    const result = await svc.runAllDetectors("co-1");

    expect(result).toEqual({ detected: 1, created: 0 });
    expect((db as any).__insertValues).toHaveLength(0);
  });
});
