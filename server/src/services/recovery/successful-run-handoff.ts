import type {
  IssueCommentAuthorType,
  IssueCommentMetadata,
  IssueCommentPresentation,
  RunLivenessState,
} from "@armyofagents/shared";

import { withRecoveryModelProfileHint } from "./model-profile-hint.js";

export const FINISH_SUCCESSFUL_RUN_HANDOFF_REASON = "finish_successful_run_handoff";
export const SUCCESSFUL_RUN_MISSING_STATE_REASON = "successful_run_missing_state";
export const DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1;

export type SuccessfulRunHandoffRun = {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  livenessState?: RunLivenessState | string | null;
  issueCommentStatus?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

export type SuccessfulRunHandoffIssue = {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  executionRunId?: string | null;
};

export type SuccessfulRunHandoffInput = {
  run: SuccessfulRunHandoffRun;
  issue: SuccessfulRunHandoffIssue | null;
  existingAttempts?: number;
  maxAttempts?: number;
};

export type SuccessfulRunHandoffDecision =
  | {
    action: "queue_handoff";
    reason: typeof SUCCESSFUL_RUN_MISSING_STATE_REASON;
    companyId: string;
    issueId: string;
    agentId: string;
    sourceRunId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }
  | {
    action: "none";
    reason:
      | "run_not_successful"
      | "run_not_productive"
      | "issue_missing"
      | "company_mismatch"
      | "issue_already_dispositioned"
      | "issue_unassigned"
      | "issue_assignee_changed"
      | "issue_run_changed"
      | "attempts_exhausted";
  };

function readIssueId(snapshot: Record<string, unknown> | null | undefined) {
  const value = snapshot?.issueId ?? snapshot?.taskId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function decideSuccessfulRunHandoff(input: SuccessfulRunHandoffInput): SuccessfulRunHandoffDecision {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS;
  if (input.run.status !== "succeeded") return { action: "none", reason: "run_not_successful" };
  if (input.run.livenessState !== "advanced") return { action: "none", reason: "run_not_productive" };
  if (!input.issue) return { action: "none", reason: "issue_missing" };
  if (input.issue.companyId !== input.run.companyId) return { action: "none", reason: "company_mismatch" };
  if (input.issue.status !== "in_progress") return { action: "none", reason: "issue_already_dispositioned" };
  if (!input.issue.assigneeAgentId) return { action: "none", reason: "issue_unassigned" };
  if (input.issue.assigneeAgentId !== input.run.agentId) return { action: "none", reason: "issue_assignee_changed" };
  if (input.issue.executionRunId !== undefined && input.issue.executionRunId !== input.run.id) {
    return { action: "none", reason: "issue_run_changed" };
  }
  if ((input.existingAttempts ?? 0) >= maxAttempts) return { action: "none", reason: "attempts_exhausted" };

  const issueId = readIssueId(input.run.contextSnapshot) ?? input.issue.id;
  const attempt = (input.existingAttempts ?? 0) + 1;
  const payload = withRecoveryModelProfileHint({
    issueId,
    taskId: issueId,
    sourceRunId: input.run.id,
    wakeReason: FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
    reason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
    handoffAttempt: attempt,
  });

  return {
    action: "queue_handoff",
    reason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
    companyId: input.run.companyId,
    issueId,
    agentId: input.run.agentId,
    sourceRunId: input.run.id,
    idempotencyKey: `${FINISH_SUCCESSFUL_RUN_HANDOFF_REASON}:${issueId}:${input.run.id}:${attempt}`,
    payload,
  };
}

export function buildSuccessfulRunHandoffNotice(input: {
  runId: string;
  agentId: string;
  reason: string;
}): {
  body: string;
  authorType: IssueCommentAuthorType;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
} {
  return {
    body: "The agent run finished, but the task is still in progress. AoA queued a recovery handoff so the agent can choose the final task status.",
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
          rows: [
            {
              runId: input.runId,
              agentId: input.agentId,
              reason: input.reason,
            },
          ],
        },
      ],
    },
  };
}
