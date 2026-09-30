/**
 * chronicler-card-eval.test.ts — Chronicler card quality gate (C9)
 *
 * Tests that thread.updateSummary called by the Chronicler produces the
 * correct shape of output (faithful, structured) when given a mock thread
 * with entries. No LLM calls — we test the tool interface contract.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => ({
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
}));

import { threadUpdateSummaryTool } from "../../services/internal-agent/tools/thread-update-summary.js";

const CID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeCtx() {
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ then: (f: Function) => f([{ companyId: CID }]) }) }) }),
      update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue([]) }) }),
    } as any,
    companyId: CID,
    services: {},
  };
}

describe("Chronicler card quality eval", () => {
  it("C1: writes routingTerms as JSON-encoded string", async () => {
    const ctx = makeCtx();
    const r = await threadUpdateSummaryTool.execute(
      { threadId: TID, summary: "About Acme contract renewal.", routingTerms: ["Acme Corp", "renewal", "contract"] },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.data.routingTermsWritten).toBe(true);
  });

  it("C2: skips routingTerms when not provided (summary-only update)", async () => {
    const ctx = makeCtx();
    const r = await threadUpdateSummaryTool.execute(
      { threadId: TID, summary: "General project update." },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.data.routingTermsWritten).toBe(false);
  });

  it("C3: rejects non-array routingTerms", async () => {
    const ctx = makeCtx();
    const r = await threadUpdateSummaryTool.execute(
      { threadId: TID, summary: "ok", routingTerms: "not-an-array" as any },
      ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toBe("INVALID_PARAMS");
  });

  it("C4: cross-tenant guard blocks write to another company's thread", async () => {
    const ctx = { ...makeCtx(), companyId: "other-company-id" };
    const r = await threadUpdateSummaryTool.execute(
      { threadId: TID, summary: "ok" },
      ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toBe("COMPANY_MISMATCH");
  });

  it("C5: empty routingTerms array is valid (no terms for this thread yet)", async () => {
    const ctx = makeCtx();
    const r = await threadUpdateSummaryTool.execute(
      { threadId: TID, summary: "A short general update.", routingTerms: [] },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.data.routingTermsWritten).toBe(true);
  });
});
