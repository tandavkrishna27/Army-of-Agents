import { describe, it, expect } from "vitest";
import { createAgentSchema, createAgentHireSchema, updateAgentSchema, adapterModelFamilyMismatch, isShellSafeModelId } from "./agent.js";

describe("agent schema adapter↔model cross-family + shell-safety", () => {
  it("rejects claude_local + a gpt model (cross-family)", () => {
    expect(
      createAgentSchema.safeParse({
        name: "x",
        adapterType: "claude_local",
        adapterConfig: { model: "gpt-5.5" },
      }).success,
    ).toBe(false);
  });

  it("rejects codex_local + a claude model", () => {
    expect(
      updateAgentSchema.safeParse({
        adapterType: "codex_local",
        adapterConfig: { model: "claude-sonnet-4-5-20250929" },
      }).success,
    ).toBe(false);
  });

  it("rejects a shell-unsafe model", () => {
    expect(
      updateAgentSchema.safeParse({
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5 && rm" },
      }).success,
    ).toBe(false);
  });

  it("allows opencode_local + openai/<model> slash format", () => {
    expect(
      updateAgentSchema.safeParse({
        adapterType: "opencode_local",
        adapterConfig: { model: "openai/gpt-5.2-codex" },
      }).success,
    ).toBe(true);
  });

  it("allows gemini_local + 'auto' and an unknown-but-safe model", () => {
    expect(
      updateAgentSchema.safeParse({
        adapterType: "gemini_local",
        adapterConfig: { model: "auto" },
      }).success,
    ).toBe(true);
    expect(
      updateAgentSchema.safeParse({
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.6" },
      }).success,
    ).toBe(true);
  });

  it("rejects claude_local + a gpt model via createAgentHireSchema (hire path)", () => {
    expect(createAgentHireSchema.safeParse({ name: "x", adapterType: "claude_local", adapterConfig: { model: "gpt-5.5" } }).success).toBe(false);
  });
  it("allows a partial update with a model but no adapterType (early return — pure validator can't see persisted adapterType)", () => {
    expect(updateAgentSchema.safeParse({ adapterConfig: { model: "gpt-5.5" } }).success).toBe(true);
  });
  it("allows an o-series model on codex_local (openai family)", () => {
    expect(updateAgentSchema.safeParse({ adapterType: "codex_local", adapterConfig: { model: "o3" } }).success).toBe(true);
  });
  it("rejects an opencode slash model with a shell-unsafe first segment", () => {
    expect(updateAgentSchema.safeParse({ adapterType: "opencode_local", adapterConfig: { model: "ev&il/gpt-5.5" } }).success).toBe(false);
  });
  it("allows opencode_local + anthropic/claude model (multi-provider, the ① fix)", () => {
    expect(updateAgentSchema.safeParse({ adapterType: "opencode_local", adapterConfig: { model: "anthropic/claude-sonnet-4-5" } }).success).toBe(true);
  });
  it("allows opencode_local + google/gemini model (multi-provider)", () => {
    expect(updateAgentSchema.safeParse({ adapterType: "opencode_local", adapterConfig: { model: "google/gemini-2.0-flash" } }).success).toBe(true);
  });
  // Codex P2: OpenCode ids can carry a nested provider namespace; the shell-safety
  // check must validate each segment WITHOUT a 2-segment cap.
  it("allows opencode_local + a NESTED-namespace model (openrouter/anthropic/...)", () => {
    expect(updateAgentSchema.safeParse({ adapterType: "opencode_local", adapterConfig: { model: "openrouter/anthropic/claude-sonnet-4" } }).success).toBe(true);
  });
  it("still rejects a nested opencode model with a shell-unsafe segment", () => {
    expect(updateAgentSchema.safeParse({ adapterType: "opencode_local", adapterConfig: { model: "openrouter/anthropic/cla;ude" } }).success).toBe(false);
  });
});

describe("isShellSafeModelId (exported for the route's model-only PATCH gate — Codex P2)", () => {
  it("accepts plain ids, provider/model, and nested-namespace opencode ids", () => {
    expect(isShellSafeModelId("gpt-5.5")).toBe(true);
    expect(isShellSafeModelId("claude-sonnet-4-20250514")).toBe(true);
    expect(isShellSafeModelId("openai/gpt-5.2-codex")).toBe(true);
    expect(isShellSafeModelId("openrouter/anthropic/claude-sonnet-4")).toBe(true);
  });
  it("accepts ollama-style tagged ids with a `:` separator (OpenCode/Pi discovery) — Codex P2", () => {
    expect(isShellSafeModelId("ollama/llama3.1:8b")).toBe(true);
    expect(isShellSafeModelId("ollama/qwen2.5-coder:32b")).toBe(true);
  });
  it("rejects shell-unsafe model strings", () => {
    expect(isShellSafeModelId("gpt-5.5; rm -rf /")).toBe(false);
    expect(isShellSafeModelId("gpt-5.5 && calc")).toBe(false);
    expect(isShellSafeModelId("a/b`whoami`")).toBe(false);
    expect(isShellSafeModelId("a//b")).toBe(false); // empty segment
    expect(isShellSafeModelId("a:;rm")).toBe(false); // `:` ok, but `;` still rejected
  });
});

describe("adapterModelFamilyMismatch (shared family check reused by route + schema)", () => {
  it("flags claude_local + gpt", () => {
    expect(adapterModelFamilyMismatch("claude_local", "gpt-5.5")).toMatch(/does not match adapter claude_local/);
  });
  it("passes codex_local + gpt", () => {
    expect(adapterModelFamilyMismatch("codex_local", "gpt-5.5")).toBeNull();
  });
  it("flags gemini_local + claude", () => {
    expect(adapterModelFamilyMismatch("gemini_local", "claude-sonnet-4-5")).toBeTruthy();
  });
  it("flags codex_local + claude", () => {
    expect(adapterModelFamilyMismatch("codex_local", "claude-sonnet-4-5")).toBeTruthy();
  });
  it("exempts opencode_local + anthropic/claude (multi-provider)", () => {
    expect(adapterModelFamilyMismatch("opencode_local", "anthropic/claude-sonnet-4-5")).toBeNull();
  });
  it("passes when adapterType is absent", () => {
    expect(adapterModelFamilyMismatch(undefined, "gpt-5.5")).toBeNull();
  });
  it("passes when model is absent", () => {
    expect(adapterModelFamilyMismatch("claude_local", undefined)).toBeNull();
  });
  it("passes claude_local + claude model", () => {
    expect(adapterModelFamilyMismatch("claude_local", "claude-sonnet-4-5")).toBeNull();
  });
  // Codex P2: codex-* (api-key-only Codex models) are OpenAI-family — block them
  // on non-OpenAI adapters at save time, allow them on codex_local.
  it("flags claude_local + a codex-* model (codex is OpenAI-family)", () => {
    expect(adapterModelFamilyMismatch("claude_local", "codex-mini-latest")).toMatch(/does not match adapter claude_local/);
  });
  it("passes codex_local + a codex-* model", () => {
    expect(adapterModelFamilyMismatch("codex_local", "codex-mini-latest")).toBeNull();
  });
});
