// server/src/__tests__/c2-thread-spin-off.test.ts
//
// Task C2 batch 2 — spin_off_thread tool tests.
// Verifies: new thread with forkedFromId is created, seed entries copied with
// sourceInfo back-pointers, thread_links row of kind=spinoff written, no-seed
// case skips the entry copy, and transactional rollback on failure.

import { describe, expect, it, vi } from "vitest";
import { spinOffThreadTool } from "../services/internal-agent/tools/thread-spin-off.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// Build a mock tx that tracks insert/select call ordinals.
// Insert order is:
//   1. tx.insert(discussions).values(...).returning() — new thread
//   2. tx.insert(discussionEntries).values(...) — once per seed entry
//   3. tx.insert(threadLinks).values(...) — final link row
// Select order is:
//   1. tx.select().from(discussions).where(...).limit(1) — source row
//      (used by the Phase G4 live-only + visibility-inherit guard)
//   2. tx.select().from(discussionEntries).where(...) — seed-entry copies
//      (only when seedEntries is non-empty)
// The mock is sequence-aware: the first .select() resolves to
// `sourceSelectReturn`, the second to `seedSelectReturn`. Both default
// to a permissive "live + company" source row so legacy tests that only
// exercise the happy path continue to pass without setup churn.
function makeTxTracker(opts: {
  newThreadReturn?: any[];
  sourceSelectReturn?: any[];
  seedSelectReturn?: any[];
  insertThrowsAt?: number; // ordinal of insert call that should throw
} = {}) {
  const insertCalls: Array<{ values: any }> = [];

  function makeInsertChain(getResult: () => any[], idx: number) {
    const chain: any = {};
    chain.values = (vals: any) => {
      insertCalls[idx].values = vals;
      return chain;
    };
    chain.returning = () => Promise.resolve(getResult());
    // Make the chain awaitable so insert(...).values(...) without
    // .returning() also works.
    chain.then = (resolve: any) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  const insert = vi.fn((_table: any) => {
    const idx = insertCalls.length;
    insertCalls.push({ values: undefined });
    if (typeof opts.insertThrowsAt === "number" && opts.insertThrowsAt === idx) {
      throw new Error("simulated insert failure");
    }
    if (idx === 0) {
      return makeInsertChain(
        () => opts.newThreadReturn ?? [{ id: "new-thread-1" }],
        idx,
      );
    }
    return makeInsertChain(() => [], idx);
  });

  const sourceDefault = [{ id: "thread-src", subtype: "live", visibility: "company", companyId: "co-1" }];
  const selectQueue = [
    opts.sourceSelectReturn ?? sourceDefault,
    opts.seedSelectReturn ?? [],
  ];
  let selectIdx = 0;

  const selectFn = vi.fn(() => {
    const idx = selectIdx++;
    const rows = selectQueue[idx] ?? [];
    const chain: any = {};
    chain.where = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockReturnValue(chain);
    chain.then = (resolve: any) => Promise.resolve(resolve(rows));
    return { from: vi.fn().mockReturnValue(chain) };
  });

  return { insert, select: selectFn, insertCalls };
}

function makeCtx(transactionFn: any): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    agentId: "agent-router",
    db: { transaction: transactionFn },
    services: {} as any,
  } as unknown as ToolContext;
}

describe("spin_off_thread tool (C2 batch 2)", () => {
  it("metadata: name, category=action, requiredRole=team_member, requires confirmation", () => {
    expect(spinOffThreadTool.name).toBe("spin_off_thread");
    expect(spinOffThreadTool.category).toBe("action");
    expect(spinOffThreadTool.requiredRole).toBe("team_member");
    expect(spinOffThreadTool.requiresConfirmation).toBe(true);
  });

  it("creates a new thread with forkedFromId + thread_links row when no seeds", async () => {
    const tracker = makeTxTracker();
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );
    const ctx = makeCtx(transactionFn);

    const result = await spinOffThreadTool.execute(
      { fromThreadId: "thread-src", title: "spinoff title" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).threadId).toBe("new-thread-1");
    expect((result.data as any).seedEntryCount).toBe(0);
    // Two inserts when no seeds: discussions + threadLinks.
    expect(tracker.insertCalls.length).toBe(2);
    const newThread = tracker.insertCalls[0].values;
    expect(newThread).toMatchObject({
      companyId: "co-1",
      title: "spinoff title",
      forkedFromId: "thread-src",
      visibility: "company",
      createdBy: "agent-router",
    });
    const link = tracker.insertCalls[1].values;
    expect(link).toMatchObject({
      companyId: "co-1",
      fromThreadId: "thread-src",
      toThreadId: "new-thread-1",
      kind: "spinoff",
    });
  });

  it("copies seed entries with sourceInfo back-pointers", async () => {
    const tracker = makeTxTracker({
      seedSelectReturn: [
        { id: "e-1", rawContent: "first content", discussionId: "thread-src" },
        { id: "e-2", rawContent: "second content", discussionId: "thread-src" },
      ],
    });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );
    const ctx = makeCtx(transactionFn);

    const result = await spinOffThreadTool.execute(
      {
        fromThreadId: "thread-src",
        title: "with seeds",
        seedEntries: ["e-1", "e-2"],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).seedEntryCount).toBe(2);
    // 1 new-thread insert + 2 entry inserts + 1 link insert = 4 inserts.
    expect(tracker.insertCalls.length).toBe(4);
    const entry1 = tracker.insertCalls[1].values;
    expect(entry1).toMatchObject({
      discussionId: "new-thread-1",
      inputType: "agent",
      rawContent: "first content",
      sourceInfo: { copiedFromThreadId: "thread-src", originalEntryId: "e-1" },
    });
    const entry2 = tracker.insertCalls[2].values;
    expect(entry2).toMatchObject({
      rawContent: "second content",
      sourceInfo: { copiedFromThreadId: "thread-src", originalEntryId: "e-2" },
    });
  });

  it("treats non-string seedEntries entries as missing (no copy, no error)", async () => {
    const tracker = makeTxTracker();
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );
    const ctx = makeCtx(transactionFn);

    const result = await spinOffThreadTool.execute(
      {
        fromThreadId: "thread-src",
        title: "filter test",
        // Mixed array: only strings should be kept; non-string entries filtered.
        seedEntries: [123, null, undefined],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).seedEntryCount).toBe(0);
    // No seed entry inserts; just 1 thread + 1 link.
    expect(tracker.insertCalls.length).toBe(2);
  });

  it("rolls back when the new-thread insert fails (no link written)", async () => {
    const tracker = makeTxTracker({ insertThrowsAt: 0 });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );
    const ctx = makeCtx(transactionFn);

    const result = await spinOffThreadTool.execute(
      { fromThreadId: "thread-src", title: "x" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("TRANSACTION_FAILED");
    expect(result.summary).toContain("simulated insert failure");
  });

  it("returns INVALID_PARAMS when fromThreadId is missing", async () => {
    const transactionFn = vi.fn();
    const ctx = makeCtx(transactionFn);
    const result = await spinOffThreadTool.execute(
      { title: "no source" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(transactionFn).not.toHaveBeenCalled();
  });

  it("returns INVALID_PARAMS when title is missing", async () => {
    const transactionFn = vi.fn();
    const ctx = makeCtx(transactionFn);
    const result = await spinOffThreadTool.execute(
      { fromThreadId: "thread-src" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(transactionFn).not.toHaveBeenCalled();
  });

  // ── Cross-tenant guards (#7) ─────────────────────────────────────────────────

  it("returns COMPANY_MISMATCH when source thread belongs to a different company", async () => {
    // Source thread has companyId='company-B', caller's ctx has companyId='co-1'.
    const tracker = makeTxTracker({
      sourceSelectReturn: [{ id: "thread-src", subtype: "live", visibility: "company", companyId: "company-B" }],
    });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );
    const ctx = makeCtx(transactionFn);

    const result = await spinOffThreadTool.execute(
      { fromThreadId: "thread-src", title: "cross-tenant attempt" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("COMPANY_MISMATCH");
    // No insert should have been issued.
    expect(tracker.insertCalls.length).toBe(0);
  });

  it("filters out seed entries whose discussionId does not match fromThreadId (cross-thread scope guard)", async () => {
    // Two seed entries returned by DB: one from the source thread, one stray.
    const tracker = makeTxTracker({
      seedSelectReturn: [
        { id: "e-1", rawContent: "valid content", discussionId: "thread-src" },
        { id: "e-stray", rawContent: "stray content from another thread", discussionId: "thread-other" },
      ],
    });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );
    const ctx = makeCtx(transactionFn);

    const result = await spinOffThreadTool.execute(
      {
        fromThreadId: "thread-src",
        title: "scope guard test",
        seedEntries: ["e-1", "e-stray"],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    // seedEntryCount is the number of IDs passed in (not filtered), for the response.
    expect((result.data as any).seedEntryCount).toBe(2);
    // But only 1 entry actually copied: the stray entry is excluded.
    // Insert order: 1=new thread, 2=e-1 copy, 3=threadLink. The stray is NOT inserted.
    expect(tracker.insertCalls.length).toBe(3);
    const copiedEntry = tracker.insertCalls[1].values;
    expect(copiedEntry).toMatchObject({
      discussionId: "new-thread-1",
      rawContent: "valid content",
      sourceInfo: { originalEntryId: "e-1" },
    });
    // Confirm the stray is not inserted (all entry inserts reference the valid ID).
    for (const call of tracker.insertCalls) {
      if (call.values?.sourceInfo) {
        expect(call.values.sourceInfo.originalEntryId).not.toBe("e-stray");
      }
    }
  });

  it("same-company source thread (happy path) still spins off successfully", async () => {
    // Explicit: same companyId as ctx ('co-1') → guard passes, spinoff succeeds.
    const tracker = makeTxTracker({
      sourceSelectReturn: [{ id: "thread-src", subtype: "live", visibility: "company", companyId: "co-1" }],
    });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );
    const ctx = makeCtx(transactionFn);

    const result = await spinOffThreadTool.execute(
      { fromThreadId: "thread-src", title: "same-company spinoff" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).threadId).toBe("new-thread-1");
    // discussions insert + threadLinks insert
    expect(tracker.insertCalls.length).toBe(2);
  });
});
