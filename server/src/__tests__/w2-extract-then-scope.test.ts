// W2 Task 4 — the controller `create_scope_draft` handler runs extract-then-scope:
//   (a) extractionService.extractThreadEntriesAwait is AWAITED BEFORE createDraftFromThread,
//       with (companyId, threadId);
//   (b) createDraftFromThread receives suppressFallbackTask: true (an extracted-and-empty
//       thread must never show a fake card — D6);
//   (c) extraction REJECTING does not block the draft (defense-in-depth: the helper never
//       throws by contract, but the handler must not depend on that).
//
// Mock stack mirrors w1b-auto-accept.test.ts (same handler under test).

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveScopeAutoAcceptGate, mockDispatchCreatedCrewTasks } = vi.hoisted(() => ({
  mockResolveScopeAutoAcceptGate: vi.fn(),
  mockDispatchCreatedCrewTasks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/crew-task-service.js", () => ({
  resolveScopeAutoAcceptGate: mockResolveScopeAutoAcceptGate,
  dispatchCreatedCrewTasks: mockDispatchCreatedCrewTasks,
  resolveCreationGate: vi.fn(),
}));

const { mockPreflightCrewDispatch } = vi.hoisted(() => ({
  mockPreflightCrewDispatch: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("../services/crew-budget.js", () => ({
  preflightCrewDispatch: mockPreflightCrewDispatch,
}));

const { mockResolveRoleToAgentId } = vi.hoisted(() => ({
  mockResolveRoleToAgentId: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/internal-agent/tools/crew-role-map.js", () => ({
  resolveRoleToAgentId: mockResolveRoleToAgentId,
}));

vi.mock("../services/threads.js", () => ({
  parseMentions: (_text: string) => [],
  processMentions: vi.fn().mockResolvedValue(undefined),
  threadService: vi.fn(() => ({ advancePhase: vi.fn() })),
}));

const { mockApprovalCreate, mockEmitHubItem, mockBuildApprovalHubEmit } = vi.hoisted(() => ({
  mockApprovalCreate: vi.fn().mockResolvedValue({ id: "ap-w2-1", companyId: "company-w2", type: "crew_dispatch" }),
  mockEmitHubItem: vi.fn().mockResolvedValue(undefined),
  mockBuildApprovalHubEmit: vi.fn().mockReturnValue({ semanticType: "approval_request" }),
}));
vi.mock("../services/approvals.js", () => ({
  approvalService: () => ({ create: mockApprovalCreate }),
}));
vi.mock("../services/hub-source-producers.js", () => ({
  emitHubItem: mockEmitHubItem,
  buildApprovalHubEmit: mockBuildApprovalHubEmit,
}));

// W2: the handler awaits extraction before compiling the draft.
const { mockExtractThreadEntriesAwait } = vi.hoisted(() => ({
  mockExtractThreadEntriesAwait: vi.fn().mockResolvedValue({ attempted: 2, failed: 0, truncated: false, deadlineHit: false, lastAttemptedSeq: 2, rangeEndCap: null }),
}));
vi.mock("../services/extraction.js", () => ({
  extractionService: () => ({ extractThreadEntriesAwait: mockExtractThreadEntriesAwait }),
}));

import { threadAgentActionService } from "../services/thread-agent-actions.js";

const COMPANY_ID = "company-w2";
const THREAD_ID = "thread-w2";
const VERSION_ID = "sv-w2-1";
const AGENT_ID = "agent-controller-1";

const scopeDraftAction = {
  id: "action-w2-1",
  companyId: COMPANY_ID,
  threadId: THREAD_ID,
  runId: "run-w2",
  agentId: AGENT_ID,
  actionType: "create_scope_draft",
  status: "proposed",
  payload: { summary: "W2 test scope" },
  idempotencyKey: "run-w2:create_scope_draft:1",
  freshness: { latestHumanSeq: 1 },
};

const draftReturn = {
  status: "created",
  version: { id: VERSION_ID },
};

/**
 * Sequence DB mirroring w1b-auto-accept.test.ts:
 *   select[0] — the ready action row
 *   select[1] — discussions.autonomyLevel (thread)
 *   select[2] — internalAgentConfig.autonomyLevel (company)
 *   select[3] — threadScopeItems (task_proposal drafts)
 * plus a chained update (mark action committed).
 */
function makeDb() {
  let selectIdx = 0;
  const selects = [
    [scopeDraftAction],
    [{ autonomyLevel: 0 }], // thread → Manual (keep W1b out of the way)
    [{ autonomyLevel: 0 }],
    [],
  ];
  const chain = (rows: () => unknown[]): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit", "values", "set", "onConflictDoNothing", "returning", "leftJoin"]) {
      c[m] = (_arg?: unknown) => c;
    }
    c.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(rows()));
    return c;
  };
  const db = {
    select: () => chain(() => selects[selectIdx++] ?? []),
    insert: () => chain(() => []),
    update: () => chain(() => [{ ...scopeDraftAction, status: "committed" }]),
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveScopeAutoAcceptGate.mockReturnValue("draft_only");
  mockExtractThreadEntriesAwait.mockResolvedValue({ attempted: 2, failed: 0, truncated: false, deadlineHit: false, lastAttemptedSeq: 2, rangeEndCap: null });
});

describe("W2: create_scope_draft runs extract-then-scope", () => {
  it("(a) awaits extractThreadEntriesAwait(companyId, threadId) BEFORE createDraftFromThread", async () => {
    const db = makeDb();
    const createDraftFromThread = vi.fn().mockResolvedValue(draftReturn);

    await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread, createOutputItem: vi.fn() },
    }).commitThreadAgentActions({ companyId: COMPANY_ID, threadId: THREAD_ID, runId: "run-w2" });

    expect(mockExtractThreadEntriesAwait).toHaveBeenCalledTimes(1);
    expect(mockExtractThreadEntriesAwait).toHaveBeenCalledWith(COMPANY_ID, THREAD_ID);
    expect(createDraftFromThread).toHaveBeenCalledTimes(1);
    // Order: extraction strictly before the draft compile.
    const extractOrder = mockExtractThreadEntriesAwait.mock.invocationCallOrder[0];
    const draftOrder = createDraftFromThread.mock.invocationCallOrder[0];
    expect(extractOrder).toBeLessThan(draftOrder);
  });

  it("(b) createDraftFromThread receives suppressFallbackTask: true", async () => {
    const db = makeDb();
    const createDraftFromThread = vi.fn().mockResolvedValue(draftReturn);

    await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread, createOutputItem: vi.fn() },
    }).commitThreadAgentActions({ companyId: COMPANY_ID, threadId: THREAD_ID, runId: "run-w2" });

    const optionsArg = createDraftFromThread.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.suppressFallbackTask).toBe(true);
  });

  it("(e) Codex #270 P2: proposedTasks present → extraction is SKIPPED entirely (the Adjutant already articulated the work; no duplicate pending items)", async () => {
    const db = makeDb();
    const createDraftFromThread = vi.fn().mockResolvedValue(draftReturn);
    // The action carries proposedTasks — patch the fixture payload for this run.
    scopeDraftAction.payload = {
      summary: "W2 test scope",
      proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
    } as never;

    try {
      await threadAgentActionService(db as never, {
        compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
        discussions: { addEntry: vi.fn() },
        scopeVersions: { createDraftFromThread, createOutputItem: vi.fn() },
      }).commitThreadAgentActions({ companyId: COMPANY_ID, threadId: THREAD_ID, runId: "run-w2" });
    } finally {
      scopeDraftAction.payload = { summary: "W2 test scope" } as never; // restore fixture
    }

    expect(mockExtractThreadEntriesAwait).not.toHaveBeenCalled();
    expect(createDraftFromThread).toHaveBeenCalledTimes(1);
    const optionsArg = createDraftFromThread.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.suppressFallbackTask).toBe(true);
    expect(Array.isArray(optionsArg.proposedTasks)).toBe(true);
  });

  it("(f) Codex #270 P1: a truncated extraction pass caps the draft range at lastAttemptedSeq", async () => {
    mockExtractThreadEntriesAwait.mockResolvedValue({
      attempted: 25, failed: 0, truncated: true, deadlineHit: false, lastAttemptedSeq: 7, rangeEndCap: 7,
    });
    const db = makeDb();
    const createDraftFromThread = vi.fn().mockResolvedValue(draftReturn);

    await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread, createOutputItem: vi.fn() },
    }).commitThreadAgentActions({ companyId: COMPANY_ID, threadId: THREAD_ID, runId: "run-w2" });

    const optionsArg = createDraftFromThread.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.sourceEndSeqOverride).toBe(7);
  });

  it("(g) a clean (non-truncated) extraction pass does NOT cap the range", async () => {
    const db = makeDb();
    const createDraftFromThread = vi.fn().mockResolvedValue(draftReturn);

    await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread, createOutputItem: vi.fn() },
    }).commitThreadAgentActions({ companyId: COMPANY_ID, threadId: THREAD_ID, runId: "run-w2" });

    const optionsArg = createDraftFromThread.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.sourceEndSeqOverride).toBeUndefined();
  });

  it("(d) Codex #270 P1: freshness is RE-CHECKED after the awaited extraction — a thread that moved on suppresses the action instead of minting a stale draft", async () => {
    const db = makeDb();
    const createDraftFromThread = vi.fn().mockResolvedValue(draftReturn);
    // Fresh at the pre-commit check (before extraction), STALE after the await —
    // a founder posted a newer human entry while extraction ran.
    const compareFreshnessSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ fresh: true })
      .mockResolvedValueOnce({ fresh: false, reason: "newer_human_entry" });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot,
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread, createOutputItem: vi.fn() },
    }).commitThreadAgentActions({ companyId: COMPANY_ID, threadId: THREAD_ID, runId: "run-w2" });

    // Extraction ran (the wait is exactly where the world moved on) …
    expect(mockExtractThreadEntriesAwait).toHaveBeenCalledTimes(1);
    // … but the draft was NOT minted, and the action is suppressed like any stale action.
    expect(createDraftFromThread).not.toHaveBeenCalled();
    expect(result.suppressed).toBe(1);
    expect(result.committed).toBe(0);
    expect(compareFreshnessSnapshot).toHaveBeenCalledTimes(2);
  });

  it("(c) extraction REJECTING does not block the draft — still compiled, action still commits", async () => {
    mockExtractThreadEntriesAwait.mockRejectedValue(new Error("extraction exploded"));
    const db = makeDb();
    const createDraftFromThread = vi.fn().mockResolvedValue(draftReturn);

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread, createOutputItem: vi.fn() },
    }).commitThreadAgentActions({ companyId: COMPANY_ID, threadId: THREAD_ID, runId: "run-w2" });

    expect(createDraftFromThread).toHaveBeenCalledTimes(1);
    expect(result.committed).toBe(1);
    expect(result.failed).toBe(0);
  });
});
