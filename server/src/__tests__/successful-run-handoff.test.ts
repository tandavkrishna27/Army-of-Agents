import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  buildSuccessfulRunHandoffNotice,
  decideSuccessfulRunHandoff,
} from "../services/recovery/successful-run-handoff.js";

describe("successful run handoff decisions", () => {
  it("queues a corrective wake when a successful run advanced work but left the task in progress", () => {
    const decision = decideSuccessfulRunHandoff({
      run: {
        id: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        status: "succeeded",
        livenessState: "advanced",
        issueCommentStatus: "not_applicable",
        contextSnapshot: { issueId: "issue-1" },
      },
      issue: {
        id: "issue-1",
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: "agent-1",
        executionRunId: "run-1",
      },
    });

    expect(decision).toMatchObject({
      action: "queue_handoff",
      reason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      issueId: "issue-1",
      agentId: "agent-1",
      idempotencyKey: `${FINISH_SUCCESSFUL_RUN_HANDOFF_REASON}:issue-1:run-1:1`,
      payload: {
        issueId: "issue-1",
        taskId: "issue-1",
        sourceRunId: "run-1",
        wakeReason: FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
        modelProfileHint: "cheap",
        recoveryModelProfile: "cheap",
      },
    });
  });

  it("does not queue when the task is already out of in-progress or attempts are exhausted", () => {
    const base = {
      run: {
        id: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        status: "succeeded",
        livenessState: "advanced",
        contextSnapshot: { issueId: "issue-1" },
      },
      issue: {
        id: "issue-1",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: "agent-1",
      },
    } as const;

    expect(decideSuccessfulRunHandoff(base)).toMatchObject({ action: "none", reason: "issue_already_dispositioned" });
    expect(
      decideSuccessfulRunHandoff({
        ...base,
        issue: { ...base.issue, status: "in_progress" },
        existingAttempts: DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
      }),
    ).toMatchObject({ action: "none", reason: "attempts_exhausted" });
  });

  it("does not queue when the completed run no longer owns the task execution", () => {
    expect(
      decideSuccessfulRunHandoff({
        run: {
          id: "run-1",
          companyId: "company-1",
          agentId: "agent-1",
          status: "succeeded",
          livenessState: "advanced",
          contextSnapshot: { issueId: "issue-1" },
        },
        issue: {
          id: "issue-1",
          companyId: "company-1",
          status: "in_progress",
          assigneeAgentId: "agent-1",
          executionRunId: "run-2",
        } as any,
      }),
    ).toMatchObject({ action: "none", reason: "issue_run_changed" });
  });

  it("builds compact system notice metadata for missing disposition", () => {
    expect(
      buildSuccessfulRunHandoffNotice({
        runId: "run-1",
        agentId: "agent-1",
        reason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      }),
    ).toMatchObject({
      authorType: "system",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Task needs final status",
      },
      metadata: {
        version: 1,
        sections: [
          {
            title: "Recovery",
            rows: [{ runId: "run-1", agentId: "agent-1", reason: SUCCESSFUL_RUN_MISSING_STATE_REASON }],
          },
        ],
      },
    });
    const notice = buildSuccessfulRunHandoffNotice({
      runId: "run-1",
      agentId: "agent-1",
      reason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
    });
    expect(notice.body).toContain("task is still in progress");
    expect(notice.body).toContain("choose the final task status");
  });
});
