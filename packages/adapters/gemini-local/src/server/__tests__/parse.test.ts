import { describe, it, expect } from "vitest";
import {
  parseGeminiJsonl,
  isGeminiUnknownSessionError,
  describeGeminiFailure,
  detectGeminiAuthRequired,
  isGeminiTurnLimitResult,
} from "../parse.js";

describe("parseGeminiJsonl", () => {
  it("returns defaults for empty string", () => {
    const result = parseGeminiJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe("");
    expect(result.errorMessage).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.resultEvent).toBeNull();
    expect(result.question).toBeNull();
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
  });

  it("extracts session ID from system init event", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "ses-123", model: "gemini-2.5-pro" });
    const result = parseGeminiJsonl(line);
    expect(result.sessionId).toBe("ses-123");
  });

  it("extracts assistant message text", () => {
    const line = JSON.stringify({ type: "assistant", message: "Hello world" });
    const result = parseGeminiJsonl(line);
    expect(result.summary).toBe("Hello world");
  });

  it("extracts assistant message from content array", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "output_text", text: "Hi there" }] },
    });
    const result = parseGeminiJsonl(line);
    expect(result.summary).toBe("Hi there");
  });

  it("extracts usage and cost from result event", () => {
    const line = JSON.stringify({
      type: "result",
      usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 },
      total_cost_usd: 0.005,
    });
    const result = parseGeminiJsonl(line);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cachedInputTokens).toBe(10);
    expect(result.costUsd).toBe(0.005);
    expect(result.resultEvent).not.toBeNull();
  });

  it("extracts error message from error event", () => {
    const line = JSON.stringify({ type: "error", error: "Something went wrong" });
    const result = parseGeminiJsonl(line);
    expect(result.errorMessage).toBe("Something went wrong");
  });

  it("extracts error from system error event", () => {
    const line = JSON.stringify({ type: "system", subtype: "error", error: "Auth failed" });
    const result = parseGeminiJsonl(line);
    expect(result.errorMessage).toBe("Auth failed");
  });

  it("accumulates usage from multiple events", () => {
    const lines = [
      JSON.stringify({ type: "step_finish", usage: { input_tokens: 50, output_tokens: 20 } }),
      JSON.stringify({ type: "result", usage: { input_tokens: 30, output_tokens: 10 } }),
    ].join("\n");
    const result = parseGeminiJsonl(lines);
    expect(result.usage.inputTokens).toBe(80);
    expect(result.usage.outputTokens).toBe(30);
  });

  it("skips non-JSON lines", () => {
    const result = parseGeminiJsonl("not json\n{bad json too");
    expect(result.summary).toBe("");
    expect(result.sessionId).toBeNull();
  });

  it("parses {type:'message', role:'assistant'} events", () => {
    const input = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Hello from Gemini v0.38",
    });
    const result = parseGeminiJsonl(input);
    expect(result.summary).toContain("Hello from Gemini v0.38");
  });

  it("ignores {type:'message', role:'user'} events for assistant summary", () => {
    const input = JSON.stringify({
      type: "message",
      role: "user",
      content: "User typed this",
    });
    const result = parseGeminiJsonl(input);
    expect(result.summary).not.toContain("User typed this");
  });
});

describe("isGeminiUnknownSessionError", () => {
  it("detects 'unknown session' in stdout", () => {
    expect(isGeminiUnknownSessionError("unknown session abc", "")).toBe(true);
  });

  it("detects 'session xyz not found' in stderr", () => {
    expect(isGeminiUnknownSessionError("", "session xyz not found")).toBe(true);
  });

  it("detects 'cannot resume'", () => {
    expect(isGeminiUnknownSessionError("cannot resume session", "")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isGeminiUnknownSessionError("Hello world", "all good")).toBe(false);
  });
});

describe("describeGeminiFailure", () => {
  it("returns null when no failure indicators", () => {
    expect(describeGeminiFailure({})).toBeNull();
  });

  it("includes status and error detail", () => {
    const result = describeGeminiFailure({ status: "error", error: "timeout" });
    expect(result).toContain("status=error");
    expect(result).toContain("timeout");
  });

  it("includes status alone", () => {
    const result = describeGeminiFailure({ status: "failed" });
    expect(result).toBe("Gemini run failed: status=failed");
  });
});

describe("detectGeminiAuthRequired", () => {
  it("detects 'not authenticated' in stderr", () => {
    const result = detectGeminiAuthRequired({ parsed: null, stdout: "", stderr: "not authenticated" });
    expect(result.requiresAuth).toBe(true);
  });

  it("detects 'api key required'", () => {
    const result = detectGeminiAuthRequired({ parsed: null, stdout: "api key required", stderr: "" });
    expect(result.requiresAuth).toBe(true);
  });

  it("detects 'authentication required'", () => {
    const result = detectGeminiAuthRequired({ parsed: null, stdout: "", stderr: "authentication required" });
    expect(result.requiresAuth).toBe(true);
  });

  it("returns false for normal output", () => {
    const result = detectGeminiAuthRequired({ parsed: null, stdout: "Hello", stderr: "" });
    expect(result.requiresAuth).toBe(false);
  });
});

describe("isGeminiTurnLimitResult", () => {
  it("returns true for exit code 53", () => {
    expect(isGeminiTurnLimitResult(null, 53)).toBe(true);
  });

  it("returns true for status turn_limit", () => {
    expect(isGeminiTurnLimitResult({ status: "turn_limit" }, 0)).toBe(true);
  });

  it("returns true for status max_turns", () => {
    expect(isGeminiTurnLimitResult({ status: "max_turns" }, 0)).toBe(true);
  });

  it("marks parsed turn-limit result payloads with canonical stop reason", () => {
    const result = parseGeminiJsonl(
      JSON.stringify({
        type: "result",
        status: "turn_limit",
        error: "Reached the turn limit",
      }),
    );

    expect(result.resultEvent).toMatchObject({
      status: "turn_limit",
      stopReason: "max_turns_exhausted",
    });
  });

  it("returns false for normal result", () => {
    expect(isGeminiTurnLimitResult({ status: "success" }, 0)).toBe(false);
  });

  it("returns false for null parsed", () => {
    expect(isGeminiTurnLimitResult(null, 0)).toBe(false);
  });
});
