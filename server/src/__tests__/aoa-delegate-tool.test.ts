import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

vi.mock("@armyofagents/db", () => {
  const t = (n: string) => new Proxy({}, { get: (_x, p) => typeof p === "string" ? Symbol(`${n}.${p}`) : undefined });
  return { agents: t("a"), agentWakeupRequests: t("awr") };
});

import { delegateToSubagentTool } from "../services/internal-agent/tools/delegate-to-subagent.js";

describe("aoa-delegate-tool", () => {
  it("requires confirmation before delegating work to another AoA agent", () => {
    expect(delegateToSubagentTool.requiresConfirmation).toBe(true);
  });

  it("resolves target by name and enqueues a wakeup with the instruction", async () => {
    const insertedValues: any[] = [];
    const db: any = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: "sub-1" }]),
        }),
      }),
      insert: () => ({
        values: (v: any) => {
          insertedValues.push(v);
          return Promise.resolve([]);
        },
      }),
    };

    const res = await delegateToSubagentTool.execute(
      { agentName: "Discussion Extraction", instruction: "process entry e1" },
      { db, companyId: "co-1" } as any,
    );

    expect(res.success).toBe(true);
    expect(insertedValues[0].agentId).toBe("sub-1");
    expect(insertedValues[0].source).toBe("aoa.delegate");
    expect(insertedValues[0].payload).toEqual({ instruction: "process entry e1" });
    expect(insertedValues[0].status).toBe("queued");
  });

  it("returns failure when no AoA agent matches the name", async () => {
    const db: any = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]), // not found
        }),
      }),
    };

    const res = await delegateToSubagentTool.execute(
      { agentName: "NonExistent", instruction: "do something" },
      { db, companyId: "co-1" } as any,
    );

    expect(res.success).toBe(false);
    expect(res.error).toBe("no such AoA agent");
  });
});
