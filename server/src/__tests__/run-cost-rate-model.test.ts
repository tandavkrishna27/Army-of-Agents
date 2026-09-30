import { describe, it, expect } from "vitest";
import { rateModelForCliTool } from "../services/internal-agent/run-cost.js";

describe("rateModelForCliTool", () => {
  it("opencode is priced as openai, not anthropic", () => {
    const r = rateModelForCliTool("opencode", null);
    expect(r.provider).toBe("openai");
  });
  it("codex stays openai", () => {
    expect(rateModelForCliTool("codex", null).provider).toBe("openai");
  });
  it("claude_cli stays anthropic and honors a configured model", () => {
    expect(rateModelForCliTool("claude_cli", "claude-opus-4-1")).toEqual({ provider: "anthropic", model: "claude-opus-4-1" });
  });
});
