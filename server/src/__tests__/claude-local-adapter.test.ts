import { describe, expect, it } from "vitest";
import { isClaudeMaxTurnsResult, parseClaudeStreamJson } from "@armyofagents/adapter-claude-local/server";

describe("claude_local max-turn detection", () => {
  it("detects max-turn exhaustion by subtype", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "error_max_turns",
        result: "Reached max turns",
      }),
    ).toBe(true);
  });

  it("detects max-turn exhaustion by stop_reason", () => {
    expect(
      isClaudeMaxTurnsResult({
        stop_reason: "max_turns",
      }),
    ).toBe(true);
  });

  it("returns false for non-max-turn results", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "success",
        stop_reason: "end_turn",
      }),
    ).toBe(false);
  });

  it("marks parsed max-turn result payloads with canonical stop reason", () => {
    const result = parseClaudeStreamJson(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        result: "Reached max turns",
      }),
    );

    expect(result.resultJson).toMatchObject({
      subtype: "error_max_turns",
      stopReason: "max_turns_exhausted",
    });
  });
});
