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
  issueReadStates: makeTableProxy("issue_read_states"),
  inboxDismissals: makeTableProxy("inbox_dismissals"),
  // heartbeat.ts also accesses these at module level
  agentRuntimeState: makeTableProxy("agent_runtime_state"),
  memoryItems: makeTableProxy("memory_items"),
  agentWakeupRequests: makeTableProxy("agent_wakeup_requests"),
  costEvents: makeTableProxy("cost_events"),
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

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
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

// Extended sequence db that also tracks what was inserted/deleted
type InsertCall = { table?: string; values?: MockRow };

function createTrackingDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  updates?: MockRow[][];
  deletes?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  let deleteIdx = 0;

  const captured: {
    insertCalls: Array<{ tableSym?: unknown; values?: unknown; onConflictTarget?: unknown; onConflictSet?: unknown }>;
    deleteCalls: Array<{ tableSym?: unknown; whereArg?: unknown }>;
    selectCalls: Array<unknown>;
  } = {
    insertCalls: [],
    deleteCalls: [],
    selectCalls: [],
  };

  function makeInsertChain(getResult: () => MockRow[], tableSym: unknown): Record<string, unknown> {
    const call: (typeof captured.insertCalls)[0] = { tableSym };
    captured.insertCalls.push(call);
    const chain: Record<string, unknown> = {};
    chain.values = (v: unknown) => {
      call.values = v;
      return chain;
    };
    chain.returning = () => chain;
    chain.onConflictDoUpdate = (opts: { target?: unknown; set?: unknown }) => {
      call.onConflictTarget = opts?.target;
      call.onConflictSet = opts?.set;
      return chain;
    };
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  function makeDeleteChain(getResult: () => MockRow[], tableSym: unknown): Record<string, unknown> {
    const call: (typeof captured.deleteCalls)[0] = { tableSym };
    captured.deleteCalls.push(call);
    const chain: Record<string, unknown> = {};
    chain.where = (w: unknown) => {
      call.whereArg = w;
      return chain;
    };
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  function makeSelectChain(getResult: () => MockRow[]): Record<string, unknown> {
    captured.selectCalls.push({});
    const chain: Record<string, unknown> = {};
    const methods = ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin", "set", "returning"];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  function makeUpdateChain(getResult: () => MockRow[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = ["set", "where", "returning"];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  // Shared fns used by both outer db and tx — all share captured + indexes
  const sharedFns = {
    select: (_fields?: unknown) => makeSelectChain(() => config.selects?.[selectIdx++] ?? []),
    selectDistinctOn: (_cols: unknown, _fields?: unknown) => makeSelectChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (tableSym: unknown) => makeInsertChain(() => config.inserts?.[insertIdx++] ?? [], tableSym),
    update: (_table: unknown) => makeUpdateChain(() => config.updates?.[updateIdx++] ?? []),
    delete: (tableSym: unknown) => makeDeleteChain(() => config.deletes?.[deleteIdx++] ?? [], tableSym),
    execute: () => Promise.resolve([]),
  };

  return {
    ...sharedFns,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(sharedFns),
    captured,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const routineId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const issueId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const triggerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const userId = "user-1234";

const baseRoutine: MockRow = {
  id: routineId,
  companyId,
  projectId: null,
  goalId: null,
  parentIssueId: null,
  title: "Daily standup",
  description: null,
  assigneeAgentId: agentId,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "always_enqueue",
  catchUpPolicy: "skip_missed",
  agentCompletionPolicyOverride: null,
  variables: [],
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: null,
  lastEnqueuedAt: null,
  createdAt: new Date("2026-03-31T00:00:00.000Z"),
  updatedAt: new Date("2026-03-31T00:00:00.000Z"),
};

const baseRun: MockRow = {
  id: runId,
  companyId,
  routineId,
  triggerId: null,
  source: "manual",
  status: "issue_created",
  triggeredAt: new Date("2026-03-31T03:00:00.000Z"),
  linkedIssueId: issueId,
  coalescedIntoRunId: null,
  failureReason: null,
  completedAt: null,
  idempotencyKey: null,
  triggerPayload: null,
  createdAt: new Date("2026-03-31T03:00:00.000Z"),
  updatedAt: new Date("2026-03-31T03:00:00.000Z"),
};

const baseTrigger: MockRow = {
  id: triggerId,
  companyId,
  routineId,
  kind: "schedule",
  label: "Daily schedule",
  enabled: true,
  cronExpression: "0 9 * * *",
  timezone: "UTC",
  nextRunAt: null,
  lastFiredAt: null,
  publicId: null,
  secretId: null,
  signingMode: null,
  replayWindowSec: null,
  lastRotatedAt: null,
  lastResult: null,
  createdByAgentId: null,
  createdByUserId: userId,
  updatedByAgentId: null,
  updatedByUserId: userId,
  createdAt: new Date("2026-03-31T00:00:00.000Z"),
  updatedAt: new Date("2026-03-31T00:00:00.000Z"),
};

const baseIssue: MockRow = {
  id: issueId,
  companyId,
  title: "Daily standup",
  status: "todo",
  assigneeAgentId: agentId,
  originKind: "routine_execution",
  originId: routineId,
  originRunId: runId,
  createdByUserId: null,
  createdByAgentId: null,
  createdAt: new Date("2026-03-31T03:00:00.000Z"),
  updatedAt: new Date("2026-03-31T03:00:00.000Z"),
  issueNumber: 1,
  identifier: "AOA-1",
  labels: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("touchIssueForUserInbox — via runRoutine (manual, fresh issue path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueWakeup.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("fresh issue from manual trigger sets createdByUserId from actor", async () => {
    const createdIssueWithUser = { ...baseIssue, createdByUserId: userId };
    mockIssueService.create.mockResolvedValue(createdIssueWithUser);

    const db = createTrackingDb({
      selects: [
        // transaction: SELECT FOR UPDATE on routines
        [baseRoutine],     // getRoutineById
        [baseRoutine],     // SELECT FOR UPDATE in tx (lock)
        [],                // findLiveExecutionIssue — no active issue
      ],
      inserts: [[baseRun]],   // insert routineRun
      updates: [
        [{ ...baseRun, status: "issue_created", linkedIssueId: issueId }], // finalizeRun
        [baseRoutine],     // updateRoutineTouchedState
      ],
    });
    const svc = routineService(db as any);

    await svc.runRoutine(routineId, { source: "manual" }, {
      agentId: null,
      userId,
    });

    // issueSvc.create was called with createdByUserId from actor
    expect(mockIssueService.create).toHaveBeenCalledOnce();
    const createCall = mockIssueService.create.mock.calls[0];
    // createCall[0] = companyId, createCall[1] = data
    expect(createCall[1]).toMatchObject({ createdByUserId: userId });
  });

  it("scheduled runs do NOT set createdByUserId (stays null)", async () => {
    const createdIssueNoUser = { ...baseIssue, createdByUserId: null };
    mockIssueService.create.mockResolvedValue(createdIssueNoUser);

    const db = createTrackingDb({
      selects: [
        [baseRoutine],     // getRoutineById
        [baseRoutine],     // SELECT FOR UPDATE
        [],                // findLiveExecutionIssue — no active issue
      ],
      inserts: [[{ ...baseRun, source: "schedule" }]],
      updates: [
        [{ ...baseRun, status: "issue_created", linkedIssueId: issueId }],
        [baseRoutine],
      ],
    });
    const svc = routineService(db as any);

    await svc.runRoutine(routineId, { source: "schedule" }, {
      agentId: null,
      userId: null,
    });

    expect(mockIssueService.create).toHaveBeenCalledOnce();
    const createCall = mockIssueService.create.mock.calls[0];
    // scheduled → createdByUserId should not be set (absent or null)
    const data = createCall[1] as Record<string, unknown>;
    expect(data.createdByUserId ?? null).toBeNull();
  });

  it("fresh issue from manual trigger by agent sets createdByAgentId", async () => {
    const createdIssueWithAgent = { ...baseIssue, createdByAgentId: agentId };
    mockIssueService.create.mockResolvedValue(createdIssueWithAgent);

    const db = createTrackingDb({
      selects: [
        [baseRoutine],
        [baseRoutine],
        [],
      ],
      inserts: [[baseRun]],
      updates: [
        [{ ...baseRun, status: "issue_created", linkedIssueId: issueId }],
        [baseRoutine],
      ],
    });
    const svc = routineService(db as any);

    await svc.runRoutine(routineId, { source: "manual" }, {
      agentId,
      userId: null,
    });

    expect(mockIssueService.create).toHaveBeenCalledOnce();
    const createCall = mockIssueService.create.mock.calls[0];
    const data = createCall[1] as Record<string, unknown>;
    expect(data.createdByAgentId).toBe(agentId);
    expect(data.createdByUserId ?? null).toBeNull();
  });

  it("uses the completion policy reread after taking the dispatch lock", async () => {
    const staleRoutine = { ...baseRoutine, agentCompletionPolicyOverride: "agent_can_complete" };
    const lockedRoutine = { ...baseRoutine, agentCompletionPolicyOverride: "review_required" };
    mockIssueService.create.mockResolvedValue(baseIssue);

    const db = createTrackingDb({
      selects: [
        [staleRoutine],
        [lockedRoutine],
        [],
      ],
      inserts: [[baseRun]],
      updates: [
        [{ ...baseRun, status: "issue_created", linkedIssueId: issueId }],
        [lockedRoutine],
      ],
    });
    const svc = routineService(db as any);

    await svc.runRoutine(routineId, { source: "manual" }, {
      agentId: null,
      userId,
    });

    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ completionPolicyCreatorOverride: "review_required" }),
      expect.anything(),
    );
  });

  it("rejects a former assignee after rereading the locked routine", async () => {
    const reassignedRoutine = { ...baseRoutine, assigneeAgentId: "replacement-agent" };
    const db = createTrackingDb({
      selects: [
        [baseRoutine],
        [reassignedRoutine],
      ],
    });
    const svc = routineService(db as any);

    await expect(svc.runRoutine(routineId, { source: "manual" }, {
      agentId,
      userId: null,
    })).rejects.toThrow("Agents can only run routines assigned to themselves");

    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects a routine archived while dispatch waits for its lock", async () => {
    const db = createTrackingDb({
      selects: [
        [baseRoutine],
        [{ ...baseRoutine, status: "archived" }],
      ],
    });
    const svc = routineService(db as any);

    await expect(svc.runRoutine(routineId, { source: "manual" }, {
      agentId: null,
      userId,
    })).rejects.toThrow("Routine is archived");

    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects a scheduled routine paused while dispatch waits for its lock", async () => {
    const db = createTrackingDb({
      selects: [
        [baseRoutine],
        [{ ...baseRoutine, status: "paused" }],
      ],
    });
    const svc = routineService(db as any);

    await expect(svc.runRoutine(routineId, { source: "schedule" }, {
      agentId: null,
      userId: null,
    })).rejects.toThrow("Routine is not active");

    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects a trigger disabled while dispatch waits for its lock", async () => {
    const db = createTrackingDb({
      selects: [
        [baseRoutine],
        [baseTrigger],
        [baseRoutine],
        [{ ...baseTrigger, enabled: false }],
      ],
    });
    const svc = routineService(db as any);

    await expect(svc.runRoutine(routineId, { source: "manual", triggerId }, {
      agentId: null,
      userId,
    })).rejects.toThrow("Routine trigger is not active");

    expect(mockIssueService.create).not.toHaveBeenCalled();
  });
});

describe("touchIssueForUserInbox — coalesce path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueWakeup.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("board actor triggers coalesce path → calls touchIssueForUserInbox (upsert read state + delete dismissal)", async () => {
    const activeIssue = { ...baseIssue, id: issueId, originRunId: runId };

    const db = createTrackingDb({
      selects: [
        // getRoutineById (outside transaction)
        [{ ...baseRoutine, concurrencyPolicy: "coalesce_if_active" }],
        // reread after SELECT FOR UPDATE
        [{ ...baseRoutine, concurrencyPolicy: "coalesce_if_active" }],
        // findLiveExecutionIssue first query (joins heartbeatRuns, returns { issues } shape)
        [{ issues: activeIssue }],
      ],
      inserts: [
        // routineRuns insert
        [{ ...baseRun, status: "received" }],
        // touchIssueForUserInbox: issueReadStates upsert (after coalesce)
        [],
      ],
      updates: [
        // finalizeRun
        [{ ...baseRun, status: "coalesced", linkedIssueId: issueId }],
        // updateRoutineTouchedState
        [baseRoutine],
      ],
      deletes: [
        // touchIssueForUserInbox: delete inboxDismissals
        [],
      ],
    });
    const svc = routineService(db as any);

    await svc.runRoutine(routineId, { source: "manual" }, {
      agentId: null,
      userId,
    });

    // issueSvc.create NOT called — coalesced
    expect(mockIssueService.create).not.toHaveBeenCalled();

    // An insert (for issueReadStates) should have been called
    const inserts = db.captured.insertCalls;
    // The first insert is the routineRun insert; the second should be issueReadStates
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    const readStateInsert = inserts[1];
    expect(readStateInsert.values).toMatchObject({
      companyId,
      issueId,
      userId,
    });
    // onConflictDoUpdate should have been set
    expect(readStateInsert.onConflictTarget).toBeDefined();

    // A delete (for inboxDismissals) should have been called
    const deletes = db.captured.deleteCalls;
    expect(deletes.length).toBeGreaterThanOrEqual(1);
  });

  it("scheduled coalesce does NOT call touchIssueForUserInbox", async () => {
    const activeIssue = { ...baseIssue, id: issueId, originRunId: runId };

    const db = createTrackingDb({
      selects: [
        // getRoutineById (outside transaction)
        [{ ...baseRoutine, concurrencyPolicy: "coalesce_if_active" }],
        // reread after SELECT FOR UPDATE
        [{ ...baseRoutine, concurrencyPolicy: "coalesce_if_active" }],
        // findLiveExecutionIssue first query (returns { issues } shape)
        [{ issues: activeIssue }],
      ],
      inserts: [[{ ...baseRun, source: "schedule", status: "received" }]],
      updates: [
        [{ ...baseRun, source: "schedule", status: "coalesced", linkedIssueId: issueId }],
        [baseRoutine],
      ],
      deletes: [],
    });
    const svc = routineService(db as any);

    await svc.runRoutine(routineId, { source: "schedule" }, {
      agentId: null,
      userId: null,
    });

    expect(mockIssueService.create).not.toHaveBeenCalled();

    // Only the routineRun insert, no issueReadStates upsert
    const inserts = db.captured.insertCalls;
    expect(inserts.length).toBe(1);

    // No inboxDismissals delete
    expect(db.captured.deleteCalls.length).toBe(0);
  });
});
