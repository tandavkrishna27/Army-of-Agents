import { describe, it, expect } from "vitest";
import {
  isCodexLocalFastModeSupported,
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
} from "../index.js";

describe("isCodexLocalFastModeSupported", () => {
  it("returns true for gpt-5.4", () => {
    expect(isCodexLocalFastModeSupported("gpt-5.4")).toBe(true);
  });

  it("returns false for unsupported models", () => {
    expect(isCodexLocalFastModeSupported("gpt-4o")).toBe(false);
    expect(isCodexLocalFastModeSupported("gpt-5.3")).toBe(false);
    expect(isCodexLocalFastModeSupported("gpt-5.3-codex")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isCodexLocalFastModeSupported(null)).toBe(false);
    expect(isCodexLocalFastModeSupported(undefined)).toBe(false);
    expect(isCodexLocalFastModeSupported("")).toBe(false);
  });

  it("CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS contains gpt-5.4", () => {
    expect(CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS).toContain("gpt-5.4");
  });
});
