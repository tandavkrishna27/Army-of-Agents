import { describe, expect, it } from "vitest";
import { parseGeminiJsonl } from "../parse.js";

describe("parseGeminiJsonl v0.38 wire format", () => {
  it("extracts usage from event.stats", () => {
    const input = JSON.stringify({
      type: "result",
      stats: { input_tokens: 100, output_tokens: 50, cached: 20 },
    });
    const result = parseGeminiJsonl(input);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cachedInputTokens).toBe(20);
  });

  it("detects errors from result.status='failed'", () => {
    const input = JSON.stringify({
      type: "result",
      status: "failed",
      error: "oops",
    });
    const result = parseGeminiJsonl(input);
    expect(result.errorMessage).toBe("oops");
  });

  it("detects errors from result.status='error'", () => {
    const input = JSON.stringify({
      type: "result",
      status: "error",
      error: "fatal",
    });
    const result = parseGeminiJsonl(input);
    expect(result.errorMessage).toBe("fatal");
  });
});
