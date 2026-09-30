import { describe, expect, it } from "vitest";
import { parseGeminiStdoutLine } from "../parse-stdout.js";

const TS = "2026-01-01T00:00:00.000Z";

describe("parse-stdout v0.38 wire format", () => {
  it("renders assistant text from {type:'message'} events", () => {
    const line = JSON.stringify({ type: "message", role: "assistant", content: "Hello" });
    const result = parseGeminiStdoutLine(line, TS);
    const assistantEntries = result.filter((e) => e.kind === "assistant");
    expect(assistantEntries.length).toBeGreaterThan(0);
    expect(JSON.stringify(assistantEntries)).toContain("Hello");
  });

  it("extracts usage from event.stats in result events", () => {
    const line = JSON.stringify({
      type: "result",
      stats: { input_tokens: 200, output_tokens: 100 },
    });
    const result = parseGeminiStdoutLine(line, TS);
    const resultEntries = result.filter((e) => e.kind === "result");
    expect(resultEntries[0]?.inputTokens).toBe(200);
  });
});
