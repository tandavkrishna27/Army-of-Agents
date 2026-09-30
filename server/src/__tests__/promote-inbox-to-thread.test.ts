import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  internalAgentConfig: new Proxy({} as any, { get: (_t, p) => p }),
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
}));

const mockPromote = vi.fn();
vi.mock("../services/inbox-attach.js", () => ({
  promoteInboxItemToNewThread: (...args: any[]) => mockPromote(...args),
}));

import { promoteInboxToThreadTool } from "../services/internal-agent/tools/promote-inbox-to-thread.js";

const COMPANY_ID = "aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa";
const INBOX_ITEM_ID = "bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb";

// Sequence-based select mock: 1st select → inbox-item existence row (companyId),
// 2nd select → dial. itemCompanyId controls the cross-tenant guard.
// claimRows controls the escalated-guard UPDATE...returning() result:
// [{id}] = still escalated (proceeds), [] = already finalized (no-op).
function makeCtx(dial: string, itemCompanyId: string | null = COMPANY_ID, claimRows: object[] = [{ id: INBOX_ITEM_ID }]) {
  const selectResults: object[][] = [
    itemCompanyId === null ? [] : [{ companyId: itemCompanyId }],
    [{ inboundRoutingLevel: dial }],
  ];
  let call = 0;
  // Capture the payload passed to the claim/record UPDATE...set() so tests can
  // assert what gets persisted (e.g. suggestedThreadTitle on the full_auto claim).
  const setSpy = vi.fn(() => ({ where: () => ({ returning: () => Promise.resolve(claimRows) }) }));
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(selectResults[call++] ?? []),
          }),
        }),
      }),
      update: () => ({ set: setSpy }),
    } as any,
    companyId: COMPANY_ID,
    services: {},
    _setSpy: setSpy,
  };
}

describe("promote_inbox_to_thread", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-creates thread at full_auto", async () => {
    mockPromote.mockResolvedValue({ threadId: "new-thread-id", entryId: "e1", alreadyHandled: false });
    const ctx = makeCtx("full_auto");
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(true);
    expect(result.data.action).toBe("created");
    expect(result.data.threadId).toBe("new-thread-id");
    expect(mockPromote).toHaveBeenCalledWith(ctx.db, expect.objectContaining({ inboxItemId: INBOX_ITEM_ID, companyId: COMPANY_ID }));
  });

  it("full_auto persists the Navigator's proposedTitle as suggestedThreadTitle on the claim", async () => {
    // The auto-create path must title the new thread with the Navigator's clean
    // proposed title (via suggestedThreadTitle on the row, which
    // promoteInboxItemToNewThread reads) — NOT the raw inbound content.
    mockPromote.mockResolvedValue({ threadId: "t1", entryId: "e1", alreadyHandled: false });
    const ctx = makeCtx("full_auto");
    await promoteInboxToThreadTool.execute(
      { inboxItemId: INBOX_ITEM_ID, proposedTitle: "Checkout 500s incident" },
      ctx,
    );
    expect((ctx as any)._setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        routingStatus: "routing",
        suggestedThreadTitle: "Checkout 500s incident",
      }),
    );
  });

  it("records suggest_new at auto_attach dial (does NOT create)", async () => {
    const ctx = makeCtx("auto_attach");
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID, proposedTitle: "Acme renewal" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data.action).toBe("suggest_new");
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("records suggest_new at suggest dial", async () => {
    const ctx = makeCtx("suggest");
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID, proposedTitle: "New topic" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data.action).toBe("suggest_new");
  });

  it("returns error when inboxItemId is missing", async () => {
    const ctx = makeCtx("full_auto");
    const result = await promoteInboxToThreadTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("rejects an item that belongs to another company (Codex P1 #6)", async () => {
    const ctx = makeCtx("full_auto", "some-other-company");
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("COMPANY_MISMATCH");
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("returns ITEM_NOT_FOUND when the inbox item does not exist", async () => {
    const ctx = makeCtx("full_auto", null);
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("ITEM_NOT_FOUND");
  });

  it("no-ops when item already finalized (escalated-guard claim returns 0 rows)", async () => {
    // claimRows=[] → the escalated-guard UPDATE matched nothing (sweep finalized first).
    const ctx = makeCtx("full_auto", COMPANY_ID, []);
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(true);
    expect(result.data.action).toBe("already_finalized");
    expect(mockPromote).not.toHaveBeenCalled();
  });
});
