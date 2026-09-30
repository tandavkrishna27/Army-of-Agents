// server/src/__tests__/provider-resolution-precedence.test.ts
import { describe, it, expect } from "vitest";
import { orderCandidates, type Candidate } from "../services/provider-resolution.js";

const c = (over: Partial<Candidate>): Candidate => ({
  connectionId: "x", authMethod: "api_key", scopeType: "company_default",
  priority: 0, connectionUpdatedAt: 0, ...over,
});

describe("orderCandidates", () => {
  it("agent_override > personal_execution_default > company_default > org_default", () => {
    const ordered = orderCandidates([
      c({ connectionId: "org", scopeType: "org_default" }),
      c({ connectionId: "co", scopeType: "company_default" }),
      c({ connectionId: "ped", scopeType: "personal_execution_default" }),
      c({ connectionId: "ag", scopeType: "agent_override" }),
    ]);
    expect(ordered.map((x) => x.connectionId)).toEqual(["ag", "ped", "co", "org"]);
  });

  it("breaks ties by priority DESC then updatedAt DESC", () => {
    const ordered = orderCandidates([
      c({ connectionId: "lo", scopeType: "company_default", priority: 1, connectionUpdatedAt: 100 }),
      c({ connectionId: "hi", scopeType: "company_default", priority: 5, connectionUpdatedAt: 1 }),
      c({ connectionId: "new", scopeType: "company_default", priority: 5, connectionUpdatedAt: 999 }),
    ]);
    expect(ordered.map((x) => x.connectionId)).toEqual(["new", "hi", "lo"]);
  });
});
