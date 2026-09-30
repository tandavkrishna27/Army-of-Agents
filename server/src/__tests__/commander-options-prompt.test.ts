import { describe, expect, it } from "vitest";
import { parseCliOutput } from "../services/internal-agent/cli-mode.js";

describe("parseCliOutput: options_prompt extraction", () => {
  it("emits options_prompt chunk for OPTIONS marker", () => {
    const payload = {
      question: "Which adapter fits your workflow?",
      options: ["Claude Code CLI", "Codex", "OpenCode", "Not sure, help me decide"],
    };
    const line = `⚡OPTIONS:${JSON.stringify(payload)}⚡`;
    const chunks = parseCliOutput(line);
    const optChunk = chunks.find((c) => c.type === "options_prompt");
    expect(optChunk).toBeDefined();
    expect((optChunk as any).question).toBe("Which adapter fits your workflow?");
    expect((optChunk as any).options).toHaveLength(4);
    expect((optChunk as any).options[0]).toBe("Claude Code CLI");
  });

  it("does NOT emit a text chunk for the OPTIONS marker line", () => {
    const payload = { question: "Pick one", options: ["A", "B"] };
    const line = `⚡OPTIONS:${JSON.stringify(payload)}⚡`;
    const chunks = parseCliOutput(line);
    expect(chunks.filter((c) => c.type === "text")).toHaveLength(0);
  });

  it("falls back to text on malformed OPTIONS marker", () => {
    const line = "⚡OPTIONS:not-json⚡";
    const chunks = parseCliOutput(line);
    expect(chunks[0].type).toBe("text");
  });

  it("still parses CONFIRM markers correctly after adding OPTIONS support", () => {
    const payload = { toolName: "create_task", params: { title: "Test" } };
    const line = `⚡CONFIRM:${JSON.stringify(payload)}⚡ Needs approval.`;
    const chunks = parseCliOutput(line);
    const confirmChunk = chunks.find((c) => c.type === "action_confirmation");
    expect(confirmChunk).toBeDefined();
  });

  it("falls back to text when OPTIONS marker has empty question", () => {
    const line = `⚡OPTIONS:${JSON.stringify({ question: "", options: ["A", "B"] })}⚡`;
    const chunks = parseCliOutput(line);
    expect(chunks[0].type).toBe("text");
  });

  it("falls back to text when OPTIONS marker has empty options array", () => {
    const line = `⚡OPTIONS:${JSON.stringify({ question: "Pick one", options: [] })}⚡`;
    const chunks = parseCliOutput(line);
    expect(chunks[0].type).toBe("text");
  });

  it("falls back to text when OPTIONS marker has non-array options", () => {
    const line = `⚡OPTIONS:${JSON.stringify({ question: "Pick one", options: "bad" })}⚡`;
    const chunks = parseCliOutput(line);
    expect(chunks[0].type).toBe("text");
  });
});
