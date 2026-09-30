import { describe, it, expect } from "vitest";
import { applyModelResolutionToConfig } from "../runner-model-resolution.js";

const status = { authMode: "chatgpt" as const, defaultModelResolved: "gpt-5.5" };
describe("applyModelResolutionToConfig", () => {
  it("rewrites an incompatible codex model to the safe default", () => {
    const cfg = applyModelResolutionToConfig("codex_local", { model: "gpt-5.3-codex", env: {} }, status);
    expect(cfg.model).toBe("gpt-5.5");
  });
  it("strips a stray (company) OPENAI_API_KEY when the agent did NOT set one", () => {
    const cfg = applyModelResolutionToConfig("codex_local", { model: "gpt-5.5", env: {} }, status,
      { inheritedEnvOpenAiKey: "sk-company" });
    expect((cfg.env as Record<string, unknown>).OPENAI_API_KEY).toBeUndefined();
  });
  it("KEEPS a per-agent OPENAI_API_KEY the agent set itself", () => {
    const cfg = applyModelResolutionToConfig("codex_local", { model: "gpt-5.5", env: { OPENAI_API_KEY: "sk-agent" } }, status,
      { inheritedEnvOpenAiKey: "sk-company" });
    expect((cfg.env as Record<string, unknown>).OPENAI_API_KEY).toBe("sk-agent");
  });
  it("KEEPS a per-agent OPENAI_API_KEY stored as a normalized plain binding (Codex P2)", () => {
    // Saved env entries are normalized to binding objects; a string-only check
    // would treat the agent's own key as absent and strip it.
    const cfg = applyModelResolutionToConfig("codex_local",
      { model: "gpt-5.5", env: { OPENAI_API_KEY: { type: "plain", value: "sk-agent" } } }, status,
      { inheritedEnvOpenAiKey: "sk-company" });
    expect((cfg.env as Record<string, unknown>).OPENAI_API_KEY).toEqual({ type: "plain", value: "sk-agent" });
  });
  it("KEEPS a per-agent OPENAI_API_KEY stored as a secret_ref binding (Codex P2)", () => {
    const cfg = applyModelResolutionToConfig("codex_local",
      { model: "gpt-5.5", env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" } } }, status,
      { inheritedEnvOpenAiKey: "sk-company" });
    expect((cfg.env as Record<string, unknown>).OPENAI_API_KEY).toEqual({ type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" });
  });
  it("sets env to {} (no inherited key leaks) when the codex config has no env field", () => {
    const cfg = applyModelResolutionToConfig("codex_local", { model: "gpt-5.5" }, status,
      { inheritedEnvOpenAiKey: "sk-company" });
    expect((cfg.env as Record<string, unknown>).OPENAI_API_KEY).toBeUndefined();
  });

  // Codex P2: a project/environment-supplied OPENAI_API_KEY (present in the merged
  // runtime env on the org/heartbeat path) is intended for the app/test suite and
  // must be PRESERVED here — only the AMBIENT server key is stripped, by the codex
  // adapter spawn (execute.ts unsetEnvKeys). This helper must not delete a key that
  // is present in the runtime env, even when an ambient key also exists.
  it("PRESERVES a runtime-env OPENAI_API_KEY (project/environment) for the workspace", () => {
    const cfg = applyModelResolutionToConfig("codex_local",
      { model: "gpt-5.5", env: { OPENAI_API_KEY: "sk-project" } }, status,
      { inheritedEnvOpenAiKey: "sk-company" });
    expect((cfg.env as Record<string, unknown>).OPENAI_API_KEY).toBe("sk-project");
  });
});
