import { describe, it, expect } from "vitest";
import { StreamJsonParser } from "../parse-stream-json.js";

// A minimal but representative claude --output-format stream-json transcript:
// an assistant text delta, then a user event carrying a ⚡CONFIRM marker
// (the exact frame W7.5e's approval flow depends on), then a result event.
const TRANSCRIPT = [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Working on it" }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "⚡CONFIRM:{\"toolName\":\"create_task\",\"confirmId\":\"a1\"}⚡ approve?" }] } }),
  JSON.stringify({ type: "result", is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }),
].join("\n") + "\n";

function parseAll(chunks: string[]): unknown[] {
  const parser = new StreamJsonParser();
  const out: unknown[] = [];
  for (const c of chunks) for (const ch of parser.push(c)) out.push(ch);
  for (const ch of parser.flush()) out.push(ch);
  return out;
}

describe("StreamJsonParser tolerates arbitrary E2B chunk boundaries", () => {
  it("produces identical output whether fed whole or split at every byte offset", () => {
    const whole = parseAll([TRANSCRIPT]);
    expect(whole.length).toBeGreaterThan(0);
    // The ⚡CONFIRM marker must reassemble into an action_confirmation chunk.
    expect(whole.some((c: any) => c.type === "action_confirmation")).toBe(true);

    for (let i = 1; i < TRANSCRIPT.length; i++) {
      const split = parseAll([TRANSCRIPT.slice(0, i), TRANSCRIPT.slice(i)]);
      expect(split).toEqual(whole);
    }
  });

  it("reassembles a marker split mid-JSON across three tiny chunks", () => {
    const line = TRANSCRIPT.split("\n")[1] + "\n";
    const thirds = [line.slice(0, 5), line.slice(5, 40), line.slice(40)];
    const out = parseAll(thirds);
    expect(out.some((c: any) => c.type === "action_confirmation")).toBe(true);
  });
});
