/**
 * P1-T10 — crew-budget-wired: verifies that `preflightCrewDispatch` is called
 * by `runController` after the atomic claim succeeds, and that a blocked preflight
 * causes an early return without advancing the cursor or calling the adjutantRunner.
 *
 * Tests:
 *   A. preflightCrewDispatch blocked (budget_exhausted) → early return, adjutantRunner NOT called
 *   B. preflightCrewDispatch allowed → run proceeds past preflight to entries check
 *   C. preflightCrewDispatch blocked (thread_paused) → early return, adjutantRunner NOT called
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _tag: "eq", a, b })),
  and: vi.fn((...args: unknown[]) => ({ _tag: "and", args })),
  gt: vi.fn((a: unknown, b: unknown) => ({ _tag: "gt", a, b })),
  asc: vi.fn((col: unknown) => ({ _tag: "asc", col })),
  sql: vi.fn(),
}));

// ── @armyofagents/db mock ─────────────────────────────────────────────────────
vi.mock("@armyofagents/db", () => ({
  threadOrchestrationState: new Proxy({} as Record<string, unknown>, { get: (_t, p) => p }),
  discussionEntries: new Proxy({} as Record<string, unknown>, { get: (_t, p) => p }),
  discussions: new Proxy({} as Record<string, unknown>, { get: (_t, p) => p }),
}));

// ── crew-budget mock ──────────────────────────────────────────────────────────
vi.mock("../services/crew-budget.js", () => ({
  preflightCrewDispatch: vi.fn(),
}));

// ── live-events mock ──────────────────────────────────────────────────────────
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn().mockResolvedValue(undefined),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────
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

// ── Imports (after all mocks) ─────────────────────────────────────────────────
import { threadOrchestrationService } from "../services/thread-orchestration.js";
import { preflightCrewDispatch } from "../services/crew-budget.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const THREAD_ID = "thread-preflight-test";
const COMPANY_ID = "company-preflight-test";

// =============================================================================
// Sequence-based mock db factory
//
// Each call to `db.select()` returns the next array in `selects[]`.
// The claim UPDATE (with .returning()) returns `updateReturns`.
// Non-returning UPDATEs resolve immediately with [].
// =============================================================================

function makeDb(sequences: { selects: unknown[][]; updateReturns?: unknown[] }): unknown {
  let selectIdx = 0;
  return {
    select: vi.fn(() => {
      const result = sequences.selects[selectIdx++] ?? [];
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(result),
            orderBy: () => Promise.resolve(result),
            then: (r: (v: unknown[]) => unknown) => Promise.resolve(r(result as unknown[])),
          }),
          limit: () => Promise.resolve(result),
          orderBy: () => Promise.resolve(result),
          then: (r: (v: unknown[]) => unknown) => Promise.resolve(r(result as unknown[])),
        }),
      };
    }),
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve(
              sequences.updateReturns ?? [
                {
                  threadId: THREAD_ID,
                  runEpoch: 1,
                  lastProcessedEntryId: null,
                  pendingRun: false,
                },
              ],
            ),
        }),
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue([]) })),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("runController — preflightCrewDispatch wiring (P1-T10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test A ────────────────────────────────────────────────────────────────
  it("A: preflightCrewDispatch blocked (budget_exhausted) → returns early with error, cursor NOT advanced", async () => {
    vi.mocked(preflightCrewDispatch).mockResolvedValue({
      allowed: false,
      reason: "budget exhausted",
      reasonCode: "budget_exhausted",
    });

    const adjutantRunner = vi.fn(async () => {
      throw new Error("adjutantRunner must NOT be called when preflight blocks");
    });

    // Select sequences:
    //   [0] — claim UPDATE .returning() → already set in updateReturns
    //   [0] — threadRow SELECT (companyId)
    //   [1] — entry SELECT (not reached but safe to provide)
    const db = makeDb({
      updateReturns: [{ threadId: THREAD_ID, runEpoch: 1, lastProcessedEntryId: null, pendingRun: false }],
      selects: [
        [{ companyId: COMPANY_ID }], // threadRow
        [],                          // entries (not reached)
      ],
    });

    const svc = threadOrchestrationService(db as Parameters<typeof threadOrchestrationService>[0]);
    const result = await svc.runController(THREAD_ID, { adjutantRunner });

    expect(result).toEqual({
      ran: true,
      suppressed: false,
      error: "budget exhausted",
      startEpoch: 1,
      cursorAdvancedTo: null,
    });

    // preflightCrewDispatch must have been called with the right params.
    expect(preflightCrewDispatch).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        companyId: COMPANY_ID,
        agentId: "adjutant",
        threadId: THREAD_ID,
      }),
    );

    // adjutantRunner must NOT have been called.
    expect(adjutantRunner).not.toHaveBeenCalled();
  });

  // ── Test B ────────────────────────────────────────────────────────────────
  it("B: preflightCrewDispatch allowed → run proceeds past preflight (short-circuits at empty entries)", async () => {
    vi.mocked(preflightCrewDispatch).mockResolvedValue({ allowed: true });

    // Select sequences:
    //   [0] — threadRow SELECT
    //   [1] — entry cursor-seq point-read (no lastProcessedEntryId so skipped)
    //         or entry load — returns [] so run short-circuits with no-pending
    const db = makeDb({
      updateReturns: [{ threadId: THREAD_ID, runEpoch: 1, lastProcessedEntryId: null, pendingRun: false }],
      selects: [
        [{ companyId: COMPANY_ID }], // threadRow
        [],                          // entries — empty → short-circuit
      ],
    });

    const adjutantRunner = vi.fn(async () => ({ output: "should not be reached" }));
    const svc = threadOrchestrationService(db as Parameters<typeof threadOrchestrationService>[0]);
    const result = await svc.runController(THREAD_ID, { adjutantRunner });

    // Run proceeded past preflight but short-circuited on empty entries.
    expect(result).toEqual({ ran: false, reason: "no-entries" });

    // Preflight was called.
    expect(preflightCrewDispatch).toHaveBeenCalledTimes(1);

    // adjutantRunner NOT called (no entries).
    expect(adjutantRunner).not.toHaveBeenCalled();
  });

  // ── Test C ────────────────────────────────────────────────────────────────
  it("C: preflightCrewDispatch blocked (thread_paused) → returns early with error, cursor NOT advanced", async () => {
    vi.mocked(preflightCrewDispatch).mockResolvedValue({
      allowed: false,
      reason: "Crew paused for this thread",
      reasonCode: "thread_paused",
    });

    const adjutantRunner = vi.fn(async () => {
      throw new Error("adjutantRunner must NOT be called when preflight blocks");
    });

    const db = makeDb({
      updateReturns: [{ threadId: THREAD_ID, runEpoch: 1, lastProcessedEntryId: null, pendingRun: false }],
      selects: [
        [{ companyId: COMPANY_ID }], // threadRow
        [],                          // entries (not reached)
      ],
    });

    const svc = threadOrchestrationService(db as Parameters<typeof threadOrchestrationService>[0]);
    const result = await svc.runController(THREAD_ID, { adjutantRunner });

    expect(result).toEqual({
      ran: true,
      suppressed: false,
      error: "Crew paused for this thread",
      startEpoch: 1,
      cursorAdvancedTo: null,
    });

    expect(preflightCrewDispatch).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        companyId: COMPANY_ID,
        agentId: "adjutant",
        threadId: THREAD_ID,
        }),
    );

    // adjutantRunner must NOT have been called.
    expect(adjutantRunner).not.toHaveBeenCalled();
  });
});
