import { describe, it, expect } from "vitest";
import { resolveModel, ShellUnsafeModelError } from "../model-resolution.js";
import { DEFAULT_CODEX_CHAT_MODEL } from "../codex-model.js";

const chatgpt = { authMode: "chatgpt" as const, defaultModelResolved: "gpt-5.5" };

describe("resolveModel", () => {
  it("THROWS on a shell-unsafe model regardless of tier", () => {
    expect(() => resolveModel("codex_local", "gpt-5 & calc.exe", chatgpt)).toThrow(ShellUnsafeModelError);
  });
  it("corrects an API-key-only codex model on chatgpt to the safe default", () => {
    const r = resolveModel("codex_local", "gpt-5.3-codex", chatgpt);
    expect(r.model).toBe("gpt-5.5");
    expect(r.note).toMatch(/not supported.*ChatGPT/i);
  });
  it("passes a compatible codex model through unchanged", () => {
    expect(resolveModel("codex_local", "gpt-5.5", chatgpt).model).toBe("gpt-5.5");
  });
  it("empty model on codex resolves to the validated default", () => {
    expect(resolveModel("codex_local", "", chatgpt).model).toBe("gpt-5.5");
  });
  it("claude passes a claude model through; gemini 'auto' is allowed (omit)", () => {
    expect(resolveModel("claude_local", "claude-sonnet-4-5-20250929", { authMode: "subscription", defaultModelResolved: null }).model)
      .toBe("claude-sonnet-4-5-20250929");
    expect(resolveModel("gemini_local", "auto", { authMode: "unknown", defaultModelResolved: null }).omitModelFlag).toBe(true);
  });
  it("passes an opencode provider/model slash model through unchanged (shell-safe)", () => {
    const r = resolveModel("opencode_local", "openai/gpt-5.2-codex", { authMode: "unknown", defaultModelResolved: null });
    expect(r.model).toBe("openai/gpt-5.2-codex");
    expect(r.omitModelFlag).toBe(false);
  });
  it("passes a codex -codex model through unchanged on an apikey login (no correction, no note)", () => {
    const r = resolveModel("codex_local", "gpt-5.3-codex", { authMode: "apikey", defaultModelResolved: "gpt-5.5" });
    expect(r.model).toBe("gpt-5.3-codex");
    expect(r.note).toBeUndefined();
  });
  it("passes a non-auto gemini model through unchanged", () => {
    const r = resolveModel("gemini_local", "gemini-2.5-pro", { authMode: "unknown", defaultModelResolved: null });
    expect(r.model).toBe("gemini-2.5-pro");
    expect(r.omitModelFlag).toBe(false);
  });

  // Codex finding P2: in apikey mode a blank requested model falls back to the
  // ~/.codex/config.toml default WITHOUT the shell-safety gate (that gate only
  // runs for a non-empty requested model). Validate the fallback too.
  it("apikey mode: an unsafe config-default fallback (blank requested) is rejected, not passed to --model", () => {
    expect(() =>
      resolveModel("codex_local", "", { authMode: "apikey", defaultModelResolved: "gpt-5 && rm -rf /" }),
    ).toThrow(ShellUnsafeModelError);
  });
  it("apikey mode: a safe config-default fallback (blank requested) passes through", () => {
    const r = resolveModel("codex_local", "", { authMode: "apikey", defaultModelResolved: "gpt-5.3-codex" });
    expect(r.model).toBe("gpt-5.3-codex");
  });
  it("apikey mode: blank requested + null config default → DEFAULT_CODEX_CHAT_MODEL", () => {
    const r = resolveModel("codex_local", "", { authMode: "apikey", defaultModelResolved: null });
    expect(r.model).toBe(DEFAULT_CODEX_CHAT_MODEL);
  });
  it("apikey mode: a safe-but-padded config default is trimmed", () => {
    const r = resolveModel("codex_local", "", { authMode: "apikey", defaultModelResolved: "  gpt-5.3-codex  " });
    expect(r.model).toBe("gpt-5.3-codex");
  });

  // Codex P2: in apikey mode a blank requested model falls back to the shared
  // ~/.codex/config.toml default after only a shell-safety check. A shell-safe
  // NON-OpenAI alias there (claude-…/gemini-…) would be passed to `codex --model`
  // with an OpenAI key and fail — constrain the fallback to OpenAI/Codex-family.
  it("apikey mode: a shell-safe NON-OpenAI config default is NOT passed to --model → DEFAULT", () => {
    expect(resolveModel("codex_local", "", { authMode: "apikey", defaultModelResolved: "claude-sonnet-4-5-20250929" }).model)
      .toBe(DEFAULT_CODEX_CHAT_MODEL);
    expect(resolveModel("codex_local", "", { authMode: "apikey", defaultModelResolved: "gemini-2.5-pro" }).model)
      .toBe(DEFAULT_CODEX_CHAT_MODEL);
  });
  it("apikey mode: an EXPLICIT gpt-*-codex request is preserved even when the config default is non-OpenAI", () => {
    const r = resolveModel("codex_local", "gpt-5.3-codex", { authMode: "apikey", defaultModelResolved: "claude-sonnet-4-5-20250929" });
    expect(r.model).toBe("gpt-5.3-codex");
    expect(r.note).toBeUndefined();
  });

  // Codex P2: an EXPLICIT apikey model must also be OpenAI/Codex-family — a
  // shell-safe slash/opencode-style id or a non-OpenAI/unknown alias must not be
  // passed to `codex --model`; correct it to the safe default.
  it("apikey mode: an explicit opencode-style slash model is corrected to DEFAULT (+ note)", () => {
    const r = resolveModel("codex_local", "openai/gpt-5.5", { authMode: "apikey", defaultModelResolved: "gpt-5.5" });
    expect(r.model).toBe(DEFAULT_CODEX_CHAT_MODEL);
    expect(r.note).toMatch(/not an OpenAI\/Codex model/i);
  });
  it("apikey mode: an explicit non-OpenAI alias (claude/gemini) is corrected to DEFAULT", () => {
    expect(resolveModel("codex_local", "claude-sonnet-4-5-20250929", { authMode: "apikey", defaultModelResolved: "gpt-5.5" }).model)
      .toBe(DEFAULT_CODEX_CHAT_MODEL);
    expect(resolveModel("codex_local", "gemini-2.5-pro", { authMode: "apikey", defaultModelResolved: "gpt-5.5" }).model)
      .toBe(DEFAULT_CODEX_CHAT_MODEL);
  });
  // Codex P2: codex-* models are API-key-only but VALID; an apikey user that
  // explicitly requests one must keep it (not get rewritten to gpt-5.5).
  it("apikey mode: an explicit codex-prefixed model (codex-mini-latest) is preserved", () => {
    const r = resolveModel("codex_local", "codex-mini-latest", { authMode: "apikey", defaultModelResolved: "gpt-5.5" });
    expect(r.model).toBe("codex-mini-latest");
    expect(r.note).toBeUndefined();
  });
});
