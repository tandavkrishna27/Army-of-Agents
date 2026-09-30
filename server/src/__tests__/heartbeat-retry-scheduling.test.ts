import { describe, expect, it } from "vitest";

import {
  MAX_TURN_CONTINUATION_MAX_ATTEMPTS,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  buildMaxTurnContinuationRetryContext,
  classifyCompletedRunLiveness,
  classifyScheduledRetryGate,
  nextMaxTurnContinuationAttempt,
} from "../services/heartbeat.js";

describe("max-turn continuation retry scheduling helpers", () => {
  it("builds bounded retry context for max-turn continuations", () => {
    expect(
      buildMaxTurnContinuationRetryContext({
        sourceRunId: "run-1",
        issueId: "issue-1",
        attempt: 1,
        contextSnapshot: { issueId: "issue-1", existing: true },
      }),
    ).toMatchObject({
      existing: true,
      retryOfRunId: "run-1",
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
      continuationAttempt: 1,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      issueId: "issue-1",
      taskId: "issue-1",
      resumeIntent: true,
    });
  });

  it("caps continuation attempts after the configured max", () => {
    expect(nextMaxTurnContinuationAttempt({ scheduledRetryAttempt: 0, contextSnapshot: {} })).toBe(1);
    expect(nextMaxTurnContinuationAttempt({ scheduledRetryAttempt: MAX_TURN_CONTINUATION_MAX_ATTEMPTS })).toBe(3);
  });

  it("classifies invalid scheduled retry gates", () => {
    expect(classifyScheduledRetryGate({ issue: null, agentId: "agent-1" })).toBe("issue_not_in_progress");
    expect(
      classifyScheduledRetryGate({
        issue: { status: "cancelled", assigneeAgentId: "agent-1" },
        agentId: "agent-1",
      }),
    ).toBe("issue_cancelled");
    expect(
      classifyScheduledRetryGate({
        issue: { status: "in_progress", assigneeAgentId: "agent-2" },
        agentId: "agent-1",
      }),
    ).toBe("issue_reassigned");
    expect(
      classifyScheduledRetryGate({
        issue: { status: "blocked", assigneeAgentId: "agent-1" },
        agentId: "agent-1",
      }),
    ).toBe("issue_not_in_progress");
  });

  it("allows in-progress retries for the assigned agent", () => {
    expect(
      classifyScheduledRetryGate({
        issue: { status: "in_progress", assigneeAgentId: "agent-1" },
        agentId: "agent-1",
      }),
    ).toBeNull();
  });

  it("classifies completed run liveness for recovery handoff gating", () => {
    expect(classifyCompletedRunLiveness({ outcome: "succeeded" })).toEqual({
      livenessState: "advanced",
      livenessReason: "adapter_succeeded",
    });
    expect(classifyCompletedRunLiveness({ outcome: "failed" })).toEqual({
      livenessState: "stalled",
      livenessReason: "adapter_did_not_succeed",
    });
    expect(classifyCompletedRunLiveness({ outcome: "succeeded", waitingQuestionId: "question-1" })).toEqual({
      livenessState: "waiting_on_human",
      livenessReason: "work_question",
      nextAction: "work_question:question-1",
    });
  });
});
