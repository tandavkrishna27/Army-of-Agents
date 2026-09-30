import { describe, expect, it, vi } from "vitest";
import { runAdjutantSweep } from "../services/internal-agent/aoa-agents/sweep-adjutant.js";
import { triggerMatchesEvent } from "../services/internal-agent/aoa-agents/triggers.js";

describe("P3.3: sweep trigger + adjutant periodic driver", () => {
  describe("triggerMatchesEvent", () => {
    it("matches 'sweep' trigger on sweep.tick event", () => {
      expect(triggerMatchesEvent({ kind: "sweep" }, { type: "sweep.tick" })).toBe(true);
    });

    it("does not match 'sweep' trigger on other events", () => {
      expect(triggerMatchesEvent({ kind: "sweep" }, { type: "thread.phase.changed" })).toBe(false);
      expect(triggerMatchesEvent({ kind: "sweep" }, { type: "thread.mention", targetType: "agent" })).toBe(false);
      expect(triggerMatchesEvent({ kind: "sweep" }, { type: "routine.tick" })).toBe(false);
    });

    it("does not match non-sweep triggers on sweep.tick", () => {
      expect(triggerMatchesEvent({ kind: "mention" }, { type: "sweep.tick" })).toBe(false);
      expect(triggerMatchesEvent({ kind: "phase-advance" }, { type: "sweep.tick" })).toBe(false);
      expect(triggerMatchesEvent({ kind: "routine" }, { type: "sweep.tick" })).toBe(false);
    });
  });

  describe("runAdjutantSweep", () => {
    function makeDb(options: {
      sweepTriggers: any[];
      activeThreads?: any[];
      insertResult?: any[];
      recentWakeups?: any[]; // QA-BUG-011: rows returned by the dedup-window lookup
      // Task 0.5 no-flood gate: rows returned by the newer-human-entry check.
      // Defaults to [{id:'e-human'}] so existing tests (which test the dedup/
      // thread-count behaviour) pass without change. Tests that want to verify
      // "no insert when no human input" must pass [].
      newerHumanEntries?: any[];
    }) {
      const valuesMock = vi.fn().mockResolvedValue(options.insertResult ?? [{ id: "w-1" }]);
      const recentRows = options.recentWakeups ?? [];
      // Default non-empty so pre-existing tests that expect inserts still pass.
      const humanRows = options.newerHumanEntries ?? [{ id: "e-human" }];

      // Post-trigger query cycle of 4 (one activeThreads + three per-thread):
      //   idx % 4 === 0 → activeThreads query (one per trigger iteration)
      //   idx % 4 === 1 → dedup window check (.where().limit(1))
      //   idx % 4 === 2 → lastFinished wakeup (.where().orderBy().limit(1))
      //   idx % 4 === 3 → newerHumanEntry gate (.where().limit(1))
      //
      // This cycle is correct when each trigger has exactly ONE active thread
      // (the common case for the tests below). Tests with multiple threads per
      // trigger must use a custom inline mock — the cycle assumption breaks when
      // numThreads > 1 per trigger because activeThreads is queried only once
      // per trigger but there are 3 per-thread queries per thread.
      //
      // All thenables expose .limit() and .orderBy() for Drizzle chain compat.
      let triggerQueryDone = false;
      let postTriggerCallIdx = 0;
      const whereMock = vi.fn().mockImplementation(() => {
        if (!triggerQueryDone) {
          triggerQueryDone = true;
          return Promise.resolve(options.sweepTriggers);
        }
        const idx = postTriggerCallIdx;
        postTriggerCallIdx += 1;
        const phase = idx % 4;

        let rows: any[];
        if (phase === 0) rows = options.activeThreads ?? []; // threads
        else if (phase === 1) rows = recentRows;             // dedup
        else if (phase === 2) rows = [];                     // lastFinished (epoch)
        else rows = humanRows;                               // humanGate

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

    it("inserts one wakeup per active thread for sweep trigger", async () => {
      // Custom inline mock: single trigger, 2 threads. Query sequence after the
      // trigger query (1 activeThreads + 3 per-thread × 2 threads = 7 calls):
      //   idx 0 → activeThreads [{id:'t-1'},{id:'t-2'}]
      //   idx 1 → dedup t-1 (empty)
      //   idx 2 → lastFinished t-1 (empty → epoch)
      //   idx 3 → humanGate t-1 → [{id:'e-1'}] → INSERT
      //   idx 4 → dedup t-2 (empty)
      //   idx 5 → lastFinished t-2 (empty → epoch)
      //   idx 6 → humanGate t-2 → [{id:'e-2'}] → INSERT
      const seqRows: any[][] = [
        [{ id: "t-1" }, { id: "t-2" }], // threads
        [],                               // dedup t-1
        [],                               // lastFinished t-1
        [{ id: "e-1" }],                  // humanGate t-1
        [],                               // dedup t-2
        [],                               // lastFinished t-2
        [{ id: "e-2" }],                  // humanGate t-2
      ];
      const valuesMock = vi.fn().mockResolvedValue([{ id: "w-1" }]);
      let triggerDone = false;
      let seqIdx = 0;
      const whereMock = vi.fn().mockImplementation(() => {
        if (!triggerDone) {
          triggerDone = true;
          return Promise.resolve([{ agentId: "adj-1", companyId: "co-1" }]);
        }
        const rows = seqRows[seqIdx++] ?? [];
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
        _valuesMock: valuesMock,
        _whereMock: whereMock,
      };

      await runAdjutantSweep(db as any);

      // Should have called insert twice (once per thread)
      expect(db._valuesMock).toHaveBeenCalledTimes(2);

      const calls = db._valuesMock.mock.calls;
      // First call for thread t-1
      expect(calls[0][0].payload).toEqual({ threadId: "t-1", role: "adjutant" });
      expect(calls[0][0].source).toBe("sweep.adjutant");
      expect(calls[0][0].reason).toBe("adjutant_sweep");

      // Second call for thread t-2
      expect(calls[1][0].payload).toEqual({ threadId: "t-2", role: "adjutant" });
      expect(calls[1][0].source).toBe("sweep.adjutant");
      expect(calls[1][0].reason).toBe("adjutant_sweep");
    });

    it("returns early when no sweep triggers exist", async () => {
      const db = makeDb({
        sweepTriggers: [],
      });

      await runAdjutantSweep(db as any);

      // Should not have called where (only tried the first query for triggers)
      // In this case, select from triggers should return empty array immediately
      expect(db._valuesMock).not.toHaveBeenCalled();
    });

    it("skips insert when no active threads for a company", async () => {
      const db = makeDb({
        sweepTriggers: [
          { agentId: "adj-1", companyId: "co-1" },
        ],
        activeThreads: [],
      });

      await runAdjutantSweep(db as any);

      // Should not have called insert when there are no active threads
      expect(db._valuesMock).not.toHaveBeenCalled();
    });

    it("QA-BUG-011: skips re-queueing when a recent wakeup exists for the same (agent, thread)", async () => {
      // recentWakeups returns a non-empty row → dedup hit → insert MUST be skipped
      const db = makeDb({
        sweepTriggers: [
          { agentId: "adj-1", companyId: "co-1" },
        ],
        activeThreads: [{ id: "t-1" }],
        recentWakeups: [{ id: "previous-wakeup-id" }],
      });

      await runAdjutantSweep(db as any);

      // No insert because the dedup window matched a previous wakeup
      expect(db._valuesMock).not.toHaveBeenCalled();
    });

    it("processes multiple triggers independently", async () => {
      const db = makeDb({
        sweepTriggers: [
          { agentId: "adj-1", companyId: "co-1" },
          { agentId: "adj-2", companyId: "co-2" },
        ],
        activeThreads: [{ id: "t-1" }],
      });

      await runAdjutantSweep(db as any);

      // Should insert twice (once per trigger × one thread per trigger)
      expect(db._valuesMock).toHaveBeenCalledTimes(2);

      const calls = db._valuesMock.mock.calls;
      expect(calls[0][0].agentId).toBe("adj-1");
      expect(calls[0][0].companyId).toBe("co-1");
      expect(calls[1][0].agentId).toBe("adj-2");
      expect(calls[1][0].companyId).toBe("co-2");
    });
  });
});
