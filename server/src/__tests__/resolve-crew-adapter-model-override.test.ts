// server/src/__tests__/resolve-crew-adapter-model-override.test.ts
import { describe, it, expect } from "vitest";
import { resolveCrewAdapterFor } from "../services/internal-agent/aoa-agents/resolve-crew-adapter.js";
import { DEFAULT_CODEX_CHAT_MODEL } from "../services/internal-agent/codex-model.js";

describe("resolveCrewAdapterFor model override", () => {
  it("applies a shell-safe claude override for anthropic", () => {
    expect(resolveCrewAdapterFor("anthropic", "claude-opus-4-1").adapterConfig.model).toBe("claude-opus-4-1");
  });
  it("falls back to the anthropic default for a shell-UNSAFE override", () => {
    expect(resolveCrewAdapterFor("anthropic", "evil; rm -rf").adapterConfig.model).toBe("claude-sonnet-4-5-20250929");
  });
  it("applies a codex-compatible override for openai", () => {
    expect(resolveCrewAdapterFor("openai", "gpt-5.5").adapterConfig.model).toBe("gpt-5.5");
  });
  it("rejects a codex-INCOMPATIBLE override → openai default", () => {
    // NOTE (review P0-3): isCodexCompatibleModel ACCEPTS gpt-4o (gpt-family, no
    // "codex"). Genuinely-incompatible = a *-codex id or a non-OpenAI family model.
    expect(resolveCrewAdapterFor("openai", "gpt-5.2-codex").adapterConfig.model).toBe(DEFAULT_CODEX_CHAT_MODEL);
    expect(resolveCrewAdapterFor("openai", "claude-sonnet-4-5").adapterConfig.model).toBe(DEFAULT_CODEX_CHAT_MODEL);
  });
  it("requires slash form for opencode override; bare → default", () => {
    expect(resolveCrewAdapterFor("opencode", "anthropic/claude-sonnet-4").adapterConfig.model).toBe("anthropic/claude-sonnet-4");
    expect(resolveCrewAdapterFor("opencode", "gpt-5.5").adapterConfig.model).toBe("openai/gpt-5.2-codex");
  });
  it("applies a shell-safe gemini override for google", () => {
    expect(resolveCrewAdapterFor("google", "gemini-2.0-flash").adapterConfig.model).toBe("gemini-2.0-flash");
  });
  it("no override → unchanged per-provider defaults", () => {
    expect(resolveCrewAdapterFor("anthropic").adapterConfig.model).toBe("claude-sonnet-4-5-20250929");
    expect(resolveCrewAdapterFor("google").adapterConfig.model).toBe("gemini-2.5-pro");
  });
});
