// server/src/__tests__/resolve-commander-adapter.test.ts
import { describe, it, expect } from "vitest";
import { resolveCommanderAdapterFor } from "../services/internal-agent/aoa-agents/resolve-crew-adapter.js";

describe("resolveCommanderAdapterFor (keyed on cliTool, not provider)", () => {
  it("claude_cli / null → claude_local", () => {
    expect(resolveCommanderAdapterFor("claude_cli", null).adapterType).toBe("claude_local");
    expect(resolveCommanderAdapterFor(null, null).adapterType).toBe("claude_local");
  });
  it("codex → codex_local", () => {
    expect(resolveCommanderAdapterFor("codex", null).adapterType).toBe("codex_local");
  });
  it("honors a valid Commander model override per cliTool", () => {
    expect(resolveCommanderAdapterFor("codex", "gpt-5.5").adapterConfig.model).toBe("gpt-5.5");
    expect(resolveCommanderAdapterFor("claude_cli", "claude-opus-4-1").adapterConfig.model).toBe("claude-opus-4-1");
  });
  it("rejects a cliTool-incompatible model → per-CLI default", () => {
    // claude default model survives validation only on claude; on codex it's rejected.
    expect(resolveCommanderAdapterFor("codex", "claude-sonnet-4-6").adapterConfig.model).not.toBe("claude-sonnet-4-6");
  });
});
