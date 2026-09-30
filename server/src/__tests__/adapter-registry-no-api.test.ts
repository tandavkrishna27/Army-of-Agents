import { describe, it, expect } from "vitest";
import { AGENT_ADAPTER_TYPES } from "@armyofagents/shared";
import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";

// Regression guard for Sprint 2A: ensures the three API adapters stay removed.
// See docs/superpowers/specs/2026-04-24-sprint-2a-drop-api-adapters-design.md
describe("adapter registry after Sprint 2A", () => {
  it("AGENT_ADAPTER_TYPES does not include claude_api / openai_api / gemini_api", () => {
    expect(AGENT_ADAPTER_TYPES).not.toContain("claude_api");
    expect(AGENT_ADAPTER_TYPES).not.toContain("openai_api");
    expect(AGENT_ADAPTER_TYPES).not.toContain("gemini_api");
  });

  // The shared list and the server set must stay identical, not merely overlap.
  // packages/shared's provider-catalog test derives its completeness check from
  // AGENT_ADAPTER_TYPES; if an adapter lands in only one of these two lists that
  // check goes blind. Membership assertions below cannot catch that — this can.
  it("AGENT_ADAPTER_TYPES and BUILTIN_ADAPTER_TYPES describe the same adapter set", () => {
    expect([...AGENT_ADAPTER_TYPES].sort()).toEqual([...BUILTIN_ADAPTER_TYPES].sort());
  });

  it("BUILTIN_ADAPTER_TYPES set does not include API adapters", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("claude_api")).toBe(false);
    expect(BUILTIN_ADAPTER_TYPES.has("openai_api")).toBe(false);
    expect(BUILTIN_ADAPTER_TYPES.has("gemini_api")).toBe(false);
  });

  it("still includes expected CLI adapters (regression guard)", () => {
    expect(AGENT_ADAPTER_TYPES).toContain("claude_local");
    expect(AGENT_ADAPTER_TYPES).toContain("acpx_local");
    expect(AGENT_ADAPTER_TYPES).toContain("codex_local");
    expect(AGENT_ADAPTER_TYPES).toContain("opencode_local");
    expect(AGENT_ADAPTER_TYPES).toContain("openclaw");
    expect(AGENT_ADAPTER_TYPES).toContain("cursor");
    expect(AGENT_ADAPTER_TYPES).toContain("cursor_cloud");
    expect(AGENT_ADAPTER_TYPES).toContain("hermes_local");
    expect(AGENT_ADAPTER_TYPES).toContain("gemini_local");
    expect(AGENT_ADAPTER_TYPES).toContain("grok_local");
    expect(AGENT_ADAPTER_TYPES).toContain("pi_local");
    expect(AGENT_ADAPTER_TYPES).toContain("openclaw_gateway");
    expect(BUILTIN_ADAPTER_TYPES.has("claude_local")).toBe(true);
    expect(BUILTIN_ADAPTER_TYPES.has("acpx_local")).toBe(true);
    expect(BUILTIN_ADAPTER_TYPES.has("codex_local")).toBe(true);
    expect(BUILTIN_ADAPTER_TYPES.has("openclaw")).toBe(true);
    expect(BUILTIN_ADAPTER_TYPES.has("cursor_cloud")).toBe(true);
    expect(BUILTIN_ADAPTER_TYPES.has("grok_local")).toBe(true);
    expect(BUILTIN_ADAPTER_TYPES.has("pi_local")).toBe(true);
    expect(BUILTIN_ADAPTER_TYPES.has("openclaw_gateway")).toBe(true);
  });
});
