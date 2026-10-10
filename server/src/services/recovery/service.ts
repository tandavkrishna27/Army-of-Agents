import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issues } from "@armyofagents/db";

import {
  buildSuccessfulRunHandoffNotice,
  decideSuccessfulRunHandoff,
} from "./successful-run-handoff.js";

type RecoveryWakeupOptions = {
  source: "automation";
  triggerDetail: "system";
  reason: "finish_successful_run_handoff";
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: "recovery";
  contextSnapshot: Record<string, unknown>;
  beforeIssueWakeCommit: (
    tx: Db,
    continuation: { id: string | null; wakeupRequestId: string | null },
  ) => Promise<void>;
};

type RecoveryDependencies = {
  enqueueWakeup: (agentId: string, options: RecoveryWakeupOptions) => Promise<unknown>;
};

function readIssueId(snapshot: Record<string, unknown> | null | undefined) {
  const value = snapshot?.issueId ?? snapshot?.taskId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function recoveryService(db: Db, deps: RecoveryDependencies) {
  return {
    async handleCompletedRun(runId: string) {
      const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
      if (!run) return { action: "none" as const, reason: "run_missing" as const };

      const snapshot = (run.contextSnapshot ?? null) as Record<string, unknown> | null;
      const issueId = readIssueId(snapshot);
      const issue = issueId
        ? await db
          .select()
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
          .then((rows) => rows[0] ?? null)
        : null;
      const existingAttempts = issueId
        ? await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, run.companyId),
              eq(agentWakeupRequests.reason, "finish_successful_run_handoff"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
            ),
          )
          .then((rows) => rows.length)
        : 0;

      const decision = decideSuccessfulRunHandoff({
        run: {
          id: run.id,
          companyId: run.companyId,
          agentId: run.agentId,
          status: run.status,
          livenessState: run.livenessState,
          issueCommentStatus: run.issueCommentStatus,
          contextSnapshot: snapshot,
        },
        issue: issue
          ? {
              id: issue.id,
              companyId: issue.companyId,
              status: issue.status,
              assigneeAgentId: issue.assigneeAgentId,
              executionRunId: issue.executionRunId,
            }
          : null,
        existingAttempts,
      });
      if (decision.action !== "queue_handoff") return decision;

      let recoveryNoticeWritten = false;
      await deps.enqueueWakeup(decision.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "finish_successful_run_handoff",
        payload: decision.payload,
        idempotencyKey: decision.idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: "recovery",
        contextSnapshot: {
          issueId: decision.issueId,
          taskId: decision.issueId,
          sourceRunId: decision.sourceRunId,
          wakeReason: decision.payload.wakeReason,
          reason: decision.reason,
        },
        // Heartbeat creates the request + org-agent run and claims the task
        // under the same transaction. Keep the founder-visible recovery notice
        // atomic with that durable run, rather than inserting a bare AoA-only
        // wakeup row that no org-agent scheduler can consume.
        beforeIssueWakeCommit: async (tx, continuation) => {
          if (!continuation.wakeupRequestId) return;
          const notice = buildSuccessfulRunHandoffNotice({
            runId: decision.sourceRunId,
            agentId: decision.agentId,
            reason: decision.reason,
          });
          await tx.insert(issueComments).values({
            companyId: decision.companyId,
            issueId: decision.issueId,
            authorType: notice.authorType,
            presentation: notice.presentation,
            metadata: notice.metadata,
            body: notice.body,
          });
          await tx.insert(activityLog).values({
            companyId: decision.companyId,
            actorType: "system",
            actorId: "system",
            action: "issue.successful_run_handoff_queued",
            entityType: "issue",
            entityId: decision.issueId,
            agentId: decision.agentId,
            runId: decision.sourceRunId,
            details: {
              wakeupRequestId: continuation.wakeupRequestId,
              recoveryRunId: continuation.id,
              reason: decision.reason,
            },
          });
          recoveryNoticeWritten = true;
        },
      });

      if (!recoveryNoticeWritten) {
        return { action: "none" as const, reason: "handoff_not_enqueued" as const };
      }
      return decision;
    },
  };
}
