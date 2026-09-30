/**
 * P1-T7: Tests for the secure scope-proposal Approve handler.
 *
 * Structure:
 *  A. Service unit tests — real threadDeliverablesService with mock DB (via vi.importActual).
 *  B. parseScopeProposalContent pure-helper tests.
 *  C. Route contract test — POST endpoint exists.
 *  D. Route integration tests (supertest) — authz, stale, happy path, idempotency.
 *
 * Mocking strategy:
 *  - `@armyofagents/db` and `drizzle-orm` are mocked with Proxy stubs (whole file).
 *  - `issueService` is mocked so service tests don't pull Drizzle internals.
 *  - `thread-deliverables.js` is mocked via `importOriginal` so the route mock
 *    intercepts the dynamic import inside the route handler. Section A/B bypass
 *    this via `vi.importActual` to exercise the real code.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Drizzle + DB mocks ────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: any, b: any) => ({ _tag: "eq", a, b })),
  and: vi.fn((...args: any[]) => ({ _tag: "and", args })),
  ne: vi.fn((a: any, b: any) => ({ _tag: "ne", a, b })),
  gt: vi.fn((a: any, b: any) => ({ _tag: "gt", a, b })),
  asc: vi.fn((col: any) => ({ _tag: "asc", col })),
  desc: vi.fn((col: any) => ({ _tag: "desc", col })),
  inArray: vi.fn((col: any, vals: any) => ({ _tag: "inArray", col, vals })),
  sql: vi.fn(),
}));

vi.mock("@armyofagents/db", () => ({
  discussionEntries: new Proxy({} as any, { get: (_t, p) => p }),
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
  discussionExtractedItems: new Proxy({} as any, { get: (_t, p) => p }),
  threadPlanSteps: new Proxy({} as any, { get: (_t, p) => p }),
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
  userRoles: new Proxy({} as any, { get: (_t, p) => p }),
  activityLog: new Proxy({} as any, { get: (_t, p) => p }),
  issues: new Proxy({} as any, { get: (_t, p) => p }),
  projects: new Proxy({} as any, { get: (_t, p) => p }),
  goals: new Proxy({} as any, { get: (_t, p) => p }),
  projectGoals: new Proxy({} as any, { get: (_t, p) => p }),
  assets: new Proxy({} as any, { get: (_t, p) => p }),
  artifacts: new Proxy({} as any, { get: (_t, p) => p }),
  memoryItems: new Proxy({} as any, { get: (_t, p) => p }),
  agents: new Proxy({} as any, { get: (_t, p) => p }),
  heartbeatRuns: new Proxy({} as any, { get: (_t, p) => p }),
}));

// ── issueService mock ─────────────────────────────────────────────────────────
const mockIssueCreate = vi.fn();

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({ create: mockIssueCreate })),
}));

// ── thread-deliverables: mock for route integration tests.
// Section A uses vi.importActual to bypass and get the real factory. ──────────
const mockApproveProposalFn = vi.fn();
const mockCreateDeliverableTasksFn = vi.fn();

vi.mock("../services/thread-deliverables.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/thread-deliverables.js")>();
  return {
    ...actual,
    // Override the factory so the route's dynamic `await import(...)` gets the mock
    threadDeliverablesService: vi.fn(() => ({
      createDeliverableTasks: mockCreateDeliverableTasksFn,
      approveProposal: mockApproveProposalFn,
    })),
    default: vi.fn(() => ({
      createDeliverableTasks: mockCreateDeliverableTasksFn,
      approveProposal: mockApproveProposalFn,
    })),
  };
});

// ── Route-level mocks ─────────────────────────────────────────────────────────
vi.mock("../services/index.js", () => ({
  discussionService: vi.fn(() => ({
    list: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(),
    addEntry: vi.fn(), reprocessEntry: vi.fn(), reprocessAllEntries: vi.fn(),
    updateItem: vi.fn(), approveItems: vi.fn(), rejectItems: vi.fn(),
    addAnnotation: vi.fn(), linkEntry: vi.fn(),
  })),
  logActivity: vi.fn().mockResolvedValue(undefined),
  permissionService: vi.fn(() => ({
    getEffectiveRole: vi.fn().mockResolvedValue("founder"),
  })),
  dependencyService: vi.fn(() => ({ addDependency: vi.fn() })),
}));

vi.mock("../services/threads.js", () => ({
  threadService: vi.fn(() => ({
    advancePhase: vi.fn(), claim: vi.fn(), transferOwnership: vi.fn(),
    addParticipant: vi.fn(), promoteToGoal: vi.fn(), assignScopeItems: vi.fn(),
    getPlanSteps: vi.fn(), updatePlanSteps: vi.fn(), entriesSince: vi.fn(),
    spinOff: vi.fn(), addScopeItemDependency: vi.fn(),
    graduateScopeItemDependencies: vi.fn(), routeItem: vi.fn(),
    createLink: vi.fn(), listLinks: vi.fn(),
  })),
  parseMentions: vi.fn(() => []),
  processMentions: vi.fn(),
}));

vi.mock("../middleware/validate.js", () => ({
  validate: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: vi.fn().mockResolvedValue(undefined),
  assertHumanRole: vi.fn().mockResolvedValue(undefined),
  assertDepartmentAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn().mockReturnValue({ actorType: "user", actorId: "u1", agentId: null }),
}));

vi.mock("../redaction.js", () => ({
  sanitizeRecord: vi.fn((r: any) => r),
}));

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => Object.assign(new Error(msg), { status: 400 }),
  notFound: (msg: string) => Object.assign(new Error(msg), { status: 404 }),
  unauthorized: () => Object.assign(new Error("Unauthorized"), { status: 401 }),
  forbidden: (msg: string) => Object.assign(new Error(msg ?? "Forbidden"), { status: 403 }),
  conflict: (msg: string) => Object.assign(new Error(msg), { status: 409 }),
  unprocessable: (msg: string) => Object.assign(new Error(msg), { status: 422 }),
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
  },
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: vi.fn().mockResolvedValue("founder"),
    isFounder: vi.fn().mockResolvedValue(true),
    isTeamLeadForDepartment: vi.fn().mockResolvedValue(false),
  })),
}));

// ── Mocks for T8b additions in discussions.ts ─────────────────────────────────
const mockWakeup = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: vi.fn(() => ({
    wakeup: mockWakeup,
  })),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock("../routes/issues-planning-mode-dispatch.js", () => ({
  shouldDispatchIssueWakeup: vi.fn().mockReturnValue(true),
}));

// ── Import routes + rbac mock after all vi.mock declarations ──────────────────
import { discussionRoutes } from "../routes/discussions.js";
import { assertHumanRole } from "../middleware/rbac.js";
import { permissionService as mockedPermissionServiceFactory } from "../services/permissions.js";
import express from "express";
import request from "supertest";

const mockedAssertHumanRole = vi.mocked(assertHumanRole);

// ─── Constants ─────────────────────────────────────────────────────────────────
const CO_ID = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
const THREAD_ID = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";
const ENTRY_ID = "cccccccc-0000-4000-8000-cccccccccccc";
const USER_ID = "dddddddd-0000-4000-8000-dddddddddddd";

// ─── Mock DB helpers ──────────────────────────────────────────────────────────

/**
 * A minimal mock Drizzle db. `selectResults` is consumed in order.
 * Chain: select().from().innerJoin?().where() → resolves to the queued result.
 */
function makeMockDb(opts: {
  selectResults?: any[][];
  updateShouldSucceed?: boolean;
} = {}) {
  const selectQueue = [...(opts.selectResults ?? [])];
  let selectCallIdx = 0;

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
    // The claim-first idempotency UPDATE ends in `.returning(...)`; the plain
    // update path ends in `.where(...)`. Support both: `.where()` resolves to
    // the result, and `.returning()` (after `.where()`) resolves to the same.
    const result = () =>
      Promise.resolve(opts.updateShouldSucceed !== false ? [{ id: ENTRY_ID }] : []);
    chain.where = () => {
      const p: any = result();
      p.returning = result;
      return p;
    };
    chain.returning = result;
    return chain;
  }

  // Expose the tx's update mock so tests can assert against it.
  // approveProposal now runs the claim UPDATE inside a db.transaction, so
  // the outer db.update is NOT called for the claim — only tx.update is.
  const txUpdate = vi.fn(updateChain);

  return {
    select: vi.fn(selectChain),
    update: vi.fn(updateChain),
    txUpdate,
    transaction: vi.fn(async (cb: any) =>
      cb({
        select: vi.fn(selectChain),
        update: txUpdate,
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([]),
          })),
        })),
      }),
    ),
  };
}

/** Valid scope proposal rawContent JSON. */
function makeProposalRaw(opts: {
  proposalCursorSeq?: number;
  proposedTasks?: Array<{ title: string; [k: string]: unknown }>;
} = {}) {
  return JSON.stringify({
    summary: "Build the auth flow",
    proposedTasks: opts.proposedTasks ?? [{ title: "Task A" }, { title: "Task B" }],
    proposalCursorSeq: opts.proposalCursorSeq ?? 5,
  });
}

/** Pending proposal entry row (proposalStatus = "pending" by default). */
function makePendingEntry(overrides: Partial<{
  id: string;
  discussionId: string;
  inputType: string;
  rawContent: string;
  proposalStatus: string | null;
}> = {}) {
  return {
    id: overrides.id ?? ENTRY_ID,
    discussionId: overrides.discussionId ?? THREAD_ID,
    inputType: overrides.inputType ?? "scope_proposal",
    rawContent: overrides.rawContent ?? makeProposalRaw({ proposalCursorSeq: 5 }),
    // P1-T7: approval lifecycle lives on proposalStatus, NOT extractionStatus.
    proposalStatus:
      overrides.proposalStatus === undefined ? "pending" : overrides.proposalStatus,
  };
}

// ════════════════════════════════════════════════════════════════════════
// A. Service unit tests (real service via vi.importActual, mock DB)
// ════════════════════════════════════════════════════════════════════════

describe("threadDeliverablesService.approveProposal (real service, mock DB)", () => {
  // Load the REAL service factory, bypassing the vi.mock override.
  // vi.importActual skips the factory replacement and returns the actual module.
  let realThreadDeliverablesService: typeof import("../services/thread-deliverables.js")["threadDeliverablesService"];

  beforeEach(async () => {
    vi.clearAllMocks();
    const actual = await vi.importActual<typeof import("../services/thread-deliverables.js")>(
      "../services/thread-deliverables.js",
    );
    realThreadDeliverablesService = actual.threadDeliverablesService;
  });

  // ── A1. Happy path ────────────────────────────────────────────────────────────
  it("happy path: creates tasks and marks proposal approved", async () => {
    mockIssueCreate
      .mockResolvedValueOnce({ id: "task-1", title: "Task A" })
      .mockResolvedValueOnce({ id: "task-2", title: "Task B" });

    const db = makeMockDb({
      selectResults: [
        // 1st select: entry + company join
        [makePendingEntry()],
        // 2nd select: thread's current entrySeq
        [{ entrySeq: 5 }],
      ],
    });

    const svc = realThreadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: ENTRY_ID,
      approver: { userId: USER_ID },
    });

    expect(result.ok).toBe(true);
    if (result.ok && !result.alreadyApproved) {
      expect(result.taskIds).toHaveLength(2);
      expect(result.taskIds).toContain("task-1");
      expect(result.taskIds).toContain("task-2");
    }
    expect(mockIssueCreate).toHaveBeenCalledTimes(2);
    // The claim UPDATE runs inside the transaction (tx.update), not on the outer db.update.
    expect(db.txUpdate).toHaveBeenCalled();
  });

  // ── A2. createDeliverableTasks called with correct args ───────────────────────
  it("passes sourceDiscussionId=threadId and createdByUserId=approver to each task", async () => {
    mockIssueCreate.mockResolvedValue({ id: "task-x", title: "Task X" });

    const db = makeMockDb({
      selectResults: [
        [makePendingEntry({
          rawContent: makeProposalRaw({
            proposedTasks: [{ title: "Task X" }],
            proposalCursorSeq: 3,
          }),
        })],
        [{ entrySeq: 3 }],
      ],
    });

    const svc = realThreadDeliverablesService(db as any);
    await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: ENTRY_ID,
      approver: { userId: USER_ID },
    });

    const createArg = mockIssueCreate.mock.calls[0][1];
    expect(createArg.sourceDiscussionId).toBe(THREAD_ID);
    expect(createArg.createdByUserId).toBe(USER_ID);
  });

  // ── A3. STALE — kill-test invariant ──────────────────────────────────────────
  it("STALE: rejects when currentSeq > proposalCursorSeq — NO tasks created", async () => {
    const db = makeMockDb({
      selectResults: [
        // Proposal stamped at seq=5
        [makePendingEntry({ rawContent: makeProposalRaw({ proposalCursorSeq: 5 }) })],
        // Thread now at seq=8 (3 newer entries)
        [{ entrySeq: 8 }],
      ],
    });

    const svc = realThreadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: ENTRY_ID,
      approver: { userId: USER_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("stale");
      expect(result.message).toMatch(/out of date/i);
    }
    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  // ── A4. Double-approve idempotency ────────────────────────────────────────────
  it("idempotent: second approve → alreadyApproved:true, no tasks created", async () => {
    const db = makeMockDb({
      selectResults: [
        [makePendingEntry({ proposalStatus: "approved" })],
      ],
    });

    const svc = realThreadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: ENTRY_ID,
      approver: { userId: USER_ID },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyApproved).toBe(true);
    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  // ── A5. Not found ─────────────────────────────────────────────────────────────
  it("returns not_found when entry does not exist for this company", async () => {
    const db = makeMockDb({ selectResults: [[]] });

    const svc = realThreadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: "nonexistent-id",
      approver: { userId: USER_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
    expect(mockIssueCreate).not.toHaveBeenCalled();
  });

  // ── A6. Wrong thread ──────────────────────────────────────────────────────────
  it("returns wrong_thread when proposal belongs to a different thread", async () => {
    const OTHER_THREAD = "eeeeeeee-0000-4000-8000-eeeeeeeeeeee";
    const db = makeMockDb({
      selectResults: [
        [makePendingEntry({ discussionId: OTHER_THREAD })],
      ],
    });

    const svc = realThreadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: ENTRY_ID,
      approver: { userId: USER_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_thread");
    expect(mockIssueCreate).not.toHaveBeenCalled();
  });

  // ── A7. Already rejected ──────────────────────────────────────────────────────
  it("returns rejected when proposal was already rejected (proposalStatus=rejected)", async () => {
    const db = makeMockDb({
      selectResults: [
        [makePendingEntry({ proposalStatus: "rejected" })],
      ],
    });

    const svc = realThreadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: ENTRY_ID,
      approver: { userId: USER_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("rejected");
    expect(mockIssueCreate).not.toHaveBeenCalled();
  });

  // ── A8. Equal seq is NOT stale ────────────────────────────────────────────────
  it("fresh: currentSeq === stampedSeq is NOT stale", async () => {
    mockIssueCreate.mockResolvedValue({ id: "task-z", title: "Task Z" });

    const db = makeMockDb({
      selectResults: [
        [makePendingEntry({ rawContent: makeProposalRaw({ proposalCursorSeq: 7 }) })],
        [{ entrySeq: 7 }], // exact match
      ],
    });

    const svc = realThreadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: ENTRY_ID,
      approver: { userId: USER_ID },
    });

    expect(result.ok).toBe(true);
    expect(mockIssueCreate).toHaveBeenCalled();
  });

  // ── A9. CLAIM-FIRST: lost race → alreadyApproved, NO tasks ────────────────────
  // Simulates the concurrent-approve loser: both requests read proposalStatus
  // "pending" (the SELECT), but the atomic claim UPDATE ... RETURNING comes back
  // empty because a concurrent approve already flipped pending -> approved.
  // The loser MUST NOT create tasks.
  it("CLAIM-FIRST: claim UPDATE returns no row → alreadyApproved, no tasks created", async () => {
    const db = makeMockDb({
      selectResults: [
        [makePendingEntry({ rawContent: makeProposalRaw({ proposalCursorSeq: 5 }) })],
        [{ entrySeq: 5 }],
      ],
      // The claim UPDATE ... RETURNING returns [] → this caller lost the race.
      updateShouldSucceed: false,
    });

    const svc = realThreadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: ENTRY_ID,
      approver: { userId: USER_ID },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyApproved).toBe(true);
    // The loser tried to claim (tx.update called) but created NO tasks.
    expect(db.txUpdate).toHaveBeenCalled();
    expect(mockIssueCreate).not.toHaveBeenCalled();
  });

  // ── A10. Two contending approves → tasks created EXACTLY once ─────────────────
  // The claim-first invariant against a single shared row. Both approves run
  // against a db whose proposalStatus mutates: whoever's atomic claim UPDATE
  // matches `proposalStatus = "pending"` first flips it to "approved" and wins
  // (creates tasks); every subsequent approve either reads "approved" at the
  // status check (step 3) or loses the claim (returns []) — either way it does
  // NOT create tasks. Net across both: exactly one task-creation batch.
  //
  // We drive the two approves to completion and assert the aggregate invariant,
  // which holds regardless of interleaving order (sequential-after-commit is
  // the realistic post-transaction case; the loser-of-claim case is covered by
  // A9). Both orderings converge on "tasks created once".
  it("two contending approves create tasks exactly once", async () => {
    mockIssueCreate.mockImplementation(async () => ({
      id: `task-${mockIssueCreate.mock.calls.length}`,
      title: "T",
    }));

    // Shared mutable row state both approves contend on.
    let proposalStatus = "pending";

    function sharedDb(): any {
      function selectChain(): any {
        let stage = 0;
        const chain: any = {};
        chain.from = () => chain;
        chain.innerJoin = () => chain;
        // Within ONE approve call: 1st terminal select = entry (current shared
        // status), 2nd = entrySeq.
        const resolve = () => {
          const s = stage++;
          return s === 0 ? [makePendingEntry({ proposalStatus })] : [{ entrySeq: 5 }];
        };
        chain.where = () => {
          const inner: any = Promise.resolve(resolve());
          inner.limit = () => Promise.resolve(resolve());
          return inner;
        };
        chain.orderBy = () => Promise.resolve(resolve());
        chain.then = (r: any) => Promise.resolve(r(resolve()));
        return chain;
      }

      // Shared update that mutates proposalStatus on the winning claim.
      function sharedUpdateFactory(): any {
        const chain: any = {};
        chain.set = () => chain;
        // Atomic claim: succeeds (returns a row) ONLY while still pending.
        const claim = () => {
          const won = proposalStatus === "pending";
          if (won) proposalStatus = "approved";
          return won ? [{ id: ENTRY_ID }] : [];
        };
        chain.where = () => {
          const rows = claim();
          const p: any = Promise.resolve(rows);
          p.returning = () => Promise.resolve(rows);
          return p;
        };
        chain.returning = () => Promise.resolve(claim());
        return chain;
      }

      const db: any = {
        select: vi.fn(selectChain),
        update: vi.fn(sharedUpdateFactory),
      };

      // The transaction passes a tx whose update shares the same mutation logic.
      // This simulates sequential transactions on the same DB row correctly.
      db.transaction = vi.fn(async (cb: any) => {
        const tx = {
          select: vi.fn(selectChain),
          update: vi.fn(sharedUpdateFactory),
          insert: vi.fn(() => ({
            values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
          })),
        };
        return cb(tx);
      });

      return db;
    }

    const db = sharedDb();
    const svc = realThreadDeliverablesService(db as any);

    const r1 = await svc.approveProposal({ threadId: THREAD_ID, companyId: CO_ID, proposalEntryId: ENTRY_ID, approver: { userId: USER_ID } });
    const r2 = await svc.approveProposal({ threadId: THREAD_ID, companyId: CO_ID, proposalEntryId: ENTRY_ID, approver: { userId: USER_ID } });

    // Exactly one fresh approval; the other is an idempotent no-op.
    const fresh = [r1, r2].filter((r) => r.ok && !r.alreadyApproved);
    const noop = [r1, r2].filter((r) => r.ok && r.alreadyApproved);
    expect(fresh).toHaveLength(1);
    expect(noop).toHaveLength(1);
    // Tasks created EXACTLY once (2 proposed tasks → 2 issue.create calls, not 4).
    expect(mockIssueCreate).toHaveBeenCalledTimes(2);
  });

  // ── A11. Non-proposal entry cannot be approved ────────────────────────────────
  // A discussion entry that is NOT a scope_proposal (proposalStatus IS NULL)
  // must be refused — approving an arbitrary paste/write into tasks would be an
  // abuse vector independent of role.
  it("refuses a non-proposal entry (proposalStatus null) with not_found — no tasks", async () => {
    const db = makeMockDb({
      selectResults: [
        [makePendingEntry({ inputType: "write", proposalStatus: null })],
      ],
    });

    const svc = realThreadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: ENTRY_ID,
      approver: { userId: USER_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  // ── A12. REGRESSION: fresh proposal (currentSeq == stampedSeq) is NOT stale ───
  // Reproduces the exact arithmetic that the P0 fix corrects:
  //   Pre-fix:  proposalCursorSeq = N (pre-bump), thread.entrySeq = N+1 after write
  //             → stale check: N+1 > N → ALWAYS stale (bug — every fresh approval blocked)
  //   Post-fix: proposalCursorSeq = N+1 (own seq), thread.entrySeq = N+1 after write
  //             → stale check: N+1 > N+1 = false → NOT stale (correct)
  //
  // This test sets proposalCursorSeq = 11 and currentSeq = 11 (matching the
  // post-fix invariant where the proposal's own seq == the thread's entrySeq
  // immediately after writing the proposal). The approve MUST succeed (not stale).
  it("REGRESSION (P0 fix): fresh proposal (currentSeq == stampedSeq) is NOT stale → tasks created", async () => {
    mockIssueCreate.mockResolvedValue({ id: "task-fresh", title: "Fresh Task" });

    const POST_BUMP_SEQ = 11; // equals thread.entrySeq after write; equals proposalCursorSeq

    const db = makeMockDb({
      selectResults: [
        // Entry with proposalCursorSeq stamped at the post-bump value (11)
        [makePendingEntry({ rawContent: makeProposalRaw({ proposalCursorSeq: POST_BUMP_SEQ }) })],
        // Thread's current entrySeq is exactly 11 (no new entries since proposal was written)
        [{ entrySeq: POST_BUMP_SEQ }],
      ],
    });

    const svc = realThreadDeliverablesService(db as any);
    const result = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: ENTRY_ID,
      approver: { userId: USER_ID },
    });

    // Must NOT be stale — stale check: 11 > 11 = false
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyApproved).toBe(false);
    // Tasks were created
    expect(mockIssueCreate).toHaveBeenCalled();
  });

  // ── A13. Transaction rollback: createDeliverableTasks throws → claim rolls back ─
  // Codex #3 robustness gap: if createDeliverableTasks throws after the claim wins,
  // the claim must roll back (transaction semantics) so the proposal remains
  // "pending" and a subsequent re-approve can succeed.
  // Without the transaction wrap, the claim UPDATE would persist and re-approve
  // would return alreadyApproved (no tasks ever created — unrecoverable).
  it("ROBUSTNESS (Codex #3): createDeliverableTasks throws → transaction rolls back claim → proposal stays retryable", async () => {
    const taskCreationError = new Error("DB connection lost during task creation");

    // First approve attempt: mockIssueCreate throws to simulate task-creation failure.
    mockIssueCreate.mockRejectedValueOnce(taskCreationError);

    // We need a db whose transaction can be made to fail on insert (simulating rollback).
    // We model the rollback by having the transaction re-throw the error from the callback
    // (matching real Postgres behavior: an error inside the transaction callback causes rollback).
    // Use a single-task proposal to keep mock-call counts unambiguous.
    const singleTaskRaw = makeProposalRaw({ proposalCursorSeq: 5, proposedTasks: [{ title: "Task Single" }] });
    const selectQueue: any[][] = [
      [makePendingEntry({ rawContent: singleTaskRaw })],
      [{ entrySeq: 5 }],
    ];
    let selectIdx = 0;

    function selectChainForRollbackDb(): any {
      const result = selectQueue[selectIdx++] ?? [];
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

    // proposalStatus starts pending; a real transaction would roll back the UPDATE.
    // We model rollback: if the tx callback throws, we do NOT persist the claim.
    let proposalStatus = "pending";
    const txUpdate = vi.fn(() => {
      const chain: any = {};
      chain.set = () => chain;
      chain.where = () => {
        // Mark pending → approved inside the (simulated) transaction.
        proposalStatus = "approved";
        const rows = [{ id: ENTRY_ID }];
        const p: any = Promise.resolve(rows);
        p.returning = () => Promise.resolve(rows);
        return p;
      };
      chain.returning = () => Promise.resolve([{ id: ENTRY_ID }]);
      return chain;
    });

    const rollbackDb: any = {
      select: vi.fn(selectChainForRollbackDb),
      update: vi.fn(), // outer db.update not used by approveProposal anymore
      transaction: vi.fn(async (cb: any) => {
        const tx = {
          select: vi.fn(selectChainForRollbackDb),
          update: txUpdate,
          insert: vi.fn(() => ({
            values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
          })),
        };
        try {
          return await cb(tx);
        } catch (err) {
          // Transaction rolled back: undo the proposalStatus mutation.
          // In real Postgres the UPDATE is rolled back atomically.
          proposalStatus = "pending";
          throw err;
        }
      }),
    };

    const svc = realThreadDeliverablesService(rollbackDb as any);

    // First approve: task creation throws → transaction rolls back.
    await expect(
      svc.approveProposal({
        threadId: THREAD_ID,
        companyId: CO_ID,
        proposalEntryId: ENTRY_ID,
        approver: { userId: USER_ID },
      }),
    ).rejects.toThrow("DB connection lost during task creation");

    // After the rollback, proposalStatus is back to "pending" (claim rolled back).
    expect(proposalStatus).toBe("pending");

    // Second approve attempt: task creation now succeeds.
    // Re-queue the select results for the retry.
    selectIdx = 0;
    mockIssueCreate.mockResolvedValueOnce({ id: "task-retry", title: "Retry Task" });

    const retryResult = await svc.approveProposal({
      threadId: THREAD_ID,
      companyId: CO_ID,
      proposalEntryId: ENTRY_ID,
      approver: { userId: USER_ID },
    });

    // The retry should succeed and create tasks.
    expect(retryResult.ok).toBe(true);
    if (retryResult.ok) expect(retryResult.alreadyApproved).toBe(false);
    // Single-task proposal: 1 failed call (first attempt) + 1 succeeded call (retry) = 2 total.
    expect(mockIssueCreate).toHaveBeenCalledTimes(2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// B. parseScopeProposalContent pure-helper tests (via vi.importActual)
// ════════════════════════════════════════════════════════════════════════

describe("parseScopeProposalContent (pure helper via importActual)", () => {
  let parseScopeProposalContent: typeof import("../services/thread-deliverables.js")["parseScopeProposalContent"];

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../services/thread-deliverables.js")>(
      "../services/thread-deliverables.js",
    );
    parseScopeProposalContent = actual.parseScopeProposalContent;
  });

  it("parses valid JSON with proposalCursorSeq", () => {
    const raw = JSON.stringify({
      summary: "Proposal",
      proposedTasks: [{ title: "T1" }],
      proposalCursorSeq: 12,
      scopeVersionId: "scope-version-1",
    });
    const result = parseScopeProposalContent(raw);
    expect(result).not.toBeNull();
    expect(result?.proposalCursorSeq).toBe(12);
    expect(result?.scopeVersionId).toBe("scope-version-1");
    expect(result?.proposedTasks[0].title).toBe("T1");
  });

  it("defaults proposalCursorSeq to 0 for legacy proposals without the field", () => {
    const legacy = JSON.stringify({ summary: "Legacy", proposedTasks: [] });
    const result = parseScopeProposalContent(legacy);
    expect(result?.proposalCursorSeq).toBe(0);
  });

  it("returns null for invalid JSON", () => {
    expect(parseScopeProposalContent("not-json")).toBeNull();
  });

  it("returns null when proposedTasks is missing", () => {
    expect(parseScopeProposalContent(JSON.stringify({ summary: "No tasks" }))).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// C. Route contract test
// ════════════════════════════════════════════════════════════════════════

function extractRoutes(router: any): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  for (const layer of router.stack ?? []) {
    if (layer.route) {
      const path = layer.route.path as string;
      const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
      for (const method of methods) routes.push({ method, path });
    }
  }
  return routes;
}

describe("route contract: POST approve-proposal endpoint exists", () => {
  it("POST …/discussions/:discussionId/proposals/:proposalEntryId/approve exists", () => {
    const router = discussionRoutes({} as any);
    const routes = extractRoutes(router);
    const found = routes.some(
      (r) =>
        r.method === "POST" &&
        r.path.includes("proposals") &&
        r.path.includes("approve"),
    );
    expect(found).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// D. Route integration tests (supertest)
// The mocked threadDeliverablesService factory returns mockApproveProposalFn.
// ════════════════════════════════════════════════════════════════════════

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.actor = { type: "board", source: "authenticated", isInstanceAdmin: false };
    next();
  });
  app.use(discussionRoutes({} as any));
  return app;
}

describe("route integration: POST …/proposals/:proposalEntryId/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAssertHumanRole.mockResolvedValue(undefined);
  });

  it("happy path: returns 201 with tasksCreated", async () => {
    mockApproveProposalFn.mockResolvedValue({
      ok: true,
      alreadyApproved: false,
      taskIds: ["task-1", "task-2"],
      createdTasks: [
        { id: "task-1", assigneeAgentId: "agent-x", workMode: null },
        { id: "task-2", assigneeAgentId: null, workMode: null },
      ],
    });

    const res = await request(makeApp())
      .post(`/companies/${CO_ID}/discussions/${THREAD_ID}/proposals/${ENTRY_ID}/approve`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.tasksCreated).toEqual(["task-1", "task-2"]);
    expect(res.body.alreadyApproved).toBe(false);
  });

  it("unauthorized (team_member): 403 — approveProposal NOT called, NO tasks created", async () => {
    // assertRole throws forbidden() (status 403) for a team_member — the route's
    // top-level await rejects and Express forwards to the error handler.
    mockedAssertHumanRole.mockRejectedValue(
      Object.assign(new Error("Requires one of: founder, team_lead"), { status: 403 }),
    );

    const res = await request(makeApp())
      .post(`/companies/${CO_ID}/discussions/${THREAD_ID}/proposals/${ENTRY_ID}/approve`)
      .send({});

    expect(res.status).toBe(403);
    // The handler never reached the service → no proposal processing AND no
    // task creation. Both the approve method and the underlying task creator
    // must be untouched.
    expect(mockApproveProposalFn).not.toHaveBeenCalled();
    expect(mockCreateDeliverableTasksFn).not.toHaveBeenCalled();
  });

  it("unauthenticated (actor.type none): 401 — approveProposal NOT called", async () => {
    // assertCompanyAccess throws unauthorized() (status 401) when actor.type is
    // "none". The route awaits it before any service call.
    const { assertCompanyAccess } = await import("../routes/authz.js");
    vi.mocked(assertCompanyAccess).mockImplementationOnce(() => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    });

    const res = await request(makeApp())
      .post(`/companies/${CO_ID}/discussions/${THREAD_ID}/proposals/${ENTRY_ID}/approve`)
      .send({});

    expect(res.status).toBe(401);
    expect(mockApproveProposalFn).not.toHaveBeenCalled();
    expect(mockCreateDeliverableTasksFn).not.toHaveBeenCalled();
  });

  it("stale proposal: returns 409 with reason stale", async () => {
    mockApproveProposalFn.mockResolvedValue({
      ok: false,
      reason: "stale",
      message: "Proposal is out of date",
    });

    const res = await request(makeApp())
      .post(`/companies/${CO_ID}/discussions/${THREAD_ID}/proposals/${ENTRY_ID}/approve`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("stale");
  });

  it("double-approve: 200 with alreadyApproved:true — no duplicate tasks", async () => {
    mockApproveProposalFn.mockResolvedValue({
      ok: true,
      alreadyApproved: true,
    });

    const res = await request(makeApp())
      .post(`/companies/${CO_ID}/discussions/${THREAD_ID}/proposals/${ENTRY_ID}/approve`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alreadyApproved).toBe(true);
    expect(res.body.tasksCreated).toEqual([]);
  });

  it("not found: returns 404", async () => {
    mockApproveProposalFn.mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "Proposal not found",
    });

    const res = await request(makeApp())
      .post(`/companies/${CO_ID}/discussions/${THREAD_ID}/proposals/nonexistent/approve`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("not_found");
  });

  it("does not wake agent when task is in planning mode", async () => {
    // Override shouldDispatchIssueWakeup to return false for this test
    const { shouldDispatchIssueWakeup } = await import("../routes/issues-planning-mode-dispatch.js");
    vi.mocked(shouldDispatchIssueWakeup).mockReturnValueOnce(false);

    mockApproveProposalFn.mockResolvedValue({
      ok: true,
      alreadyApproved: false,
      taskIds: ["task-planning-1"],
      createdTasks: [{ id: "task-planning-1", assigneeAgentId: "agent-1", workMode: "planning" }],
    });

    const res = await request(makeApp())
      .post(`/companies/${CO_ID}/discussions/${THREAD_ID}/proposals/${ENTRY_ID}/approve`)
      .send({});

    expect(res.status).toBe(201);
    expect(mockWakeup).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// E. REAL assertRole authorization logic (importActual) — proves the actual
//    role gate (not a mock) rejects a team_member / unauthenticated caller.
//    The route integration tests above mock assertRole; this exercises the
//    genuine `server/src/middleware/rbac.ts` decision path so the 403 is real.
// ════════════════════════════════════════════════════════════════════════

describe("REAL assertRole gate for proposal approve (founder, team_lead)", () => {
  let realAssertRole: typeof import("../middleware/rbac.js")["assertRole"];

  beforeEach(async () => {
    vi.clearAllMocks();
    const actual = await vi.importActual<typeof import("../middleware/rbac.js")>(
      "../middleware/rbac.js",
    );
    realAssertRole = actual.assertRole;
  });

  /** Build a real (non-implicit, non-admin) board request for a given userId. */
  function boardReq(userId: string): any {
    return {
      actor: {
        type: "board",
        source: "authenticated",
        isInstanceAdmin: false,
        userId,
      },
    };
  }

  function dbWithEffectiveRole(role: string): any {
    // The real assertRole imports permissionService from the (mocked) module;
    // override getEffectiveRole for this assertion.
    vi.mocked(mockedPermissionServiceFactory).mockReturnValue({
      getEffectiveRole: vi.fn().mockResolvedValue(role),
      isFounder: vi.fn().mockResolvedValue(role === "founder"),
      isTeamLeadForDepartment: vi.fn().mockResolvedValue(false),
    } as any);
    return {} as any;
  }

  it("team_member → throws 403 (forbidden)", async () => {
    const db = dbWithEffectiveRole("team_member");
    await expect(
      realAssertRole(db, boardReq(USER_ID), CO_ID, "founder", "team_lead"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("unauthenticated (actor.type none) → throws 401 (unauthorized)", async () => {
    const req: any = { actor: { type: "none" } };
    await expect(
      realAssertRole({} as any, req, CO_ID, "founder", "team_lead"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("team_lead → passes (no throw)", async () => {
    const db = dbWithEffectiveRole("team_lead");
    await expect(
      realAssertRole(db, boardReq(USER_ID), CO_ID, "founder", "team_lead"),
    ).resolves.toBeUndefined();
  });

  it("founder → passes (no throw)", async () => {
    const db = dbWithEffectiveRole("founder");
    await expect(
      realAssertRole(db, boardReq(USER_ID), CO_ID, "founder", "team_lead"),
    ).resolves.toBeUndefined();
  });
});
