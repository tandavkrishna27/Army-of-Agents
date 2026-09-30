import { describe, it, expect } from "vitest";
import { claudeModelArgs } from "../services/internal-agent/cli-mode.js";

describe("claudeModelArgs (Commander model on claude_cli)", () => {
  it("empty/undefined model → no args (byte-identical default path)", () => {
    expect(claudeModelArgs(null)).toEqual([]);
    expect(claudeModelArgs("")).toEqual([]);
    expect(claudeModelArgs(undefined)).toEqual([]);
  });
  it("shell-safe model → --model <model>", () => {
    expect(claudeModelArgs("claude-opus-4-1")).toEqual(["--model", "claude-opus-4-1"]);
  });
  it("shell-UNSAFE model → no args (never interpolate unsafe input)", () => {
    expect(claudeModelArgs("evil; rm -rf")).toEqual([]);
  });
});
