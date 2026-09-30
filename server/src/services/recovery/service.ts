import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issues } from "@armyofagents/db";

import {
  buildSuccessfulRunHandoffNotice,
  decideSuccessfulRunHandoff,
} from "./successful-run-handoff.js";

function readIssueId(snapshot: Record<string, unknown> | null | undefined) {
  const value = snapshot?.issueId ?? snapshot?.taskId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function recoveryService(db: Db) {
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
              eq(agentWakeupRequests.idempotencyKey, `finish_successful_run_handoff:${issueId}:${run.id}:1`),
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

      await db.transaction(async (tx) => {
        const [wake] = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: decision.companyId,
            agentId: decision.agentId,
            source: "automation",
            triggerDetail: "recovery.successful_run_handoff",
            reason: "finish_successful_run_handoff",
            payload: decision.payload,
            status: "queued",
            idempotencyKey: decision.idempotencyKey,
          })
          .onConflictDoNothing()
          .returning();

        if (!wake) return;

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
        await tx
          .update(issues)
          .set({ updatedAt: new Date() })
          .where(and(eq(issues.id, decision.issueId), eq(issues.companyId, decision.companyId)));
        await tx.insert(activityLog).values({
          companyId: decision.companyId,
          actorType: "system",
          actorId: "system",
          action: "issue.successful_run_handoff_queued",
          entityType: "issue",
          entityId: decision.issueId,
          agentId: decision.agentId,
          runId: decision.sourceRunId,
          details: { wakeupRequestId: wake.id, reason: decision.reason },
        });
      });

      return decision;
    },
  };
}
