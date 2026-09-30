import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB table stubs ────────────────────────────────────────────────────────────
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("@armyofagents/db", () => ({
  routines: makeTableProxy("routines"),
  routineRevisions: makeTableProxy("routine_revisions"),
  routineTriggers: makeTableProxy("routine_triggers"),
  routineRuns: makeTableProxy("routine_runs"),
  issues: makeTableProxy("issues"),
  agents: makeTableProxy("agents"),
  projects: makeTableProxy("projects"),
  activityLog: makeTableProxy("activity_log"),
  heartbeatRuns: makeTableProxy("heartbeat_runs"),
  agentRuntimeState: makeTableProxy("agent_runtime_state"),
  memoryItems: makeTableProxy("memory_items"),
  agentWakeupRequests: makeTableProxy("agent_wakeup_requests"),
  costEvents: makeTableProxy("cost_events"),
  goals: makeTableProxy("goals"),
  companySecrets: makeTableProxy("company_secrets"),
  issueReadStates: makeTableProxy("issue_read_states"),
  inboxDismissals: makeTableProxy("inbox_dismissals"),
}));

// ── Service mocks ─────────────────────────────────────────────────────────────

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
  resolveSecretValue: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockQueueWakeup = vi.hoisted(() => vi.fn());

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

  // Track what was passed to insert/update for assertion
  const captured = {
    insertValues: [] as unknown[],
    updateSets: [] as unknown[],
  };

  function makeChain(getResult: () => MockRow[], captureArg?: (arg: unknown) => void): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin", "for"];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.values = (arg: unknown) => {
      if (captureArg) captureArg(arg);
      return chain;
    };
    chain.set = (arg: unknown) => {
      captured.updateSets.push(arg);
      return chain;
    };
    chain.returning = () => chain;
    // Make the chain thenable
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  return {
    _captured: captured,
    select: (_fields?: unknown) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    selectDistinctOn: (_cols: unknown, _fields?: unknown) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (_table: unknown) => makeChain(() => config.inserts?.[insertIdx++] ?? [], (arg) => captured.insertValues.push(arg)),
    update: (_table: unknown) => makeChain(() => config.updates?.[updateIdx++] ?? []),
    delete: (_table: unknown) => makeChain(() => config.deletes?.[deleteIdx++] ?? []),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      execute: () => Promise.resolve([]),
      select: (_fields?: unknown) => makeChain(() => config.selects?.[selectIdx++] ?? []),
      selectDistinctOn: (_cols: unknown, _fields?: unknown) => makeChain(() => config.selects?.[selectIdx++] ?? []),
      insert: (_table: unknown) => makeChain(() => config.inserts?.[insertIdx++] ?? [], (arg) => captured.insertValues.push(arg)),
      update: (_table: unknown) => makeChain(() => config.updates?.[updateIdx++] ?? []),
      delete: (_table: unknown) => makeChain(() => config.deletes?.[deleteIdx++] ?? []),
    }),
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const routineId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agentId   = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const otherAgentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const revisionId = "11111111-1111-4111-8111-111111111111";
const rev2Id     = "22222222-2222-4222-8222-222222222222";

const baseRoutine: MockRow = {
  id: routineId,
  companyId,
  projectId: null,
  goalId: null,
  parentIssueId: null,
  latestRevisionId: null,
  title: "Nightly build",
  description: "Does things",
  assigneeAgentId: agentId,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  agentCompletionPolicyOverride: "agent_can_complete",
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

const actor = { agentId: null, userId: "user-1" };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("routineService - completion policy persistence", () => {
  it("persists and returns a creator override on create", async () => {
    const createdRoutine = {
      ...baseRoutine,
      agentCompletionPolicyOverride: "review_required",
    };
    const db = createSequenceDb({ inserts: [[createdRoutine]] });

    const svc = routineService(db as any);
    const result = await svc.create(
      companyId,
      {
        title: "Nightly build",
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        agentCompletionPolicyOverride: "review_required",
      },
      actor,
    );

    expect(result.agentCompletionPolicyOverride).toBe("review_required");
    expect(db._captured.insertValues[0]).toMatchObject({
      agentCompletionPolicyOverride: "review_required",
    });
  });

  it("rejects an agent-supplied creator override on create", async () => {
    const db = createSequenceDb();
    const svc = routineService(db as any);

    await expect(
      svc.create(
        companyId,
        {
          title: "Agent routine",
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          agentCompletionPolicyOverride: "agent_can_complete",
        },
        { agentId, userId: null },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(db._captured.insertValues).toHaveLength(0);
  });
});

describe("routineService — createRevision", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a revision with correct fields and updates latestRevisionId", async () => {
    const newRev = { id: revisionId, companyId, routineId };
    const db = createSequenceDb({
      selects: [[baseRoutine]],         // getRoutineById
      inserts: [[newRev]],              // insert into routine_revisions → returning
      updates: [[{ ...baseRoutine, latestRevisionId: revisionId }]], // update routines.latestRevisionId
    });
    const svc = routineService(db as any);
    await svc.createRevision(routineId, actor);

    // Verify one insert happened with correct companyId, routineId, and snapshot fields
    expect(db._captured.insertValues).toHaveLength(1);
    const insertedValues = db._captured.insertValues[0] as Record<string, unknown>;
    expect(insertedValues.companyId).toBe(companyId);
    expect(insertedValues.routineId).toBe(routineId);
    expect(insertedValues.createdByUserId).toBe("user-1");
    expect(insertedValues.createdByAgentId).toBeNull();
    // Snapshot should contain key routine fields
    const snap = insertedValues.snapshot as Record<string, unknown>;
    expect(snap.title).toBe("Nightly build");
    expect(snap.description).toBe("Does things");
    expect(snap.priority).toBe("medium");
    expect(snap.status).toBe("active");
    expect(snap.agentCompletionPolicyOverride).toBe("agent_can_complete");
  });

  it("does nothing when routine is not found", async () => {
    const db = createSequenceDb({
      selects: [[]], // getRoutineById → not found
    });
    const svc = routineService(db as any);
    await expect(svc.createRevision(routineId, actor)).resolves.toBeUndefined();
    expect(db._captured.insertValues).toHaveLength(0);
  });
});

describe("routineService — update with baseRevisionId conflict check", () => {
  beforeEach(() => vi.clearAllMocks());

  it("succeeds when baseRevisionId matches latestRevisionId", async () => {
    const routineWithRev = { ...baseRoutine, latestRevisionId: revisionId };
    const updatedRoutine = { ...routineWithRev, title: "Updated", latestRevisionId: rev2Id };
    const newRev = { id: rev2Id, companyId, routineId };
    // Sequence: getRoutineById (for update check) → getRoutineById (for createRevisionInternal) → insert revision → update latestRevisionId → db.update routines
    const db = createSequenceDb({
      selects: [[routineWithRev], [routineWithRev]],
      inserts: [[newRev]],
      updates: [
        [{ ...routineWithRev, latestRevisionId: rev2Id }],  // update latestRevisionId
        [updatedRoutine],                                    // update routine fields
      ],
    });
    const svc = routineService(db as any);
    const result = await svc.update(routineId, { title: "Updated", baseRevisionId: revisionId }, actor);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Updated");

    // Verify the UPDATE was called with the patch values applied
    const updateSets = db._captured.updateSets as Record<string, unknown>[];
    const patchUpdateSet = updateSets.find((s) => s.title === "Updated");
    expect(patchUpdateSet).toBeDefined();
    expect(patchUpdateSet?.title).toBe("Updated");
    expect(patchUpdateSet).not.toHaveProperty("agentCompletionPolicyOverride");
  });

  it("throws 409 conflict when baseRevisionId is stale", async () => {
    const routineWithRev = { ...baseRoutine, latestRevisionId: revisionId };
    const db = createSequenceDb({
      selects: [[routineWithRev]],
    });
    const svc = routineService(db as any);
    await expect(
      svc.update(routineId, { title: "Updated", baseRevisionId: "stale-id-that-differs" }, actor),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rechecks baseRevisionId after locking and rejects an interleaved update", async () => {
    const routineAtRead = { ...baseRoutine, latestRevisionId: revisionId };
    const routineAfterConcurrentUpdate = { ...baseRoutine, latestRevisionId: rev2Id };
    const db = createSequenceDb({
      selects: [[routineAtRead], [routineAfterConcurrentUpdate]],
    });
    const svc = routineService(db as any);

    await expect(
      svc.update(routineId, { title: "Updated", baseRevisionId: revisionId }, actor),
    ).rejects.toMatchObject({ status: 409 });
    expect(db._captured.insertValues).toHaveLength(0);
    expect(db._captured.updateSets).toHaveLength(0);
  });

  it("uses an explicit null baseRevisionId to guard the first edit", async () => {
    const routineAfterConcurrentUpdate = { ...baseRoutine, latestRevisionId: rev2Id };
    const db = createSequenceDb({
      selects: [[baseRoutine], [routineAfterConcurrentUpdate]],
    });
    const svc = routineService(db as any);

    await expect(
      svc.update(routineId, { title: "Updated", baseRevisionId: null }, actor),
    ).rejects.toMatchObject({ status: 409 });
    expect(db._captured.insertValues).toHaveLength(0);
    expect(db._captured.updateSets).toHaveLength(0);
  });

  it("rechecks agent ownership after locking the routine", async () => {
    const reassignedRoutine = { ...baseRoutine, assigneeAgentId: otherAgentId };
    const db = createSequenceDb({
      selects: [[baseRoutine], [reassignedRoutine]],
    });
    const svc = routineService(db as any);

    await expect(
      svc.update(routineId, { title: "Updated" }, { agentId, userId: null }),
    ).rejects.toMatchObject({ status: 403 });
    expect(db._captured.insertValues).toHaveLength(0);
    expect(db._captured.updateSets).toHaveLength(0);
  });

  it("succeeds without baseRevisionId (backward-compat)", async () => {
    const newRev = { id: rev2Id, companyId, routineId };
    const updatedRoutine = { ...baseRoutine, title: "Updated" };
    // No baseRevisionId — no conflict check. latestRevisionId is null so conflict check is skipped anyway.
    const db = createSequenceDb({
      selects: [[baseRoutine], [baseRoutine]],   // update check + createRevisionInternal
      inserts: [[newRev]],
      updates: [
        [{ ...baseRoutine, latestRevisionId: rev2Id }], // update latestRevisionId
        [updatedRoutine],                               // update routine fields
      ],
    });
    const svc = routineService(db as any);
    const result = await svc.update(routineId, { title: "Updated" }, actor);
    expect(result).not.toBeNull();
  });

  it("persists an explicit completion policy override", async () => {
    const newRev = { id: rev2Id, companyId, routineId };
    const updatedRoutine = {
      ...baseRoutine,
      agentCompletionPolicyOverride: "review_required",
    };
    const db = createSequenceDb({
      selects: [[baseRoutine], [baseRoutine]],
      inserts: [[newRev]],
      updates: [
        [{ ...baseRoutine, latestRevisionId: rev2Id }],
        [updatedRoutine],
      ],
    });

    const svc = routineService(db as any);
    const result = await svc.update(
      routineId,
      { agentCompletionPolicyOverride: "review_required" },
      actor,
    );

    expect(result?.agentCompletionPolicyOverride).toBe("review_required");
    expect(db._captured.updateSets).toContainEqual(
      expect.objectContaining({ agentCompletionPolicyOverride: "review_required" }),
    );
  });

  it("rejects an agent changing the completion policy override", async () => {
    const db = createSequenceDb({ selects: [[baseRoutine]] });
    const svc = routineService(db as any);

    await expect(
      svc.update(
        routineId,
        { agentCompletionPolicyOverride: "review_required" },
        { agentId, userId: null },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(db._captured.updateSets).toHaveLength(0);
  });
});

describe("routineService — restoreRevision", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies snapshot fields to the routine", async () => {
    const originalTitle = "Original title";
    const snapshot = {
      title: originalTitle,
      description: "Original desc",
      assigneeAgentId: null,
      priority: "high",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      agentCompletionPolicyOverride: "review_required",
      variables: [],
      projectId: null,
      goalId: null,
      parentIssueId: null,
    };
    const storedRevision = { id: revisionId, companyId, routineId, snapshot, createdAt: new Date(), createdByAgentId: null, createdByUserId: null };
    const routineAfterRestore = {
      ...baseRoutine,
      title: originalTitle,
      agentCompletionPolicyOverride: "review_required",
      latestRevisionId: rev2Id,
    };
    const newRev1 = { id: "aaaaa-pre", companyId, routineId };
    const newRev2 = { id: rev2Id, companyId, routineId };

    // Sequence of DB ops in restoreRevision:
    // 1. select from routineRevisions (find revision)
    // 2. getRoutineById (for createRevisionInternal pre-restore snapshot)
    // 3. insert into routineRevisions (pre-restore snapshot)
    // 4. update routines.latestRevisionId (pre-restore)
    // 5. update routines with restored snapshot
    // 6. getRoutineById (for createRevisionInternal post-restore)
    // 7. insert into routineRevisions (post-restore snapshot)
    // 8. update routines.latestRevisionId (post-restore)
    // 9. select from routineTriggers (webhook trigger check)
    const db = createSequenceDb({
      selects: [
        [storedRevision],                // select from routineRevisions
        [baseRoutine],                   // getRoutineById for pre-restore createRevisionInternal
        [routineAfterRestore],           // getRoutineById for post-restore createRevisionInternal
        [],                              // select from routineTriggers (no webhook triggers)
      ],
      inserts: [
        [newRev1],                       // insert pre-restore revision
        [newRev2],                       // insert post-restore revision
      ],
      updates: [
        [{ ...baseRoutine, latestRevisionId: "aaaaa-pre" }],  // latestRevisionId pre-restore
        [routineAfterRestore],                                  // restore snapshot
        [{ ...routineAfterRestore, latestRevisionId: rev2Id }], // latestRevisionId post-restore
      ],
    });

    const svc = routineService(db as any);
    const result = await svc.restoreRevision(routineId, revisionId, baseRoutine.latestRevisionId, actor);
    expect(result).not.toBeNull();
    expect(result?.title).toBe(originalTitle);
    expect(result?.latestRevisionId).toBe(rev2Id);

    // Verify the UPDATE was called with the correct snapshot values
    const updateSets = db._captured.updateSets as Record<string, unknown>[];
    const snapshotUpdateSet = updateSets.find((s) => s.title === originalTitle);
    expect(snapshotUpdateSet).toBeDefined();
    expect(snapshotUpdateSet?.title).toBe(originalTitle);
    expect(snapshotUpdateSet?.agentCompletionPolicyOverride).toBe("review_required");
  });

  it("returns null when revision is not found", async () => {
    const db = createSequenceDb({
      selects: [[]], // select from routineRevisions → not found
    });
    const svc = routineService(db as any);
    const result = await svc.restoreRevision(routineId, revisionId, baseRoutine.latestRevisionId, actor);
    expect(result).toBeNull();
  });

  it("rejects restore when the locked routine head changed", async () => {
    const storedRevision = {
      id: revisionId,
      companyId,
      routineId,
      snapshot: { title: "Original title" },
    };
    const db = createSequenceDb({
      selects: [
        [storedRevision],
        [{ ...baseRoutine, latestRevisionId: rev2Id }],
      ],
    });
    const svc = routineService(db as any);

    await expect(
      svc.restoreRevision(routineId, revisionId, revisionId, actor),
    ).rejects.toMatchObject({ status: 409 });
    expect(db._captured.insertValues).toHaveLength(0);
    expect(db._captured.updateSets).toHaveLength(0);
  });

  it("rejects an agent restore before applying any snapshot fields", async () => {
    const storedRevision = {
      id: revisionId,
      companyId,
      routineId,
      snapshot: {
        title: "Original title",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        agentCompletionPolicyOverride: "review_required",
        variables: [],
        projectId: null,
        goalId: null,
        parentIssueId: null,
      },
    };
    const db = createSequenceDb({
      selects: [[storedRevision], [baseRoutine]],
    });
    const svc = routineService(db as any);

    await expect(
      svc.restoreRevision(routineId, revisionId, baseRoutine.latestRevisionId, { agentId, userId: null }),
    ).rejects.toMatchObject({ status: 403 });
    expect(db._captured.insertValues).toHaveLength(0);
    expect(db._captured.updateSets).toHaveLength(0);
  });

  it("rotates webhook trigger secrets when restoring", async () => {
    const snapshot = {
      title: "Original title",
      description: null,
      assigneeAgentId: null,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
      projectId: null,
      goalId: null,
      parentIssueId: null,
    };
    const storedRevision = { id: revisionId, companyId, routineId, snapshot, createdAt: new Date(), createdByAgentId: null, createdByUserId: null };
    const webhookTrigger = {
      id: "trig-1",
      companyId,
      routineId,
      kind: "webhook",
      secretId: "secret-abc",
    };
    const routineAfterRestore = { ...baseRoutine, title: "Original title" };
    const newRev1 = { id: "aaaaa-pre", companyId, routineId };
    const newRev2 = { id: rev2Id, companyId, routineId };

    mockSecretService.rotate.mockResolvedValue(undefined);

    const db = createSequenceDb({
      selects: [
        [storedRevision],
        [baseRoutine],           // pre-restore getRoutineById
        [routineAfterRestore],   // post-restore getRoutineById
        [webhookTrigger],        // routineTriggers webhook select
      ],
      inserts: [
        [newRev1],
        [newRev2],
      ],
      updates: [
        [{ ...baseRoutine, latestRevisionId: "aaaaa-pre" }],
        [routineAfterRestore],
        [{ ...routineAfterRestore, latestRevisionId: rev2Id }],
      ],
    });

    const svc = routineService(db as any);
    await svc.restoreRevision(routineId, revisionId, baseRoutine.latestRevisionId, actor);

    expect(mockSecretService.rotate).toHaveBeenCalledOnce();
    expect(mockSecretService.rotate).toHaveBeenCalledWith(
      "secret-abc",
      expect.objectContaining({ value: expect.any(String) }),
      actor,
    );
  });

  it("rejects and rolls back restore when webhook secret rotation fails", async () => {
    const snapshot = {
      title: "Restored title",
      description: null,
      assigneeAgentId: null,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
      projectId: null,
      goalId: null,
      parentIssueId: null,
    };
    const storedRevision = { id: revisionId, companyId, routineId, snapshot, createdAt: new Date(), createdByAgentId: null, createdByUserId: null };
    const routineAfterRestore = { ...baseRoutine, title: "Restored title" };
    mockSecretService.rotate.mockRejectedValueOnce(new Error("provider unavailable"));
    const db = createSequenceDb({
      selects: [
        [storedRevision],
        [baseRoutine],
        [routineAfterRestore],
        [{ id: "trig-1", companyId, routineId, kind: "webhook", secretId: "secret-abc" }],
      ],
      inserts: [[{ id: "pre", companyId, routineId }], [{ id: rev2Id, companyId, routineId }]],
      updates: [
        [{ ...baseRoutine, latestRevisionId: "pre" }],
        [routineAfterRestore],
        [{ ...routineAfterRestore, latestRevisionId: rev2Id }],
      ],
    });

    await expect(
      routineService(db as any).restoreRevision(
        routineId,
        revisionId,
        baseRoutine.latestRevisionId,
        actor,
      ),
    ).rejects.toThrow("provider unavailable");
  });
});
