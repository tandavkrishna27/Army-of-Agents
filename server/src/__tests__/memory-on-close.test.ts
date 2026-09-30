/**
 * P3-T1: Memory-extraction-on-close — `enqueueMemoryExtractionOnClose`.
 *
 * On thread archive, a Memory Keeper invocation is enqueued (the existing
 * wakeup → dispatcher → MK pipeline) so the closing thread's knowledge becomes
 * pending, founder-gated memory proposals. These tests verify the wakeup is
 * enqueued with the right shape, is idempotent (dedupKey + onConflictDoNothing),
 * and no-ops when the company has no Memory Keeper.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  and: vi.fn((...args: unknown[]) => ({ _op: "and", args })),
  ne: vi.fn((a: unknown, b: unknown) => ({ _op: "ne", a, b })),
}));

vi.mock("@armyofagents/db", () => ({
  agents: new Proxy({} as any, { get: (_t, p) => p }),
  agentWakeupRequests: new Proxy({} as any, { get: (_t, p) => p }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { enqueueMemoryExtractionOnClose } from "../services/internal-agent/aoa-agents/memory-extraction-on-close.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const MK_ID = "33333333-3333-4333-8333-333333333333";

/** Mock DB. `selectResult` is what the MK-resolution select returns. Captures
 *  the values passed to insert(...).values(...) and whether onConflictDoNothing fired. */
function makeMockDb(selectResult: any[]) {
  const insertValues = vi.fn();
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResult),
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: (v: any) => {
        insertValues(v);
        return { onConflictDoNothing };
      },
    })),
  };
  return { db, insertValues, onConflictDoNothing };
}

describe("enqueueMemoryExtractionOnClose (P3-T1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enqueues a Memory Keeper wakeup with the close source/reason and dedupKey", async () => {
    const { db, insertValues, onConflictDoNothing } = makeMockDb([{ id: MK_ID }]);

    await enqueueMemoryExtractionOnClose(db as any, COMPANY_ID, THREAD_ID);

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      agentId: MK_ID,
      source: "thread.close",
      reason: "memory_extraction_on_close",
      payload: { threadId: THREAD_ID, role: "memory_keeper" },
      dedupKey: `mk-close:${THREAD_ID}`,
      status: "queued",
    });
    // Idempotency: paired with onConflictDoNothing.
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the company has no Memory Keeper agent", async () => {
    const { db, insertValues } = makeMockDb([]); // MK resolution returns nothing

    await enqueueMemoryExtractionOnClose(db as any, COMPANY_ID, THREAD_ID);

    expect(db.insert).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("payload carries role='memory_keeper' so the dispatcher routes it to the MK", async () => {
    const { db, insertValues } = makeMockDb([{ id: MK_ID }]);

    await enqueueMemoryExtractionOnClose(db as any, COMPANY_ID, THREAD_ID);

    const payload = insertValues.mock.calls[0][0].payload;
    expect(payload.role).toBe("memory_keeper");
    expect(payload.threadId).toBe(THREAD_ID);
  });
});
