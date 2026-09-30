/**
 * Phase G4.3 — Integration tests for the live-thread → spin-off flow.
 *
 * Verifies the wiring from `spin_off_thread` (the agent tool, Navigator-
 * invoked) through the discussions + thread_links + seed-entry copy.
 *
 * Phase G4 wiring gaps closed in this file:
 *   - Spin-off rejects when source `subtype !== 'live'` (error NOT_LIVE).
 *   - New thread inherits `visibility` from the source (private/department/
 *     company) instead of always hardcoding "company".
 *
 * What the tool still does (unchanged): new thread carries forkedFromId,
 * thread_links row of kind='spinoff' is written, seed entries are copied
 * with sourceInfo back-pointers, the spawned thread's companyId is stamped
 * from the caller's ctx.
 *
 * Task 1.5 (#7) hardening: the tool now validates the SOURCE thread's
 * companyId against ctx.companyId — a cross-tenant spin-off is rejected with
 * COMPANY_MISMATCH (the same source read drives the live-only guard +
 * visibility inheritance). All source-row fixtures here therefore carry
 * companyId = ctx.companyId ("co-spinoff-1") so the guard passes; the
 * dedicated cross-company test below pins the rejection.
 */

import { describe, expect, it, vi } from "vitest";
import { spinOffThreadTool } from "../../services/internal-agent/tools/thread-spin-off.js";
import type { ToolContext } from "../../services/internal-agent/types.js";

// ---------------------------------------------------------------------------
// Mock harness — mirrors c2-thread-spin-off.test.ts. Tracks insert ordinals
// so we can identify which insert is the new thread vs entry copies vs the
// thread_links row.
// ---------------------------------------------------------------------------

interface TxTrackerOpts {
  newThreadReturn?: any[];
  /**
   * Row returned for the 1st `tx.select()` — the source-thread guard read.
   * Default: a "live" + "company"-visibility row so existing happy-path
   * tests don't need explicit setup. Pass `[]` to simulate a missing
   * source (→ SOURCE_NOT_FOUND), or override subtype/visibility to drive
   * the live-only + visibility-inherit guards.
   */
  sourceSelectReturn?: any[];
  /** Row returned for the 2nd `tx.select()` — the seed-entries lookup. */
  seedSelectReturn?: any[];
  /** When provided, the insert at this ordinal throws (transaction roll-back). */
  insertThrowsAt?: number;
}

function makeTxTracker(opts: TxTrackerOpts = {}) {
  const insertCalls: Array<{ values: any }> = [];

  function makeInsertChain(getResult: () => any[], idx: number) {
    const chain: any = {};
    chain.values = (vals: any) => {
      insertCalls[idx].values = vals;
      return chain;
    };
    chain.returning = () => Promise.resolve(getResult());
    chain.then = (resolve: any) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  const insert = vi.fn((_table: any) => {
    const idx = insertCalls.length;
    insertCalls.push({ values: undefined });
    if (typeof opts.insertThrowsAt === "number" && opts.insertThrowsAt === idx) {
      throw new Error("simulated transaction failure");
    }
    if (idx === 0) {
      return makeInsertChain(
        () => opts.newThreadReturn ?? [{ id: "new-thread-spinoff" }],
        idx,
      );
    }
    return makeInsertChain(() => [], idx);
  });

  // Sequence-aware select stub: 1st call → source guard, 2nd → seed copy.
  const sourceDefault = [
    { id: "thread-src-1", companyId: "co-spinoff-1", subtype: "live", visibility: "company" },
  ];
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
    companyId: "co-spinoff-1",
    userId: "u-spinoff-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    agentId: "agent-navigator",
    db: { transaction: transactionFn },
    services: {} as any,
  } as unknown as ToolContext;
}

describe("integration: live thread → spin-off flow", () => {
  // ── Happy path — links, scope inheritance ────────────────────────────────

  it("spin_off creates a new thread linked back to the source via thread_links(kind='spinoff')", async () => {
    const tracker = makeTxTracker();
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    const result = await spinOffThreadTool.execute(
      { fromThreadId: "thread-src-1", title: "Spin-off thread" },
      makeCtx(transactionFn),
    );

    expect(result.success).toBe(true);
    expect((result.data as any).threadId).toBe("new-thread-spinoff");

    // The tx makes 2 inserts when no seeds: (1) discussions, (2) thread_links.
    expect(tracker.insertCalls).toHaveLength(2);
    const newThread = tracker.insertCalls[0].values;
    expect(newThread).toMatchObject({
      companyId: "co-spinoff-1",
      title: "Spin-off thread",
      forkedFromId: "thread-src-1",
      // Visibility inherits from source — see the dedicated inheritance
      // tests below. The default mock source row is `company`-visible.
      visibility: "company",
      phase: "discuss",
      createdBy: "agent-navigator",
    });
    const link = tracker.insertCalls[1].values;
    expect(link).toMatchObject({
      companyId: "co-spinoff-1",
      fromThreadId: "thread-src-1",
      toThreadId: "new-thread-spinoff",
      kind: "spinoff",
    });
  });

  it("spawned thread carries companyId from the caller's context", async () => {
    // The spawned thread's companyId is stamped from ctx.companyId. The tool
    // DOES read the source row now (Task 1.5 #7 guard + visibility inherit),
    // but the new thread's companyId comes from ctx — and since the guard
    // requires source.companyId === ctx.companyId, the default same-company
    // source (co-spinoff-1) passes and the spawned thread is co-spinoff-1.
    const tracker = makeTxTracker();
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    await spinOffThreadTool.execute(
      { fromThreadId: "thread-src-1", title: "scope-inherit-check" },
      makeCtx(transactionFn),
    );

    expect(tracker.insertCalls[0].values.companyId).toBe("co-spinoff-1");
    expect(tracker.insertCalls[1].values.companyId).toBe("co-spinoff-1");
  });

  it("spin-off from a DIFFERENT company's source thread is REJECTED with COMPANY_MISMATCH (#7)", async () => {
    // Cross-tenant guard (Task 1.5 #7): a caller scoped to co-spinoff-1 must
    // not be able to spin off from another company's thread. The guard fires
    // after the source read, before any insert — nothing is written.
    const tracker = makeTxTracker({
      sourceSelectReturn: [
        { id: "foreign-thread", companyId: "other-co", subtype: "live", visibility: "company" },
      ],
    });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    const result = await spinOffThreadTool.execute(
      { fromThreadId: "foreign-thread", title: "cross-tenant-attempt" },
      makeCtx(transactionFn),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("COMPANY_MISMATCH");
    expect(tracker.insertCalls).toHaveLength(0);
    expect(tracker.select).toHaveBeenCalledTimes(1);
  });

  // ── Seed-entry copy semantics ────────────────────────────────────────────

  it("seed entries are copied into the new thread with sourceInfo back-pointers", async () => {
    const tracker = makeTxTracker({
      seedSelectReturn: [
        // discussionId must match fromThreadId — the Task 1.5 (#7) scope filter
        // drops any seed entry that doesn't belong to the source thread.
        { id: "src-e-1", discussionId: "thread-src-1", rawContent: "first seed entry content" },
        { id: "src-e-2", discussionId: "thread-src-1", rawContent: "second seed entry content" },
      ],
    });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    const result = await spinOffThreadTool.execute(
      {
        fromThreadId: "thread-src-1",
        title: "Seeded spin-off",
        seedEntries: ["src-e-1", "src-e-2"],
      },
      makeCtx(transactionFn),
    );

    expect(result.success).toBe(true);
    expect((result.data as any).seedEntryCount).toBe(2);

    // 1 new-thread + 2 seed entries + 1 link = 4 inserts in order.
    expect(tracker.insertCalls).toHaveLength(4);
    const entry1 = tracker.insertCalls[1].values;
    expect(entry1).toMatchObject({
      discussionId: "new-thread-spinoff",
      inputType: "agent", // seeded entries are tagged as agent-authored
      rawContent: "first seed entry content",
      sourceInfo: {
        copiedFromThreadId: "thread-src-1",
        originalEntryId: "src-e-1",
      },
    });
    const entry2 = tracker.insertCalls[2].values;
    expect(entry2).toMatchObject({
      rawContent: "second seed entry content",
      sourceInfo: {
        copiedFromThreadId: "thread-src-1",
        originalEntryId: "src-e-2",
      },
    });
  });

  it("missing source title falls back to the supplied tool title (no implicit copy)", async () => {
    // We're asserting that the tool does NOT silently borrow the source
    // title — that would be a privacy leak if the source title contained
    // sensitive context. The caller is responsible for the new title.
    const tracker = makeTxTracker();
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    await spinOffThreadTool.execute(
      { fromThreadId: "thread-src-1", title: "explicit-title-only" },
      makeCtx(transactionFn),
    );

    expect(tracker.insertCalls[0].values.title).toBe("explicit-title-only");
  });

  // ── Phase G4 wiring gap closed: spin-off requires subtype='live' ─────────

  it("spin-off on a non-live source thread is REJECTED with error NOT_LIVE", async () => {
    // Plan G4.3 contract: only `subtype='live'` threads may spin off.
    // A "normal" thread is self-contained and should not produce a
    // derived thread via the agent tool. The guard fires inside the tx
    // (the first select against discussions) and rolls back without
    // inserting anything.
    const tracker = makeTxTracker({
      sourceSelectReturn: [
        { id: "normal-thread-id", companyId: "co-spinoff-1", subtype: "normal", visibility: "company" },
      ],
    });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    const result = await spinOffThreadTool.execute(
      { fromThreadId: "normal-thread-id", title: "should-be-blocked" },
      makeCtx(transactionFn),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_LIVE");
    // No writes happened — source-guard rollback.
    expect(tracker.insertCalls).toHaveLength(0);
    // The source was queried exactly once (the guard read).
    expect(tracker.select).toHaveBeenCalledTimes(1);
  });

  it("spin-off on a live source thread PROCEEDS (subtype='live')", async () => {
    // Complementary assertion: explicit `subtype='live'` short-circuits
    // past the guard and produces the new thread + link rows as expected.
    const tracker = makeTxTracker({
      sourceSelectReturn: [
        { id: "thread-src-1", companyId: "co-spinoff-1", subtype: "live", visibility: "company" },
      ],
    });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    const result = await spinOffThreadTool.execute(
      { fromThreadId: "thread-src-1", title: "live-source-ok" },
      makeCtx(transactionFn),
    );

    expect(result.success).toBe(true);
    // Two inserts when no seeds: discussions + thread_links.
    expect(tracker.insertCalls).toHaveLength(2);
  });

  it("spin-off when source thread is missing is REJECTED with SOURCE_NOT_FOUND", async () => {
    // Defensive: a referenced thread that no longer exists must not
    // silently produce an orphaned derived thread. We assert the explicit
    // structured rejection.
    const tracker = makeTxTracker({ sourceSelectReturn: [] });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    const result = await spinOffThreadTool.execute(
      { fromThreadId: "ghost-thread-id", title: "noop" },
      makeCtx(transactionFn),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("SOURCE_NOT_FOUND");
    expect(tracker.insertCalls).toHaveLength(0);
  });

  // ── Phase G4 wiring gap closed: visibility inherits from source ──────────

  it("derived thread inherits visibility='private' from a private live source", async () => {
    const tracker = makeTxTracker({
      sourceSelectReturn: [
        { id: "thread-src-1", companyId: "co-spinoff-1", subtype: "live", visibility: "private" },
      ],
    });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    await spinOffThreadTool.execute(
      { fromThreadId: "thread-src-1", title: "private-spin-off" },
      makeCtx(transactionFn),
    );

    expect(tracker.insertCalls[0].values.visibility).toBe("private");
  });

  it("derived thread inherits visibility='department' from a department-scoped live source", async () => {
    const tracker = makeTxTracker({
      sourceSelectReturn: [
        { id: "thread-src-1", companyId: "co-spinoff-1", subtype: "live", visibility: "department" },
      ],
    });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    await spinOffThreadTool.execute(
      { fromThreadId: "thread-src-1", title: "dept-spin-off" },
      makeCtx(transactionFn),
    );

    expect(tracker.insertCalls[0].values.visibility).toBe("department");
  });

  it("derived thread inherits visibility='company' from a company-visible live source", async () => {
    const tracker = makeTxTracker({
      sourceSelectReturn: [
        { id: "thread-src-1", companyId: "co-spinoff-1", subtype: "live", visibility: "company" },
      ],
    });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    await spinOffThreadTool.execute(
      { fromThreadId: "thread-src-1", title: "company-spin-off" },
      makeCtx(transactionFn),
    );

    expect(tracker.insertCalls[0].values.visibility).toBe("company");
  });

  // ── Failure mode ─────────────────────────────────────────────────────────

  it("transaction rollback when the new-thread insert fails (no link, no entries)", async () => {
    const tracker = makeTxTracker({ insertThrowsAt: 0 });
    const transactionFn = vi.fn(async (cb: any) =>
      cb({ insert: tracker.insert, select: tracker.select }),
    );

    const result = await spinOffThreadTool.execute(
      { fromThreadId: "thread-src-1", title: "should-fail" },
      makeCtx(transactionFn),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("TRANSACTION_FAILED");
    expect(result.summary).toMatch(/simulated transaction failure/);
  });

  it("missing fromThreadId or title → INVALID_PARAMS, no tx attempted", async () => {
    const transactionFn = vi.fn();
    const ctx = makeCtx(transactionFn);

    let r = await spinOffThreadTool.execute({ title: "no-source" }, ctx);
    expect(r.error).toBe("INVALID_PARAMS");

    r = await spinOffThreadTool.execute({ fromThreadId: "thread-src-1" }, ctx);
    expect(r.error).toBe("INVALID_PARAMS");

    expect(transactionFn).not.toHaveBeenCalled();
  });
});
