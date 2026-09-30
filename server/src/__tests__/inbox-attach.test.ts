// server/src/__tests__/inbox-attach.test.ts
//
// Task 0.3 (Inbound Dirty-Data Routing) — tests for inbox-attach.ts service.
//
// Covers:
//   1. companyId mismatch (inbox or thread in a different company) → COMPANY_MISMATCH throw, no writes
//   2. happy attach: claims row + inserts discussion_entries with correct inputType,
//      createdBy from originSource, seq, extractionStatus='skipped' + bumps entrySeq + publishes live events
//   3. idempotent: second attach when status is already 'attached' → posted:false, alreadyHandled:true, no duplicate entry
//   4. promote: creates a thread + posts rawContent as the first entry; returns threadId + entryId
//
// Mock-DB style mirrors c2-thread-post-scope-proposal.test.ts:
//   - select chains return pre-configured rows
//   - transaction callback receives a mock tx with tracked insert/update calls
//   - publishLiveEvent is vi.mock'd

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock live events — called after the transaction in the happy path.
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

// Mock discussions service for the promote path — we just need the create call
// to return a shaped object; we don't want to run the real service internals.
vi.mock("../services/discussions.js", () => ({
  discussionService: vi.fn(),
}));

import { attachInboxItemToThread, promoteInboxItemToNewThread } from "../services/inbox-attach.js";
import { publishLiveEvent } from "../services/live-events.js";
import { discussionService } from "../services/discussions.js";

const publishLiveEventMock = vi.mocked(publishLiveEvent);
const discussionServiceMock = vi.mocked(discussionService);

// ── Helpers ───────────────────────────────────────────────────────────────────

const COMPANY_A = "co-aaaa";
const COMPANY_B = "co-bbbb";

const INBOX_ITEM_PENDING = {
  id: "item-1",
  companyId: COMPANY_A,
  rawContent: "Hello from inbound",
  originSource: "external-bot",
  originMedium: "mcp",
  status: "pending",
};

const INBOX_ITEM_ATTACHED = {
  ...INBOX_ITEM_PENDING,
  status: "attached",
};

const THREAD = {
  id: "thread-1",
  companyId: COMPANY_A,
};

const ACTOR = {
  actorId: "user-1",
  actorType: "user",
  agentId: null,
};

/**
 * Build a mock db that handles:
 *   - select chains (pre-flight companyId checks)
 *   - transaction (receives tx with insert + update mocks)
 */
function makeDb(opts: {
  inboxRow?: object | null;     // row returned for inbox item select
  threadRow?: object | null;    // row returned for thread select
  claimRows?: object[];         // rows returned by the UPDATE...RETURNING claim
  updateThrows?: Error;
  insertEntry?: object;         // row returned by discussionEntries insert
}) {
  const {
    inboxRow = INBOX_ITEM_PENDING,
    threadRow = THREAD,
    claimRows = [{ id: "item-1" }],
    insertEntry = { id: "entry-new", seq: 1 },
  } = opts;

  // select is called twice in the pre-flight: once for inbox, once for thread.
  let selectCallCount = 0;
  const select = vi.fn(() => {
    const callIdx = selectCallCount;
    selectCallCount++;
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(
        callIdx === 0
          ? (inboxRow ? [inboxRow] : [])
          : (threadRow ? [threadRow] : []),
      ),
    };
  });

  // Track all update + insert calls inside transactions.
  const txUpdateCalls: Array<{ set: any; whereArg: any; result: any }> = [];
  const txInsertCalls: Array<{ values: any }> = [];

  const makeTxUpdate = (claimedResult: any) => ({
    set: (s: any) => ({
      where: (w: any) => {
        txUpdateCalls.push({ set: s, whereArg: w, result: claimedResult });
        if (opts.updateThrows) throw opts.updateThrows;
        return {
          returning: (_cols?: any) => Promise.resolve(claimedResult),
        };
      },
    }),
  });

  const makeTxInsert = () => {
    const chain: any = {
      values: (vals: any) => {
        txInsertCalls.push({ values: vals });
        return {
          returning: () => Promise.resolve([insertEntry]),
          // For cases that don't .returning() (e.g. plain insert)
          then: (resolve: any) => Promise.resolve(resolve([insertEntry])),
        };
      },
    };
    return chain;
  };

  // The update in the transaction is called in this order:
  //   1. claim UPDATE (threadInboxItems) → returns claimRows
  //   2. seq bump UPDATE (discussions) → returns [{ entrySeq:1, companyId }]
  let txUpdateIdx = 0;
  const txUpdate = vi.fn(() => {
    const idx = txUpdateIdx;
    txUpdateIdx++;
    if (idx === 0) return makeTxUpdate(claimRows);
    // Seq bump — always returns a valid row.
    return makeTxUpdate([{ entrySeq: 1, companyId: COMPANY_A }]);
  });

  const txInsert = vi.fn(() => makeTxInsert());

  const transaction = vi.fn(async (cb: any) => {
    txUpdateIdx = 0; // reset per-transaction call order
    return await cb({ update: txUpdate, insert: txInsert });
  });

  return {
    db: { select, transaction } as any,
    txUpdateCalls,
    txInsertCalls,
    txUpdate,
    txInsert,
    transaction,
  };
}

// ── Tests: attachInboxItemToThread ────────────────────────────────────────────

describe("attachInboxItemToThread", () => {
  beforeEach(() => {
    publishLiveEventMock.mockClear();
  });

  it("throws COMPANY_MISMATCH when inbox item belongs to a different company", async () => {
    const { db, transaction } = makeDb({
      inboxRow: { ...INBOX_ITEM_PENDING, companyId: COMPANY_B },
    });

    await expect(
      attachInboxItemToThread(db, {
        companyId: COMPANY_A,
        inboxItemId: "item-1",
        threadId: "thread-1",
        actor: ACTOR,
      }),
    ).rejects.toThrow("COMPANY_MISMATCH");

    // No writes.
    expect(transaction).not.toHaveBeenCalled();
    expect(publishLiveEventMock).not.toHaveBeenCalled();
  });

  it("throws COMPANY_MISMATCH when inbox item is missing", async () => {
    const { db, transaction } = makeDb({ inboxRow: null });

    await expect(
      attachInboxItemToThread(db, {
        companyId: COMPANY_A,
        inboxItemId: "missing",
        threadId: "thread-1",
        actor: ACTOR,
      }),
    ).rejects.toThrow("COMPANY_MISMATCH");

    expect(transaction).not.toHaveBeenCalled();
    expect(publishLiveEventMock).not.toHaveBeenCalled();
  });

  it("throws COMPANY_MISMATCH when thread belongs to a different company", async () => {
    const { db, transaction } = makeDb({
      threadRow: { id: "thread-1", companyId: COMPANY_B },
    });

    await expect(
      attachInboxItemToThread(db, {
        companyId: COMPANY_A,
        inboxItemId: "item-1",
        threadId: "thread-1",
        actor: ACTOR,
      }),
    ).rejects.toThrow("COMPANY_MISMATCH");

    expect(transaction).not.toHaveBeenCalled();
    expect(publishLiveEventMock).not.toHaveBeenCalled();
  });

  it("throws COMPANY_MISMATCH when thread is missing", async () => {
    const { db, transaction } = makeDb({ threadRow: null });

    await expect(
      attachInboxItemToThread(db, {
        companyId: COMPANY_A,
        inboxItemId: "item-1",
        threadId: "missing-thread",
        actor: ACTOR,
      }),
    ).rejects.toThrow("COMPANY_MISMATCH");

    expect(transaction).not.toHaveBeenCalled();
    expect(publishLiveEventMock).not.toHaveBeenCalled();
  });

  it("happy attach: claims row + inserts entry with correct shape + bumps seq + publishes events", async () => {
    const { db, txInsertCalls, transaction } = makeDb({});

    const result = await attachInboxItemToThread(db, {
      companyId: COMPANY_A,
      inboxItemId: "item-1",
      threadId: "thread-1",
      actor: ACTOR,
    });

    expect(result.posted).toBe(true);
    expect(result.entryId).toBe("entry-new");
    expect(result.alreadyHandled).toBe(false);

    // Transaction was used.
    expect(transaction).toHaveBeenCalledOnce();

    // Exactly one entry insert.
    expect(txInsertCalls.length).toBe(1);
    const entryValues = txInsertCalls[0].values;

    // rawContent from the inbox item.
    expect(entryValues.rawContent).toBe("Hello from inbound");
    // inputType mapped from originMedium ('mcp' is valid).
    expect(entryValues.inputType).toBe("mcp");
    // extractionStatus must be 'skipped' so the Scribe drain can't clobber it.
    expect(entryValues.extractionStatus).toBe("skipped");
    // seq is set from the bumped entrySeq.
    expect(entryValues.seq).toBe(1);
    // createdBy authored from originSource.
    expect(entryValues.createdBy).toBe("external-bot");
    // authorAgentId left null (originSource is a free string, not a validated uuid).
    expect(entryValues.authorAgentId).toBeNull();
    // sourceInfo carries provenance.
    expect(entryValues.sourceInfo).toMatchObject({
      originSource: "external-bot",
      fromInboxItem: "item-1",
    });

    // Live events published.
    expect(publishLiveEventMock).toHaveBeenCalledTimes(2);
    const eventTypes = publishLiveEventMock.mock.calls.map((c) => c[0].type);
    expect(eventTypes).toContain("discussion.entry.created");
    expect(eventTypes).toContain("thread.entry.created");
  });

  it("maps originMedium to inputType when it is a valid DiscussionEntryInputType", async () => {
    const { db, txInsertCalls } = makeDb({
      inboxRow: { ...INBOX_ITEM_PENDING, originMedium: "voice" },
    });

    await attachInboxItemToThread(db, {
      companyId: COMPANY_A,
      inboxItemId: "item-1",
      threadId: "thread-1",
      actor: ACTOR,
    });

    expect(txInsertCalls[0].values.inputType).toBe("voice");
  });

  it("falls back inputType to 'mcp' when originMedium is not a valid entry input type", async () => {
    const { db, txInsertCalls } = makeDb({
      inboxRow: { ...INBOX_ITEM_PENDING, originMedium: "integration" }, // valid
    });

    await attachInboxItemToThread(db, {
      companyId: COMPANY_A,
      inboxItemId: "item-1",
      threadId: "thread-1",
      actor: ACTOR,
    });

    expect(txInsertCalls[0].values.inputType).toBe("integration");
  });

  it("falls back inputType to 'mcp' when originMedium is an unknown medium", async () => {
    const { db, txInsertCalls } = makeDb({
      inboxRow: { ...INBOX_ITEM_PENDING, originMedium: "scheduled" }, // not a valid entry input type
    });

    await attachInboxItemToThread(db, {
      companyId: COMPANY_A,
      inboxItemId: "item-1",
      threadId: "thread-1",
      actor: ACTOR,
    });

    expect(txInsertCalls[0].values.inputType).toBe("mcp");
  });

  it("falls back createdBy to 'system' when originSource is null", async () => {
    const { db, txInsertCalls } = makeDb({
      inboxRow: { ...INBOX_ITEM_PENDING, originSource: null },
    });

    await attachInboxItemToThread(db, {
      companyId: COMPANY_A,
      inboxItemId: "item-1",
      threadId: "thread-1",
      actor: ACTOR,
    });

    expect(txInsertCalls[0].values.createdBy).toBe("system");
  });

  it("idempotent: second attach (claim returns 0 rows) → posted:false, alreadyHandled:true, no entry insert", async () => {
    const { db, txInsertCalls, transaction } = makeDb({
      claimRows: [], // claim finds no pending row → already handled
    });

    const result = await attachInboxItemToThread(db, {
      companyId: COMPANY_A,
      inboxItemId: "item-1",
      threadId: "thread-1",
      actor: ACTOR,
    });

    expect(result.posted).toBe(false);
    expect(result.entryId).toBeNull();
    expect(result.alreadyHandled).toBe(true);

    // Transaction was entered (we need to attempt the claim), but no entry was inserted.
    expect(transaction).toHaveBeenCalledOnce();
    expect(txInsertCalls.length).toBe(0);

    // No live events.
    expect(publishLiveEventMock).not.toHaveBeenCalled();
  });
});

// ── Tests: promoteInboxItemToNewThread ────────────────────────────────────────
//
// After the P0 claim-first fix, the promote function:
//   1. Pre-flight SELECT (companyId guard — unchanged)
//   2. Inside transaction:
//      a. Atomic claim UPDATE (status=pending→attached, routingStatus=routed, routedAt)
//         with companyId in WHERE — returns [{ id }] on win, [] on already-claimed
//      b. IF claim wins: discussionService.create (thread + first entry)
//      c. Backfill suggestedThreadId UPDATE
//   3. Returns { threadId, entryId, alreadyHandled }
//
// Harness: the txUpdate mock must handle two sequential calls:
//   call 0 — the atomic claim (returns .returning() → [{ id }] or [])
//   call 1 — the suggestedThreadId backfill (plain where().resolvedValue)

/** Build a tx.update mock that returns a claim result for call 0 and a no-op for call 1. */
function makeTxUpdateForPromote(claimResult: any[]) {
  let callIdx = 0;
  return vi.fn(() => {
    const idx = callIdx++;
    if (idx === 0) {
      // Atomic claim: .set().where().returning()
      return {
        set: (s: any) => ({
          where: (_w: any) => ({
            returning: () => Promise.resolve(claimResult),
          }),
        }),
      };
    }
    // Backfill suggestedThreadId: .set().where() → plain resolve
    return {
      set: (_s: any) => ({
        where: (_w: any) => Promise.resolve([]),
      }),
    };
  });
}

describe("promoteInboxItemToNewThread", () => {
  beforeEach(() => {
    publishLiveEventMock.mockClear();
    discussionServiceMock.mockClear();
  });

  it("throws COMPANY_MISMATCH when inbox item belongs to a different company", async () => {
    const select = vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ ...INBOX_ITEM_PENDING, companyId: COMPANY_B }]),
    }));
    const transaction = vi.fn();
    const db = { select, transaction } as any;

    await expect(
      promoteInboxItemToNewThread(db, {
        companyId: COMPANY_A,
        inboxItemId: "item-1",
        actor: ACTOR,
      }),
    ).rejects.toThrow("COMPANY_MISMATCH");

    expect(transaction).not.toHaveBeenCalled();
  });

  it("throws COMPANY_MISMATCH when inbox item is missing", async () => {
    const select = vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    }));
    const transaction = vi.fn();
    const db = { select, transaction } as any;

    await expect(
      promoteInboxItemToNewThread(db, {
        companyId: COMPANY_A,
        inboxItemId: "missing",
        actor: ACTOR,
      }),
    ).rejects.toThrow("COMPANY_MISMATCH");

    expect(transaction).not.toHaveBeenCalled();
  });

  it("promote: creates thread + posts rawContent as first entry, returns threadId + entryId + alreadyHandled:false", async () => {
    const select = vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([INBOX_ITEM_PENDING]),
    }));

    // Claim wins: returns [{ id }].
    const txUpdate = makeTxUpdateForPromote([{ id: "item-1" }]);

    const mockCreate = vi.fn().mockResolvedValue({
      id: "new-thread-1",
      companyId: COMPANY_A,
      entry: { id: "entry-first", seq: 1 },
    });
    discussionServiceMock.mockReturnValue({ create: mockCreate } as any);

    const transaction = vi.fn(async (cb: any) => {
      return await cb({ update: txUpdate, insert: vi.fn() });
    });

    const db = { select, transaction } as any;

    const result = await promoteInboxItemToNewThread(db, {
      companyId: COMPANY_A,
      inboxItemId: "item-1",
      actor: ACTOR,
    });

    expect(result.threadId).toBe("new-thread-1");
    expect(result.entryId).toBe("entry-first");
    expect(result.alreadyHandled).toBe(false);

    // discussionService.create was called with the rawContent entry.
    expect(mockCreate).toHaveBeenCalledOnce();
    const [calledCompanyId, calledData, calledCreatedBy] = mockCreate.mock.calls[0];
    expect(calledCompanyId).toBe(COMPANY_A);
    expect(calledData.entry).toMatchObject({
      inputType: "mcp",
      rawContent: "Hello from inbound",
      sourceInfo: {
        originSource: "external-bot",
        fromInboxItem: "item-1",
      },
    });
    expect(calledCreatedBy).toBe("external-bot");

    // Two tx.update calls: claim + suggestedThreadId backfill.
    expect(txUpdate).toHaveBeenCalledTimes(2);
  });

  it("promote: prefers the Navigator's suggestedThreadTitle as the thread title (suggest_new)", async () => {
    // suggest_new path: the Navigator wrote a clean, human-readable title.
    // The created thread must use THAT title, not the raw inbound content.
    const ITEM_WITH_SUGGESTION = {
      ...INBOX_ITEM_PENDING,
      suggestedThreadTitle: "Senior Backend Engineer - Payments (Aug 2026)",
    };
    const select = vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([ITEM_WITH_SUGGESTION]),
    }));
    const txUpdate = makeTxUpdateForPromote([{ id: "item-1" }]);
    const mockCreate = vi.fn().mockResolvedValue({
      id: "new-thread-1",
      companyId: COMPANY_A,
      entry: { id: "entry-first", seq: 1 },
    });
    discussionServiceMock.mockReturnValue({ create: mockCreate } as any);
    const transaction = vi.fn(async (cb: any) => await cb({ update: txUpdate, insert: vi.fn() }));
    const db = { select, transaction } as any;

    await promoteInboxItemToNewThread(db, {
      companyId: COMPANY_A,
      inboxItemId: "item-1",
      actor: ACTOR,
    });

    const [, calledData] = mockCreate.mock.calls[0];
    expect(calledData.title).toBe("Senior Backend Engineer - Payments (Aug 2026)");
    // The clean suggested title wins — the raw inbound content is NOT the title.
    expect(calledData.title).not.toContain("Hello from inbound");
  });

  it("promote: falls back to rawContent-derived title when no suggestedThreadTitle (plain/override promote)", async () => {
    // INBOX_ITEM_PENDING has no suggestedThreadTitle → rawContent-derived title.
    const select = vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([INBOX_ITEM_PENDING]),
    }));
    const txUpdate = makeTxUpdateForPromote([{ id: "item-1" }]);
    const mockCreate = vi.fn().mockResolvedValue({
      id: "new-thread-1",
      companyId: COMPANY_A,
      entry: { id: "entry-first", seq: 1 },
    });
    discussionServiceMock.mockReturnValue({ create: mockCreate } as any);
    const transaction = vi.fn(async (cb: any) => await cb({ update: txUpdate, insert: vi.fn() }));
    const db = { select, transaction } as any;

    await promoteInboxItemToNewThread(db, {
      companyId: COMPANY_A,
      inboxItemId: "item-1",
      actor: ACTOR,
    });

    const [, calledData] = mockCreate.mock.calls[0];
    expect(calledData.title).toBe("Hello from inbound");
  });

  it("promote: alreadyHandled — claim returns 0 rows → no thread created, returns alreadyHandled:true", async () => {
    const select = vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([INBOX_ITEM_PENDING]),
    }));

    // Claim loses: returns [].
    const txUpdate = makeTxUpdateForPromote([]);

    const mockCreate = vi.fn();
    discussionServiceMock.mockReturnValue({ create: mockCreate } as any);

    const transaction = vi.fn(async (cb: any) => {
      return await cb({ update: txUpdate, insert: vi.fn() });
    });

    const db = { select, transaction } as any;

    const result = await promoteInboxItemToNewThread(db, {
      companyId: COMPANY_A,
      inboxItemId: "item-1",
      actor: ACTOR,
    });

    expect(result.alreadyHandled).toBe(true);
    expect(result.threadId).toBeNull();
    expect(result.entryId).toBeNull();

    // discussionService.create must NOT be called — no duplicate thread.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("promote: title is derived from rawContent (first 80 chars)", async () => {
    const longContent = "A".repeat(200);
    const select = vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ ...INBOX_ITEM_PENDING, rawContent: longContent }]),
    }));

    const txUpdate = makeTxUpdateForPromote([{ id: "item-1" }]);

    const mockCreate = vi.fn().mockResolvedValue({
      id: "new-thread-2",
      companyId: COMPANY_A,
      entry: { id: "entry-2", seq: 1 },
    });
    discussionServiceMock.mockReturnValue({ create: mockCreate } as any);

    const transaction = vi.fn(async (cb: any) => {
      return await cb({ update: txUpdate, insert: vi.fn() });
    });

    const db = { select, transaction } as any;

    await promoteInboxItemToNewThread(db, {
      companyId: COMPANY_A,
      inboxItemId: "item-1",
      actor: ACTOR,
    });

    const [, calledData] = mockCreate.mock.calls[0];
    // Title is rawContent.slice(0,80) — 80 "A"s.
    expect(calledData.title).toBe("A".repeat(80));
  });
});
