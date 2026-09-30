import { describe, it, expect } from "vitest";
import { getContextLimit, shortModelName } from "../components/workspace/adapter-utils";

describe("getContextLimit", () => {
  it("returns 200K for Claude Sonnet", () => {
    expect(getContextLimit("claude-sonnet-4-20250514")).toBe(200_000);
  });

  it("returns 200K for Claude Opus", () => {
    expect(getContextLimit("claude-opus-4-6")).toBe(200_000);
  });

  it("returns 128K for GPT-4o", () => {
    expect(getContextLimit("gpt-4o")).toBe(128_000);
  });

  it("returns 128K for GPT-4o Mini (not confused with GPT-4o)", () => {
    expect(getContextLimit("gpt-4o-mini")).toBe(128_000);
  });

  it("returns 1M for Gemini 2.5 Pro", () => {
    expect(getContextLimit("gemini-2.5-pro")).toBe(1_000_000);
  });

  it("returns null for unknown model", () => {
    expect(getContextLimit("some-unknown-model")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(getContextLimit(null)).toBeNull();
  });
});

describe("shortModelName ordering", () => {
  it("gpt-4o-mini returns GPT-4o Mini, not GPT-4o", () => {
    expect(shortModelName("gpt-4o-mini")).toBe("GPT-4o Mini");
  });

  it("o1-mini returns o1 Mini, not o1", () => {
    expect(shortModelName("o1-mini")).toBe("o1 Mini");
  });

  it("o4-mini returns o4 Mini, not o4", () => {
    expect(shortModelName("o4-mini-2025-04-16")).toBe("o4 Mini");
  });

  it("o4 returns o4", () => {
    expect(shortModelName("o4-2025-04-16")).toBe("o4");
  });
});

describe("getContextLimit additional", () => {
  it("returns 200K for o4-mini", () => {
    expect(getContextLimit("o4-mini-2025-04-16")).toBe(200_000);
  });
});
