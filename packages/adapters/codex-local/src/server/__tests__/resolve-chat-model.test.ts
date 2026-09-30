import { describe, expect, it } from "vitest";
import { resolveCodexChatModel, isCodexCompatibleModel } from "../resolve-chat-model.js";

describe("resolveCodexChatModel (package-local mirror)", () => {
  it("defaults an empty config model to gpt-5.5", () => {
    expect(resolveCodexChatModel("", null)).toBe("gpt-5.5");
  });
  it("rejects an incompatible gpt-5.3-codex → default", () => {
    expect(resolveCodexChatModel("gpt-5.3-codex", null)).toBe("gpt-5.5");
  });
  it("passes a compatible config model through", () => {
    expect(resolveCodexChatModel("gpt-4o", null)).toBe("gpt-4o");
  });
  it("falls back to a compatible shared model", () => {
    expect(resolveCodexChatModel("", "gpt-4o")).toBe("gpt-4o");
  });
  it("isCodexCompatibleModel rejects codex-family + empty + unsafe", () => {
    expect(isCodexCompatibleModel("gpt-5.3-codex")).toBe(false);
    expect(isCodexCompatibleModel("")).toBe(false);
    expect(isCodexCompatibleModel("claude-sonnet-4")).toBe(false);
    expect(isCodexCompatibleModel("gpt-4o")).toBe(true);
  });
});
