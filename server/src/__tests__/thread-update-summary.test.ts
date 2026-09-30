import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
  internalAgentConfig: new Proxy({} as any, { get: (_t, p) => p }),
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
}));
const mockLogActivity = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity-log.js", () => ({
  logActivity: (...a: any[]) => mockLogActivity(...a),
}));

import { threadUpdateSummaryTool } from "../services/internal-agent/tools/thread-update-summary.js";

const COMPANY_ID = "aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID = "bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb";

function makeCtx(opts: { agentId?: string } = {}) {
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ then: (f: Function) => f([{ companyId: COMPANY_ID }]) }) }) }),
      update: () => ({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) }),
    } as any,
    companyId: COMPANY_ID,
    agentId: opts.agentId,
    services: {},
  };
}

describe("thread.updateSummary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes routingTerms to the row when provided", async () => {
    const ctx = makeCtx();
    const result = await threadUpdateSummaryTool.execute(
      { threadId: THREAD_ID, summary: "Acme renewal discussion", routingTerms: ["Acme Corp", "renewal"] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ threadId: THREAD_ID, routingTermsWritten: true });
  });

  it("skips routingTerms write when param is absent", async () => {
    const ctx = makeCtx();
    const result = await threadUpdateSummaryTool.execute(
      { threadId: THREAD_ID, summary: "A simple summary" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ threadId: THREAD_ID, routingTermsWritten: false });
  });

  it("returns error when routingTerms is not an array", async () => {
    const ctx = makeCtx();
    const result = await threadUpdateSummaryTool.execute(
      { threadId: THREAD_ID, summary: "ok", routingTerms: "not-an-array" as any },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("returns error when routingTerms contains a non-string element", async () => {
    const ctx = makeCtx();
    const result = await threadUpdateSummaryTool.execute(
      { threadId: THREAD_ID, summary: "ok", routingTerms: ["valid", 42] as any },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("logs an activity entry with the agent actor (C6 audit)", async () => {
    const ctx = makeCtx({ agentId: "agent-chronicler-1" });
    await threadUpdateSummaryTool.execute({ threadId: THREAD_ID, summary: "ok" }, ctx);
    expect(mockLogActivity).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({
        action: "thread.summary.updated",
        actorType: "agent",
        actorId: "agent-chronicler-1",
        entityId: THREAD_ID,
      }),
    );
  });
});
