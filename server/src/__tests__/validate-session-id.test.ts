import { describe, expect, it } from "vitest";
import { validateSessionId } from "../services/internal-agent/cli-mode.js";

describe("validateSessionId — shell injection guard", () => {
  it("passes through valid alphanumeric-dash-underscore IDs", () => {
    expect(validateSessionId("abc-123_XYZ")).toBe("abc-123_XYZ");
  });

  it("passes through typical codex session ID format", () => {
    expect(validateSessionId("sess_01ABCDEF0123456789")).toBe("sess_01ABCDEF0123456789");
  });

  it("rejects ID containing semicolon (cmd.exe command chaining)", () => {
    expect(validateSessionId("abc;rm -rf /")).toBeNull();
  });

  it("rejects ID containing pipe (cmd.exe piping)", () => {
    expect(validateSessionId("abc|whoami")).toBeNull();
  });

  it("rejects ID containing ampersand (cmd.exe/bash command chaining)", () => {
    expect(validateSessionId("abc&& evil")).toBeNull();
  });

  it("rejects ID containing spaces", () => {
    expect(validateSessionId("abc def")).toBeNull();
  });

  it("rejects IDs exceeding 128 chars", () => {
    expect(validateSessionId("a".repeat(129))).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateSessionId("")).toBeNull();
  });

  it("rejects non-string input (number)", () => {
    expect(validateSessionId(42 as unknown as string)).toBeNull();
  });

  it("rejects non-string input (null)", () => {
    expect(validateSessionId(null as unknown as string)).toBeNull();
  });
});
