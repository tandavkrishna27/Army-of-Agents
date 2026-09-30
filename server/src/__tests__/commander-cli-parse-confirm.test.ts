import { describe, expect, it } from "vitest";
import { parseCliOutput } from "../services/internal-agent/cli-mode.js";

describe("parseCliOutput: action_confirmation extraction", () => {
  it("passes through normal text as a text chunk", () => {
    const chunks = parseCliOutput("Hello, I am Commander.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("text");
    expect((chunks[0] as any).delta).toBe("Hello, I am Commander.");
  });

  it("extracts CONFIRM marker and emits action_confirmation chunk", () => {
    const payload = { toolName: "create_task", params: { title: "Plan sprint" } };
    const line = `⚡CONFIRM:${JSON.stringify(payload)}⚡ This action requires your approval before I can proceed.`;
    const chunks = parseCliOutput(line);

    const confirmChunk = chunks.find((c) => c.type === "action_confirmation");
    expect(confirmChunk).toBeDefined();
    expect((confirmChunk as any).toolName).toBe("create_task");
    expect((confirmChunk as any).params).toMatchObject({ title: "Plan sprint" });
  });

  it("does NOT emit a text chunk for the CONFIRM marker line", () => {
    const payload = { toolName: "create_task", params: {} };
    const line = `⚡CONFIRM:${JSON.stringify(payload)}⚡ Needs approval.`;
    const chunks = parseCliOutput(line);
    const textChunks = chunks.filter((c) => c.type === "text");
    expect(textChunks).toHaveLength(0);
  });

  it("handles malformed CONFIRM markers gracefully — falls back to text", () => {
    const line = "⚡CONFIRM:not-valid-json⚡ something";
    const chunks = parseCliOutput(line);
    expect(chunks[0].type).toBe("text");
  });

  it("falls back to text when CONFIRM marker has no toolName", () => {
    const line = `⚡CONFIRM:${JSON.stringify({ params: {} })}⚡ something`;
    const chunks = parseCliOutput(line);
    expect(chunks[0].type).toBe("text");
  });
});
