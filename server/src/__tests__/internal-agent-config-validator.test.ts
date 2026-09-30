// server/src/__tests__/internal-agent-config-validator.test.ts
import { describe, it, expect } from "vitest";
import { updateInternalAgentConfigSchema } from "@armyofagents/shared";

describe("updateInternalAgentConfigSchema", () => {
  it("accepts provider=opencode", () => {
    const r = updateInternalAgentConfigSchema.safeParse({ provider: "opencode" });
    expect(r.success).toBe(true);
    expect(r.data?.provider).toBe("opencode");
  });
  it("accepts a crewModel string and carries it through (not stripped)", () => {
    const r = updateInternalAgentConfigSchema.safeParse({ crewModel: "openai/gpt-5.2-codex" });
    expect(r.success).toBe(true);
    // Genuine red→green: before crewModel is added to the schema, Zod strips the
    // unknown key so r.data.crewModel is undefined. Assert presence, not just success.
    expect(r.data?.crewModel).toBe("openai/gpt-5.2-codex");
  });
  it("accepts null crewModel (clear override)", () => {
    const r = updateInternalAgentConfigSchema.safeParse({ crewModel: null });
    expect(r.success).toBe(true);
    expect(r.data).toHaveProperty("crewModel", null);
  });
  it("rejects an unknown provider", () => {
    const r = updateInternalAgentConfigSchema.safeParse({ provider: "mistral" });
    expect(r.success).toBe(false);
  });
});
