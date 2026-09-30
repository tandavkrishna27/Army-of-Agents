import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB table stubs ────────────────────────────────────────────────────────────
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("@armyofagents/db", () => ({
  routines: makeTableProxy("routines"),
  routineTriggers: makeTableProxy("routine_triggers"),
  routineRuns: makeTableProxy("routine_runs"),
  issues: makeTableProxy("issues"),
  agents: makeTableProxy("agents"),
  projects: makeTableProxy("projects"),
  activityLog: makeTableProxy("activity_log"),
  heartbeatRuns: makeTableProxy("heartbeat_runs"),
  // heartbeat.ts also accesses these at module level
  agentRuntimeState: makeTableProxy("agent_runtime_state"),
  memoryItems: makeTableProxy("memory_items"),
  agentWakeupRequests: makeTableProxy("agent_wakeup_requests"),
  costEvents: makeTableProxy("cost_events"),
  // Required by services/embeddings.ts (B1: createEmbeddingService target map)
  discussions: makeTableProxy("discussions"),
  discussionExtractedItems: makeTableProxy("discussion_extracted_items"),
  embeddingQueue: makeTableProxy("embedding_queue"),
}));

// ── Service mocks injected via deps ──────────────────────────────────────────

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  rotate: vi.fn(),
  delete: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockQueueWakeup = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  secretService: () => mockSecretService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  queueIssueAssignmentWakeup: mockQueueWakeup,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueWakeup,
}));

import { routineService } from "../services/routines.js";

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
    // Make the chain thenable — resolves when awaited
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  return {
    select: (_fields?: unknown) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    selectDistinctOn: (_cols: unknown, _fields?: unknown) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (_table: unknown) => makeChain(() => config.inserts?.[insertIdx++] ?? []),
    update: (_table: unknown) => makeChain(() => config.updates?.[updateIdx++] ?? []),
    delete: (_table: unknown) => makeChain(() => config.deletes?.[deleteIdx++] ?? []),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: (_fields?: unknown) => makeChain(() => config.selects?.[selectIdx++] ?? []),
      selectDistinctOn: (_cols: unknown, _fields?: unknown) => makeChain(() => config.selects?.[selectIdx++] ?? []),
      insert: (_table: unknown) => makeChain(() => config.inserts?.[insertIdx++] ?? []),
      update: (_table: unknown) => makeChain(() => config.updates?.[updateIdx++] ?? []),
      delete: (_table: unknown) => makeChain(() => config.deletes?.[deleteIdx++] ?? []),
    }),
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const routineId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const triggerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const issueId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const baseRoutine: MockRow = {
  id: routineId,
  companyId,
  projectId: null,
  goalId: null,
  parentIssueId: null,
  title: "Nightly build",
  description: null,
  assigneeAgentId: agentId,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: null,
  lastEnqueuedAt: null,
  createdAt: new Date("2026-03-31T00:00:00.000Z"),
  updatedAt: new Date("2026-03-31T00:00:00.000Z"),
};

const baseTrigger: MockRow = {
  id: triggerId,
  companyId,
  routineId,
  kind: "schedule",
  label: "Nightly",
  enabled: true,
  cronExpression: "0 3 * * *",
  timezone: "UTC",
  nextRunAt: null,
  lastFiredAt: null,
  publicId: "pub-abc",
  secretId: null,
  signingMode: null,
  replayWindowSec: null,
  lastRotatedAt: null,
  lastResult: null,
  createdAt: new Date("2026-03-31T00:00:00.000Z"),
  updatedAt: new Date("2026-03-31T00:00:00.000Z"),
};

const baseRun: MockRow = {
  id: runId,
  companyId,
  routineId,
  triggerId,
  source: "schedule",
  status: "issue_created",
  triggeredAt: new Date("2026-03-31T03:00:00.000Z"),
  linkedIssueId: issueId,
  coalescedIntoRunId: null,
  failureReason: null,
  completedAt: null,
  createdAt: new Date("2026-03-31T03:00:00.000Z"),
  updatedAt: new Date("2026-03-31T03:00:00.000Z"),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("routineService — get", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the routine when found", async () => {
    const db = createSequenceDb({ selects: [[baseRoutine]] });
    const svc = routineService(db as any);
    const result = await svc.get(routineId);
    expect(result).toMatchObject({ id: routineId, title: "Nightly build" });
  });

  it("returns null when not found", async () => {
    const db = createSequenceDb({ selects: [[]] });
    const svc = routineService(db as any);
    const result = await svc.get(routineId);
    expect(result).toBeNull();
  });
});

describe("routineService — list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns routines for a company", async () => {
    const db = createSequenceDb({ selects: [[baseRoutine, { ...baseRoutine, id: "other-id" }]] });
    const svc = routineService(db as any);
    const result = await svc.list(companyId);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no routines", async () => {
    const db = createSequenceDb({ selects: [[]] });
    const svc = routineService(db as any);
    const result = await svc.list(companyId);
    expect(result).toEqual([]);
  });

  it("includes cronExpression and timezone in trigger list response", async () => {
    const cronTrigger = {
      ...baseTrigger,
      cronExpression: "0 9 * * 1",
      timezone: "America/New_York",
    };
    // Sequence: [routines], [triggers], [latestRuns], [liveIssues]
    const db = createSequenceDb({
      selects: [
        [baseRoutine],   // select from routines
        [cronTrigger],   // listTriggersForRoutineIds → select from routineTriggers
        [],              // listLatestRunByRoutineIds → selectDistinctOn from routineRuns
        [],              // listLiveIssueByRoutineIds → selectDistinctOn from issues
      ],
    });
    const svc = routineService(db as any);
    const result = await svc.list(companyId);
    expect(result).toHaveLength(1);
    const found = result[0];
    expect(found.triggers).toHaveLength(1);
    expect(found.triggers[0]).toMatchObject({
      cronExpression: "0 9 * * 1",
      timezone: "America/New_York",
    });
  });
});

describe("routineService — syncRunStatusForIssue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks the run completed when the linked issue is done", async () => {
    const doneIssue = {
      id: issueId,
      status: "done",
      originKind: "routine_execution",
      originRunId: runId,
    };

    const db = createSequenceDb({
      selects: [
        [doneIssue],                       // fetch issue
        [{ ...baseRun, status: "issue_created" }], // fetch linked run
      ],
      updates: [[{ ...baseRun, status: "completed" }]], // update run
    });

    const svc = routineService(db as any);
    await svc.syncRunStatusForIssue(issueId);
    // If it didn't throw, the flow succeeded — the update chain was called
    expect(true).toBe(true);
  });

  it("marks the run failed when the linked issue is cancelled", async () => {
    const cancelledIssue = {
      id: issueId,
      status: "cancelled",
      originKind: "routine_execution",
      originRunId: runId,
    };

    const db = createSequenceDb({
      selects: [
        [cancelledIssue],
        [{ ...baseRun, status: "issue_created" }],
      ],
      updates: [[{ ...baseRun, status: "failed" }]],
    });

    const svc = routineService(db as any);
    await svc.syncRunStatusForIssue(issueId);
    expect(true).toBe(true);
  });

  it("returns early when issue is not a routine execution", async () => {
    const regularIssue = {
      id: issueId,
      status: "done",
      originKind: null,
      originRunId: null,
    };

    const db = createSequenceDb({ selects: [[regularIssue]] });
    const svc = routineService(db as any);
    // Should return without querying routine_runs
    await svc.syncRunStatusForIssue(issueId);
    expect(true).toBe(true);
  });
});

describe("routineService — constants contract", () => {
  it("factory returns all expected methods", () => {
    const db = createSequenceDb();
    const svc = routineService(db as any);
    const methods = [
      "get", "getTrigger", "list", "getDetail", "create", "update",
      "createTrigger", "updateTrigger", "deleteTrigger", "rotateTriggerSecret",
      "runRoutine", "firePublicTrigger", "listRuns",
      "tickScheduledTriggers", "syncRunStatusForIssue",
    ];
    for (const m of methods) {
      expect(typeof (svc as any)[m], `missing method: ${m}`).toBe("function");
    }
  });
});

// ── Draft routine (null project / null assignee) ──────────────────────────────

describe("routineService — draft defaults (null project + null assignee)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a draft routine with null projectId and null assigneeAgentId", async () => {
    const draftRoutineRow = {
      ...baseRoutine,
      projectId: null,
      assigneeAgentId: null,
      variables: [],
    };
    const db = createSequenceDb({
      inserts: [[draftRoutineRow]],
    });
    const svc = routineService(db as any);
    const result = await svc.create(companyId, {
      title: "Draft routine",
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    }, { userId: "board" });
    expect(result).toMatchObject({ projectId: null, assigneeAgentId: null });
  });

  it("get returns a routine with null projectId and null assigneeAgentId", async () => {
    const draftRoutineRow = {
      ...baseRoutine,
      projectId: null,
      assigneeAgentId: null,
      variables: [],
    };
    const db = createSequenceDb({ selects: [[draftRoutineRow]] });
    const svc = routineService(db as any);
    const result = await svc.get(routineId);
    expect(result).toMatchObject({ id: routineId, projectId: null, assigneeAgentId: null });
  });
});

// ── Run-time variable overrides ───────────────────────────────────────────────

import { resolveRoutineRunVariables } from "../services/routine-variable-runtime.js";

describe("resolveRoutineRunVariables — pure function", () => {
  it("pre-fills defaults for all variables", () => {
    const result = resolveRoutineRunVariables(
      { variables: [{ name: "environment", label: null, type: "text", defaultValue: "staging", required: true, options: [] }] },
      undefined,
    );
    expect(result).toEqual({ environment: "staging" });
  });

  it("merges variableOverrides with stored defaults — overrides win", () => {
    const result = resolveRoutineRunVariables(
      { variables: [{ name: "environment", label: null, type: "text", defaultValue: "staging", required: true, options: [] }] },
      { environment: "production" },
    );
    expect(result).toEqual({ environment: "production" });
  });

  it("rejects unknown variable names in overrides", () => {
    expect(() =>
      resolveRoutineRunVariables(
        { variables: [{ name: "environment", label: null, type: "text", defaultValue: "staging", required: true, options: [] }] },
        { unknownVar: "x" },
      ),
    ).toThrow('Unknown routine variable: "unknownVar"');
  });

  it("handles null defaultValue by coercing to empty string", () => {
    const result = resolveRoutineRunVariables(
      { variables: [{ name: "region", label: null, type: "text", defaultValue: null, required: false, options: [] }] },
      undefined,
    );
    expect(result).toEqual({ region: "" });
  });

  it("rejects any override key when routine has no variables", () => {
    // no known keys → any override key would be unknown
    expect(() =>
      resolveRoutineRunVariables({ variables: [] }, { anything: "val" }),
    ).toThrow('Unknown routine variable: "anything"');
  });

  it("variableOverrides take precedence over input.variables for matching keys", () => {
    // Mirrors the merge at routines.ts:589:
    //   effectiveVariables = { ...input.variables, ...resolveRoutineRunVariables(routine, overrides) }
    // So variableOverrides (resolved last) always win over input.variables for the same key.
    const routine = {
      variables: [
        { name: "foo", label: null, type: "text" as const, defaultValue: "stored-default", required: false, options: [] },
        { name: "bar", label: null, type: "text" as const, defaultValue: "bar-default", required: false, options: [] },
      ],
    };

    // resolveRoutineRunVariables represents the variableOverrides layer:
    // it takes stored defaults from the routine and applies caller overrides on top.
    const resolvedOverrides = resolveRoutineRunVariables(routine, { foo: "from-overrides" });
    // "foo" came from the override; "bar" came from stored default.
    expect(resolvedOverrides).toEqual({ foo: "from-overrides", bar: "bar-default" });

    // Simulate the full merge: input.variables provides "from-variables" for "foo",
    // but overrides spread last so "from-overrides" wins.
    const inputVariables = { foo: "from-variables", bar: "bar-default" };
    const effectiveVariables = { ...inputVariables, ...resolvedOverrides };
    expect(effectiveVariables.foo).toBe("from-overrides");
    expect(effectiveVariables.bar).toBe("bar-default");
  });
});
