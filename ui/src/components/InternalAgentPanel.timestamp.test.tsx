import { describe, it, expect } from "vitest";
import { mergeServerMessagesWithTransientLocal } from "./InternalAgentPanel";
import type { AgentMessage } from "../api/internal-agent";

const serverMsg: AgentMessage = {
  id: "m1",
  role: "assistant",
  content: "hi",
  toolCalls: null,
  reasoning: null,
  outputRefs: null,
  pageContext: null,
  createdAt: "2026-06-16T08:00:00Z",
};

describe("createdAt survives server→local mapping", () => {
  it("mergeServerMessagesWithTransientLocal carries createdAt", () => {
    const merged = mergeServerMessagesWithTransientLocal([serverMsg], []);
    expect(merged[0]!.createdAt).toBe("2026-06-16T08:00:00Z");
  });
});
