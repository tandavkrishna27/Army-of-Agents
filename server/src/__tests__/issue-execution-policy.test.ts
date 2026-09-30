import { describe, expect, it } from "vitest";

import {
  buildInitialIssueMonitorFields,
  buildIssueMonitorClearedPatch,
  buildIssueMonitorTriggeredPatch,
  normalizeIssueMonitorPolicy,
} from "../services/issue-execution-policy.js";

const future = new Date(Date.UTC(2026, 4, 14, 12)).toISOString();

describe("issue execution monitor policy helpers", () => {
  it("normalizes monitor policy input and redacts external refs from metadata", () => {
    const policy = normalizeIssueMonitorPolicy({
      kind: "handoff",
      nextCheckAt: future,
      scheduledBy: "board",
      notes: "check status",
      maxAttempts: 2,
      timeoutAt: new Date(Date.UTC(2026, 4, 15, 12)).toISOString(),
      externalRef: "https://private.example/ref",
      recoveryPolicy: { mode: "cheap" },
    });

    const fields = buildInitialIssueMonitorFields({
      companyId: "company-1",
      issue: { id: "issue-1", status: "in_progress", assigneeAgentId: "agent-1" },
      policy,
      now: new Date(Date.UTC(2026, 4, 13, 12)),
    });

    expect(fields).toMatchObject({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      status: "scheduled",
      kind: "handoff",
      scheduledBy: "board",
      maxAttempts: 2,
      recoveryPolicy: { mode: "cheap" },
    });
    expect(fields?.metadata).toMatchObject({ externalRefRedacted: true });
    expect(fields?.metadata).not.toHaveProperty("externalRef");
  });

  it("only schedules monitor rows for agent-assigned active reviewable tasks", () => {
    const policy = normalizeIssueMonitorPolicy({ nextCheckAt: future });

    expect(
      buildInitialIssueMonitorFields({
        companyId: "company-1",
        issue: { id: "issue-1", status: "todo", assigneeAgentId: "agent-1" },
        policy,
      }),
    ).toBeNull();
    expect(
      buildInitialIssueMonitorFields({
        companyId: "company-1",
        issue: { id: "issue-1", status: "in_progress", assigneeAgentId: null },
        policy,
      }),
    ).toBeNull();
    expect(
      buildInitialIssueMonitorFields({
        companyId: "company-1",
        issue: { id: "issue-1", status: "in_review", assigneeAgentId: "agent-1" },
        policy,
      }),
    ).toMatchObject({ issueId: "issue-1", agentId: "agent-1" });
  });

  it("clears invalid or exhausted monitors and builds trigger patches", () => {
    const now = new Date(Date.UTC(2026, 4, 13, 12));

    expect(
      buildIssueMonitorClearedPatch({
        monitor: { maxAttempts: 2, attemptCount: 2, timeoutAt: null },
        issue: { status: "in_progress", assigneeAgentId: "agent-1" },
        now,
      }),
    ).toMatchObject({ status: "cleared", clearReason: "max_attempts_exhausted", clearedAt: now });
    expect(
      buildIssueMonitorClearedPatch({
        monitor: { maxAttempts: null, attemptCount: 0, timeoutAt: null, agentId: "agent-1" },
        issue: { status: "done", assigneeAgentId: "agent-1" },
        now,
      }),
    ).toMatchObject({ clearReason: "done" });
    expect(
      buildIssueMonitorTriggeredPatch({ attemptCount: 0, now }),
    ).toMatchObject({ status: "triggered", attemptCount: 1, lastTriggeredAt: now });
  });
});
