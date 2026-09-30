import { describe, it, expect } from "vitest";
import { mergeServerMessagesWithTransientLocal, type LocalMessage } from "./InternalAgentPanel";
import type { AgentMessage } from "../api/internal-agent";

// The streamed assistant message carries a live-only durationMs (from the done
// SSE event). It has a CLIENT temp id (≠ the persisted server id), so the merge
// must carry durationMs onto the server message by CONTENT, or the post-turn
// server sync wipes the "Worked for Xs" caption immediately.

const serverMsg: AgentMessage = {
  id: "server-1",
  role: "assistant",
  content: "Here is the answer.",
  toolCalls: null,
  reasoning: null,
  outputRefs: null,
  pageContext: null,
  createdAt: "2026-06-16T00:00:00Z",
};

const localStreamed: LocalMessage = {
  id: "temp-local-1",
  role: "assistant",
  content: "Here is the answer.",
  streamingDone: true,
  durationMs: 6812,
  createdAt: "2026-06-16T00:00:00Z",
};

describe('durationMs survives the post-turn server sync ("Worked for Xs")', () => {
  it("carries durationMs from the streamed local message onto the persisted server message by content", () => {
    const merged = mergeServerMessagesWithTransientLocal([serverMsg], [localStreamed]);
    expect(merged.find((m) => m.id === "server-1")?.durationMs).toBe(6812);
  });

  it("leaves durationMs undefined on a hard reload (no local messages — live-only by design)", () => {
    const merged = mergeServerMessagesWithTransientLocal([serverMsg], []);
    expect(merged.find((m) => m.id === "server-1")?.durationMs).toBeUndefined();
  });
});
