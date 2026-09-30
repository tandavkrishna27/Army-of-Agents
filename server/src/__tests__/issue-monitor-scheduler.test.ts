import { describe, expect, it } from "vitest";

import {
  ISSUE_MONITOR_DUE_REASON,
  buildIssueMonitorWake,
  issueMonitorIssueClearReason,
  shouldClearDueIssueMonitor,
} from "../services/issue-monitor-scheduler.js";

describe("issue monitor scheduler helpers", () => {
  it("builds cheap-profile monitor wake payloads with deterministic idempotency keys", () => {
    expect(
      buildIssueMonitorWake({
        monitorId: "monitor-1",
        issueId: "issue-1",
        agentId: "agent-1",
        companyId: "company-1",
        nextAttempt: 2,
      }),
    ).toMatchObject({
      companyId: "company-1",
      agentId: "agent-1",
      reason: ISSUE_MONITOR_DUE_REASON,
      idempotencyKey: "issue_monitor_due:monitor-1:2",
      payload: {
        issueId: "issue-1",
        monitorId: "monitor-1",
        wakeReason: ISSUE_MONITOR_DUE_REASON,
        monitorAttempt: 2,
        modelProfileHint: "cheap",
        recoveryModelProfile: "cheap",
      },
    });
  });

  it("clears due monitors when timeout or max attempts are exhausted", () => {
    const now = new Date(Date.UTC(2026, 4, 13, 12));

    expect(
      shouldClearDueIssueMonitor({
        attemptCount: 3,
        maxAttempts: 3,
        timeoutAt: null,
        now,
      }),
    ).toBe("max_attempts_exhausted");
    expect(
      shouldClearDueIssueMonitor({
        attemptCount: 0,
        maxAttempts: null,
        timeoutAt: new Date(now.getTime() - 1),
        now,
      }),
    ).toBe("timeout_exceeded");
    expect(
      shouldClearDueIssueMonitor({
        attemptCount: 0,
        maxAttempts: 2,
        timeoutAt: new Date(now.getTime() + 1_000),
        now,
      }),
    ).toBeNull();
  });

  it("clears monitors for completed, invalid, or reassigned tasks before waking", () => {
    expect(issueMonitorIssueClearReason({ issue: null, monitorAgentId: "agent-1" })).toBe("missing_issue");
    expect(
      issueMonitorIssueClearReason({
        issue: { status: "done", assigneeAgentId: "agent-1" },
        monitorAgentId: "agent-1",
      }),
    ).toBe("done");
    expect(
      issueMonitorIssueClearReason({
        issue: { status: "cancelled", assigneeAgentId: "agent-1" },
        monitorAgentId: "agent-1",
      }),
    ).toBe("cancelled");
    expect(
      issueMonitorIssueClearReason({
        issue: { status: "blocked", assigneeAgentId: "agent-1" },
        monitorAgentId: "agent-1",
      }),
    ).toBe("invalid_status");
    expect(
      issueMonitorIssueClearReason({
        issue: { status: "in_progress", assigneeAgentId: "agent-2" },
        monitorAgentId: "agent-1",
      }),
    ).toBe("invalid_assignee");
    expect(
      issueMonitorIssueClearReason({
        issue: { status: "in_review", assigneeAgentId: "agent-1" },
        monitorAgentId: "agent-1",
      }),
    ).toBeNull();
  });
});
