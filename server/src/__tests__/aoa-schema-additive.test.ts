import { describe, expect, it } from "vitest";
import { aoaAgentTriggers } from "@armyofagents/db";
describe("aoa_agent_triggers schema", () => {
  it("has the expected columns", () => {
    const cols = Object.keys(aoaAgentTriggers);
    for (const c of ["id","companyId","agentId","kind","enabled","config","createdAt","updatedAt"]) expect(cols).toContain(c);
  });
  it("internal_agent_config + internal_agent_runs expose agentId", async () => {
    const { internalAgentConfig, internalAgentRuns } = await import("@armyofagents/db");
    expect(Object.keys(internalAgentConfig)).toContain("agentId");
    expect(Object.keys(internalAgentRuns)).toContain("agentId");
  });
});
