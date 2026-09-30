// ui/src/api/__tests__/agent-config-types.test.ts
import { describe, it, expect } from "vitest";
import type { AgentConfig } from "../internal-agent";
import type { UpdateInternalAgentConfig } from "@armyofagents/shared";

describe("UI config types carry crewModel", () => {
  it("AgentConfig (read type) has provider + crewModel", () => {
    const c: Pick<AgentConfig, "provider" | "crewModel"> = { provider: "openai", crewModel: "gpt-5.5" };
    expect(c.provider).toBe("openai");
    expect(c.crewModel).toBe("gpt-5.5");
  });
  it("UpdateInternalAgentConfig (write type) accepts crewModel", () => {
    const u: UpdateInternalAgentConfig = { provider: "opencode", crewModel: "openai/gpt-5.2-codex" };
    expect(u.crewModel).toBe("openai/gpt-5.2-codex");
  });
});
