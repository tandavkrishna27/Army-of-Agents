// server/src/__tests__/inbox-attach-to-thread.test.ts
//
// Task 1.8 — attach_to_thread dial-gate tests.
//
// Verifies that the routing dial (inboundRoutingLevel) drives behaviour:
//
//   'suggest'    → attachInboxItemToThread NOT called; db.update records
//                  routerDecision='suggest' + suggestedThreadId; status stays 'pending'.
//   'auto_attach'→ attachInboxItemToThread called once with correct args; returns entryId.
//   'full_auto'  → same as auto_attach (acts).
//   'off'        → also acts (dispatcher gates wakeups; explicit call is manual action).
//   suggest + cross-company item → COMPANY_MISMATCH, no update, shared service not called.
//   auto_attach + shared service throws COMPANY_MISMATCH → tool returns COMPANY_MISMATCH.
//   alreadyHandled → success with "already attached" summary.
//   INVALID_PARAMS on missing inboxItemId or threadId.
//   metadata contract unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks (must be hoisted before imports) ───────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ _op: "and", args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
}));

vi.mock("@armyofagents/db", () => ({
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
  internalAgentConfig: new Proxy({} as any, { get: (_t, p) => p }),
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
}));

const mockAttachInboxItemToThread = vi.fn();

vi.mock("../services/inbox-attach.js", () => ({
  attachInboxItemToThread: (...args: any[]) => mockAttachInboxItemToThread(...args),
}));

import { attachToThreadTool } from "../services/internal-agent/tools/inbox-attach-to-thread.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID = "co-aaaa-1111";
const INBOX_ITEM_ID = "item-bbbb-2222";
const THREAD_ID = "thread-cccc-3333";
const AGENT_ID = "agent-dddd-4444";

// ── DB builder ────────────────────────────────────────────────────────────────
//
// select() calls in the tool:
//   index 0 — internalAgentConfig (dial level)
//   index 1 — threadInboxItems (suggest path only: existence + companyId guard)
//
// update() captures set/where for assertion.

interface MakeDbOptions {
  /** inboundRoutingLevel returned by the config select. Default: 'off'. */
  dialLevel?: string;
  /** threadInboxItems rows for the suggest-path pre-flight. Default: same-company item. */
  inboxItemRows?: any[];
  /** discussions rows for the suggest-path thread company guard. Default: matching thread. */
  threadRows?: any[];
  /** Capture update set values. */
  onUpdateSet?: (vals: any) => void;
}

function makeDb(opts: MakeDbOptions = {}) {
  const {
    dialLevel = "off",
    inboxItemRows = [{ id: INBOX_ITEM_ID, companyId: COMPANY_ID }],
    threadRows = [{ id: THREAD_ID }],
    onUpdateSet,
  } = opts;

  // Three possible select results indexed by call order.
  const selectQueue: any[][] = [
    [{ level: dialLevel }],  // 0: internalAgentConfig
    inboxItemRows,            // 1: threadInboxItems (suggest path — item existence + company)
    threadRows,               // 2: discussions (suggest path — thread company guard)
  ];
  let selectCallIndex = 0;

  const makeSelectChain = (resultIndex: number) => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(selectQueue[resultIndex] ?? []),
  });

  const select = vi.fn(() => makeSelectChain(selectCallIndex++));

  // update chain — tracks the set payload.
  //
  // The act-path race-guard (Codex round-3 P1) issues an atomic escalated-claim
  // UPDATE … .where(…).returning({ id }) before delegating to the shared service.
  // The chain's where() therefore returns an object that is BOTH awaitable
  // (resolves to [] — the suggest path awaits it directly) AND exposes
  // .returning(). returning() resolves to a non-empty array so the guard treats
  // the claim as "succeeded" and falls straight through to the act path (these
  // dial-gate tests are not escalation-resolution scenarios).
  const capturedSets: any[] = [];
  const makeUpdateChain = () => {
    const chain: any = {};
    chain.set = vi.fn((vals: any) => {
      capturedSets.push(vals);
      if (onUpdateSet) onUpdateSet(vals);
      return chain;
    });
    chain.where = vi.fn(() => {
      const whereResult: any = Promise.resolve([]);
      whereResult.returning = vi.fn().mockResolvedValue([{ id: INBOX_ITEM_ID }]);
      return whereResult;
    });
    return chain;
  };
  const update = vi.fn(() => makeUpdateChain());

  return {
    db: { select, update } as any,
    capturedSets,
    updateFn: update,
  };
}

function makeCtx(db: any): ToolContext {
  return {
    companyId: COMPANY_ID,
    userId: "u-1111",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    agentId: AGENT_ID,
    db,
    services: {} as any,
  } as unknown as ToolContext;
}

// ── Reset mocks before each test ──────────────────────────────────────────────

beforeEach(() => {
  mockAttachInboxItemToThread.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("attach_to_thread tool (Task 1.8 — dial gate)", () => {
  // Metadata
  it("preserves name, category, requiredRole, requiresConfirmation contract", () => {
    expect(attachToThreadTool.name).toBe("attach_to_thread");
    expect(attachToThreadTool.category).toBe("action");
    expect(attachToThreadTool.requiredRole).toBe("team_member");
    expect(attachToThreadTool.requiresConfirmation).toBe(false);
  });

  // INVALID_PARAMS
  it("returns INVALID_PARAMS when inboxItemId is missing", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute({ threadId: THREAD_ID }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(mockAttachInboxItemToThread).not.toHaveBeenCalled();
  });

  it("returns INVALID_PARAMS when threadId is missing", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(mockAttachInboxItemToThread).not.toHaveBeenCalled();
  });

  // suggest path — happy
  it("suggest: records routerDecision without calling shared service", async () => {
    const { db, capturedSets, updateFn } = makeDb({ dialLevel: "suggest" });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: THREAD_ID },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).suggested).toBe(true);
    expect((result.data as any).suggestedThreadId).toBe(THREAD_ID);
    expect(result.summary).toContain("founder confirms");
    // Shared service NOT called.
    expect(mockAttachInboxItemToThread).not.toHaveBeenCalled();
    // update was called once with the suggestion fields.
    expect(updateFn).toHaveBeenCalledOnce();
    expect(capturedSets[0]).toMatchObject({
      routerDecision: "suggest",
      suggestedThreadId: THREAD_ID,
      routingStatus: "routed",
    });
    // 'status' must NOT be set to 'attached' — item stays pending for human confirm.
    expect(capturedSets[0].status).toBeUndefined();
  });

  // suggest path — L9 first-writer guard: item already finalized by reclaim sweep
  it("suggest + already finalized (0 rows updated): returns already_finalized, does NOT call shared service", async () => {
    // A stale Navigator suggest must not clobber an item the reclaim sweep already
    // finalized to the founder. The escalated-guarded UPDATE matches 0 rows.
    const selectQueue: any[][] = [
      [{ level: "suggest" }], // 0: dial
      [{ id: INBOX_ITEM_ID, companyId: COMPANY_ID }], // 1: item exists, same company
      [{ id: THREAD_ID }], // 2: thread exists in company
    ];
    let selectCallIndex = 0;
    const makeSelectChain = (resultIndex: number) => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(selectQueue[resultIndex] ?? []),
    });
    const selectFn = vi.fn(() => makeSelectChain(selectCallIndex++));
    // suggest update's .returning() resolves to [] → already finalized.
    const updateFn = vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
    }));
    const db = { select: selectFn, update: updateFn } as any;
    const ctx = makeCtx(db);

    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: THREAD_ID },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).action).toBe("already_finalized");
    expect((result.data as any).suggested).toBeUndefined();
    expect(mockAttachInboxItemToThread).not.toHaveBeenCalled();
    // The escalated-guarded suggest update was attempted exactly once.
    expect(updateFn).toHaveBeenCalledOnce();
  });

  // suggest path — cross-company item
  it("suggest + cross-company item: returns COMPANY_MISMATCH, no update", async () => {
    const { db, updateFn } = makeDb({
      dialLevel: "suggest",
      inboxItemRows: [{ id: INBOX_ITEM_ID, companyId: "co-different" }],
    });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: THREAD_ID },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("COMPANY_MISMATCH");
    expect(mockAttachInboxItemToThread).not.toHaveBeenCalled();
    expect(updateFn).not.toHaveBeenCalled();
  });

  // suggest path — item not found
  it("suggest + missing item: returns NOT_FOUND, no update", async () => {
    const { db, updateFn } = makeDb({
      dialLevel: "suggest",
      inboxItemRows: [],
    });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: THREAD_ID },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(mockAttachInboxItemToThread).not.toHaveBeenCalled();
    expect(updateFn).not.toHaveBeenCalled();
  });

  // suggest path — cross-company or nonexistent threadId (Fix 1)
  it("suggest + cross-company threadId: returns THREAD_NOT_FOUND, does NOT write suggestedThreadId", async () => {
    // Inbox item belongs to this company; thread select returns empty (cross-company or deleted)
    const { db, updateFn } = makeDb({
      dialLevel: "suggest",
      inboxItemRows: [{ id: INBOX_ITEM_ID, companyId: COMPANY_ID }],
      threadRows: [], // empty = thread not found in this company
    });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: "thread-other-company" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("THREAD_NOT_FOUND");
    expect(result.summary).toContain("not found in this company");
    // Must NOT have written suggestedThreadId
    expect(updateFn).not.toHaveBeenCalled();
    expect(mockAttachInboxItemToThread).not.toHaveBeenCalled();
  });

  it("suggest + nonexistent threadId (hallucinated): returns THREAD_NOT_FOUND, does NOT write suggestedThreadId", async () => {
    const { db, updateFn } = makeDb({
      dialLevel: "suggest",
      inboxItemRows: [{ id: INBOX_ITEM_ID, companyId: COMPANY_ID }],
      threadRows: [], // hallucinated id — not in DB at all
    });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: "thread-does-not-exist" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("THREAD_NOT_FOUND");
    expect(updateFn).not.toHaveBeenCalled();
    expect(mockAttachInboxItemToThread).not.toHaveBeenCalled();
  });

  // auto_attach — acts via shared service
  it("auto_attach: calls attachInboxItemToThread with correct args", async () => {
    mockAttachInboxItemToThread.mockResolvedValue({
      posted: true,
      entryId: "entry-xyz",
      alreadyHandled: false,
    });
    const { db, updateFn, capturedSets } = makeDb({ dialLevel: "auto_attach" });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: THREAD_ID },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).entryId).toBe("entry-xyz");
    expect((result.data as any).alreadyHandled).toBe(false);
    expect(result.summary).toContain("attached to thread");
    // Shared service called with correct shape.
    expect(mockAttachInboxItemToThread).toHaveBeenCalledOnce();
    const [_db, args] = mockAttachInboxItemToThread.mock.calls[0];
    expect(args.companyId).toBe(COMPANY_ID);
    expect(args.inboxItemId).toBe(INBOX_ITEM_ID);
    expect(args.threadId).toBe(THREAD_ID);
    expect(args.actor.actorType).toBe("agent");
    expect(args.actor.agentId).toBe(AGENT_ID);
    // The only local update is the race-guard's atomic escalated-claim
    // (Codex round-3 P1); the shared service still owns the actual entry write.
    expect(updateFn).toHaveBeenCalledOnce();
    expect(capturedSets[0]).toEqual({ routingStatus: "routing" });
  });

  // full_auto — same as auto_attach
  it("full_auto: acts via shared service (same as auto_attach)", async () => {
    mockAttachInboxItemToThread.mockResolvedValue({
      posted: true,
      entryId: "entry-full-auto",
      alreadyHandled: false,
    });
    const { db } = makeDb({ dialLevel: "full_auto" });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: THREAD_ID },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockAttachInboxItemToThread).toHaveBeenCalledOnce();
  });

  // off — also acts
  it("off: acts via shared service (explicit call is a manual/direct action)", async () => {
    mockAttachInboxItemToThread.mockResolvedValue({
      posted: true,
      entryId: "entry-off-path",
      alreadyHandled: false,
    });
    const { db } = makeDb({ dialLevel: "off" });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: THREAD_ID },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockAttachInboxItemToThread).toHaveBeenCalledOnce();
  });

  // default dial (cfg row absent)
  it("missing config row defaults to 'off' and acts", async () => {
    // Simulate no config row by overriding the first select to return [].
    // We do this by patching dialLevel to a sentinel, then overriding the queue.
    // Easier: build a custom db with empty config row.
    const selectQueue: any[][] = [[], [{ id: INBOX_ITEM_ID, companyId: COMPANY_ID }]];
    let selectCallIndex = 0;
    const makeSelectChain = (resultIndex: number) => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(selectQueue[resultIndex] ?? []),
    });
    const selectFn = vi.fn(() => makeSelectChain(selectCallIndex++));
    // update chain must support the act-path race-guard's
    // .set().where().returning() (see makeDb's makeUpdateChain note).
    const updateFn = vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn(() => {
        const whereResult: any = Promise.resolve([]);
        whereResult.returning = vi.fn().mockResolvedValue([{ id: INBOX_ITEM_ID }]);
        return whereResult;
      }),
    }));
    const db = { select: selectFn, update: updateFn } as any;

    mockAttachInboxItemToThread.mockResolvedValue({
      posted: true,
      entryId: "entry-default",
      alreadyHandled: false,
    });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: THREAD_ID },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockAttachInboxItemToThread).toHaveBeenCalledOnce();
  });

  // auto_attach + shared service throws COMPANY_MISMATCH
  it("auto_attach + shared service COMPANY_MISMATCH → tool returns COMPANY_MISMATCH", async () => {
    mockAttachInboxItemToThread.mockRejectedValue(
      new Error("COMPANY_MISMATCH: inbox item belongs to a different company"),
    );
    const { db } = makeDb({ dialLevel: "auto_attach" });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: THREAD_ID },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("COMPANY_MISMATCH");
    expect(result.summary).toContain("different company");
  });

  // alreadyHandled — idempotent
  it("alreadyHandled: returns success with 'already attached' summary", async () => {
    mockAttachInboxItemToThread.mockResolvedValue({
      posted: false,
      entryId: null,
      alreadyHandled: true,
    });
    const { db } = makeDb({ dialLevel: "auto_attach" });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: THREAD_ID },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).alreadyHandled).toBe(true);
    expect(result.summary).toContain("already attached");
  });

  // Generic failure from shared service
  it("shared service generic error → TRANSACTION_FAILED with message", async () => {
    mockAttachInboxItemToThread.mockRejectedValue(
      new Error("connection timeout"),
    );
    const { db } = makeDb({ dialLevel: "auto_attach" });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, threadId: THREAD_ID },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("TRANSACTION_FAILED");
    expect(result.summary).toContain("connection timeout");
  });
});
