// T2.0 — resolveCrewAdapterFor must map provider='opencode' to the
// opencode_local CLI adapter. Pre-T2.0 the resolver fell through unknown
// providers to the codex_local default, so a company configured with
// provider='opencode' would get codex agents — silently wrong CLI, wrong
// model, wrong MCP wiring path. T2.0 adds the explicit branch.
//
// Companion to resolve-crew-adapter.ts (pure function, no DB). The DB-
// reading wrapper `resolveCrewAdapterForCompany` is tested elsewhere.

import { describe, expect, it } from "vitest";
import { resolveCrewAdapterFor } from "../services/internal-agent/aoa-agents/resolve-crew-adapter.js";

describe("resolveCrewAdapterFor — opencode (T2.0)", () => {
  it("provider='opencode' → opencode_local adapter", () => {
    const adapter = resolveCrewAdapterFor("opencode");
    expect(adapter.adapterType).toBe("opencode_local");
  });

  it("opencode adapterConfig includes a model so the CLI has something to invoke", () => {
    // The model name is a teaching default — operators can override per-agent
    // via adapterConfig.model on the agent row. The resolver must NOT return
    // an empty object (the opencode CLI requires --model or it errors out
    // before even reaching the MCP bridge).
    const adapter = resolveCrewAdapterFor("opencode");
    expect(typeof adapter.adapterConfig.model).toBe("string");
    expect((adapter.adapterConfig.model as string).length).toBeGreaterThan(0);
  });

  it("opencode is distinct from openai (which still maps to codex_local)", () => {
    // Defense: provider='openai' uses codex CLI; provider='opencode' uses
    // opencode CLI. These two strings differ by one letter; a regression
    // could silently route opencode to codex via a missing-case fall-through.
    const codex = resolveCrewAdapterFor("openai");
    const opencode = resolveCrewAdapterFor("opencode");
    expect(codex.adapterType).toBe("codex_local");
    expect(opencode.adapterType).toBe("opencode_local");
    expect(codex.adapterType).not.toBe(opencode.adapterType);
  });

  it("preserves existing branches: anthropic → claude_local, google → gemini_local", () => {
    expect(resolveCrewAdapterFor("anthropic").adapterType).toBe("claude_local");
    expect(resolveCrewAdapterFor("google").adapterType).toBe("gemini_local");
  });

  it("unknown provider still falls back to codex_local (existing default)", () => {
    // T2.0 must not change the fallback behavior for unrecognized providers.
    // The default is codex_local because OpenAI/Codex is AoA's lowest-cost
    // production option; bad config falls into the cheapest CLI, not a
    // potentially expensive one. Plus the fall-through ensures companies
    // mid-migration (provider not yet populated) still get a working crew.
    const adapter = resolveCrewAdapterFor("totally_made_up_provider");
    expect(adapter.adapterType).toBe("codex_local");
  });
});
