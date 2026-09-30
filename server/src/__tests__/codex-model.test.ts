// server/src/__tests__/codex-model.test.ts
import { describe, it, expect } from "vitest";
import {
  resolveCodexChatModel,
  isCodexCompatibleModel,
  isOpenAiFamilyModel,
  isShellSafeModel,
  DEFAULT_CODEX_CHAT_MODEL,
  COMMANDER_CODEX_REASONING_EFFORT,
} from "../services/internal-agent/codex-model.js";

describe("isShellSafeModel", () => {
  it("accepts bare ids, provider/model, AND nested-namespace opencode ids (no segment cap) — Codex P2", () => {
    expect(isShellSafeModel("gpt-5.5")).toBe(true);
    expect(isShellSafeModel("openai/gpt-5.2-codex")).toBe(true);
    expect(isShellSafeModel("openrouter/anthropic/claude-sonnet-4")).toBe(true); // 3 segments — was wrongly rejected
    expect(isShellSafeModel("  anthropic/claude-3.5-sonnet  ")).toBe(true); // trims
    expect(isShellSafeModel("ollama/llama3.1:8b")).toBe(true); // `:` tag separator (Codex P2)
  });
  it("rejects shell-unsafe segments, empty segments, and empty input", () => {
    expect(isShellSafeModel("gpt-5.5; rm -rf /")).toBe(false);
    expect(isShellSafeModel("a/b && calc")).toBe(false);
    expect(isShellSafeModel("a//b")).toBe(false); // empty middle segment
    expect(isShellSafeModel("/leading")).toBe(false);
    expect(isShellSafeModel("")).toBe(false);
    expect(isShellSafeModel(null)).toBe(false);
  });
});

describe("isOpenAiFamilyModel", () => {
  it("accepts OpenAI/Codex-family identifiers INCLUDING codex-* and *-codex (api-key-valid)", () => {
    expect(isOpenAiFamilyModel("gpt-5.5")).toBe(true);
    expect(isOpenAiFamilyModel("gpt-5.3-codex")).toBe(true);
    expect(isOpenAiFamilyModel("o3-mini")).toBe(true);
    expect(isOpenAiFamilyModel("chatgpt-4o")).toBe(true);
    expect(isOpenAiFamilyModel("codex-mini-latest")).toBe(true); // the fix — was wrongly rejected
    expect(isOpenAiFamilyModel("  codex-mini  ")).toBe(true); // trims
  });
  it("rejects non-OpenAI families, slash/opencode ids, and empty", () => {
    expect(isOpenAiFamilyModel("claude-sonnet-4-5-20250929")).toBe(false);
    expect(isOpenAiFamilyModel("gemini-2.5-pro")).toBe(false);
    expect(isOpenAiFamilyModel("openai/gpt-5.5")).toBe(false); // slash rejected by SAFE_MODEL_RE
    expect(isOpenAiFamilyModel("")).toBe(false);
    expect(isOpenAiFamilyModel(null)).toBe(false);
  });
  it("widening CODEX_FAMILY_RE does NOT loosen isCodexCompatibleModel — codex-* stays ChatGPT-INcompatible", () => {
    expect(isCodexCompatibleModel("codex-mini-latest")).toBe(false);
    expect(isCodexCompatibleModel("gpt-5.3-codex")).toBe(false);
    expect(isCodexCompatibleModel("gpt-5.5")).toBe(true);
  });
});

describe("isCodexCompatibleModel", () => {
  it("accepts ChatGPT-account openai chat families", () => {
    expect(isCodexCompatibleModel("gpt-5.5")).toBe(true);
    expect(isCodexCompatibleModel("gpt-4.1")).toBe(true);
    expect(isCodexCompatibleModel("gpt-4o")).toBe(true);
    expect(isCodexCompatibleModel("o3-mini")).toBe(true);
    expect(isCodexCompatibleModel("o1")).toBe(true);
    expect(isCodexCompatibleModel("chatgpt-4o")).toBe(true);
    expect(isCodexCompatibleModel("  gpt-5.5  ")).toBe(true); // trims
  });
  it("rejects the known-bad GPT-Codex variants (ChatGPT-account 400s) — REVIEW FIX C1/C2", () => {
    // The exact model that 400s on a ChatGPT account; it passed a naive /^gpt-/.
    expect(isCodexCompatibleModel("gpt-5.3-codex")).toBe(false);
    expect(isCodexCompatibleModel("gpt-5-codex")).toBe(false);
    expect(isCodexCompatibleModel("o1-codex")).toBe(false);
    expect(isCodexCompatibleModel("codex-mini")).toBe(false);
  });
  it("rejects non-openai families + empty", () => {
    expect(isCodexCompatibleModel("claude-sonnet-4-6")).toBe(false);
    expect(isCodexCompatibleModel("gemini-2.0")).toBe(false);
    expect(isCodexCompatibleModel("opus")).toBe(false);
    expect(isCodexCompatibleModel("")).toBe(false);
    expect(isCodexCompatibleModel(null)).toBe(false);
    expect(isCodexCompatibleModel(undefined)).toBe(false);
  });
  it("rejects shell-unsafe strings (spawn uses shell:true on Windows) — REVIEW FIX C10/S5", () => {
    expect(isCodexCompatibleModel("gpt-5.5; rm -rf /")).toBe(false);
    expect(isCodexCompatibleModel("gpt-5.5 && calc")).toBe(false);
    expect(isCodexCompatibleModel("gpt-5.5\nmalicious")).toBe(false);
    expect(isCodexCompatibleModel("gpt-5.5`whoami`")).toBe(false);
  });
});

describe("resolveCodexChatModel", () => {
  it("uses config.model when codex-compatible", () => {
    expect(resolveCodexChatModel("gpt-4.1", "gpt-5.5")).toBe("gpt-4.1");
    expect(resolveCodexChatModel("  o3-mini ", "gpt-5.5")).toBe("o3-mini");
  });
  it("falls back to the shared model when config.model is a claude default", () => {
    expect(resolveCodexChatModel("claude-sonnet-4-6", "gpt-5.5")).toBe("gpt-5.5");
  });
  it("VALIDATES the shared model too (not trusted as-is) — REVIEW FIX C1", () => {
    // shared ~/.codex could hold a claude alias or a GPT-Codex model → must not pass it through
    expect(resolveCodexChatModel(null, "claude-3-opus")).toBe(DEFAULT_CODEX_CHAT_MODEL);
    expect(resolveCodexChatModel(null, "gpt-5.3-codex")).toBe(DEFAULT_CODEX_CHAT_MODEL);
    expect(resolveCodexChatModel(null, "gpt-5.5")).toBe("gpt-5.5"); // valid shared still honored
  });
  it("falls back to the safe default when nothing usable is available", () => {
    expect(resolveCodexChatModel(null, null)).toBe(DEFAULT_CODEX_CHAT_MODEL);
    expect(resolveCodexChatModel("claude-sonnet-4-6", "  ")).toBe(DEFAULT_CODEX_CHAT_MODEL);
  });
  it("exposes the proven defaults", () => {
    expect(DEFAULT_CODEX_CHAT_MODEL).toBe("gpt-5.5");
    expect(COMMANDER_CODEX_REASONING_EFFORT).toBe("high");
  });
});
