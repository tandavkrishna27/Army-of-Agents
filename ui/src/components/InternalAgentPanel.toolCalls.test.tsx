import { describe, it, expect } from "vitest";
import { mergeServerMessagesWithTransientLocal } from "./InternalAgentPanel";
import type { AgentMessage } from "../api/internal-agent";

const serverMsg: AgentMessage = {
  id: "m1",
  role: "assistant",
  content: "done",
  toolCalls: [{ name: "create_task", success: true, summary: "Created task X" }],
  reasoning: null,
  outputRefs: null,
  pageContext: null,
  createdAt: "2026-06-16T00:00:00Z",
};

describe("tool activity survives server→local mapping", () => {
  it("maps persisted enriched toolCalls into done ToolCallEntry", () => {
    const merged = mergeServerMessagesWithTransientLocal([serverMsg], []);
    expect(merged[0]!.toolCalls).toHaveLength(1);
    expect(merged[0]!.toolCalls![0]).toMatchObject({
      name: "create_task",
      status: "done",
      success: true,
      summary: "Created task X",
    });
  });
});
