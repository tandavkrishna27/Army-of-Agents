// T1.4 part 1 — sweep driver for the Memory Keeper role.
//
// Pre-T1.4, Memory Keeper was seeded with kind='outbox', but the dispatcher's
// Phase-2 outbox drain is hardcoded to the extraction agent (see
// listEnabledOutboxAgents + dispatcher.ts Phase-2). Net effect: Memory Keeper
// never ran at all — the trigger row was dead code (F4 in the v1-completion
// plan). T1.4 part 1 fixes this by replacing the outbox trigger with a 4hr
// sweep (the safety floor: MK wakes for every active thread at least once
// every 4hr). Event-driven entry.added wakeups are T1.4 part 2 — added later
// as an optimization on top of the sweep.
//
// Mirrors p3-sweep-adjutant.test.ts pattern. The key behavioral differences:
//  - Filters by config.role='memory_keeper' (Adjutant sweep was previously
//    bare kind='sweep' which would cross-fire if MK also used kind='sweep'
//    without role discrimination — fixed in this task on both sides).
//  - Per-thread debounce: skip threads with an MK wakeup queued/run in the
//    last 4hr (prevents resweep storms on tick boundaries).

import { describe, expect, it, vi } from "vitest";
import { runMemoryKeeperSweep } from "../services/internal-agent/aoa-agents/sweep-memory-keeper.js";

interface MockDbOpts {
  /** Triggers returned by the first select query (kind='sweep' join agents). */
  sweepTriggers: Array<{
    agentId: string;
    companyId: string;
    config: Record<string, unknown> | null;
  }>;
  /** Active threads returned per-company by the second select query. */
  activeThreads?: Array<{ id: string }>;
  /** Thread IDs that should be considered DEBOUNCED (skipped). The mock
   *  matches this against the per-trigger third-query check. */
  debouncedThreadIds?: string[];
}

/**
 * Build a sequence-aware DB mock that returns:
 *   1) sweepTriggers (first select with innerJoin)
 *   2) activeThreads (second select per company)
 *   3) debouncedThreadIds (third select per (agent, thread) — debounce check)
 * Each subsequent insert collects its values for assertion.
 */
function makeDb(opts: MockDbOpts) {
  const valuesMock = vi.fn().mockResolvedValue([{ id: "w-new" }]);
  let selectCallIdx = 0;

  // Whenever .where() resolves a query, return the right result based on
  // which select call we're in. The Adjutant test mock used a flag; we use
  // an index so we can distinguish the 3rd-call debounce check from the 2nd.
  const whereImpl = vi.fn().mockImplementation(() => {
    const idx = selectCallIdx;
    selectCallIdx += 1;
    if (idx === 0) {
      // first select: triggers
      return Promise.resolve(opts.sweepTriggers);
    }
    // Subsequent selects alternate between active-threads and debounce.
    // The driver's loop calls them in pairs per trigger; the test fixtures
    // here use a SINGLE trigger so this is fine.
    if (idx % 2 === 1) {
      return Promise.resolve(opts.activeThreads ?? []);
    }
    // debounce check — return one row per thread in debouncedThreadIds.
    return Promise.resolve(
      (opts.debouncedThreadIds ?? []).map((id) => ({ threadId: id })),
    );
  });

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: whereImpl }),
        where: whereImpl,
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: valuesMock }),
    _valuesMock: valuesMock,
    _whereMock: whereImpl,
  };
}

describe("T1.4 part 1: runMemoryKeeperSweep", () => {
  it("inserts one wakeup per active thread when MK sweep trigger exists", async () => {
    const db = makeDb({
      sweepTriggers: [
        { agentId: "mk-1", companyId: "co-1", config: { role: "memory_keeper" } },
      ],
      activeThreads: [{ id: "t-1" }, { id: "t-2" }],
      debouncedThreadIds: [], // nothing debounced — all threads eligible
    });

    await runMemoryKeeperSweep(db as any);

    expect(db._valuesMock).toHaveBeenCalledTimes(2);
    const calls = db._valuesMock.mock.calls;
    // Payload shape mirrors Adjutant: threadId + role
    expect(calls[0][0].payload).toEqual({ threadId: "t-1", role: "memory_keeper" });
    expect(calls[0][0].source).toBe("sweep.memory_keeper");
    expect(calls[0][0].reason).toBe("memory_keeper_sweep");
    expect(calls[1][0].payload).toEqual({ threadId: "t-2", role: "memory_keeper" });
  });

  it("returns early when no MK sweep triggers exist", async () => {
    const db = makeDb({ sweepTriggers: [] });
    await runMemoryKeeperSweep(db as any);
    expect(db._valuesMock).not.toHaveBeenCalled();
  });

  it("ignores sweep triggers whose config.role is NOT 'memory_keeper'", async () => {
    // The triggers select returns BOTH Adjutant + MK sweeps (the table is shared
    // between sweep drivers). The driver must only operate on memory_keeper rows.
    const db = makeDb({
      sweepTriggers: [
        { agentId: "adj-1", companyId: "co-1", config: { role: "adjutant" } },
        { agentId: "mk-1", companyId: "co-1", config: { role: "memory_keeper" } },
      ],
      activeThreads: [{ id: "t-1" }],
      debouncedThreadIds: [],
    });

    await runMemoryKeeperSweep(db as any);

    // ONE call for the MK thread; the adjutant row was filtered out by role.
    expect(db._valuesMock).toHaveBeenCalledTimes(1);
    expect(db._valuesMock.mock.calls[0][0].agentId).toBe("mk-1");
    expect(db._valuesMock.mock.calls[0][0].payload.role).toBe("memory_keeper");
  });

  it("ignores rows without a config.role (defense — pre-T1.4 seed shape)", async () => {
    // If a legacy seed wrote { kind: 'sweep', config: {} }, the driver must
    // NOT silently grab it (could cross-fire with an Adjutant or future role
    // sweep). Backfill is responsible for repairing those rows.
    const db = makeDb({
      sweepTriggers: [
        { agentId: "x-1", companyId: "co-1", config: {} },
        { agentId: "x-2", companyId: "co-1", config: null },
      ],
      activeThreads: [{ id: "t-1" }],
      debouncedThreadIds: [],
    });

    await runMemoryKeeperSweep(db as any);
    expect(db._valuesMock).not.toHaveBeenCalled();
  });

  it("skips threads inside the 4hr debounce window", async () => {
    // The debounce check returns thread t-2 as debounced (had an MK wakeup
    // in the last 4hr); only t-1 + t-3 should get fresh wakeups.
    const db = makeDb({
      sweepTriggers: [
        { agentId: "mk-1", companyId: "co-1", config: { role: "memory_keeper" } },
      ],
      activeThreads: [{ id: "t-1" }, { id: "t-2" }, { id: "t-3" }],
      debouncedThreadIds: ["t-2"],
    });

    await runMemoryKeeperSweep(db as any);

    // Two wakeups (for t-1 + t-3), not three.
    expect(db._valuesMock).toHaveBeenCalledTimes(2);
    const inserted = db._valuesMock.mock.calls.map((c: any) => c[0].payload.threadId);
    expect(inserted).toEqual(["t-1", "t-3"]);
    expect(inserted).not.toContain("t-2");
  });

  it("skips insert entirely when ALL active threads are debounced", async () => {
    const db = makeDb({
      sweepTriggers: [
        { agentId: "mk-1", companyId: "co-1", config: { role: "memory_keeper" } },
      ],
      activeThreads: [{ id: "t-1" }, { id: "t-2" }],
      debouncedThreadIds: ["t-1", "t-2"],
    });

    await runMemoryKeeperSweep(db as any);
    expect(db._valuesMock).not.toHaveBeenCalled();
  });

  it("processes multiple MK triggers across companies independently", async () => {
    // Per-company MK sweep — each company's Memory Keeper agent gets its own
    // active-thread list and its own debounce window.
    const db = makeDb({
      sweepTriggers: [
        { agentId: "mk-1", companyId: "co-1", config: { role: "memory_keeper" } },
        { agentId: "mk-2", companyId: "co-2", config: { role: "memory_keeper" } },
      ],
      activeThreads: [{ id: "t-shared" }], // mock returns same set for both — fine for assertion
      debouncedThreadIds: [],
    });

    await runMemoryKeeperSweep(db as any);

    // Two calls — one per (agent, thread) pair.
    expect(db._valuesMock).toHaveBeenCalledTimes(2);
    const calls = db._valuesMock.mock.calls;
    expect(calls[0][0].agentId).toBe("mk-1");
    expect(calls[0][0].companyId).toBe("co-1");
    expect(calls[1][0].agentId).toBe("mk-2");
    expect(calls[1][0].companyId).toBe("co-2");
  });
});
