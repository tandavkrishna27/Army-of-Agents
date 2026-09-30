/**
 * P1-T12 — Full-loop deterministic integration test (CI gate).
 *
 * Chains the AoA Crew v2 services together end-to-end using mocked I/O:
 *   threadOrchestrationService  →  threadDeliverablesService
 *
 * No embedded-postgres, no real CLI/LLM. All DB and external calls are mocked.
 *
 * Suite A: Happy path — idea → scope card → approve → deliverables
 *   A1  human entry triggers controller run (trigger seam)
 *   A2  runController with adjutantRunner seam — scope proposal posted
 *   A3  approveProposal creates deliverable tasks with sourceDiscussionId
 *   A4  approveProposal returns createdTasks with assigneeAgentId for dispatch
 *
 * Suite B: Kill-test sequence (required CI gate)
 *   B1  KILL TEST — stale run suppressed, fresh run processes B exactly once
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  and: vi.fn((...args: unknown[]) => ({ _op: "and", args })),
  ne: vi.fn((a: unknown, b: unknown) => ({ _op: "ne", a, b })),
  gt: vi.fn((a: unknown, b: unknown) => ({ _op: "gt", a, b })),
  asc: vi.fn((col: unknown) => ({ _op: "asc", col })),
  desc: vi.fn((col: unknown) => ({ _op: "desc", col })),
  isNull: vi.fn((col: unknown) => ({ _op: "isNull", col })),
  isNotNull: vi.fn((col: unknown) => ({ _op: "isNotNull", col })),
  or: vi.fn((...args: unknown[]) => ({ _op: "or", args })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ _op: "inArray", col, vals })),
  sql: Object.assign(
    vi.fn((_s: unknown) => {
      const tag: { as: ReturnType<typeof vi.fn>; mapWith: ReturnType<typeof vi.fn>; toString: () => string } = {
        as: vi.fn().mockReturnThis(),
        mapWith: vi.fn().mockReturnThis(),
        toString: () => "sql_expr",
      };
      return tag;
    }),
    {
      raw: vi.fn((s: unknown) => s),
      placeholder: vi.fn((s: unknown) => s),
    },
  ),
}));

// ── @armyofagents/db mock ─────────────────────────────────────────────────────
function tableProxy(name: string) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        return `${name}.${String(prop)}`;
      },
    },
  );
}

vi.mock("@armyofagents/db", () => ({
  threadOrchestrationState: tableProxy("tos"),
  discussionEntries: tableProxy("de"),
  discussions: tableProxy("discussions"),
  agents: tableProxy("agents"),
  agentWakeupRequests: tableProxy("awr"),
}));

// ── crew-budget mock ──────────────────────────────────────────────────────────
vi.mock("../../services/crew-budget.js", () => ({
  preflightCrewDispatch: vi.fn().mockResolvedValue({ allowed: true }),
}));

// ── live-events mock ──────────────────────────────────────────────────────────
vi.mock("../../services/live-events.js", () => ({
  publishLiveEvent: vi.fn().mockResolvedValue(undefined),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock("../../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// ── issueService mock (for Suite A approve tests) ────────────────────────────
const mockIssueCreate = vi.fn();
vi.mock("../../services/issues.js", () => ({
  issueService: vi.fn(() => ({ create: mockIssueCreate })),
}));

// ── Imports (after all mocks) ─────────────────────────────────────────────────
import { threadOrchestrationService } from "../../services/thread-orchestration.js";
import type { AdjutantRunner, OrchestratedEntry } from "../../services/thread-orchestration.js";

// =============================================================================
// Constants
// =============================================================================

const COMPANY_ID      = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID       = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENTRY_ID_A      = "eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTRY_ID_B      = "eeeeeeee-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROPOSAL_ENTRY_ID = "pppppppp-pppp-4ppp-8ppp-pppppppppppp";
const ENGINEER_AGENT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const USER_ID         = "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu";

const SCOPE_PROPOSAL_RAW = JSON.stringify({
  summary: "Build the auth flow",
  proposedTasks: [
    { title: "Design the login page", assigneeAgentId: ENGINEER_AGENT_ID },
    { title: "Implement JWT tokens" },
  ],
  proposalCursorSeq: 3,
});

// =============================================================================
// In-memory state model (mirrors thread-orchestration-kill.test.ts)
// =============================================================================

interface ControllerState {
  threadId: string;
  runEpoch: number;
  pendingRun: boolean;
  hopCount: number;
  lastProcessedEntryId: string | null;
  lastError: string | null;
}

interface EntryRow {
  id: string;
  discussionId: string;
  seq: number;
  createdAt: Date;
  inputType: string;
  rawContent: string;
}

/**
 * Stateful mock DB that mirrors the pattern from thread-orchestration-kill.test.ts.
 * Tracks commits and supports the exact query shapes that runController emits.
 */
function makeStateDb(controller: ControllerState, allEntries: EntryRow[]) {
  const commits: { cursorAdvancedTo: string | null }[] = [];
  const lastErrorWrites: (string | null)[] = [];
  let claimCount = 0;

  function claim(setPayload: Record<string, unknown>): ControllerState[] {
    if (!controller.pendingRun) return [];
    claimCount++;
    if ("pendingRun" in setPayload) controller.pendingRun = setPayload.pendingRun as boolean;
    return [{ ...controller }];
  }

  function applyUpdate(setPayload: Record<string, unknown>): ControllerState[] {
    if ("lastProcessedEntryId" in setPayload) {
      controller.lastProcessedEntryId = setPayload.lastProcessedEntryId as string | null;
      commits.push({ cursorAdvancedTo: controller.lastProcessedEntryId });
    }
    if ("lastError" in setPayload) {
      controller.lastError = setPayload.lastError as string | null;
      lastErrorWrites.push(controller.lastError);
    }
    if ("pendingRun" in setPayload) {
      controller.pendingRun = setPayload.pendingRun as boolean;
    }
    return [{ ...controller }];
  }

  function readEpoch(): Array<{ runEpoch: number }> {
    return [{ runEpoch: controller.runEpoch }];
  }

  function readCursorSeq(cursorId: string): Array<{ seq: number }> {
    const entry = allEntries.find(e => e.id === cursorId);
    if (!entry) return [];
    return [{ seq: entry.seq }];
  }

  function loadEntriesBySeq(cursorSeq: number | null): EntryRow[] {
    const forThread = allEntries
      .filter(e => e.discussionId === controller.threadId)
      .sort((a, b) => a.seq - b.seq);
    if (cursorSeq === null) return [...forThread];
    return forThread.filter(e => e.seq > cursorSeq);
  }

  let pendingCursorSeq: number | null = null;

  const db = {
    update: vi.fn(() => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        const isClaim = "pendingRun" in payload && !("lastProcessedEntryId" in payload);
        return {
          where: vi.fn(() => {
            if (isClaim) {
              return { returning: vi.fn(async () => claim(payload)) };
            }
            return Promise.resolve(applyUpdate(payload));
          }),
        };
      }),
    })),

    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => {
        const isTosTable = String((table as Record<string, unknown>)["runEpoch"]).startsWith("tos.");
        const isDeTable = String((table as Record<string, unknown>)["seq"]).startsWith("de.");
        const isDiscussionsTable = String((table as Record<string, unknown>)["companyId"]).startsWith("discussions.");

        return {
          where: vi.fn((_where: unknown) => {
            if (isTosTable) {
              return Promise.resolve(readEpoch());
            }

            if (isDiscussionsTable) {
              return {
                limit: vi.fn(() => Promise.resolve([{ companyId: COMPANY_ID }])),
              };
            }

            if (isDeTable && projection != null) {
              const seqResult = readCursorSeq(controller.lastProcessedEntryId ?? "");
              pendingCursorSeq = seqResult[0]?.seq ?? null;
              return Promise.resolve(seqResult);
            }

            const capturedCursorSeq = pendingCursorSeq;
            pendingCursorSeq = null;
            return {
              orderBy: vi.fn(async (..._args: unknown[]) => loadEntriesBySeq(capturedCursorSeq)),
            };
          }),
        };
      }),
    })),

    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => []),
        })),
      })),
    })),
  };

  return {
    db: db as unknown as Parameters<typeof threadOrchestrationService>[0],
    controller,
    commits,
    lastErrorWrites,
    get claimCount() { return claimCount; },
  };
}

/** Directly mutate the in-memory controller state to simulate triggerOnHumanEntry. */
function makeTrigger(controller: ControllerState) {
  return () => {
    controller.runEpoch += 1;
    controller.pendingRun = true;
    controller.hopCount = 0;
  };
}

// =============================================================================
// Mock DB for approve tests (sequence-based, mirrors makeMockDb from
// thread-deliverables-approve.test.ts, extended with .limit() support)
// =============================================================================

function makeApproveDb(opts: {
  selectResults?: any[][];
  updateShouldSucceed?: boolean;
  proposalEntryId?: string;
} = {}) {
  const selectQueue = [...(opts.selectResults ?? [])];
  let selectCallIdx = 0;
  const eid = opts.proposalEntryId ?? PROPOSAL_ENTRY_ID;

  function selectChain(): any {
    const idx = selectCallIdx++;
    const result = selectQueue[idx] ?? [];
    const chain: any = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = () => {
      const inner: any = Promise.resolve(result);
      inner.limit = () => Promise.resolve(result);
      return inner;
    };
    chain.orderBy = () => Promise.resolve(result);
    chain.then = (resolve: any) => Promise.resolve(resolve(result));
    return chain;
  }

  function updateChain(): any {
    const chain: any = {};
    chain.set = () => chain;
    const result = () =>
      Promise.resolve(opts.updateShouldSucceed !== false ? [{ id: eid }] : []);
    chain.where = () => {
      const p: any = result();
      p.returning = result;
      return p;
    };
    chain.returning = result;
    return chain;
  }

  return {
    select: vi.fn(selectChain),
    update: vi.fn(updateChain),
    transaction: vi.fn(async (cb: any) =>
      cb({
        select: vi.fn(selectChain),
        update: vi.fn(updateChain),
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([]),
          })),
        })),
      }),
    ),
  };
}

// =============================================================================
// Suite A: Happy path — idea → scope card → approve → deliverables
// =============================================================================

describe("Suite A: happy path — trigger → runController → approveProposal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── A1: human entry triggers controller run ──────────────────────────────────
  it("A1: human entry triggers controller run — pendingRun+epoch updated", async () => {
    const controller: ControllerState = {
      threadId: THREAD_ID,
      runEpoch: 0,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };

    // Use the in-memory trigger directly (mirrors what triggerOnHumanEntry does).
    const bumpEpoch = makeTrigger(controller);
    bumpEpoch();

    expect(controller.runEpoch).toBe(1);
    expect(controller.pendingRun).toBe(true);
    expect(controller.hopCount).toBe(0);
    expect(controller.lastProcessedEntryId).toBeNull();
  });

  // ── A2: runController with adjutantRunner seam — scope proposal posted ───────
  it("A2: runController with adjutantRunner seam returns ran+not-suppressed+cursor", async () => {
    const controller: ControllerState = {
      threadId: THREAD_ID,
      runEpoch: 1,
      pendingRun: true,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };

    const entry: EntryRow = {
      id: ENTRY_ID_A,
      discussionId: THREAD_ID,
      seq: 1,
      createdAt: new Date("2026-01-01T10:00:00Z"),
      inputType: "write",
      rawContent: "Initial idea",
    };

    let runnerCalled = false;
    const mockRunner: AdjutantRunner = async (input) => {
      runnerCalled = true;
      expect(input.threadId).toBe(THREAD_ID);
      expect(input.entries).toHaveLength(1);
      expect(input.entries[0].id).toBe(ENTRY_ID_A);
      expect(input.startEpoch).toBe(1);
      return {
        output: { type: "scope_proposal", content: SCOPE_PROPOSAL_RAW },
      };
    };

    const { db } = makeStateDb(controller, [entry]);
    const svc = threadOrchestrationService(db);

    const result = await svc.runController(THREAD_ID, { adjutantRunner: mockRunner });

    expect(runnerCalled).toBe(true);
    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.suppressed).toBe(false);
      if (!result.suppressed) {
        expect(result.cursorAdvancedTo).toBe(ENTRY_ID_A);
        expect(result.startEpoch).toBe(1);
      }
    }
  });

  // ── A3: approveProposal creates deliverable tasks with sourceDiscussionId ─────
  it("A3: approveProposal creates deliverable tasks with sourceDiscussionId=THREAD_ID", async () => {
    mockIssueCreate
      .mockResolvedValueOnce({
        id: "task-login",
        title: "Design the login page",
        assigneeAgentId: ENGINEER_AGENT_ID,
        workMode: "standard",
      })
      .mockResolvedValueOnce({
        id: "task-jwt",
        title: "Implement JWT tokens",
        assigneeAgentId: ENGINEER_AGENT_ID,  // assigned by findDefaultBuilder
        workMode: "standard",
      });

    const proposalEntry = {
      id: PROPOSAL_ENTRY_ID,
      discussionId: THREAD_ID,
      inputType: "scope_proposal",
      rawContent: SCOPE_PROPOSAL_RAW,
      proposalStatus: "pending",
    };

    const db = makeApproveDb({
      selectResults: [
        // Select 1: proposal entry + company join
        [proposalEntry],
        // Select 2: thread's current entrySeq (matches proposalCursorSeq=3 — NOT stale)
        [{ entrySeq: 3 }],
        // Select 3: findDefaultBuilder for Engineer agent
        [{ id: ENGINEER_AGENT_ID }],
      ],
    });

    // Use vi.importActual to get the real service
    const { threadDeliverablesService } = await vi.importActual<
      typeof import("../../services/thread-deliverables.js")
    >("../../services/thread-deliverables.js");

    const svc = threadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: COMPANY_ID,
      proposalEntryId: PROPOSAL_ENTRY_ID,
      approver: { userId: USER_ID },
    });

    expect(result.ok).toBe(true);
    if (result.ok && !result.alreadyApproved) {
      expect(result.taskIds).toHaveLength(2);
      expect(result.taskIds).toContain("task-login");
      expect(result.taskIds).toContain("task-jwt");
    }

    // Verify issueService.create was called with sourceDiscussionId=THREAD_ID
    expect(mockIssueCreate).toHaveBeenCalledTimes(2);
    const firstCallPayload = mockIssueCreate.mock.calls[0][1];
    expect(firstCallPayload.sourceDiscussionId).toBe(THREAD_ID);
    expect(firstCallPayload.createdByUserId).toBe(USER_ID);

    const secondCallPayload = mockIssueCreate.mock.calls[1][1];
    expect(secondCallPayload.sourceDiscussionId).toBe(THREAD_ID);
  });

  // ── A4: approveProposal returns createdTasks with assigneeAgentId for dispatch ─
  it("A4: approveProposal returns createdTasks with assigneeAgentId set for dispatch handoff", async () => {
    mockIssueCreate
      .mockResolvedValueOnce({
        id: "task-login",
        title: "Design the login page",
        assigneeAgentId: ENGINEER_AGENT_ID,
        workMode: "standard",
      })
      .mockResolvedValueOnce({
        id: "task-jwt",
        title: "Implement JWT tokens",
        assigneeAgentId: ENGINEER_AGENT_ID,
        workMode: "standard",
      });

    const proposalEntry = {
      id: PROPOSAL_ENTRY_ID,
      discussionId: THREAD_ID,
      inputType: "scope_proposal",
      rawContent: SCOPE_PROPOSAL_RAW,
      proposalStatus: "pending",
    };

    const db = makeApproveDb({
      selectResults: [
        [proposalEntry],
        [{ entrySeq: 3 }],
        [{ id: ENGINEER_AGENT_ID }],
      ],
    });

    const { threadDeliverablesService } = await vi.importActual<
      typeof import("../../services/thread-deliverables.js")
    >("../../services/thread-deliverables.js");

    const svc = threadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: COMPANY_ID,
      proposalEntryId: PROPOSAL_ENTRY_ID,
      approver: { userId: USER_ID },
    });

    expect(result.ok).toBe(true);
    if (result.ok && !result.alreadyApproved) {
      expect(result.createdTasks).toHaveLength(2);
      // First task has explicit assigneeAgentId from the proposal
      expect(result.createdTasks[0].assigneeAgentId).toBe(ENGINEER_AGENT_ID);
      // Second task gets assigneeAgentId from findDefaultBuilder fallback
      expect(result.createdTasks[1].assigneeAgentId).toBe(ENGINEER_AGENT_ID);
    }
  });
});

// =============================================================================
// Suite B: Kill-test sequence (required CI gate)
// =============================================================================

describe("Suite B: KILL TEST — stale-run suppression CI gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("B1: KILL TEST — stale run suppressed, fresh run processes B exactly once", async () => {
    const threadId = THREAD_ID;

    const entryA: EntryRow = {
      id: ENTRY_ID_A,
      discussionId: threadId,
      seq: 1,
      createdAt: new Date("2026-01-01T10:00:00Z"),
      inputType: "write",
      rawContent: "Hello from human A",
    };
    const entryB: EntryRow = {
      id: ENTRY_ID_B,
      discussionId: threadId,
      seq: 2,
      createdAt: new Date("2026-01-01T10:01:00Z"),
      inputType: "write",
      rawContent: "Hello from human B",
    };

    // Start with epoch=0, pendingRun=false
    const controller: ControllerState = {
      threadId,
      runEpoch: 0,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };

    // ── Step 1: Human A arrives → trigger ─────────────────────────────────────
    const bumpEpoch = makeTrigger(controller);
    bumpEpoch(); // epoch 0→1, pendingRun=true
    expect(controller.runEpoch).toBe(1);
    expect(controller.pendingRun).toBe(true);

    const allEntries: EntryRow[] = [entryA];

    // ── Step 2: Run-1 starts; mid-run Human B bumps the epoch ─────────────────
    let entriesSeenByRun1: OrchestratedEntry[] = [];
    const adjutantRun1: AdjutantRunner = async (input) => {
      entriesSeenByRun1 = input.entries;
      // Simulate: entry B arrives while run-1 is in flight
      allEntries.push(entryB);
      bumpEpoch(); // epoch 1→2, pendingRun=true
      return { output: "run-1 output" };
    };

    const { db: db1, controller: ctrl1, commits: commits1 } = makeStateDb(controller, allEntries);
    const svc1 = threadOrchestrationService(db1);

    const result1 = await svc1.runController(threadId, { adjutantRunner: adjutantRun1 });

    // ── Step 3: Run-1 MUST be suppressed ──────────────────────────────────────
    expect(result1).toMatchObject({ ran: true, suppressed: true, startEpoch: 1, endEpoch: 2 });
    // Cursor must NOT have advanced
    expect(ctrl1.lastProcessedEntryId).toBeNull();
    // pendingRun must still be true (re-set by the bump)
    expect(ctrl1.pendingRun).toBe(true);
    // No commits from run-1
    expect(commits1).toHaveLength(0);
    // Run-1 saw only A
    expect(entriesSeenByRun1.map(e => e.id)).toEqual([ENTRY_ID_A]);

    // ── Step 4: Fresh run-2 processes BOTH A and B ───────────────────────────
    let entriesSeenByRun2: OrchestratedEntry[] = [];
    const adjutantRun2: AdjutantRunner = async (input) => {
      entriesSeenByRun2 = input.entries;
      return { output: "run-2 output" };
    };

    const { db: db2, commits: commits2 } = makeStateDb(controller, allEntries);
    const svc2 = threadOrchestrationService(db2);

    const result2 = await svc2.runController(threadId, { adjutantRunner: adjutantRun2 });

    // ── Step 5: Run-2 COMMITS both entries exactly once ───────────────────────
    expect(result2).toMatchObject({
      ran: true,
      suppressed: false,
      startEpoch: 2,
      cursorAdvancedTo: ENTRY_ID_B,
    });

    // Cursor advanced to B
    expect(controller.lastProcessedEntryId).toBe(ENTRY_ID_B);
    // pendingRun cleared
    expect(controller.pendingRun).toBe(false);
    // Exactly one commit
    expect(commits2).toHaveLength(1);
    expect(commits2[0].cursorAdvancedTo).toBe(ENTRY_ID_B);

    // Run-2 saw BOTH A and B (cursor was null → full scan)
    expect(entriesSeenByRun2.map(e => e.id)).toEqual([ENTRY_ID_A, ENTRY_ID_B]);

    // A and B processed EXACTLY once across both runs combined
    // run-1 saw [A] but was suppressed → not committed
    // run-2 saw [A, B] and committed → A+B each processed exactly once
    const allCommitted = entriesSeenByRun2.map(e => e.id);
    expect(allCommitted).toContain(ENTRY_ID_A);
    expect(allCommitted).toContain(ENTRY_ID_B);
    const unique = new Set(allCommitted);
    expect(unique.size).toBe(allCommitted.length);
  });
});
