import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ op: "eq", a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  gt: vi.fn((a: unknown, b: unknown) => ({ op: "gt", a, b })),
  asc: vi.fn((col: unknown) => ({ op: "asc", col })),
  sql: Object.assign(
    vi.fn(() => ({ as: vi.fn().mockReturnThis(), mapWith: vi.fn().mockReturnThis() })),
    { raw: vi.fn((s: unknown) => s), placeholder: vi.fn((s: unknown) => s) },
  ),
}));

function tableProxy(name: string) {
  return new Proxy({}, { get: (_target, prop) => `${name}.${String(prop)}` });
}

vi.mock("@armyofagents/db", () => ({
  threadOrchestrationState: tableProxy("tos"),
  discussionEntries: tableProxy("de"),
  discussions: tableProxy("discussions"),
}));

vi.mock("../services/crew-budget.js", () => ({
  preflightCrewDispatch: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

const { commitThreadAgentActionsMock } = vi.hoisted(() => ({
  commitThreadAgentActionsMock: vi.fn().mockResolvedValue({
    committed: 0,
    suppressed: 0,
    blocked: 0,
    failed: 0,
  }),
}));

vi.mock("../services/thread-agent-actions.js", () => ({
  threadAgentActionService: vi.fn(() => ({
    commitThreadAgentActions: commitThreadAgentActionsMock,
  })),
}));

import { threadOrchestrationService } from "../services/thread-orchestration.js";

type ControllerState = {
  threadId: string;
  runEpoch: number;
  pendingRun: boolean;
  lastProcessedEntryId: string | null;
  lastError: string | null;
  consecutiveCommitFailures: number;
};

type EntryRow = {
  id: string;
  discussionId: string;
  seq: number;
  createdAt: Date;
  inputType: string;
  rawContent: string;
};

function createControllerDb(controller: ControllerState, entries: EntryRow[], entriesLoadError?: Error) {
  const cursorCommits: string[] = [];

  const db = {
    update: vi.fn(() => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        // The Step-1 atomic claim is the only update that sets pendingRun=false
        // (the failure/circuit-break paths set pendingRun=true). Identify it by
        // that flag so the failure-path re-schedule (pendingRun=true) is NOT
        // misclassified as a claim.
        const isClaim = "pendingRun" in payload && payload.pendingRun === false;
        return {
          where: vi.fn(() => {
            if (isClaim) {
              return {
                returning: vi.fn(async () => {
                  if (!controller.pendingRun) return [];
                  controller.pendingRun = false;
                  return [{ ...controller }];
                }),
              };
            }
            if ("lastProcessedEntryId" in payload) {
              controller.lastProcessedEntryId = payload.lastProcessedEntryId as string | null;
              if (controller.lastProcessedEntryId) cursorCommits.push(controller.lastProcessedEntryId);
            }
            if ("lastError" in payload) {
              controller.lastError = payload.lastError as string | null;
            }
            if ("consecutiveCommitFailures" in payload) {
              controller.consecutiveCommitFailures = payload.consecutiveCommitFailures as number;
            }
            if ("pendingRun" in payload) {
              controller.pendingRun = payload.pendingRun as boolean;
            }
            return Promise.resolve([{ ...controller }]);
          }),
        };
      }),
    })),
    select: vi.fn((projection?: unknown) => ({
      from: vi.fn((table: unknown) => {
        const tableName = String((table as Record<string, unknown>).id ?? table);
        return {
          where: vi.fn(() => {
            if (tableName.startsWith("discussions.")) {
              return { limit: vi.fn(async () => [{ companyId: "company-1" }]) };
            }
            if (tableName.startsWith("tos.")) {
              return Promise.resolve([{ runEpoch: controller.runEpoch }]);
            }
            if (tableName.startsWith("de.") && projection) {
              const cursor = entries.find((entry) => entry.id === controller.lastProcessedEntryId);
              return Promise.resolve(cursor ? [{ seq: cursor.seq }] : []);
            }
            return {
              orderBy: vi.fn(async () => {
                // Simulate a transient entries-load failure (exercises the
                // bounded-reschedule stall path).
                if (entriesLoadError) throw entriesLoadError;
                const cursor = entries.find((entry) => entry.id === controller.lastProcessedEntryId);
                const cursorSeq = cursor?.seq ?? 0;
                return entries.filter((entry) => entry.seq > cursorSeq);
              }),
            };
          }),
        };
      }),
    })),
  };

  return { db: db as never, cursorCommits };
}

describe("runController action gate integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits proposed thread actions before advancing the cursor on a fresh run", async () => {
    const threadId = "thread-action-gate-fresh";
    const controller: ControllerState = {
      threadId,
      runEpoch: 1,
      pendingRun: true,
      lastProcessedEntryId: null,
      lastError: null,
      consecutiveCommitFailures: 0,
    };
    const entry: EntryRow = {
      id: "entry-a",
      discussionId: threadId,
      seq: 1,
      createdAt: new Date("2026-06-15T10:00:00Z"),
      inputType: "write",
      rawContent: "Please help scope this.",
    };
    const { db, cursorCommits } = createControllerDb(controller, [entry]);
    const order: string[] = [];
    commitThreadAgentActionsMock.mockImplementationOnce(async () => {
      order.push("action-gate");
      return { committed: 1, suppressed: 0, blocked: 0, failed: 0 };
    });

    const result = await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => ({ output: "done", runId: "run-1" }),
      onCommit: async () => {
        order.push("onCommit");
      },
    });

    expect(result).toMatchObject({ ran: true, suppressed: false, cursorAdvancedTo: "entry-a" });
    expect(commitThreadAgentActionsMock).toHaveBeenCalledWith({
      companyId: "company-1",
      threadId,
      runId: "run-1",
    });
    expect(cursorCommits).toEqual(["entry-a"]);
    expect(order).toEqual(["action-gate", "onCommit"]);
  });

  it("does NOT advance the cursor when an action commit reports failures", async () => {
    // Fix (c): a per-action commit failure is swallowed inside
    // commitThreadAgentActions (row set failed, call returns normally). The
    // orchestration loop must NOT advance the cursor in that case, so the
    // triggering entry is retried on the next tick instead of being dropped.
    const threadId = "thread-action-gate-failed";
    const controller: ControllerState = {
      threadId,
      runEpoch: 1,
      pendingRun: true,
      lastProcessedEntryId: null,
      lastError: null,
      consecutiveCommitFailures: 0,
    };
    const entry: EntryRow = {
      id: "entry-a",
      discussionId: threadId,
      seq: 1,
      createdAt: new Date("2026-06-15T10:00:00Z"),
      inputType: "write",
      rawContent: "Please help scope this.",
    };
    const { db, cursorCommits } = createControllerDb(controller, [entry]);
    commitThreadAgentActionsMock.mockResolvedValueOnce({
      committed: 0,
      suppressed: 0,
      blocked: 0,
      failed: 1,
    });
    const onCommit = vi.fn();

    const result = await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => ({ output: "done", runId: "run-1" }),
      onCommit,
    });

    expect(result).toMatchObject({
      ran: true,
      suppressed: false,
      error: "action_commit_failed:1",
      cursorAdvancedTo: null,
    });
    expect(commitThreadAgentActionsMock).toHaveBeenCalledWith({
      companyId: "company-1",
      threadId,
      runId: "run-1",
    });
    // Cursor not advanced → entry will be retried next tick.
    expect(cursorCommits).toEqual([]);
    expect(controller.lastProcessedEntryId).toBeNull();
    expect(controller.lastError).toBe("action_commit_failed:1");
    // The post-commit hook must NOT fire on the failed path.
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not commit proposed thread actions when a newer human entry makes the run stale", async () => {
    const threadId = "thread-action-gate-stale";
    const controller: ControllerState = {
      threadId,
      runEpoch: 1,
      pendingRun: true,
      lastProcessedEntryId: null,
      lastError: null,
      consecutiveCommitFailures: 0,
    };
    const entry: EntryRow = {
      id: "entry-a",
      discussionId: threadId,
      seq: 1,
      createdAt: new Date("2026-06-15T10:00:00Z"),
      inputType: "write",
      rawContent: "Please help scope this.",
    };
    const { db, cursorCommits } = createControllerDb(controller, [entry]);

    const result = await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => {
        controller.runEpoch += 1;
        controller.pendingRun = true;
        return { output: "stale" };
      },
    });

    expect(result).toMatchObject({ ran: true, suppressed: true, startEpoch: 1, endEpoch: 2 });
    expect(commitThreadAgentActionsMock).not.toHaveBeenCalled();
    expect(cursorCommits).toEqual([]);
  });

  it("re-schedules (pendingRun=true) and does NOT advance the cursor on the first commit failure", async () => {
    // First failure (priorFailures=0 → newCount=1 < MAX): the controller must
    // re-schedule (pendingRun=true → the 2-min sweep retries) WITHOUT advancing
    // the cursor, and bump consecutiveCommitFailures to 1.
    const threadId = "thread-action-gate-first-failure";
    const controller: ControllerState = {
      threadId,
      runEpoch: 1,
      pendingRun: true,
      lastProcessedEntryId: null,
      lastError: null,
      consecutiveCommitFailures: 0,
    };
    const entry: EntryRow = {
      id: "entry-a",
      discussionId: threadId,
      seq: 1,
      createdAt: new Date("2026-06-15T10:00:00Z"),
      inputType: "write",
      rawContent: "Please help scope this.",
    };
    const { db, cursorCommits } = createControllerDb(controller, [entry]);
    commitThreadAgentActionsMock.mockResolvedValueOnce({
      committed: 0,
      suppressed: 0,
      blocked: 0,
      failed: 1,
    });
    const onCommit = vi.fn();

    const result = await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => ({ output: "done", runId: "run-1" }),
      onCommit,
    });

    expect(result).toMatchObject({
      ran: true,
      suppressed: false,
      error: "action_commit_failed:1",
      cursorAdvancedTo: null,
    });
    expect(cursorCommits).toEqual([]);
    expect(controller.lastProcessedEntryId).toBeNull();
    expect(controller.consecutiveCommitFailures).toBe(1);
    expect(controller.pendingRun).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("circuit-breaks after MAX consecutive failures: advances the cursor, resets the counter, sets a skip lastError", async () => {
    // priorFailures = MAX-1 (2). One more failure (newCount=3 === MAX) trips the
    // breaker: advance the cursor past the poison entry, reset the counter,
    // re-schedule to drain later entries, and write a human-visible lastError.
    const threadId = "thread-action-gate-circuit-break";
    const controller: ControllerState = {
      threadId,
      runEpoch: 1,
      pendingRun: true,
      lastProcessedEntryId: null,
      lastError: null,
      consecutiveCommitFailures: 2,
    };
    const entry: EntryRow = {
      id: "entry-a",
      discussionId: threadId,
      seq: 1,
      createdAt: new Date("2026-06-15T10:00:00Z"),
      inputType: "write",
      rawContent: "Please help scope this.",
    };
    const { db, cursorCommits } = createControllerDb(controller, [entry]);
    commitThreadAgentActionsMock.mockResolvedValueOnce({
      committed: 0,
      suppressed: 0,
      blocked: 0,
      failed: 1,
    });
    const onCommit = vi.fn();

    const result = await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => ({ output: "done", runId: "run-1" }),
      onCommit,
    });

    expect(result).toMatchObject({
      ran: true,
      suppressed: false,
      cursorAdvancedTo: "entry-a",
    });
    // On circuit-break the run does NOT surface an error (the cursor advanced,
    // the thread is unstuck) — it is undefined, not the commit-failure string.
    expect((result as { error?: string }).error).toBeUndefined();
    // Cursor advanced past the poison entry.
    expect(cursorCommits).toEqual(["entry-a"]);
    expect(controller.lastProcessedEntryId).toBe("entry-a");
    expect(controller.consecutiveCommitFailures).toBe(0);
    expect(controller.pendingRun).toBe(true);
    expect(controller.lastError).toMatch(/action_commit_failed_skipped/);
    // The breaker advanced the cursor itself; the success-path onCommit hook
    // does NOT fire (the run returned from the commit-failure branch).
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("resets consecutiveCommitFailures to 0 on a successful commit", async () => {
    // priorFailures = 2; this commit reports failed:0 → the success path resets
    // the counter, advances the cursor, and clears lastError.
    const threadId = "thread-action-gate-success-reset";
    const controller: ControllerState = {
      threadId,
      runEpoch: 1,
      pendingRun: true,
      lastProcessedEntryId: null,
      lastError: "action_commit_failed:1",
      consecutiveCommitFailures: 2,
    };
    const entry: EntryRow = {
      id: "entry-a",
      discussionId: threadId,
      seq: 1,
      createdAt: new Date("2026-06-15T10:00:00Z"),
      inputType: "write",
      rawContent: "Please help scope this.",
    };
    const { db, cursorCommits } = createControllerDb(controller, [entry]);
    commitThreadAgentActionsMock.mockResolvedValueOnce({
      committed: 1,
      suppressed: 0,
      blocked: 0,
      failed: 0,
    });

    const result = await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => ({ output: "done", runId: "run-1" }),
    });

    expect(result).toMatchObject({ ran: true, suppressed: false, cursorAdvancedTo: "entry-a" });
    expect(cursorCommits).toEqual(["entry-a"]);
    expect(controller.lastProcessedEntryId).toBe("entry-a");
    expect(controller.consecutiveCommitFailures).toBe(0);
    expect(controller.lastError).toBeNull();
  });

  it("MIXED batch (committed>0 AND failed>0) advances the cursor AND reschedules the failed row (pendingRun=true)", async () => {
    // Codex P2: a mixed batch must advance the cursor (committed work is done, and
    // re-running would re-execute it) BUT also reschedule via pendingRun so the
    // retryable failed row is re-driven on the next sweep instead of being orphaned
    // until an unrelated future trigger. The thread-scoped commit re-selects the
    // failed row directly (bounded by attemptCount < maxAttempts).
    const threadId = "thread-mixed-batch";
    const controller: ControllerState = {
      threadId, runEpoch: 1, pendingRun: true,
      lastProcessedEntryId: null, lastError: null, consecutiveCommitFailures: 0,
    };
    const entry: EntryRow = {
      id: "entry-a", discussionId: threadId, seq: 1,
      createdAt: new Date("2026-06-15T10:00:00Z"), inputType: "write", rawContent: "x",
    };
    const { db, cursorCommits } = createControllerDb(controller, [entry]);
    commitThreadAgentActionsMock.mockResolvedValueOnce({ committed: 1, suppressed: 0, blocked: 0, failed: 1, lostRace: 0 });

    const result = await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => ({ output: "done", runId: "run-1" }),
    });

    expect(result).toMatchObject({ ran: true, suppressed: false, cursorAdvancedTo: "entry-a" });
    expect(cursorCommits).toEqual(["entry-a"]);
    expect(controller.pendingRun).toBe(true); // rescheduled so the failed row is re-driven
    expect(controller.consecutiveCommitFailures).toBe(0);
    expect((result as { error?: string }).error).toBeUndefined();
  });

  it("ALL-LOST batch (every action lost the CAS) advances the cursor AND reschedules (pendingRun=true)", async () => {
    // Codex P2: when every selected action loses the fenced claim to a concurrent
    // committer, the result is all-zero except lostRace. The controller must NOT treat
    // that as a clean success and walk away — it advances the cursor (the winner is
    // committing this turn) but reschedules so any leftover (e.g. if the winner then
    // crashes and the reaper flips its row to failed) is re-driven.
    const threadId = "thread-all-lost";
    const controller: ControllerState = {
      threadId, runEpoch: 1, pendingRun: true,
      lastProcessedEntryId: null, lastError: null, consecutiveCommitFailures: 0,
    };
    const entry: EntryRow = {
      id: "entry-a", discussionId: threadId, seq: 1,
      createdAt: new Date("2026-06-15T10:00:00Z"), inputType: "write", rawContent: "x",
    };
    const { db } = createControllerDb(controller, [entry]);
    commitThreadAgentActionsMock.mockResolvedValueOnce({ committed: 0, suppressed: 0, blocked: 0, failed: 0, lostRace: 1 });

    await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => ({ output: "done", runId: "run-1" }),
    });

    expect(controller.pendingRun).toBe(true); // lost-race work re-driven, not silently dropped
  });

  it("outbox seal: a FAILED controller run does NOT commit (failed runs never seal → never drain)", async () => {
    // The producer-gate: a controller run that did not succeed never sealed its proposed actions
    // (the runner seals only on success), and runController additionally skips the commit so the
    // transient superset relay cannot drain the failed run's proposed rows either. This closes the
    // controller-path variant of the failed-run leak (Codex P1).
    const threadId = "thread-failed-controller-run";
    const controller: ControllerState = {
      threadId, runEpoch: 1, pendingRun: true,
      lastProcessedEntryId: null, lastError: null, consecutiveCommitFailures: 0,
    };
    const entry: EntryRow = {
      id: "entry-a", discussionId: threadId, seq: 1,
      createdAt: new Date("2026-06-15T10:00:00Z"), inputType: "write", rawContent: "x",
    };
    const { db } = createControllerDb(controller, [entry]);

    await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => ({ output: { status: "failed" }, error: "cli failed", runId: "run-1" }),
    });

    expect(commitThreadAgentActionsMock).not.toHaveBeenCalled(); // failed run → no commit, no leak
  });

  it("adjutant-runner throw reschedules (pendingRun=true) under the cap", async () => {
    const threadId = "thread-runner-throw";
    const controller: ControllerState = {
      threadId, runEpoch: 1, pendingRun: true,
      lastProcessedEntryId: null, lastError: null, consecutiveCommitFailures: 0,
    };
    const entry: EntryRow = {
      id: "entry-a", discussionId: threadId, seq: 1,
      createdAt: new Date("2026-06-15T10:00:00Z"), inputType: "write", rawContent: "x",
    };
    const { db, cursorCommits } = createControllerDb(controller, [entry]);

    const result = await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => { throw new Error("cli auth failed"); },
    });

    expect(result).toMatchObject({ ran: true, suppressed: false, cursorAdvancedTo: null });
    expect(controller.pendingRun).toBe(true); // re-driven by the sweep
    expect(controller.consecutiveCommitFailures).toBe(1); // bounded
    expect(cursorCommits).toEqual([]); // not advanced under cap
    expect(controller.lastError).toBe("cli auth failed");
  });

  it("adjutant-runner throw at the cap advances past the poison entry", async () => {
    const threadId = "thread-runner-throw-cap";
    const controller: ControllerState = {
      threadId, runEpoch: 1, pendingRun: true,
      lastProcessedEntryId: null, lastError: null, consecutiveCommitFailures: 2,
    };
    const entry: EntryRow = {
      id: "entry-a", discussionId: threadId, seq: 1,
      createdAt: new Date("2026-06-15T10:00:00Z"), inputType: "write", rawContent: "x",
    };
    const { db, cursorCommits } = createControllerDb(controller, [entry]);

    const result = await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => { throw new Error("cli auth failed"); },
    });

    expect(result).toMatchObject({ ran: true, suppressed: false, cursorAdvancedTo: "entry-a" });
    expect(cursorCommits).toEqual(["entry-a"]);
    expect(controller.consecutiveCommitFailures).toBe(0);
    expect(controller.lastError).toMatch(/action_commit_failed_skipped|cli auth failed/);
  });

  it("entries-load throw reschedules under the cap (pendingRun=true), no cursor advance", async () => {
    const threadId = "thread-load-throw";
    const controller: ControllerState = {
      threadId, runEpoch: 1, pendingRun: true,
      lastProcessedEntryId: null, lastError: null, consecutiveCommitFailures: 0,
    };
    const { db, cursorCommits } = createControllerDb(controller, [], new Error("db read timeout"));

    const result = await threadOrchestrationService(db).runController(threadId, {
      adjutantRunner: async () => ({ output: "done", runId: "run-1" }),
    });

    expect(result).toMatchObject({ ran: true, suppressed: false, cursorAdvancedTo: null });
    expect(controller.pendingRun).toBe(true);
    expect(controller.consecutiveCommitFailures).toBe(1);
    expect(cursorCommits).toEqual([]);
    expect(controller.lastError).toBe("db read timeout");
  });
});
