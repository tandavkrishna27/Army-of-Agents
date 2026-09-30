import { describe, it, expect } from "vitest";
import { mergeServerMessagesWithTransientLocal } from "./InternalAgentPanel";
import type { AgentMessage } from "../api/internal-agent";

const serverMsg: AgentMessage = {
  id: "m1", role: "assistant", content: "answer", toolCalls: null,
  reasoning: "I reasoned about X.", outputRefs: null, pageContext: null,
  createdAt: "2026-06-16T00:00:00Z",
};
describe("reasoning survives server→local mapping (persisted)", () => {
  it("maps the persisted reasoning column", () => {
    const merged = mergeServerMessagesWithTransientLocal([serverMsg], []);
    expect(merged.find((m) => m.id === "m1")?.reasoning).toBe("I reasoned about X.");
  });
});
