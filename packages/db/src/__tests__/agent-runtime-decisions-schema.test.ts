import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentRuntimeDecisions } from "../schema/agent_runtime_decisions.js";

describe("agent_runtime_decisions schema", () => {
  it("has a (status, expires_at) index for the global timeout sweep", () => {
    const cfg = getTableConfig(agentRuntimeDecisions);
    const names = cfg.indexes.map((i) => i.config.name);
    expect(names).toContain("agent_runtime_decisions_status_expiry_idx");
  });
});
