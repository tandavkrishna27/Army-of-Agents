/**
 * sweep-adjutant-no-flood.test.ts
 *
 * Validates that runAdjutantSweep does NOT enqueue a wakeup for a thread that
 * has no human-authored entry newer than the Adjutant's last finished action
 * in that thread.
 *
 * "Human-authored entry" = authorAgentId IS NULL AND inputType NOT IN
 * ('agent', 'system', 'scope_proposal'). This mirrors the isHumanEntry rule
 * in thread-events.ts — the sweep must use the same discriminator.
 *
 * "Agent's last action" = finishedAt of the most recent agentWakeupRequests
 * row for this (agentId, threadId) pair that has a finishedAt set. If no
 * finished wakeup exists, any human entry qualifies.
 *
 * The fix kills the notice flood: a dormant thread with no new human input
 * since the Adjutant last ran must be skipped silently.
 */

import { describe, expect, it, vi } from "vitest";
import { runAdjutantSweep } from "../services/internal-agent/aoa-agents/sweep-adjutant.js";

// ── Mock builder ─────────────────────────────────────────────────────────────
//
// The sweep performs these DB queries in order, per trigger per thread:
//   Q1: SELECT triggers (innerJoin agents) WHERE kind='sweep' AND enabled=true AND NOT paused
//   Q2: SELECT active threads WHERE companyId=... AND phase!=done AND crewPaused=false
//   Q3: SELECT dedup window check (.where().limit(1))
//   Q4: SELECT last finished wakeup (.where().orderBy().limit(1))    ← new gate
//   Q5: SELECT newer human entry (.where().limit(1))                 ← new gate
//   INSERT (only when Q3 = [], Q5 = [{id}])
//
// The mock uses a call-sequence counter. Each call to whereMock returns a
// thenable that also exposes .limit() and .orderBy() so the Drizzle chain
// resolves without errors. The sequence mapping:
//   call 0           → Q1 triggers (innerJoin chain)
//   call 1 per loop  → Q2 activeThreads (awaited directly)
//   call 2 per loop  → Q3 dedup (.limit chained)
//   call 3 per loop  → Q4 lastFinished (.orderBy().limit() chained)
//   call 4 per loop  → Q5 newerHumanEntry (.limit chained)

interface MockDbOpts {
  sweepTriggers: Array<{ agentId: string; companyId: string; config?: Record<string, unknown> | null }>;
  activeThreads?: Array<{ id: string }>;
  /** Rows returned by the dedup-window check (QA-BUG-011). Empty = no recent wakeup → proceed. */
  recentWakeups?: Array<{ id: string }>;
  /**
   * Rows returned by the "last finished wakeup" lookup.
   * This is an internal detail of the implementation — tests typically pass [] (no
   * previous action) or [{ finishedAt: someDate }] to simulate a prior run.
   * Defaults to [] (no prior run → epoch used as lastActionAt → any human entry qualifies).
   */
  lastFinishedWakeups?: Array<{ finishedAt: Date | null }>;
  /**
   * Rows returned by the newer-human-entry gate.
   * Empty = no new human input → SKIP.
   * Non-empty = there IS new human input → proceed to insert.
   */
  newerHumanEntries?: Array<{ id: string }>;
}

/**
 * Build a sequence-based mock DB. The where mock returns different fixtures
 * depending on which query number (0-indexed post-trigger) is being made.
 * Each call returns a thenable that exposes .limit() and .orderBy() so any
 * Drizzle chain resolves cleanly regardless of which call chained it.
 */
function makeDb(opts: MockDbOpts) {
  const valuesMock = vi.fn().mockResolvedValue([{ id: "w-new" }]);
  const recentWakeups = opts.recentWakeups ?? [];
  const lastFinishedWakeups = opts.lastFinishedWakeups ?? [];
  const newerHumanEntries = opts.newerHumanEntries ?? [];

  let triggerQueryDone = false;
  // Per-trigger loop counter (resets per trigger via postTriggerCallIdx).
  // Pattern per thread: Q2(threads), Q3(dedup), Q4(lastFinished), Q5(humanGate)
  // idx % 4: 0=threads, 1=dedup, 2=lastFinished, 3=humanGate
  let postTriggerCallIdx = 0;

  const whereMock = vi.fn().mockImplementation(() => {
    if (!triggerQueryDone) {
      triggerQueryDone = true;
      return Promise.resolve(opts.sweepTriggers);
    }

    const idx = postTriggerCallIdx;
    postTriggerCallIdx += 1;
    const phase = idx % 4;

    let rows: unknown[];
    if (phase === 0) rows = opts.activeThreads ?? [];
    else if (phase === 1) rows = recentWakeups;
    else if (phase === 2) rows = lastFinishedWakeups;
    else rows = newerHumanEntries;

    // Return a thenable that also exposes .limit() and .orderBy() so that
    // whichever chain the sweep uses resolves without a TypeError.
    const limitFn = vi.fn().mockResolvedValue(rows);
    const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
    const t = Promise.resolve(rows);
    return Object.assign(t, { limit: limitFn, orderBy: orderByFn });
  });

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: whereMock }),
        where: whereMock,
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: valuesMock }),
    _valuesMock: valuesMock,
    _whereMock: whereMock,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sweep-adjutant: no-flood gate (Task 0.5)", () => {
  it("SKIP: does NOT enqueue when there is no newer human entry since the last Adjutant action", async () => {
    // Thread has no recent wakeup in dedup window (recentWakeups = []) but
    // also has NO newer human entry (newerHumanEntries = []).
    // Expected: insert is NOT called — the thread is dormant, skip it.
    const db = makeDb({
      sweepTriggers: [{ agentId: "adj-1", companyId: "co-1", config: { role: "adjutant" } }],
      activeThreads: [{ id: "t-1" }],
      recentWakeups: [],        // dedup window: no recent wakeup → would normally proceed
      lastFinishedWakeups: [],  // no previous run (epoch used)
      newerHumanEntries: [],    // human-entry gate: no new input → SKIP
    });

    await runAdjutantSweep(db as any);

    expect(db._valuesMock).not.toHaveBeenCalled();
  });

  it("ENQUEUE: enqueues when there IS a newer human entry since last Adjutant action", async () => {
    // Thread has a newer human entry — Adjutant should wake.
    const db = makeDb({
      sweepTriggers: [{ agentId: "adj-1", companyId: "co-1", config: { role: "adjutant" } }],
      activeThreads: [{ id: "t-1" }],
      recentWakeups: [],                    // dedup window clear
      lastFinishedWakeups: [],              // no previous run
      newerHumanEntries: [{ id: "e-99" }], // new human input present → ENQUEUE
    });

    await runAdjutantSweep(db as any);

    expect(db._valuesMock).toHaveBeenCalledTimes(1);
    expect(db._valuesMock.mock.calls[0][0].payload).toEqual({
      threadId: "t-1",
      role: "adjutant",
    });
  });

  it("SKIP: dedup window still wins — no insert even when newer human entry exists", async () => {
    // recentWakeups is non-empty → dedup hit. Even if there is a newer
    // human entry we must not insert (dedup check runs first and short-circuits).
    const db = makeDb({
      sweepTriggers: [{ agentId: "adj-1", companyId: "co-1", config: { role: "adjutant" } }],
      activeThreads: [{ id: "t-1" }],
      recentWakeups: [{ id: "prev-wakeup" }], // dedup hit → skip regardless
      lastFinishedWakeups: [],
      newerHumanEntries: [{ id: "e-99" }],    // has new input, but dedup wins
    });

    await runAdjutantSweep(db as any);

    expect(db._valuesMock).not.toHaveBeenCalled();
  });

  it("mixed threads: only threads with new human input get wakeups", async () => {
    // Two threads: t-1 has new human input, t-2 does not.
    // Since makeDb's mock iterates at idx%4 per ALL thread iterations,
    // we provide a custom mock here that routes per (thread, queryType).
    const valuesMock = vi.fn().mockResolvedValue([{ id: "w-new" }]);
    let triggerDone = false;

    // Post-trigger query sequence for 2 threads (no dedup hits):
    //   idx 0 → activeThreads = [{id:'t-1'},{id:'t-2'}]
    //   idx 1 → dedup for t-1 → []
    //   idx 2 → lastFinished for t-1 → []
    //   idx 3 → humanGate for t-1 → [{id:'e-1'}]  → ENQUEUE t-1
    //   idx 4 → dedup for t-2 → []
    //   idx 5 → lastFinished for t-2 → []
    //   idx 6 → humanGate for t-2 → []             → SKIP t-2

    let postIdx = 0;
    const perCallResults: unknown[][] = [
      [{ id: "t-1" }, { id: "t-2" }], // idx 0: threads
      [],                               // idx 1: dedup t-1 (clear)
      [],                               // idx 2: lastFinished t-1 (none)
      [{ id: "e-1" }],                  // idx 3: humanGate t-1 (has input)
      [],                               // idx 4: dedup t-2 (clear)
      [],                               // idx 5: lastFinished t-2 (none)
      [],                               // idx 6: humanGate t-2 (no input)
    ];

    const whereMock = vi.fn().mockImplementation(() => {
      if (!triggerDone) {
        triggerDone = true;
        return Promise.resolve([
          { agentId: "adj-1", companyId: "co-1", config: { role: "adjutant" } },
        ]);
      }
      const rows = perCallResults[postIdx] ?? [];
      postIdx++;
      const limitFn = vi.fn().mockResolvedValue(rows);
      const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
      const t = Promise.resolve(rows);
      return Object.assign(t, { limit: limitFn, orderBy: orderByFn });
    });

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({ where: whereMock }),
          where: whereMock,
        }),
      }),
      insert: vi.fn().mockReturnValue({ values: valuesMock }),
    };

    await runAdjutantSweep(db as any);

    // Only t-1 should get a wakeup
    expect(valuesMock).toHaveBeenCalledTimes(1);
    expect(valuesMock.mock.calls[0][0].payload.threadId).toBe("t-1");
  });
});
