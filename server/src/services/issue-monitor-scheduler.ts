import { and, asc, eq, lte } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { activityLog, agentWakeupRequests, issueMonitors, issues } from "@armyofagents/db";

import { withRecoveryModelProfileHint } from "./recovery/model-profile-hint.js";
import { buildIssueMonitorClearedPatch, buildIssueMonitorTriggeredPatch } from "./issue-execution-policy.js";

export const ISSUE_MONITOR_DUE_REASON = "issue_monitor_due";

export function buildIssueMonitorWake(input: {
  companyId: string;
  agentId: string;
  issueId: string;
  monitorId: string;
  nextAttempt: number;
}) {
  return {
    companyId: input.companyId,
    agentId: input.agentId,
    source: "automation",
    triggerDetail: "recovery.issue_monitor_due",
    reason: ISSUE_MONITOR_DUE_REASON,
    status: "queued",
    idempotencyKey: `${ISSUE_MONITOR_DUE_REASON}:${input.monitorId}:${input.nextAttempt}`,
    payload: withRecoveryModelProfileHint({
      issueId: input.issueId,
      monitorId: input.monitorId,
      wakeReason: ISSUE_MONITOR_DUE_REASON,
      monitorAttempt: input.nextAttempt,
    }),
  };
}

export function shouldClearDueIssueMonitor(input: {
  attemptCount: number;
  maxAttempts: number | null;
  timeoutAt: Date | null;
  now: Date;
}) {
  if (input.timeoutAt && input.timeoutAt <= input.now) return "timeout_exceeded";
  if (input.maxAttempts != null && input.maxAttempts > 0 && input.attemptCount >= input.maxAttempts) {
    return "max_attempts_exhausted";
  }
  return null;
}

export function issueMonitorIssueClearReason(input: {
  issue: { status: string; assigneeAgentId: string | null } | null;
  monitorAgentId: string | null;
}) {
  if (!input.issue) return "missing_issue";
  if (input.issue.status === "done") return "done";
  if (input.issue.status === "cancelled") return "cancelled";
  if (!["in_progress", "in_review"].includes(input.issue.status)) return "invalid_status";
  if (!input.monitorAgentId || input.issue.assigneeAgentId !== input.monitorAgentId) return "invalid_assignee";
  return null;
}

export function issueMonitorSchedulerService(db: Db) {
  return {
    async triggerDueMonitors(companyId: string, opts: { now?: Date; limit?: number } = {}) {
      const now = opts.now ?? new Date();
      const due = await db
        .select()
        .from(issueMonitors)
        .where(
          and(
            eq(issueMonitors.companyId, companyId),
            eq(issueMonitors.status, "scheduled"),
            lte(issueMonitors.nextCheckAt, now),
          ),
        )
        .orderBy(asc(issueMonitors.nextCheckAt), asc(issueMonitors.createdAt))
        .limit(opts.limit ?? 50);

      let triggered = 0;
      let cleared = 0;

      for (const candidate of due) {
        const result = await db.transaction(async (tx) => {
          const monitor = await tx
            .select()
            .from(issueMonitors)
            .where(
              and(
                eq(issueMonitors.id, candidate.id),
                eq(issueMonitors.companyId, companyId),
                eq(issueMonitors.status, "scheduled"),
                lte(issueMonitors.nextCheckAt, now),
              ),
            )
            .then((rows) => rows[0] ?? null);
          if (!monitor) return "skipped" as const;

          const issue = await tx
            .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
            .from(issues)
            .where(and(eq(issues.companyId, companyId), eq(issues.id, monitor.issueId)))
            .then((rows) => rows[0] ?? null);
          const issueClearReason = issueMonitorIssueClearReason({
            issue,
            monitorAgentId: monitor.agentId,
          });
          if (issueClearReason) {
            await tx
              .update(issueMonitors)
              .set(buildIssueMonitorClearedPatch({ now, clearReason: issueClearReason }))
              .where(and(eq(issueMonitors.id, monitor.id), eq(issueMonitors.companyId, companyId)));
            await tx.insert(activityLog).values({
              companyId,
              actorType: "system",
              actorId: "system",
              action: "issue.monitor_cleared",
              entityType: "issue",
              entityId: monitor.issueId,
              agentId: monitor.agentId,
              details: { monitorId: monitor.id, clearReason: issueClearReason },
            });
            return "cleared" as const;
          }

          const clearReason = shouldClearDueIssueMonitor({
            attemptCount: monitor.attemptCount,
            maxAttempts: monitor.maxAttempts,
            timeoutAt: monitor.timeoutAt,
            now,
          });
          if (clearReason) {
            await tx
              .update(issueMonitors)
              .set(buildIssueMonitorClearedPatch({ now, clearReason }))
              .where(and(eq(issueMonitors.id, monitor.id), eq(issueMonitors.companyId, companyId)));
            await tx.insert(activityLog).values({
              companyId,
              actorType: "system",
              actorId: "system",
              action: "issue.monitor_cleared",
              entityType: "issue",
              entityId: monitor.issueId,
              agentId: monitor.agentId,
              details: { monitorId: monitor.id, clearReason },
            });
            return "cleared" as const;
          }

          const nextAttempt = monitor.attemptCount + 1;
          const wake = buildIssueMonitorWake({
            companyId,
            agentId: monitor.agentId!,
            issueId: monitor.issueId,
            monitorId: monitor.id,
            nextAttempt,
          });

          await tx
            .update(issueMonitors)
            .set(buildIssueMonitorTriggeredPatch({ now, nextAttempt }))
            .where(and(eq(issueMonitors.id, monitor.id), eq(issueMonitors.companyId, companyId)));

          await tx
            .insert(agentWakeupRequests)
            .values(wake)
            .onConflictDoNothing();

          await tx.insert(activityLog).values({
            companyId,
            actorType: "system",
            actorId: "system",
            action: "issue.monitor_triggered",
            entityType: "issue",
            entityId: monitor.issueId,
            agentId: monitor.agentId,
            details: { monitorId: monitor.id, attempt: nextAttempt },
          });
          return "triggered" as const;
        });

        if (result === "triggered") triggered += 1;
        if (result === "cleared") cleared += 1;
      }

      return { checked: due.length, triggered, cleared };
    },
  };
}
