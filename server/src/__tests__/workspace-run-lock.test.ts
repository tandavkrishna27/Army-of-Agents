/**
 * Tests for the DB-backed per-workspace run lock (P1-T8 slice 2).
 *
 * The entire DB layer is replaced with an in-memory simulation:
 *  • `makeWorkspace(overrides?)` — creates a mock workspace row.
 *  • `makeDb(workspace, opts?)` — wires a mock Drizzle-shaped db whose UPDATE
 *    implements the conditional claim / release logic in-memory.
 *
 * No live DB or embedded-postgres is required — the suite is fully
 * deterministic and safe on all platforms including Windows CI.
 *
 * Design note on staleMs handling:
 *   The real service passes staleMs to the SQL template as an interval literal.
 *   In the mock we can't cheaply parse SQL fragments, so we instead accept the
 *   expected staleMs via makeDb(workspace, { staleMs }).  Tests that use a
 *   non-default staleMs pass the SAME value to both makeDb and
 *   tryClaimWorkspaceRun — this mirrors real usage where both the caller and
 *   the DB query use the same threshold.
 */

import { describe, it, expect, vi } from "vitest";

// ── Drizzle-orm mock (minimal stubs only) ─────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq:   vi.fn((a: unknown, b: unknown) => ({ _type: "eq",  a, b })),
  and:  vi.fn((...args: unknown[]) => ({ _type: "and", args })),
  ne:   vi.fn((a: unknown, b: unknown) => ({ _type: "ne",  a, b })),
  desc: vi.fn((a: unknown) => ({ _type: "desc", a })),
  inArray: vi.fn((col: unknown, arr: unknown) => ({ _type: "inArray", col, arr })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      _type: "sql",
      strings,
      values,
    })),
    {
      raw: vi.fn((v: unknown) => ({ _type: "sql_raw", v })),
    },
  ),
}));

// ── @armyofagents/db mock (only the table tokens used by the lock methods) ────
vi.mock("@armyofagents/db", () => ({
  executionWorkspaces: {
    id:           "id",
    companyId:    "companyId",
    sourceIssueId: "sourceIssueId",
    status:       "status",
    activeRunId:  "activeRunId",
    lockedAt:     "lockedAt",
  },
  issues:               {},
  projects:             {},
  projectWorkspaces:    {},
  workspaceRuntimeServices: {},
}));

// ── Subject under test ────────────────────────────────────────────────────────
import {
  executionWorkspaceService,
  WORKSPACE_RUN_LOCK_STALE_MS,
} from "../services/execution-workspaces.js";

// ── In-memory workspace row ───────────────────────────────────────────────────

interface MockWorkspaceRow {
  id: string;
  companyId: string;
  projectId: string;
  projectWorkspaceId: string | null;
  sourceIssueId: string | null;
  mode: string;
  strategyType: string;
  name: string;
  status: string;
  cwd: string | null;
  repoUrl: string | null;
  baseRef: string | null;
  branchName: string | null;
  providerType: string;
  providerRef: string | null;
  derivedFromExecutionWorkspaceId: string | null;
  lastUsedAt: Date;
  openedAt: Date;
  closedAt: Date | null;
  cleanupEligibleAt: Date | null;
  cleanupReason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  activeRunId: string | null;
  lockedAt: Date | null;
}

function makeWorkspace(overrides: Partial<MockWorkspaceRow> = {}): MockWorkspaceRow {
  return {
    id:              "workspace-1",
    companyId:       "company-1",
    projectId:       "project-1",
    projectWorkspaceId: null,
    sourceIssueId:   "issue-1",
    mode:            "shared_workspace",
    strategyType:    "git_worktree",
    name:            "test workspace",
    status:          "active",
    cwd:             null,
    repoUrl:         null,
    baseRef:         null,
    branchName:      null,
    providerType:    "local_fs",
    providerRef:     null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt:      new Date(),
    openedAt:        new Date(),
    closedAt:        null,
    cleanupEligibleAt: null,
    cleanupReason:   null,
    metadata:        null,
    createdAt:       new Date(),
    updatedAt:       new Date(),
    activeRunId:     null,
    lockedAt:        null,
    ...overrides,
  };
}

// ── DB mock factory ───────────────────────────────────────────────────────────

/**
 * Builds a mock DB that implements tryClaimWorkspaceRun / releaseWorkspaceRun
 * entirely in-memory.
 *
 * `staleMs` mirrors what the test will pass to tryClaimWorkspaceRun — the mock
 * uses the same value so the stale-check logic is faithfully exercised without
 * needing to parse SQL template literals.
 *
 * WHERE-clause predicate objects produced by the mocked drizzle-orm helpers are
 * inspected to extract the runId for the release path.
 */
function makeDb(initialState: MockWorkspaceRow, opts: { staleMs?: number } = {}) {
  const staleMs = opts.staleMs ?? WORKSPACE_RUN_LOCK_STALE_MS;

  // Shared mutable row — simulates the DB row.
  const state = { ...initialState };

  // Track the SET payload and WHERE runId for each pending update.
  let pendingSet: Record<string, unknown> | null = null;
  let pendingReleaseRunId: string | null = null;

  // ── Recursive helper to extract a runId from the and(eq(...), eq(...)) WHERE
  function extractRunId(node: unknown): string | null {
    if (!node || typeof node !== "object") return null;
    const rec = node as Record<string, unknown>;
    if (rec._type === "eq" && rec.a === "activeRunId" && typeof rec.b === "string") {
      return rec.b;
    }
    if (rec._type === "and" && Array.isArray(rec.args)) {
      for (const arg of rec.args) {
        const found = extractRunId(arg);
        if (found) return found;
      }
    }
    return null;
  }

  // ── Build the chainable query object ─────────────────────────────────────
  const chain: Record<string, (...args: unknown[]) => unknown> = {};

  const selfReturn = (..._args: unknown[]) => chain;
  chain.from      = selfReturn;
  chain.innerJoin = selfReturn;
  chain.leftJoin  = selfReturn;
  chain.orderBy   = selfReturn;
  chain.limit     = selfReturn;

  chain.set = (patch: Record<string, unknown>) => {
    pendingSet = patch;
    return chain;
  };

  chain.where = (...whereArgs: unknown[]) => {
    // Capture the releaseRunId if this is a release WHERE clause.
    const extracted = extractRunId(whereArgs[0]);
    if (extracted) pendingReleaseRunId = extracted;
    return chain;
  };

  chain.returning = (_projection?: unknown) => {
    if (!pendingSet) {
      // Plain SELECT path — not used by lock methods directly but needed for
      // other service methods that call db.select().from(...).where(...).then()
      return Promise.resolve([state]);
    }

    const patch = pendingSet;
    const releaseRunId = pendingReleaseRunId;
    pendingSet = null;
    pendingReleaseRunId = null;

    // ── CLAIM: activeRunId is being set to a non-null string ──────────────
    if (
      Object.prototype.hasOwnProperty.call(patch, "activeRunId") &&
      patch.activeRunId !== null
    ) {
      const newRunId  = patch.activeRunId as string;
      const lockedAt  = patch.lockedAt as Date;

      // Stale threshold: lockedAt - staleMs gives the cutoff.  Any existing
      // lockedAt before this cutoff is stale.
      const staleThreshold = new Date(lockedAt.getTime() - staleMs);

      const isUnlocked = state.activeRunId === null;
      const isStale    = state.lockedAt !== null && state.lockedAt < staleThreshold;

      if (isUnlocked || isStale) {
        state.activeRunId = newRunId;
        state.lockedAt    = lockedAt;
        return Promise.resolve([{
          id:          state.id,
          activeRunId: state.activeRunId,
          lockedAt:    state.lockedAt,
        }]);
      }
      // Locked by another run and not stale — claim fails, return empty
      return Promise.resolve([]);
    }

    // ── RELEASE: activeRunId is being set to null ─────────────────────────
    if (
      Object.prototype.hasOwnProperty.call(patch, "activeRunId") &&
      patch.activeRunId === null
    ) {
      if (releaseRunId !== null && state.activeRunId === releaseRunId) {
        state.activeRunId = null;
        state.lockedAt    = null;
        return Promise.resolve([{ id: state.id }]);
      }
      // Not the holder — no-op
      return Promise.resolve([]);
    }

    // Fallback (e.g. a regular workspace update)
    return Promise.resolve([state]);
  };

  chain.then = (resolve: (v: MockWorkspaceRow[]) => unknown) =>
    Promise.resolve(resolve([state]));

  const db = {
    select: (..._args: unknown[]) => chain,
    update: (..._args: unknown[]) => chain,
    insert: (..._args: unknown[]) => chain,
    delete: (..._args: unknown[]) => chain,
    _state: state, // exposed so tests can inspect final DB state
  };

  return db;
}

// ── WORKSPACE_RUN_LOCK_STALE_MS constant ─────────────────────────────────────

describe("WORKSPACE_RUN_LOCK_STALE_MS", () => {
  it("is exported and equals 30 minutes in milliseconds", () => {
    expect(WORKSPACE_RUN_LOCK_STALE_MS).toBe(30 * 60 * 1000);
  });
});

// ── tryClaimWorkspaceRun — free workspace ────────────────────────────────────

describe("tryClaimWorkspaceRun — free workspace", () => {
  it("succeeds when the workspace has no current lock", async () => {
    const workspace = makeWorkspace({ activeRunId: null, lockedAt: null });
    const db  = makeDb(workspace);
    const svc = executionWorkspaceService(db as never);

    const result = await svc.tryClaimWorkspaceRun("workspace-1", "run-A");

    expect(result).not.toBeNull();
    expect(result?.activeRunId).toBe("run-A");
    expect(result?.lockedAt).toBeInstanceOf(Date);
    // DB state updated
    expect(db._state.activeRunId).toBe("run-A");
    expect(db._state.lockedAt).toBeInstanceOf(Date);
  });
});

// ── tryClaimWorkspaceRun — locked workspace ──────────────────────────────────

describe("tryClaimWorkspaceRun — locked workspace", () => {
  it("fails when another run holds a fresh lock", async () => {
    const workspace = makeWorkspace({
      activeRunId: "run-B",
      lockedAt:    new Date(), // just acquired — not stale
    });
    const db  = makeDb(workspace);
    const svc = executionWorkspaceService(db as never);

    const result = await svc.tryClaimWorkspaceRun("workspace-1", "run-A");

    expect(result).toBeNull();
    // State unchanged
    expect(db._state.activeRunId).toBe("run-B");
  });
});

// ── tryClaimWorkspaceRun — stale lock ────────────────────────────────────────

describe("tryClaimWorkspaceRun — stale lock reclaimable", () => {
  it("reclaims a lock whose lockedAt is older than staleMs", async () => {
    const staleMs = 5_000; // 5 s threshold for this test
    // Lock was acquired 10 seconds ago — older than the 5-second threshold
    const staleLockTime = new Date(Date.now() - 10_000);

    const workspace = makeWorkspace({ activeRunId: "run-B", lockedAt: staleLockTime });
    const db  = makeDb(workspace, { staleMs });
    const svc = executionWorkspaceService(db as never);

    const result = await svc.tryClaimWorkspaceRun("workspace-1", "run-A", { staleMs });

    expect(result).not.toBeNull();
    expect(result?.activeRunId).toBe("run-A");
    expect(db._state.activeRunId).toBe("run-A");
  });

  it("does NOT reclaim when the lock is still within staleMs", async () => {
    const staleMs = 60_000; // 60 s threshold
    // Lock was acquired only 1 second ago — still fresh
    const freshLockTime = new Date(Date.now() - 1_000);

    const workspace = makeWorkspace({ activeRunId: "run-B", lockedAt: freshLockTime });
    const db  = makeDb(workspace, { staleMs });
    const svc = executionWorkspaceService(db as never);

    const result = await svc.tryClaimWorkspaceRun("workspace-1", "run-A", { staleMs });

    expect(result).toBeNull();
    expect(db._state.activeRunId).toBe("run-B");
  });
});

// ── releaseWorkspaceRun ──────────────────────────────────────────────────────

describe("releaseWorkspaceRun — holder releases", () => {
  it("clears the lock when called by the current lock holder", async () => {
    const workspace = makeWorkspace({ activeRunId: "run-A", lockedAt: new Date() });
    const db  = makeDb(workspace);
    const svc = executionWorkspaceService(db as never);

    const released = await svc.releaseWorkspaceRun("workspace-1", "run-A");

    expect(released).toBe(true);
    expect(db._state.activeRunId).toBeNull();
    expect(db._state.lockedAt).toBeNull();
  });
});

describe("releaseWorkspaceRun — non-holder cannot release", () => {
  it("does nothing when called by a run that does not hold the lock", async () => {
    const workspace = makeWorkspace({ activeRunId: "run-B", lockedAt: new Date() });
    const db  = makeDb(workspace);
    const svc = executionWorkspaceService(db as never);

    const released = await svc.releaseWorkspaceRun("workspace-1", "run-A");

    expect(released).toBe(false);
    // Lock intact — not cleared
    expect(db._state.activeRunId).toBe("run-B");
    expect(db._state.lockedAt).not.toBeNull();
  });
});

// ── Concurrency simulation ────────────────────────────────────────────────────

describe("concurrent claims — only one run wins", () => {
  it("serialises two simultaneous claim attempts: exactly one succeeds", async () => {
    const workspace = makeWorkspace({ activeRunId: null, lockedAt: null });
    const db  = makeDb(workspace);
    const svc = executionWorkspaceService(db as never);

    // Fire both concurrently with Promise.all
    const [r1, r2] = await Promise.all([
      svc.tryClaimWorkspaceRun("workspace-1", "run-A"),
      svc.tryClaimWorkspaceRun("workspace-1", "run-B"),
    ]);

    const winners = [r1, r2].filter(Boolean);
    // Exactly one winner
    expect(winners).toHaveLength(1);
    // The winning runId is what ended up in the DB
    expect(db._state.activeRunId).toBe(winners[0]!.activeRunId);
  });
});

describe("releaseWorkspaceRunsForRun", () => {
  it("releases leases owned by the terminal run", async () => {
    const workspace = makeWorkspace({ activeRunId: "run-A", lockedAt: new Date() });
    const db = makeDb(workspace);
    const svc = executionWorkspaceService(db as never);

    const releasedIds = await svc.releaseWorkspaceRunsForRun("run-A");

    expect(releasedIds).toEqual(["workspace-1"]);
    expect(db._state.activeRunId).toBeNull();
    expect(db._state.lockedAt).toBeNull();
  });

  it("does not release a lease that another run owns", async () => {
    const workspace = makeWorkspace({ activeRunId: "run-B", lockedAt: new Date() });
    const db = makeDb(workspace);
    const svc = executionWorkspaceService(db as never);

    const releasedIds = await svc.releaseWorkspaceRunsForRun("run-A");

    expect(releasedIds).toEqual([]);
    expect(db._state.activeRunId).toBe("run-B");
    expect(db._state.lockedAt).not.toBeNull();
  });
});
