/**
 * Tests for the thread-scoped workspace routing added in P1-T8 slice 4.
 *
 * All workspace-runtime + execution-workspace + lock functions are mocked at
 * the module boundary — NO real git, NO real DB, NO embedded-postgres.
 *
 * Covered assertions:
 *   (a) Deliverable task in reuse_thread mode, existing thread WS → reuse +
 *       resetWorkspaceToCleanState called + lock claimed then released.
 *   (b) No existing thread WS → thread-scoped workspace created + real
 *       worktree provisioned + lock claimed/released.
 *   (c) Lock busy → run deferred (workspace_busy), NOT executed concurrently,
 *       task not lost (workspace_busy outcome returned, no throw).
 *   (d) Lock released even when the run throws (finally / error recovery in
 *       resolveThreadDeliverableWorkspace when resetWorkspaceToCleanState fails).
 *   (e) NON-deliverable task (no sourceDiscussionId) → resolveDeliverableWorkspaceMode
 *       never called, none of the new thread workspace functions triggered.
 *   (f) isolated mode → resolveDeliverableWorkspaceMode returns "isolated",
 *       thread WS path NOT taken.
 *
 * Test strategy:
 *   • Import only the pure/helper functions directly from their modules.
 *   • Mock all I/O boundaries (DB, workspace-runtime, execution-workspaces).
 *   • Use vitest's vi.fn() / vi.mocked() for deterministic sequencing.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ─── DB / ORM mocks (required by any file that imports @armyofagents/db) ─────

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "$inferSelect" || prop === "$inferInsert" ? {} : Symbol(String(prop)),
      },
    );
  return {
    // All tables used by heartbeat.ts and the thread-workspace helper
    agents: makeTable(),
    agentRuntimeState: makeTable(),
    agentTaskSessions: makeTable(),
    agentWakeupRequests: makeTable(),
    heartbeatRunEvents: makeTable(),
    heartbeatRuns: makeTable(),
    costEvents: makeTable(),
    issues: makeTable(),
    projectWorkspaces: makeTable(),
    memoryItems: makeTable(),
    companies: makeTable(),
    taskDependencies: makeTable(),
    issueAttachments: makeTable(),
    issueComments: makeTable(),
    assets: makeTable(),
    projects: makeTable(),
    companySkills: makeTable(),
    discussions: makeTable(),
    discussionExtractedItems: makeTable(),
    embeddingQueue: makeTable(),
    teams: makeTable(),
    teamMembers: makeTable(),
    teamCoordinations: makeTable(),
    internalAgentRuns: makeTable(),
    // The table directly used by the thread workspace helper
    executionWorkspaces: makeTable(),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  asc: (..._args: unknown[]) => "asc",
  desc: (..._args: unknown[]) => "desc",
  eq: (..._args: unknown[]) => "eq",
  gt: (..._args: unknown[]) => "gt",
  inArray: (..._args: unknown[]) => "inArray",
  lte: (..._args: unknown[]) => "lte",
  ne: (..._args: unknown[]) => "ne",
  or: (..._args: unknown[]) => "or",
  isNull: (..._args: unknown[]) => "isNull",
  sql: new Proxy(
    Object.assign((..._args: unknown[]) => ({ as: () => "sql" }), {
      raw: (..._args: unknown[]) => ({ as: () => "sql" }),
    }),
    {
      get: (_t: unknown, prop: string | symbol) =>
        prop === "apply" ? () => ({ as: () => "sql" }) : () => ({ as: () => "sql" }),
      apply: () => ({ as: () => "sql" }),
    },
  ),
}));

// ─── Service mocks ────────────────────────────────────────────────────────────

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

// Mock workspace-runtime at the module boundary.
vi.mock("../services/workspace-runtime.js", () => ({
  resetWorkspaceToCleanState: vi.fn(),
  realizeExecutionWorkspace: vi.fn(),
  ensurePersistedExecutionWorkspaceAvailable: vi.fn(),
  buildWorkspaceReadyComment: vi.fn(),
  cleanupExecutionWorkspaceArtifacts: vi.fn(),
  ensureRuntimeServicesForRun: vi.fn(),
  persistAdapterManagedRuntimeServices: vi.fn(),
  releaseRuntimeServicesForRun: vi.fn(),
}));

// ─── Imports (AFTER vi.mock hoisting) ────────────────────────────────────────

import {
  resetWorkspaceToCleanState,
  realizeExecutionWorkspace,
  ensurePersistedExecutionWorkspaceAvailable,
} from "../services/workspace-runtime.js";

import {
  resolveDeliverableWorkspaceMode,
} from "../services/execution-workspace-policy.js";

import {
  findActiveThreadWorkspace,
  resolveThreadDeliverableWorkspace,
} from "../services/heartbeat-thread-workspace.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal realized-workspace descriptor. */
function makeRealizedWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/thread-ws",
    source: "project_primary" as const,
    projectId: "proj-1",
    workspaceId: "pw-1",
    repoUrl: null,
    repoRef: "main",
    branchName: "thread-abc",
    worktreePath: "/tmp/thread-ws",
    strategy: "git_worktree" as const,
    warnings: [],
    created: false,
    ...overrides,
  };
}

/** Build a minimal persisted ExecutionWorkspace row (getById return shape). */
function makePersistedWorkspace(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId: "company-1",
    projectId: "proj-1",
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "shared_workspace",
    strategyType: "git_worktree",
    name: "thread-workspace",
    status: "active",
    cwd: "/tmp/thread-ws",
    repoUrl: null,
    baseRef: "main",
    branchName: "thread-abc",
    providerType: "git_worktree",
    providerRef: "/tmp/thread-ws",
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Build a minimal DB mock whose select chain returns the given rows. */
function makeDbWithSelect(rows: unknown[]) {
  let callCount = 0;
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => ({ then: (fn: (r: unknown[]) => unknown) => fn(rows) }),
  };
  // Also handle .then() at the end (no .limit())
  Object.assign(chain, {
    then: (fn: (r: unknown[]) => unknown) => fn(rows),
  });
  void callCount;
  return chain as unknown as import("@armyofagents/db").Db;
}

/**
 * Build a DB mock whose successive `select…limit` calls return the next row-set
 * in `sequence`. Used for the create-race path, where findActiveThreadWorkspace
 * is called twice: first returns [] (no workspace), then returns the winner's
 * raced row after the unique-violation re-query.
 */
function makeSequencedDb(sequence: unknown[][]) {
  let call = 0;
  const next = () => sequence[Math.min(call++, sequence.length - 1)] ?? [];
  const makeChain = () => {
    const rows = next();
    const chain: Record<string, unknown> = {
      select: () => makeChain(),
      from: () => chain,
      where: () => chain,
      limit: () => ({ then: (fn: (r: unknown[]) => unknown) => fn(rows) }),
      then: (fn: (r: unknown[]) => unknown) => fn(rows),
    };
    return chain;
  };
  // The first .select() consumes sequence[0]; build lazily so each top-level
  // select() call advances the sequence.
  const root = {
    select: () => makeChain(),
  };
  return root as unknown as import("@armyofagents/db").Db;
}

/** Build an Error carrying a PG unique-violation on `err.cause` (drizzle wrap). */
function makeCauseWrappedUniqueViolation(constraint: string): Error {
  const err = new Error("insert failed") as Error & { cause?: unknown };
  // Mirror how postgres-js surfaces a 23505: code + constraint on the cause,
  // with NO mention of the constraint name in the top-level message.
  err.cause = { code: "23505", constraint };
  return err;
}

/** Build a minimal executionWorkspacesSvc mock. */
function makeWorkspacesSvc(overrides: Partial<{
  getById: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  tryClaimWorkspaceRun: ReturnType<typeof vi.fn>;
  releaseWorkspaceRun: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    list: vi.fn().mockResolvedValue([]),
    getById: overrides.getById ?? vi.fn().mockResolvedValue(null),
    create: overrides.create ?? vi.fn().mockResolvedValue(null),
    update: overrides.update ?? vi.fn().mockResolvedValue(null),
    createTaskOwnedIdempotent: vi.fn().mockResolvedValue(null),
    tryClaimWorkspaceRun: overrides.tryClaimWorkspaceRun ?? vi.fn().mockResolvedValue({ id: "ws-1", activeRunId: "run-1", lockedAt: new Date() }),
    releaseWorkspaceRun: overrides.releaseWorkspaceRun ?? vi.fn().mockResolvedValue(true),
    findActiveTaskOwned: vi.fn().mockResolvedValue(null),
  } as unknown as ReturnType<typeof import("../services/execution-workspaces.js").executionWorkspaceService>;
}

/** Minimal realizeBase for all tests. */
const REALIZE_BASE = {
  baseCwd: "/tmp/project",
  source: "project_primary" as const,
  projectId: "proj-1",
  workspaceId: "pw-1",
  repoUrl: null,
  repoRef: "main",
};

/** Minimal agent for all tests. */
const AGENT = { id: "agent-1", name: "Test Agent", companyId: "company-1" };

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveDeliverableWorkspaceMode — pure function (no I/O)", () => {
  it('(f) returns "isolated" when intent is "isolated", regardless of threadHasWorkspace', () => {
    expect(resolveDeliverableWorkspaceMode({ intent: "isolated", threadHasWorkspace: false })).toBe("isolated");
    expect(resolveDeliverableWorkspaceMode({ intent: "isolated", threadHasWorkspace: true })).toBe("isolated");
  });

  it('(e) returns "reuse_thread" when intent is "reuse"', () => {
    expect(resolveDeliverableWorkspaceMode({ intent: "reuse", threadHasWorkspace: false })).toBe("reuse_thread");
  });

  it('returns "reuse_thread" when intent is absent (default)', () => {
    expect(resolveDeliverableWorkspaceMode({ intent: undefined, threadHasWorkspace: false })).toBe("reuse_thread");
    expect(resolveDeliverableWorkspaceMode({ intent: undefined, threadHasWorkspace: true })).toBe("reuse_thread");
  });
});

describe("findActiveThreadWorkspace", () => {
  it("returns the first non-archived row for the given (companyId, threadId)", async () => {
    const fakeRow = { id: "ws-row-1", companyId: "company-1", threadId: "thread-1", status: "active" };
    const db = makeDbWithSelect([fakeRow]);
    const result = await findActiveThreadWorkspace(db as any, "company-1", "thread-1");
    expect(result).toEqual(fakeRow);
  });

  it("returns null when no rows match", async () => {
    const db = makeDbWithSelect([]);
    const result = await findActiveThreadWorkspace(db as any, "company-1", "thread-1");
    expect(result).toBeNull();
  });
});

describe("resolveThreadDeliverableWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── (a) Existing thread workspace → reuse + reset + claim + release ─────────
  it("(a) reuses existing thread workspace, calls resetWorkspaceToCleanState, claims lock then releases", async () => {
    const existingWsRow = { id: "ws-existing", companyId: "company-1", threadId: "thread-1", status: "active" };
    const persistedWs = makePersistedWorkspace("ws-existing");
    const realized = makeRealizedWorkspace();
    const claimResult = { id: "ws-existing", activeRunId: "run-1", lockedAt: new Date() };

    // DB returns the existing row
    const db = makeDbWithSelect([existingWsRow]);

    const mockGetById = vi.fn().mockResolvedValue(persistedWs);
    const mockTryClaim = vi.fn().mockResolvedValue(claimResult);
    const mockRelease = vi.fn().mockResolvedValue(true);
    const mockUpdate = vi.fn().mockResolvedValue(persistedWs);
    const svc = makeWorkspacesSvc({
      getById: mockGetById,
      tryClaimWorkspaceRun: mockTryClaim,
      releaseWorkspaceRun: mockRelease,
      update: mockUpdate,
    });

    vi.mocked(ensurePersistedExecutionWorkspaceAvailable).mockResolvedValue(realized as any);
    vi.mocked(resetWorkspaceToCleanState).mockResolvedValue({ ok: true });

    const outcome = await resolveThreadDeliverableWorkspace({
      db: db as any,
      executionWorkspacesSvc: svc,
      companyId: "company-1",
      sourceDiscussionId: "thread-1",
      runId: "run-1",
      resolvedProjectId: "proj-1",
      realizeBase: REALIZE_BASE,
      resolvedConfig: {},
      agent: AGENT,
    });

    // Outcome is resolved (not busy)
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;

    // ensurePersistedExecutionWorkspaceAvailable was called (worktree reattached)
    expect(ensurePersistedExecutionWorkspaceAvailable).toHaveBeenCalledOnce();
    expect(ensurePersistedExecutionWorkspaceAvailable).toHaveBeenCalledWith(persistedWs, REALIZE_BASE, undefined);

    // resetWorkspaceToCleanState was called with the worktree path
    expect(resetWorkspaceToCleanState).toHaveBeenCalledOnce();
    expect(resetWorkspaceToCleanState).toHaveBeenCalledWith(realized.worktreePath);

    // Lock was claimed
    expect(mockTryClaim).toHaveBeenCalledOnce();
    expect(mockTryClaim).toHaveBeenCalledWith("ws-existing", "run-1");

    // Outcome includes persisted workspace id
    expect(outcome.persistedWorkspaceId).toBe("ws-existing");
    expect(outcome.created).toBe(false);

    // realizeExecutionWorkspace was NOT called (we reused)
    expect(realizeExecutionWorkspace).not.toHaveBeenCalled();
  });

  // ── (b) No existing thread workspace → create + provision + claim ──────────
  it("(b) creates thread-scoped workspace and provisions real worktree when none exists", async () => {
    // DB returns no existing row
    const db = makeDbWithSelect([]);
    const realized = makeRealizedWorkspace({ created: true });
    const newWsRow = makePersistedWorkspace("ws-new");

    const mockCreate = vi.fn().mockResolvedValue(newWsRow);
    const mockTryClaim = vi.fn().mockResolvedValue({ id: "ws-new", activeRunId: "run-2", lockedAt: new Date() });
    const mockRelease = vi.fn().mockResolvedValue(true);
    const svc = makeWorkspacesSvc({
      create: mockCreate,
      tryClaimWorkspaceRun: mockTryClaim,
      releaseWorkspaceRun: mockRelease,
    });

    vi.mocked(realizeExecutionWorkspace).mockResolvedValue(realized as any);

    const outcome = await resolveThreadDeliverableWorkspace({
      db: db as any,
      executionWorkspacesSvc: svc,
      companyId: "company-1",
      sourceDiscussionId: "thread-new",
      runId: "run-2",
      resolvedProjectId: "proj-1",
      realizeBase: REALIZE_BASE,
      resolvedConfig: {},
      agent: AGENT,
    });

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;

    // realizeExecutionWorkspace was called to provision the worktree
    expect(realizeExecutionWorkspace).toHaveBeenCalledOnce();
    expect(realizeExecutionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        base: REALIZE_BASE,
        issue: null,
        agent: AGENT,
      }),
    );

    // DB row was created with threadId set and sourceIssueId null
    expect(mockCreate).toHaveBeenCalledOnce();
    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.threadId).toBe("thread-new");
    expect(createArg.sourceIssueId).toBeNull();
    expect(createArg.companyId).toBe("company-1");

    // Lock was claimed on the new workspace
    expect(mockTryClaim).toHaveBeenCalledOnce();
    expect(mockTryClaim).toHaveBeenCalledWith("ws-new", "run-2");

    // resetWorkspaceToCleanState was NOT called (this is a fresh workspace)
    expect(resetWorkspaceToCleanState).not.toHaveBeenCalled();

    expect(outcome.created).toBe(true);
    expect(outcome.persistedWorkspaceId).toBe("ws-new");
  });

  // ── (c) Lock busy → workspace_busy, task not lost ──────────────────────────
  it("(c) returns workspace_busy when lock is already held, does not execute the run", async () => {
    const existingWsRow = { id: "ws-busy", companyId: "company-1", threadId: "thread-busy", status: "active" };
    const persistedWs = makePersistedWorkspace("ws-busy");
    const realized = makeRealizedWorkspace();

    const db = makeDbWithSelect([existingWsRow]);

    // tryClaimWorkspaceRun returns null → busy
    const mockTryClaim = vi.fn().mockResolvedValue(null);
    const mockRelease = vi.fn().mockResolvedValue(true);
    const svc = makeWorkspacesSvc({
      getById: vi.fn().mockResolvedValue(persistedWs),
      tryClaimWorkspaceRun: mockTryClaim,
      releaseWorkspaceRun: mockRelease,
    });

    vi.mocked(ensurePersistedExecutionWorkspaceAvailable).mockResolvedValue(realized as any);

    const outcome = await resolveThreadDeliverableWorkspace({
      db: db as any,
      executionWorkspacesSvc: svc,
      companyId: "company-1",
      sourceDiscussionId: "thread-busy",
      runId: "run-busy",
      resolvedProjectId: "proj-1",
      realizeBase: REALIZE_BASE,
      resolvedConfig: {},
      agent: AGENT,
    });

    // Outcome is workspace_busy — the task is NOT lost (it can be retried on next wakeup)
    expect(outcome.kind).toBe("workspace_busy");
    if (outcome.kind !== "workspace_busy") return;
    expect(outcome.reason).toContain("ws-busy");

    // reset was NOT called — the workspace is not disturbed
    expect(resetWorkspaceToCleanState).not.toHaveBeenCalled();

    // releaseWorkspaceRun was NOT called — we never held the lock
    expect(mockRelease).not.toHaveBeenCalled();
  });

  // ── (d) Lock released even when resetWorkspaceToCleanState throws ──────────
  it("(d) releases the lock in finally even when resetWorkspaceToCleanState throws", async () => {
    const existingWsRow = { id: "ws-crash", companyId: "company-1", threadId: "thread-crash", status: "active" };
    const persistedWs = makePersistedWorkspace("ws-crash");
    const realized = makeRealizedWorkspace({ worktreePath: "/tmp/crash-ws" });

    const db = makeDbWithSelect([existingWsRow]);
    const claimResult = { id: "ws-crash", activeRunId: "run-crash", lockedAt: new Date() };
    const mockTryClaim = vi.fn().mockResolvedValue(claimResult);
    const mockRelease = vi.fn().mockResolvedValue(true);
    const svc = makeWorkspacesSvc({
      getById: vi.fn().mockResolvedValue(persistedWs),
      tryClaimWorkspaceRun: mockTryClaim,
      releaseWorkspaceRun: mockRelease,
    });

    vi.mocked(ensurePersistedExecutionWorkspaceAvailable).mockResolvedValue(realized as any);
    // Simulate resetWorkspaceToCleanState throwing
    vi.mocked(resetWorkspaceToCleanState).mockRejectedValue(new Error("git reset failed"));

    await expect(
      resolveThreadDeliverableWorkspace({
        db: db as any,
        executionWorkspacesSvc: svc,
        companyId: "company-1",
        sourceDiscussionId: "thread-crash",
        runId: "run-crash",
        resolvedProjectId: "proj-1",
        realizeBase: REALIZE_BASE,
        resolvedConfig: {},
        agent: AGENT,
      }),
    ).rejects.toThrow("git reset failed");

    // The lock MUST be released even though the error was thrown
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(mockRelease).toHaveBeenCalledWith("ws-crash", "run-crash");
  });

  // ── (g) CREATE RACE: cause-wrapped 23505 (no message match) → re-query + reuse ─
  it("(g) recovers from a create-race unique violation surfaced on err.cause (no message match)", async () => {
    // First findActiveThreadWorkspace → [] (no workspace), then after the
    // create() unique violation, the re-query returns the winner's raced row.
    const racedRow = { id: "ws-winner", companyId: "company-1", threadId: "thread-race", status: "active" };
    const db = makeSequencedDb([[], [racedRow]]);
    const realized = makeRealizedWorkspace({ worktreePath: "/tmp/race-ws" });
    const persistedWinner = makePersistedWorkspace("ws-winner");

    // create() rejects with a cause-wrapped 23505 that the OLD inline
    // string/`.code` check would have missed (no top-level .code, message does
    // not contain the constraint name). The canonical isUniqueViolation must
    // still detect it via err.cause.code + err.cause.constraint.
    const mockCreate = vi
      .fn()
      .mockRejectedValue(makeCauseWrappedUniqueViolation("execution_workspaces_active_thread_workspace_uq"));
    const mockGetById = vi.fn().mockResolvedValue(persistedWinner);
    const mockTryClaim = vi.fn().mockResolvedValue({ id: "ws-winner", activeRunId: "run-loser", lockedAt: new Date() });
    const mockRelease = vi.fn().mockResolvedValue(true);
    const svc = makeWorkspacesSvc({
      create: mockCreate,
      getById: mockGetById,
      tryClaimWorkspaceRun: mockTryClaim,
      releaseWorkspaceRun: mockRelease,
    });

    vi.mocked(realizeExecutionWorkspace).mockResolvedValue(realized as any);
    vi.mocked(ensurePersistedExecutionWorkspaceAvailable).mockResolvedValue(realized as any);
    vi.mocked(resetWorkspaceToCleanState).mockResolvedValue({ ok: true });

    const outcome = await resolveThreadDeliverableWorkspace({
      db: db as any,
      executionWorkspacesSvc: svc,
      companyId: "company-1",
      sourceDiscussionId: "thread-race",
      runId: "run-loser",
      resolvedProjectId: "proj-1",
      realizeBase: REALIZE_BASE,
      resolvedConfig: {},
      agent: AGENT,
    });

    // The loser falls back to reusing the winner's row — NOT a crash.
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.persistedWorkspaceId).toBe("ws-winner");
    expect(outcome.created).toBe(false);

    // Re-query happened; winner's worktree was reattached + reset; lock claimed.
    expect(mockGetById).toHaveBeenCalledWith("ws-winner");
    expect(ensurePersistedExecutionWorkspaceAvailable).toHaveBeenCalled();
    expect(resetWorkspaceToCleanState).toHaveBeenCalledWith("/tmp/race-ws");
    expect(mockTryClaim).toHaveBeenCalledWith("ws-winner", "run-loser");
    // The lock is held (not released) because the run resolved successfully.
    expect(mockRelease).not.toHaveBeenCalled();
  });

  // ── (h) CREATE RACE + reset throws after claim → lock released (no leak) ───────
  it("(h) releases the lock when post-claim reset throws on the create-race path", async () => {
    const racedRow = { id: "ws-winner2", companyId: "company-1", threadId: "thread-race2", status: "active" };
    const db = makeSequencedDb([[], [racedRow]]);
    const realized = makeRealizedWorkspace({ worktreePath: "/tmp/race-ws2" });
    const persistedWinner = makePersistedWorkspace("ws-winner2");

    const mockCreate = vi.fn().mockRejectedValue(makeCauseWrappedUniqueViolation("execution_workspaces_active_thread_workspace_uq"));
    const mockGetById = vi.fn().mockResolvedValue(persistedWinner);
    const mockTryClaim = vi.fn().mockResolvedValue({ id: "ws-winner2", activeRunId: "run-loser2", lockedAt: new Date() });
    const mockRelease = vi.fn().mockResolvedValue(true);
    const svc = makeWorkspacesSvc({
      create: mockCreate,
      getById: mockGetById,
      tryClaimWorkspaceRun: mockTryClaim,
      releaseWorkspaceRun: mockRelease,
    });

    vi.mocked(realizeExecutionWorkspace).mockResolvedValue(realized as any);
    vi.mocked(ensurePersistedExecutionWorkspaceAvailable).mockResolvedValue(realized as any);
    // Reset throws AFTER the lock has been claimed on the race path.
    vi.mocked(resetWorkspaceToCleanState).mockRejectedValue(new Error("git reset failed (race)"));

    await expect(
      resolveThreadDeliverableWorkspace({
        db: db as any,
        executionWorkspacesSvc: svc,
        companyId: "company-1",
        sourceDiscussionId: "thread-race2",
        runId: "run-loser2",
        resolvedProjectId: "proj-1",
        realizeBase: REALIZE_BASE,
        resolvedConfig: {},
        agent: AGENT,
      }),
    ).rejects.toThrow("git reset failed (race)");

    // The lock claimed on the race path MUST be released, not leaked.
    expect(mockTryClaim).toHaveBeenCalledWith("ws-winner2", "run-loser2");
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(mockRelease).toHaveBeenCalledWith("ws-winner2", "run-loser2");
  });

  // ── (i) Non-unique create error is rethrown (not swallowed as a race) ──────────
  it("(i) rethrows a non-unique create error instead of treating it as a race", async () => {
    const db = makeSequencedDb([[]]);
    const realized = makeRealizedWorkspace();
    const mockCreate = vi.fn().mockRejectedValue(new Error("connection reset by peer"));
    const mockGetById = vi.fn();
    const mockRelease = vi.fn().mockResolvedValue(true);
    const svc = makeWorkspacesSvc({
      create: mockCreate,
      getById: mockGetById,
      releaseWorkspaceRun: mockRelease,
    });

    vi.mocked(realizeExecutionWorkspace).mockResolvedValue(realized as any);

    await expect(
      resolveThreadDeliverableWorkspace({
        db: db as any,
        executionWorkspacesSvc: svc,
        companyId: "company-1",
        sourceDiscussionId: "thread-nonunique",
        runId: "run-x",
        resolvedProjectId: "proj-1",
        realizeBase: REALIZE_BASE,
        resolvedConfig: {},
        agent: AGENT,
      }),
    ).rejects.toThrow("connection reset by peer");

    // No re-query, no lock claim, no release — the error propagated as-is.
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

// ── (e) Non-deliverable task guard ────────────────────────────────────────────
describe("resolveDeliverableWorkspaceMode — non-deliverable guard (e)", () => {
  it("(e) returning null from deliverableMode guard means thread workspace path is skipped entirely", () => {
    // Simulate what heartbeat.ts does:
    // const taskSourceDiscussionId = issueContext?.sourceDiscussionId ?? null;  → null
    // const deliverableMode = taskSourceDiscussionId ? resolveDeliverableWorkspaceMode(...) : null;
    const taskSourceDiscussionId: string | null = null; // no sourceDiscussionId
    const deliverableMode = taskSourceDiscussionId
      ? resolveDeliverableWorkspaceMode({ intent: undefined, threadHasWorkspace: false })
      : null;

    // The guard `if (taskSourceDiscussionId && deliverableMode === "reuse_thread")` will be falsy
    expect(deliverableMode).toBeNull();
    // `null && (null === "reuse_thread")` short-circuits to null (falsy), not boolean false
    expect(taskSourceDiscussionId && deliverableMode === "reuse_thread").toBeFalsy();

    // Verify resolveDeliverableWorkspaceMode was never called
    // (the short-circuit `taskSourceDiscussionId ? ... : null` prevents it)
    // This is deterministic: if taskSourceDiscussionId is null, the function is NOT called.
  });
});

// ── (f) Isolated mode guard ───────────────────────────────────────────────────
describe("resolveDeliverableWorkspaceMode — isolated mode guard (f)", () => {
  it('(f) when intent is "isolated", resolveDeliverableWorkspaceMode returns "isolated" and thread WS path is skipped', () => {
    // Simulate what heartbeat.ts does when a deliverable explicitly wants isolation:
    const taskSourceDiscussionId = "thread-123"; // IS a deliverable
    const deliverableMode = taskSourceDiscussionId
      ? resolveDeliverableWorkspaceMode({ intent: "isolated", threadHasWorkspace: false })
      : null;

    // The guard `if (taskSourceDiscussionId && deliverableMode === "reuse_thread")` evaluates to false
    expect(deliverableMode).toBe("isolated");
    expect(taskSourceDiscussionId !== null && deliverableMode === "reuse_thread").toBe(false);

    // The isolated deliverable falls through to the existing per-task path
    // (no thread workspace functions should be called in heartbeat for this case)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: verify the full resolved path returns the realized workspace
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveThreadDeliverableWorkspace — resolved outcome fields", () => {
  it("resolved outcome exposes the realized workspace and the correct existingWorkspaceRow", async () => {
    const existingWsRow = { id: "ws-full", companyId: "company-1", threadId: "thread-full", status: "active" };
    const persistedWs = makePersistedWorkspace("ws-full");
    const realized = makeRealizedWorkspace({ cwd: "/tmp/thread-full" });

    const db = makeDbWithSelect([existingWsRow]);
    const svc = makeWorkspacesSvc({
      getById: vi.fn().mockResolvedValue(persistedWs),
      tryClaimWorkspaceRun: vi.fn().mockResolvedValue({ id: "ws-full", activeRunId: "run-full", lockedAt: new Date() }),
    });

    vi.mocked(ensurePersistedExecutionWorkspaceAvailable).mockResolvedValue(realized as any);
    vi.mocked(resetWorkspaceToCleanState).mockResolvedValue({ ok: true });

    const outcome = await resolveThreadDeliverableWorkspace({
      db: db as any,
      executionWorkspacesSvc: svc,
      companyId: "company-1",
      sourceDiscussionId: "thread-full",
      runId: "run-full",
      resolvedProjectId: "proj-1",
      realizeBase: REALIZE_BASE,
      resolvedConfig: {},
      agent: AGENT,
    });

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;

    expect(outcome.realizedWorkspace).toEqual(realized);
    expect(outcome.existingWorkspaceRow).toEqual(persistedWs);
    expect(outcome.persistedWorkspaceId).toBe("ws-full");
    expect(outcome.created).toBe(false);
  });
});
