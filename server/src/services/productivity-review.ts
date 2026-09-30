import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issues } from "@armyofagents/db";
import { RECOVERY_ORIGIN_KINDS } from "@armyofagents/shared";

import { withRecoveryModelProfileHint } from "./recovery/model-profile-hint.js";
import { issueService } from "./issues.js";

export const DEFAULT_PRODUCTIVITY_REVIEW_LIMITS = {
  noCommentStreakRuns: 10,
  longActiveMs: 6 * 60 * 60 * 1000,
  highChurnHourly: 10,
  highChurnSixHours: 30,
  resolvedSnoozeMs: 6 * 60 * 60 * 1000,
  refreshIntervalMs: 60 * 60 * 1000,
  maxRefreshComments: 3,
  creationWindowMs: 24 * 60 * 60 * 1000,
  maxCreationsPerWindow: 3,
} as const;

export type ProductivityReviewTrigger = "no_comment_streak" | "long_active" | "high_churn";

export function shouldCreateProductivityReview(input: {
  noCommentRunStreak: number;
  activeSince: Date | null;
  churnLastHour: number;
  churnLastSixHours: number;
  openReviewIssue: { id: string; lastRefreshedAt: Date | null; refreshCount: number } | null;
  recentResolvedReviewAt: Date | null;
  creationsInWindow: number;
  now: Date;
  limits?: typeof DEFAULT_PRODUCTIVITY_REVIEW_LIMITS;
}) {
  const limits = input.limits ?? DEFAULT_PRODUCTIVITY_REVIEW_LIMITS;
  let trigger: ProductivityReviewTrigger | null = null;
  if (input.noCommentRunStreak >= limits.noCommentStreakRuns) trigger = "no_comment_streak";
  else if (input.activeSince && input.now.getTime() - input.activeSince.getTime() > limits.longActiveMs) {
    trigger = "long_active";
  } else if (
    input.churnLastHour >= limits.highChurnHourly ||
    input.churnLastSixHours >= limits.highChurnSixHours
  ) {
    trigger = "high_churn";
  }

  if (!trigger) return { create: false as const, reason: "no_signal" as const };
  if (input.openReviewIssue) return { create: false as const, reason: "open_review_exists" as const, trigger };
  if (
    input.recentResolvedReviewAt &&
    input.now.getTime() - input.recentResolvedReviewAt.getTime() < limits.resolvedSnoozeMs
  ) {
    return { create: false as const, reason: "recently_resolved_snooze" as const, trigger };
  }
  if (input.creationsInWindow >= limits.maxCreationsPerWindow) {
    return { create: false as const, reason: "creation_window_cap" as const, trigger };
  }
  return { create: true as const, trigger };
}

export function shouldHoldProductivityReviewContinuation(input: { openReviewIssueId: string | null }) {
  return Boolean(input.openReviewIssueId);
}

export function shouldRefreshProductivityReview(input: {
  lastRefreshedAt: Date | null;
  refreshCount: number;
  now: Date;
  limits?: typeof DEFAULT_PRODUCTIVITY_REVIEW_LIMITS;
}) {
  const limits = input.limits ?? DEFAULT_PRODUCTIVITY_REVIEW_LIMITS;
  if (input.refreshCount >= limits.maxRefreshComments) return false;
  if (!input.lastRefreshedAt) return true;
  return input.now.getTime() - input.lastRefreshedAt.getTime() >= limits.refreshIntervalMs;
}

function clampIssueRequestDepth(value: number) {
  return Math.max(0, Math.min(value, 5));
}

export function isProductivityReviewSourceIssue(input: { originKind?: string | null }) {
  return input.originKind !== RECOVERY_ORIGIN_KINDS.issueProductivityReview;
}

export function buildProductivityReviewIssueInput(input: {
  sourceIssue: {
    id: string;
    companyId: string;
    title: string;
    assigneeAgentId: string | null;
    projectId: string | null;
    goalId: string | null;
    requestDepth: number;
  };
  trigger: ProductivityReviewTrigger;
}) {
  return {
    issue: {
      title: `Review productivity for: ${input.sourceIssue.title}`,
      description: [
        "Review whether this task is still making useful progress.",
        `Source task: ${input.sourceIssue.id}`,
        `Trigger: ${input.trigger}`,
      ].join("\n"),
      status: "todo",
      priority: "medium",
      assigneeAgentId: input.sourceIssue.assigneeAgentId,
      projectId: input.sourceIssue.projectId,
      goalId: input.sourceIssue.goalId,
      originKind: RECOVERY_ORIGIN_KINDS.issueProductivityReview,
      originId: input.sourceIssue.id,
      requestDepth: clampIssueRequestDepth((input.sourceIssue.requestDepth ?? 0) + 1),
    },
  };
}

export function buildProductivityReviewWakePayload(input: {
  reviewIssueId: string;
  sourceIssueId: string;
  trigger: ProductivityReviewTrigger;
}) {
  return withRecoveryModelProfileHint({
    issueId: input.reviewIssueId,
    taskId: input.reviewIssueId,
    reviewIssueId: input.reviewIssueId,
    sourceIssueId: input.sourceIssueId,
    wakeReason: RECOVERY_ORIGIN_KINDS.issueProductivityReview,
    trigger: input.trigger,
  });
}

export function productivityReviewService(db: Db) {
  async function findOpenReviewIssue(companyId: string, issueId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueProductivityReview),
          eq(issues.originId, issueId),
          inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .then((rows) => rows[0] ?? null);
  }

  return {
    async isProductivityReviewContinuationHoldActive(input: {
      companyId: string;
      issueId: string;
      agentId?: string | null;
    }) {
      const review = await findOpenReviewIssue(input.companyId, input.issueId);
      if (!review) return false;
      if (input.agentId && review.assigneeAgentId && review.assigneeAgentId !== input.agentId) return false;
      return true;
    },

    async reconcileCompany(companyId: string, opts: { now?: Date; limit?: number } = {}) {
      const now = opts.now ?? new Date();
      const limits = DEFAULT_PRODUCTIVITY_REVIEW_LIMITS;
      const activeIssues = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "in_progress"),
            isNull(issues.hiddenAt),
            sql`${issues.assigneeAgentId} is not null`,
            or(isNull(issues.originKind), ne(issues.originKind, RECOVERY_ORIGIN_KINDS.issueProductivityReview)),
          ),
        )
        .limit(opts.limit ?? 50);

      let created = 0;
      let refreshed = 0;
      for (const issue of activeIssues) {
        const creationWindowStart = new Date(now.getTime() - limits.creationWindowMs);
        const [creationCount] = await db
          .select({ count: sql<number>`count(*)` })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueProductivityReview),
              gte(issues.createdAt, creationWindowStart),
            ),
          );
        const openReviewIssue = await findOpenReviewIssue(companyId, issue.id);
        const recentResolvedReview = await db
          .select({ completedAt: issues.completedAt, cancelledAt: issues.cancelledAt, updatedAt: issues.updatedAt })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueProductivityReview),
              eq(issues.originId, issue.id),
              or(eq(issues.status, "done"), eq(issues.status, "cancelled")),
            ),
          )
          .orderBy(desc(issues.updatedAt))
          .then((rows) => rows[0] ?? null);
        const recentResolvedAt =
          recentResolvedReview?.completedAt ?? recentResolvedReview?.cancelledAt ?? recentResolvedReview?.updatedAt ?? null;

        const commentsSinceStart = await db
          .select({ count: sql<number>`count(*)` })
          .from(issueComments)
          .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issue.id)))
          .then((rows) => Number(rows[0]?.count ?? 0));
        const runCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(heartbeatRuns.agentId, issue.assigneeAgentId!),
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
              eq(heartbeatRuns.status, "succeeded"),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        const churnLastHour = await db
          .select({ count: sql<number>`count(*)` })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.entityType, "issue"),
              eq(activityLog.entityId, issue.id),
              gte(activityLog.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        const churnLastSixHours = await db
          .select({ count: sql<number>`count(*)` })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.entityType, "issue"),
              eq(activityLog.entityId, issue.id),
              gte(activityLog.createdAt, new Date(now.getTime() - 6 * 60 * 60 * 1000)),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));

        const refreshStats = openReviewIssue
          ? await db
              .select({ createdAt: activityLog.createdAt })
              .from(activityLog)
              .where(
                and(
                  eq(activityLog.companyId, companyId),
                  eq(activityLog.action, "issue.productivity_review_refreshed"),
                  eq(activityLog.entityType, "issue"),
                  eq(activityLog.entityId, openReviewIssue.id),
                ),
              )
              .orderBy(desc(activityLog.createdAt))
          : [];

        const decision = shouldCreateProductivityReview({
          noCommentRunStreak: commentsSinceStart === 0 ? runCount : 0,
          activeSince: issue.startedAt,
          churnLastHour,
          churnLastSixHours,
          openReviewIssue: openReviewIssue
            ? {
                id: openReviewIssue.id,
                lastRefreshedAt: refreshStats[0]?.createdAt ?? openReviewIssue.updatedAt,
                refreshCount: refreshStats.length,
              }
            : null,
          recentResolvedReviewAt: recentResolvedAt,
          creationsInWindow: Number(creationCount?.count ?? 0),
          now,
        });

        if (!decision.create) {
          if (
            decision.reason === "open_review_exists" &&
            openReviewIssue &&
            shouldRefreshProductivityReview({
              lastRefreshedAt: refreshStats[0]?.createdAt ?? openReviewIssue.updatedAt,
              refreshCount: refreshStats.length,
              now,
            })
          ) {
            await db.insert(issueComments).values({
              companyId,
              issueId: openReviewIssue.id,
              authorType: "system",
              body: [
                "This productivity review is still open.",
                `Source task: ${issue.id}`,
                `Trigger: ${decision.trigger}`,
              ].join("\n"),
              presentation: {
                kind: "system_notice",
                tone: "warning",
                title: "Productivity review refresh",
              },
              metadata: {
                version: 1,
                sections: [
                  {
                    title: "Recovery review",
                    rows: [{ sourceIssueId: issue.id, trigger: decision.trigger }],
                  },
                ],
              },
            });
            await db.insert(activityLog).values({
              companyId,
              actorType: "system",
              actorId: "system",
              action: "issue.productivity_review_refreshed",
              entityType: "issue",
              entityId: openReviewIssue.id,
              agentId: openReviewIssue.assigneeAgentId,
              details: { sourceIssueId: issue.id, trigger: decision.trigger, refreshCount: refreshStats.length + 1 },
            });
            refreshed += 1;
          }
          continue;
        }

        const reviewInput = buildProductivityReviewIssueInput({ sourceIssue: issue, trigger: decision.trigger });
        const reviewIssue = await issueService(db).create(companyId, reviewInput.issue);
        if (!reviewIssue) continue;
        created += 1;
        await db.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "system",
          action: "issue.productivity_review_created",
          entityType: "issue",
          entityId: issue.id,
          agentId: issue.assigneeAgentId,
          details: { reviewIssueId: reviewIssue.id, trigger: decision.trigger },
        });
        await db.insert(agentWakeupRequests).values({
          companyId,
          agentId: issue.assigneeAgentId!,
          source: "automation",
          triggerDetail: "recovery.productivity_review",
          reason: RECOVERY_ORIGIN_KINDS.issueProductivityReview,
          payload: buildProductivityReviewWakePayload({
            reviewIssueId: reviewIssue.id,
            sourceIssueId: issue.id,
            trigger: decision.trigger,
          }),
          status: "queued",
          idempotencyKey: `${RECOVERY_ORIGIN_KINDS.issueProductivityReview}:${issue.id}:${reviewIssue.id}`,
        });
      }

      return { checked: activeIssues.length, created, refreshed };
    },
  };
}
