import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => ({
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
}));

import { deferInboxToHumanTool } from "../services/internal-agent/tools/defer-inbox-to-human.js";

const COMPANY_ID = "aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa";
const INBOX_ITEM_ID = "bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb";

// claimRows controls the escalated-guard UPDATE...returning():
// [{id}] = still escalated (finalizes), [] = already finalized (no-op).
function makeCtx(itemCompanyId: string | null = COMPANY_ID, claimRows: object[] = [{ id: INBOX_ITEM_ID }]) {
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: () =>
        Promise.resolve(itemCompanyId === null ? [] : [{ companyId: itemCompanyId }]) }) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(claimRows) }) }) }),
    } as any,
    companyId: COMPANY_ID,
    services: {},
  };
}

describe("defer_inbox_to_human", () => {
  it("finalizes the item to routed + human", async () => {
    const ctx = makeCtx();
    const result = await deferInboxToHumanTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ action: "deferred_to_human" });
  });

  it("no-ops when item already finalized (escalated-guard returns 0 rows)", async () => {
    const ctx = makeCtx(COMPANY_ID, []);
    const result = await deferInboxToHumanTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ action: "already_finalized" });
  });

  it("rejects an item from another company", async () => {
    const ctx = makeCtx("other-company");
    const result = await deferInboxToHumanTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("COMPANY_MISMATCH");
  });

  it("returns ITEM_NOT_FOUND for a missing item", async () => {
    const ctx = makeCtx(null);
    const result = await deferInboxToHumanTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("ITEM_NOT_FOUND");
  });

  it("requires inboxItemId", async () => {
    const ctx = makeCtx();
    const result = await deferInboxToHumanTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });
});
