import { describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
}));

vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return {
    agents: t("agents"),
    aoaAgentTriggers: t("aoaAgentTriggers"),
  };
});

import { assertCrewMemoryWrite } from "../services/internal-agent/aoa-agents/ensure-command-staff.js";

describe("crew memory write guard", () => {
  it("allows a pending proposal in any layer", () => {
    expect(() => assertCrewMemoryWrite({ layer: "domain", status: "pending" })).not.toThrow();
    expect(() => assertCrewMemoryWrite({ layer: "identity", status: "pending" })).not.toThrow();
  });
  it("rejects any non-pending crew memory write", () => {
    expect(() => assertCrewMemoryWrite({ layer: "working", status: "approved" })).toThrow(/propose/i);
    expect(() => assertCrewMemoryWrite({ layer: "domain", status: "approved" })).toThrow(/propose/i);
  });
});
