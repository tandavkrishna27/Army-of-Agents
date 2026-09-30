/**
 * chronicler.test.ts (sweep behavior)
 *
 * Tests:
 *   - Sweep queues wakeups for threads with stale cards
 *   - Sweep returns 0 when no Chronicler agent exists
 *   - Sweep does NOT re-queue when a recent (queued/processing) wakeup exists (debounce)
 *   - Sweep queues 0 when no stale threads
 *   - Sweep respects CHRONICLER_MAX_CONCURRENT (mock honors .limit)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  ne: vi.fn((a: unknown, b: unknown) => ({ _op: "ne", a, b })),
  gt: vi.fn((a: unknown, b: unknown) => ({ _op: "gt", a, b })),
  or: vi.fn((...a: unknown[]) => ({ _op: "or", a })),
  isNull: vi.fn((a: unknown) => ({ _op: "isNull", a })),
  isNotNull: vi.fn((a: unknown) => ({ _op: "isNotNull", a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ _op: "inArray", a, b })),
  sql: Object.assign(vi.fn((s: TemplateStringsArray) => ({ _sql: s })), { raw: vi.fn() }),
}));

vi.mock("@armyofagents/db", () => ({
  agents: new Proxy({} as any, { get: (_t, p) => p }),
  aoaAgentTriggers: new Proxy({} as any, { get: (_t, p) => p }),
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
  agentWakeupRequests: new Proxy({} as any, { get: (_t, p) => p }),
  internalAgentConfig: new Proxy({} as any, { get: (_t, p) => `iac.${String(p)}` }),
}));

import {
  runChroniclerSweep,
  CHRONICLER_MAX_CONCURRENT,
} from "../services/internal-agent/aoa-agents/sweep-chronicler.js";
import { eq } from "drizzle-orm";

const AGENT_ID = "agent-chronicler-1";
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_1 = "t1-cccc-cccc-cccc-cccccccccccc";
const THREAD_2 = "t2-dddd-dddd-dddd-dddddddddddd";
const LAST_ENTRY_AT = new Date("2026-06-14T08:00:00Z");
const FINISHED_AFTER_LAST_ENTRY = new Date("2026-06-14T08:01:00Z");

// A "result holder" that is awaitable (recentWakeups), `.limit(n)`-able (the
// staleThreads/companyConfig queries) AND `.orderBy().limit(1)`-able (the
// per-thread lastFinished probe — review fix (k), mirrors sweep-adjutant).
// `.limit(n)` honors n so the CHRONICLER_MAX_CONCURRENT cap test is real.
function holder(rows: object[]) {
  return {
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    orderBy: () => ({ limit: (n: number) => Promise.resolve(rows.slice(0, n)) }),
    then: (resolve: (v: object[]) => unknown) => resolve(rows),
  };
}

function makeDb({
  chroniclerRows = [{ agentId: AGENT_ID, companyId: COMPANY_ID }],
  companyConfigRows = [{ crewPaused: false }],
  staleThreads = [{ id: THREAD_1, lastEntryAt: LAST_ENTRY_AT }, { id: THREAD_2, lastEntryAt: LAST_ENTRY_AT }],
  recentWakeups = [] as object[],
  // Review fix (k): the chronicler now probes the latest finished wakeup PER
  // thread (ORDER BY finishedAt DESC LIMIT 1), not one batch query. Map a
  // threadId → finishedAt so each per-thread probe returns the right single row.
  finishedByThread = {} as Record<string, Date>,
}: {
  chroniclerRows?: object[];
  companyConfigRows?: object[];
  staleThreads?: object[];
  recentWakeups?: object[];
  finishedByThread?: Record<string, Date>;
} = {}) {
  // Fixed-position selects (per company): 1) company config 2) staleThreads
  // 3) recentWakeups. After those, ONE per-thread lastFinished probe per stale
  // thread that was not already debounced. The per-thread probe filters by
  // payload->>'threadId'; the mock can't see the SQL arg, so it serves the
  // finishedByThread rows in stale-thread order.
  const fixed = [companyConfigRows, staleThreads, recentWakeups];
  let seqCall = 0;
  // Per-thread probe cursor — walks the (non-debounced) stale threads in order.
  const probeThreadIds = (staleThreads as Array<{ id: string }>)
    .map((t) => t.id)
    .filter((id) => !(recentWakeups as Array<{ payload?: { threadId?: string } }>).some(
      (w) => w.payload?.threadId === id,
    ));
  let probeIdx = 0;

  const insertSpy = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) });

  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(chroniclerRows),
        }),
        where: () => {
          if (seqCall < fixed.length) {
            return holder(fixed[seqCall++] ?? []);
          }
          // Per-thread lastFinished probe.
          const threadId = probeThreadIds[probeIdx++];
          const finishedAt = threadId ? finishedByThread[threadId] : undefined;
          return holder(finishedAt ? [{ finishedAt }] : []);
        },
      }),
    }),
    insert: insertSpy,
  } as any;
}

describe("runChroniclerSweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues wakeups for stale threads", async () => {
    const db = makeDb();
    const result = await runChroniclerSweep(db as any);
    expect(result.queued).toBe(2);
  });

  it("stale-thread query excludes paused threads", async () => {
    const db = makeDb();
    await runChroniclerSweep(db as any);

    expect(eq).toHaveBeenCalledWith("crewPaused", false);
  });

  it("returns 0 and queues nothing when company crew is paused", async () => {
    const db = makeDb({ companyConfigRows: [{ crewPaused: true }] });

    const result = await runChroniclerSweep(db as any);

    expect(result.queued).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns 0 when no Chronicler agents found", async () => {
    const db = makeDb({ chroniclerRows: [] });
    const result = await runChroniclerSweep(db as any);
    expect(result.queued).toBe(0);
  });

  it("does not queue when thread is already in recent wakeups (debounce)", async () => {
    const db = makeDb({
      recentWakeups: [
        { payload: { threadId: THREAD_1 } },
        { payload: { threadId: THREAD_2 } },
      ],
    });
    const result = await runChroniclerSweep(db as any);
    expect(result.queued).toBe(0);
  });

  it("does not requeue the same stale thread immediately after a completed Chronicler wake", async () => {
    const db = makeDb({
      staleThreads: [{ id: THREAD_1, lastEntryAt: LAST_ENTRY_AT }],
      recentWakeups: [],
      // Latest finished wakeup for THREAD_1 is AFTER the thread's last entry →
      // nothing new since the last card update → must not requeue.
      finishedByThread: { [THREAD_1]: FINISHED_AFTER_LAST_ENTRY },
    });

    const result = await runChroniclerSweep(db as any);

    expect(result.queued).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("queues 0 when no stale threads", async () => {
    const db = makeDb({ staleThreads: [] });
    const result = await runChroniclerSweep(db as any);
    expect(result.queued).toBe(0);
  });

  it("respects CHRONICLER_MAX_CONCURRENT limit (mock honors .limit)", async () => {
    const manyThreads = Array.from({ length: CHRONICLER_MAX_CONCURRENT + 5 }, (_, i) => ({ id: `t${i}` }));
    const db = makeDb({ staleThreads: manyThreads });
    const result = await runChroniclerSweep(db as any);
    expect(result.queued).toBe(CHRONICLER_MAX_CONCURRENT);
  });

  it("review fix (k): the per-thread finished probe is bounded (orderBy + limit 1)", async () => {
    // Assert the per-thread lastFinished lookup uses ORDER BY ... LIMIT 1 (the
    // sibling sweep-adjutant pattern), not an unbounded all-rows scan. We spy on
    // the chain terminal for the per-thread probe (the 4th+ where() call).
    const limitSpy = vi.fn((n: number) => Promise.resolve([] as object[]));
    const orderBySpy = vi.fn(() => ({ limit: limitSpy }));
    let whereCall = 0;

    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve([{ agentId: AGENT_ID, companyId: COMPANY_ID }]),
          }),
          where: () => {
            whereCall += 1;
            if (whereCall === 1) return { limit: () => Promise.resolve([{ crewPaused: false }]) }; // config
            if (whereCall === 2) return { limit: () => Promise.resolve([{ id: THREAD_1, lastEntryAt: LAST_ENTRY_AT }]) }; // staleThreads
            if (whereCall === 3) return { then: (r: (v: object[]) => unknown) => r([]) }; // recentWakeups
            // Per-thread lastFinished probe → must use orderBy().limit(1).
            return { orderBy: orderBySpy };
          },
        }),
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
    } as any;

    await runChroniclerSweep(db);

    expect(orderBySpy).toHaveBeenCalled();
    expect(limitSpy).toHaveBeenCalledWith(1);
  });
});
