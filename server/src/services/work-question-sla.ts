import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { activityLog, issues, workQuestions, type Db } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import { hubItemsService } from "./hub-items.js";
import { createNotification } from "./notifications.js";

export interface WorkQuestionSlaSweepResult {
  scanned: number;
  breached: number;
  notificationFailures: number;
}

export interface WorkQuestionSlaDependencies {
  createNotification?: typeof createNotification;
}

export function workQuestionSlaService(db: Db, dependencies: WorkQuestionSlaDependencies = {}) {
  const notify = dependencies.createNotification ?? createNotification;
  return {
    async processDue(now = new Date(), limit = 100): Promise<WorkQuestionSlaSweepResult> {
      const candidates = await db
        .select({ id: workQuestions.id, companyId: workQuestions.companyId })
        .from(workQuestions)
        .where(and(
          eq(workQuestions.status, "open"),
          isNull(workQuestions.slaNotificationsCompletedAt),
          lte(workQuestions.dueAt, now),
        ))
        .orderBy(asc(workQuestions.dueAt), asc(workQuestions.id))
        .limit(Math.max(1, Math.min(limit, 500)));

      let breached = 0;
      let notificationFailures = 0;
      for (const candidate of candidates) {
        const accepted = await db.transaction(async (txRaw) => {
          const tx = txRaw as unknown as Db;
          const current = await tx
            .select()
            .from(workQuestions)
            .where(and(
              eq(workQuestions.id, candidate.id),
              eq(workQuestions.companyId, candidate.companyId),
              eq(workQuestions.status, "open"),
              isNull(workQuestions.slaNotificationsCompletedAt),
              lte(workQuestions.dueAt, now),
            ))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!current) return null;
          const newlyBreached = current.slaBreachedAt === null;
          const updated = newlyBreached
            ? await tx.update(workQuestions).set({
              slaBreachedAt: now,
              version: sql`${workQuestions.version} + 1`,
              updatedAt: now,
            }).where(and(
              eq(workQuestions.id, current.id),
              eq(workQuestions.companyId, current.companyId),
              isNull(workQuestions.slaBreachedAt),
            )).returning().then((rows) => rows[0] ?? current)
            : current;
          const issue = updated.issueId
            ? await tx.select({ projectId: issues.projectId })
              .from(issues)
              .where(and(eq(issues.companyId, updated.companyId), eq(issues.id, updated.issueId)))
              .then((rows) => rows[0] ?? null)
            : null;
          if (newlyBreached) {
            await hubItemsService(tx).emit({
              companyId: updated.companyId,
              semanticType: "work_question",
              sourceType: "work_question",
              sourceId: updated.id,
              title: updated.title,
              summary: updated.question,
              relatedEntityType: "issue",
              relatedEntityId: updated.issueId,
              scopeKey: issue?.projectId ?? null,
              priority: "urgent",
              ownerUserId: updated.currentRecipientUserId,
              sourceActorType: "agent",
              sourceActorId: updated.askingAgentId,
              sourcePermissionRevision: `${updated.version}:${now.toISOString()}`,
              slaAt: updated.dueAt,
              executor: tx,
            });
            await tx.insert(activityLog).values({
              companyId: updated.companyId,
              actorType: "system",
              actorId: "work-question-sla",
              action: "work_question.sla_breached",
              entityType: "work_question",
              entityId: updated.id,
              details: {
                dueAt: updated.dueAt.toISOString(),
                currentRecipientUserId: updated.currentRecipientUserId,
                escalationRecipientUserId: updated.escalationRecipientUserId,
                slaDurationHours: updated.slaDurationHours,
                slaSource: updated.slaSource,
                slaSourceId: updated.slaSourceId,
              },
            });
          }
          return { question: updated, newlyBreached };
        });
        if (!accepted) continue;
        if (accepted.newlyBreached) breached += 1;

        const recipients = new Set([
          accepted.question.currentRecipientUserId,
          accepted.question.escalationRecipientUserId,
        ].filter((value): value is string => Boolean(value)));
        let notificationComplete = true;
        for (const userId of recipients) {
          try {
            await notify(db, {
              companyId: accepted.question.companyId,
              userId,
              type: "work_question.sla_breached",
              title: `Question overdue: ${accepted.question.title}`,
              message: `${accepted.question.askingAgentNameSnapshot ?? "An agent"} is waiting for a human response. The original recipient has not been changed.`,
              relatedEntityType: "issue",
              relatedEntityId: accepted.question.issueId,
              idempotencyKey: `work-question-sla:${accepted.question.id}:${userId}`,
            });
          } catch (error) {
            notificationComplete = false;
            notificationFailures += 1;
            logger.error(
              { error, companyId: accepted.question.companyId, questionId: accepted.question.id, userId },
              "work-question SLA breach notification failed",
            );
          }
        }
        if (notificationComplete) {
          await db.update(workQuestions).set({
            slaNotificationsCompletedAt: now,
            updatedAt: now,
          }).where(and(
            eq(workQuestions.companyId, accepted.question.companyId),
            eq(workQuestions.id, accepted.question.id),
            eq(workQuestions.status, "open"),
            isNull(workQuestions.slaNotificationsCompletedAt),
          ));
        }
      }

      return { scanned: candidates.length, breached, notificationFailures };
    },
  };
}
