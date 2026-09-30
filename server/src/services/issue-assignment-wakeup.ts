import type { Db } from "@armyofagents/db";
import { shouldDispatchIssueWakeup } from "../routes/issues-planning-mode-dispatch.js";
import { enqueueIssueAssigneeWakeup } from "./issue-assignee-wakeup.js";
import { logger } from "../middleware/logger.js";

export function queueIssueAssignmentWakeup(input: {
  db: Db;
  issue: { id: string; companyId: string; assigneeAgentId: string | null; status: string; workMode?: string | null };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog" || !shouldDispatchIssueWakeup({ workMode: input.issue.workMode ?? null })) return;

  return enqueueIssueAssigneeWakeup(input.db, {
    companyId: input.issue.companyId,
    agentId: input.issue.assigneeAgentId,
    issueId: input.issue.id,
    source: "assignment",
    reason: input.reason,
    mutation: input.mutation,
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId ?? null,
  }).catch((err) => {
    logger.warn({ err, issueId: input.issue.id }, "failed assignee wake");
    if (input.rethrowOnError) throw err;
    return null;
  });
}
