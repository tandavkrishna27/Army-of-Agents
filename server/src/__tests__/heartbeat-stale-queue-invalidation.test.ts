import { describe, expect, it } from "vitest";

import { classifyScheduledRetryGate } from "../services/heartbeat.js";

describe("heartbeat stale queued issue invalidation", () => {
  it("cancels queued work when the issue was reassigned", () => {
    expect(
      classifyScheduledRetryGate({
        issue: { status: "in_progress", assigneeAgentId: "new-agent" },
        agentId: "old-agent",
      }),
    ).toBe("issue_reassigned");
  });

  it("cancels queued work when the issue was cancelled", () => {
    expect(
      classifyScheduledRetryGate({
        issue: { status: "cancelled", assigneeAgentId: "agent-1" },
        agentId: "agent-1",
      }),
    ).toBe("issue_cancelled");
  });

  it("cancels queued work when the issue leaves in-progress", () => {
    expect(
      classifyScheduledRetryGate({
        issue: { status: "blocked", assigneeAgentId: "agent-1" },
        agentId: "agent-1",
      }),
    ).toBe("issue_not_in_progress");
  });
});
