import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => ({
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  sql: Object.assign(vi.fn((s: TemplateStringsArray, ...v: unknown[]) => ({ _sql: s, v })), {
    raw: vi.fn((s: string) => ({ _raw: s })),
  }),
  isNotNull: vi.fn((a: unknown) => ({ _op: "isNotNull", a })),
}));

import { listThreadCardsTool } from "../services/internal-agent/tools/list-thread-cards.js";

const COMPANY_ID = "aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa";

function makeCtx(threadRows: Array<{ id: string; title: string | null; summaryText: string | null; routingTerms: string[] | null }>) {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(threadRows),
          }),
        }),
      }),
    } as any,
    companyId: COMPANY_ID,
    services: {},
  };
}

describe("list_thread_cards", () => {
  it("returns all active thread cards for small scale", async () => {
    const rows = [
      { id: "t1", title: "Acme renewal", summaryText: "About the Acme renewal deal", routingTerms: ["Acme Corp", "renewal"] },
      { id: "t2", title: "Infra upgrade", summaryText: "Server migration discussion", routingTerms: null },
    ];
    const ctx = makeCtx(rows);
    const result = await listThreadCardsTool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      threadId: "t1",
      title: "Acme renewal",
      summaryText: "About the Acme renewal deal",
      routingTerms: ["Acme Corp", "renewal"],
    });
    expect(result.data[1]).toMatchObject({ threadId: "t2", routingTerms: [] });
  });

  it("returns empty array when no active threads", async () => {
    const ctx = makeCtx([]);
    const result = await listThreadCardsTool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });
});
