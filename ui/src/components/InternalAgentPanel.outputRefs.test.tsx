import { describe, it, expect } from "vitest";
import { mergeServerMessagesWithTransientLocal } from "./InternalAgentPanel";
import type { AgentMessage } from "../api/internal-agent";

const serverMsg: AgentMessage = {
  id: "m1",
  role: "assistant",
  content: "done",
  toolCalls: null,
  reasoning: null,
  outputRefs: [{ v: 1, kind: "artifact", id: "a1", action: "created" } as any],
  pageContext: null,
  createdAt: "2026-06-11T00:00:00Z",
};

describe("outputRefs survive server→local mapping", () => {
  it("mergeServerMessagesWithTransientLocal carries outputRefs", () => {
    const merged = mergeServerMessagesWithTransientLocal([serverMsg], []);
    expect(merged[0]!.outputRefs).toHaveLength(1);
    expect(merged[0]!.outputRefs![0]).toMatchObject({ id: "a1" });
  });
});
