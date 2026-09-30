import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  internalAgentRuns,
  issues,
  workQuestionContinuationRequests,
  workQuestions,
  type Db,
} from "@armyofagents/db";
import type { WorkQuestionContinuationEnvelope } from "@armyofagents/shared";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "./heartbeat.js";
import {
  bindInternalAgentWorkQuestionContinuation,
  finalizeHeartbeatWorkQuestionContinuation,
  finalizeInternalAgentWorkQuestionContinuation,
} from "./work-question-continuation-terminal.js";

const MAX_ATTEMPTS = 5;
const BASE_RETRY_MS = 5_000;
const CLAIM_LEASE_MS = 2 * 60 * 1000;

export interface WorkQuestionContinuationHeartbeatInput {
  companyId: string;
  agentId: string;
  issueId: string | null;
  questionId: string;
  question: string;
  answer: unknown;
  answerVersion: number;
  sourceDiscussionId: string | null;
  sourceCommanderConversationId: string | null;
  continuationEnvelope: WorkQuestionContinuationEnvelope;
  humanQuestionWaitMs: number;
  idempotencyKey: string;
}

export type WorkQuestionContinuationCrewInput = WorkQuestionContinuationHeartbeatInput;

interface EnqueuedContinuation {
  id: string | null;
  wakeupRequestId: string | null;
}

class ContinuationClaimLostError extends Error {
  constructor() {
    super("Continuation claim was cancelled or reclaimed before dispatch committed");
  }
}

export interface WorkQuestionContinuationDependencies {
  enqueueHeartbeat?: (
    input: WorkQuestionContinuationHeartbeatInput,
    executor?: Db,
  ) => Promise<{ id: string | null; wakeupRequestId?: string | null } | null>;
  enqueueCrew?: (
    input: WorkQuestionContinuationCrewInput,
    executor?: Db,
  ) => Promise<EnqueuedContinuation | null>;
}

export function workQuestionContinuationService(
  db: Db,
  dependencies: WorkQuestionContinuationDependencies = {},
) {
  async function enqueueHeartbeat(
    input: WorkQuestionContinuationHeartbeatInput,
    beforeIssueWakeCommit: (
      tx: Db,
      continuation: EnqueuedContinuation,
    ) => Promise<void>,
  ) {
    const existingWakeup = await db
      .select({ runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
      ))
      .then((rows) => rows.find((row) => row.runId) ?? null);
    if (existingWakeup?.runId) {
      const existingRun = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.id, existingWakeup.runId),
        ))
        .then((rows) => rows[0] ?? null);
      if (existingRun) return { ...existingRun, wakeupRequestId: null };
    }

    const run = await heartbeatService(db).wakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "work_question_continuation",
      payload: {
        issueId: input.issueId,
        questionId: input.questionId,
        question: input.question,
        answer: input.answer,
        answerVersion: input.answerVersion,
        sourceDiscussionId: input.sourceDiscussionId,
        sourceCommanderConversationId: input.sourceCommanderConversationId,
        continuationEnvelope: input.continuationEnvelope,
        humanQuestionWaitMs: input.humanQuestionWaitMs,
      },
      contextSnapshot: {
        issueId: input.issueId,
        source: "work_question_continuation",
        questionId: input.questionId,
        answerVersion: input.answerVersion,
        continuationEnvelope: input.continuationEnvelope,
        humanQuestionWaitMs: input.humanQuestionWaitMs,
      },
      requestedByActorType: "system",
      requestedByActorId: "work-question-continuation",
      idempotencyKey: input.idempotencyKey,
      beforeIssueWakeCommit,
    });
    if (run) return { ...run, wakeupRequestId: null };

    const deferred = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ))
      .then((rows) => rows[0] ?? null);
    return deferred ? { id: null, wakeupRequestId: deferred.id } : null;
  }

  async function enqueueCrew(
    input: WorkQuestionContinuationCrewInput,
    executor: Db = db,
  ): Promise<EnqueuedContinuation | null> {
    if (dependencies.enqueueCrew) return dependencies.enqueueCrew(input, executor);

    const inserted = await executor.insert(agentWakeupRequests).values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "work_question_continuation",
      triggerDetail: "system",
      reason: "work_question_continuation",
      payload: {
        issueId: input.issueId,
        questionId: input.questionId,
        question: input.question,
        answer: input.answer,
        answerVersion: input.answerVersion,
        sourceDiscussionId: input.sourceDiscussionId,
        sourceCommanderConversationId: input.sourceCommanderConversationId,
        continuationEnvelope: input.continuationEnvelope,
        humanQuestionWaitMs: input.humanQuestionWaitMs,
        continuationIdempotencyKey: input.idempotencyKey,
      },
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "work-question-continuation",
      idempotencyKey: input.idempotencyKey,
    }).onConflictDoNothing().returning({
      id: agentWakeupRequests.id,
      runId: agentWakeupRequests.runId,
    }).then((rows) => rows[0] ?? null);
    const wakeup = inserted ?? await executor.select({
      id: agentWakeupRequests.id,
      runId: agentWakeupRequests.runId,
    }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
    )).then((rows) => rows[0] ?? null);
    return wakeup ? { id: wakeup.runId, wakeupRequestId: wakeup.id } : null;
  }

  async function claimDue(now: Date, limit: number) {
    const claimable = or(
      and(
        eq(workQuestionContinuationRequests.status, "pending"),
        lte(workQuestionContinuationRequests.nextAttemptAt, now),
      ),
      and(
        eq(workQuestionContinuationRequests.status, "claimed"),
        or(
          isNull(workQuestionContinuationRequests.leaseExpiresAt),
          lte(workQuestionContinuationRequests.leaseExpiresAt, now),
        ),
      ),
    );
    const candidates = await db
      .select({ id: workQuestionContinuationRequests.id })
      .from(workQuestionContinuationRequests)
      .where(claimable)
      .orderBy(asc(workQuestionContinuationRequests.nextAttemptAt))
      .limit(Math.min(limit, 100));
    const claimed: (typeof workQuestionContinuationRequests.$inferSelect)[] = [];
    for (const candidate of candidates) {
      const claimToken = randomUUID();
      const [row] = await db
        .update(workQuestionContinuationRequests)
        .set({
          status: "claimed",
          claimedAt: now,
          claimToken,
          leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
          attempts: sql`${workQuestionContinuationRequests.attempts} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(workQuestionContinuationRequests.id, candidate.id),
          claimable,
        ))
        .returning();
      if (row) claimed.push(row);
    }
    return claimed;
  }

  async function markFailed(
    request: typeof workQuestionContinuationRequests.$inferSelect,
    error: unknown,
  ) {
    const now = new Date();
    const terminal = request.attempts >= MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message : String(error);
    const retryDelay = BASE_RETRY_MS * 2 ** Math.max(0, request.attempts - 1);
    await db.transaction(async (tx) => {
      if (!request.claimToken) return;
      const [markedRequest] = await tx.update(workQuestionContinuationRequests).set({
        status: terminal ? "failed" : "pending",
        nextAttemptAt: terminal ? request.nextAttemptAt : new Date(now.getTime() + retryDelay),
        claimedAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        lastError: message.slice(0, 4000),
        updatedAt: now,
      }).where(and(
        eq(workQuestionContinuationRequests.id, request.id),
        eq(workQuestionContinuationRequests.status, "claimed"),
        eq(workQuestionContinuationRequests.claimToken, request.claimToken),
      )).returning({ id: workQuestionContinuationRequests.id });
      if (!markedRequest) return;
      await tx.update(workQuestions).set({
        continuationStatus: terminal ? "failed" : "pending",
        continuationError: message.slice(0, 4000),
        updatedAt: now,
      }).where(and(
        eq(workQuestions.companyId, request.companyId),
        eq(workQuestions.id, request.questionId),
        eq(workQuestions.continuationStatus, "pending"),
      ));
      if (terminal) {
        await tx.insert(activityLog).values({
          companyId: request.companyId,
          actorType: "system",
          actorId: "work-question-continuation",
          action: "work_question.continuation_failed",
          entityType: "work_question",
          entityId: request.questionId,
          details: { attempts: request.attempts, error: message.slice(0, 1000) },
        });
      }
    });
  }

  async function markDispatched(
    executor: Db,
    request: typeof workQuestionContinuationRequests.$inferSelect,
    continuationRun: EnqueuedContinuation,
  ) {
    if (!request.claimToken) return false;
    const now = new Date();
    const [markedRequest] = await executor.update(workQuestionContinuationRequests).set({
      status: "dispatched",
      dispatchedAt: now,
      claimedAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: now,
    }).where(and(
      eq(workQuestionContinuationRequests.id, request.id),
      eq(workQuestionContinuationRequests.status, "claimed"),
      eq(workQuestionContinuationRequests.claimToken, request.claimToken),
    )).returning({ id: workQuestionContinuationRequests.id });
    if (!markedRequest) return false;
    await executor.update(workQuestions).set({
      continuationStatus: "dispatched",
      continuationRunKind: request.targetRunKind,
      continuationRunId: continuationRun.id,
      continuationError: null,
      updatedAt: now,
    }).where(and(
      eq(workQuestions.companyId, request.companyId),
      eq(workQuestions.id, request.questionId),
      eq(workQuestions.continuationStatus, "pending"),
    ));
    await executor.insert(activityLog).values({
      companyId: request.companyId,
      actorType: "system",
      actorId: "work-question-continuation",
      action: "work_question.continuation_dispatched",
      entityType: "work_question",
      entityId: request.questionId,
      details: {
        targetRunKind: request.targetRunKind,
        targetAgentId: request.targetAgentId,
        continuationRunKind: request.targetRunKind,
        continuationRunId: continuationRun.id,
        wakeupRequestId: continuationRun.wakeupRequestId,
        answerVersion: request.answerVersion,
      },
    });
    return true;
  }

  async function enqueueAndCommitWithTaskLock(
    request: typeof workQuestionContinuationRequests.$inferSelect,
    input: WorkQuestionContinuationHeartbeatInput,
    enqueue: (
      continuationInput: WorkQuestionContinuationHeartbeatInput,
      executor: Db,
    ) => Promise<{ id: string | null; wakeupRequestId?: string | null } | null>,
  ) {
    if (!input.issueId) return false;
    const issueId = input.issueId;
    return db.transaction(async (tx) => {
      const executor = tx as unknown as Db;
      await tx.execute(sql`
        select id
        from issues
        where id = ${issueId} and company_id = ${input.companyId}
        for update
      `);
      const eligibleIssue = await tx.select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      }).from(issues).where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.id, issueId),
      )).then((rows) => rows[0] ?? null);
      if (
        !eligibleIssue
        || eligibleIssue.status !== "in_progress"
        || eligibleIssue.assigneeAgentId !== input.agentId
      ) return false;

      const enqueued = await enqueue(input, executor);
      if (!enqueued) throw new Error("Continuation execution was not enqueued");
      const committed = await markDispatched(executor, request, {
        id: enqueued.id,
        wakeupRequestId: enqueued.wakeupRequestId ?? null,
      });
      if (!committed) throw new ContinuationClaimLostError();
      return true;
    });
  }

  async function dispatch(request: typeof workQuestionContinuationRequests.$inferSelect) {
    try {
      const question = await db
        .select()
        .from(workQuestions)
        .where(and(
          eq(workQuestions.companyId, request.companyId),
          eq(workQuestions.id, request.questionId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!question || question.status !== "answered" || question.continuationStatus !== "pending") {
        if (!request.claimToken) return { requestId: request.id, status: "cancelled" as const };
        await db.update(workQuestionContinuationRequests).set({
          status: "cancelled",
          claimedAt: null,
          claimToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(workQuestionContinuationRequests.id, request.id),
          eq(workQuestionContinuationRequests.status, "claimed"),
          eq(workQuestionContinuationRequests.claimToken, request.claimToken),
        ));
        return { requestId: request.id, status: "cancelled" as const };
      }
      if (!request.targetAgentId) throw new Error("Continuation target agent no longer exists");
      if (!request.continuationEnvelope) {
        throw new Error("Continuation request is missing its immutable envelope");
      }
      const issue = question.issueId
        ? await db.select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        }).from(issues).where(and(
          eq(issues.companyId, request.companyId),
          eq(issues.id, question.issueId),
        )).then((rows) => rows[0] ?? null)
        : null;
      if (
        !issue ||
        issue.status !== "in_progress" ||
        issue.assigneeAgentId !== request.targetAgentId
      ) {
        const now = new Date();
        await db.transaction(async (tx) => {
          if (!request.claimToken) return;
          const [markedRequest] = await tx.update(workQuestionContinuationRequests).set({
            status: "cancelled",
            claimedAt: null,
            claimToken: null,
            leaseExpiresAt: null,
            lastError: "Task is no longer eligible for continuation",
            updatedAt: now,
          }).where(and(
            eq(workQuestionContinuationRequests.id, request.id),
            eq(workQuestionContinuationRequests.status, "claimed"),
            eq(workQuestionContinuationRequests.claimToken, request.claimToken),
          )).returning({ id: workQuestionContinuationRequests.id });
          if (!markedRequest) return;
          await tx.update(workQuestions).set({
            continuationStatus: "not_needed",
            continuationError: "Task is no longer eligible for continuation",
            updatedAt: now,
          }).where(and(
            eq(workQuestions.companyId, request.companyId),
            eq(workQuestions.id, request.questionId),
            eq(workQuestions.continuationStatus, "pending"),
          ));
          await tx.insert(activityLog).values({
            companyId: request.companyId,
            actorType: "system",
            actorId: "work-question-continuation",
            action: "work_question.continuation_cancelled",
            entityType: "work_question",
            entityId: request.questionId,
            details: {
              reason: !issue
                ? "task_missing"
                : issue.status !== "in_progress"
                  ? "task_not_in_progress"
                  : "task_reassigned",
            },
          });
        });
        return { requestId: request.id, status: "cancelled" as const };
      }
      const agent = await db.select({ id: agents.id, kind: agents.kind, status: agents.status }).from(agents).where(and(
        eq(agents.companyId, request.companyId),
        eq(agents.id, request.targetAgentId),
      )).then((rows) => rows[0] ?? null);
      if (!agent || agent.status === "terminated" || agent.status === "pending_approval") {
        throw new Error("Continuation target agent is not invokable");
      }
      if (request.targetRunKind === "heartbeat" && agent.kind !== "org") {
        throw new Error("Heartbeat continuation target is not an organization agent");
      }
      if (request.targetRunKind === "internal_agent" && agent.kind !== "aoa") {
        throw new Error("Internal-agent continuation target is not an AoA Crew agent");
      }

      const continuationInput = {
        companyId: request.companyId,
        agentId: request.targetAgentId,
        issueId: question.issueId,
        questionId: question.id,
        question: question.question,
        answer: question.answer,
        answerVersion: request.answerVersion,
        sourceDiscussionId: question.sourceDiscussionId,
        sourceCommanderConversationId: question.sourceCommanderConversationId,
        continuationEnvelope: request.continuationEnvelope,
        humanQuestionWaitMs: Math.max(
          0,
          (question.answeredAt?.getTime() ?? question.updatedAt.getTime()) - question.createdAt.getTime(),
        ),
        idempotencyKey: request.downstreamIdempotencyKey,
      };
      let committed = false;
      if (request.targetRunKind === "internal_agent") {
        committed = await enqueueAndCommitWithTaskLock(request, continuationInput, enqueueCrew);
      } else if (dependencies.enqueueHeartbeat) {
        committed = await enqueueAndCommitWithTaskLock(
          request,
          continuationInput,
          dependencies.enqueueHeartbeat,
        );
      } else {
        let finalizedInWakeupTransaction = false;
        const continuationRun = await enqueueHeartbeat(
          continuationInput,
          async (tx, enqueued) => {
            const finalized = await markDispatched(tx, request, enqueued);
            if (!finalized) throw new ContinuationClaimLostError();
            finalizedInWakeupTransaction = true;
          },
        );
        if (!continuationRun) throw new Error("Continuation execution was not enqueued");
        committed = finalizedInWakeupTransaction || await db.transaction(async (tx) =>
          markDispatched(tx as unknown as Db, request, continuationRun));
      }
      if (!committed) return { requestId: request.id, status: "cancelled" as const };
      return { requestId: request.id, status: "dispatched" as const };
    } catch (error) {
      if (error instanceof ContinuationClaimLostError) {
        return { requestId: request.id, status: "cancelled" as const };
      }
      await markFailed(request, error);
      logger.warn(
        { err: error, requestId: request.id, questionId: request.questionId },
        "work-question continuation dispatch failed",
      );
      return { requestId: request.id, status: "failed" as const };
    }
  }

  async function reconcileHeartbeatTerminals(limit = 200) {
    const rows = await db
      .select({
        companyId: workQuestions.companyId,
        runId: heartbeatRuns.id,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
      })
      .from(workQuestions)
      .innerJoin(heartbeatRuns, and(
        eq(heartbeatRuns.companyId, workQuestions.companyId),
        eq(heartbeatRuns.id, workQuestions.continuationRunId),
      ))
      .where(and(
        eq(workQuestions.continuationRunKind, "heartbeat"),
        eq(workQuestions.continuationStatus, "dispatched"),
        inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out"]),
      ))
      .limit(Math.min(limit, 500));

    let finalized = 0;
    for (const row of rows) {
      const questionId = await finalizeHeartbeatWorkQuestionContinuation(db, {
        companyId: row.companyId,
        runId: row.runId,
        status: row.status as "succeeded" | "failed" | "cancelled" | "timed_out",
        error: row.error,
      });
      if (questionId) finalized += 1;
    }
    return finalized;
  }

  async function reconcileInternalAgentTerminals(limit = 200) {
    const cappedLimit = Math.min(limit, 500);
    const boundRows = await db
      .select({
        questionId: workQuestions.id,
        companyId: workQuestions.companyId,
        runId: internalAgentRuns.id,
        status: internalAgentRuns.status,
        error: internalAgentRuns.errorMessage,
      })
      .from(workQuestions)
      .innerJoin(workQuestionContinuationRequests, and(
        eq(workQuestionContinuationRequests.companyId, workQuestions.companyId),
        eq(workQuestionContinuationRequests.questionId, workQuestions.id),
        eq(workQuestionContinuationRequests.status, "dispatched"),
      ))
      .innerJoin(internalAgentRuns, and(
        eq(internalAgentRuns.companyId, workQuestions.companyId),
        eq(internalAgentRuns.id, workQuestions.continuationRunId),
      ))
      .where(and(
        eq(workQuestions.continuationRunKind, "internal_agent"),
        eq(workQuestions.continuationStatus, "dispatched"),
        inArray(internalAgentRuns.status, ["completed", "failed", "cancelled"]),
      ))
      .limit(cappedLimit);

    // The wakeup row is the durable authority for the run when the runner
    // inserted and terminalized a run but its initial bind transaction failed.
    // Order newest-first so a historical duplicate idempotency row cannot bind
    // an older attempt over the wakeup that most recently owned dispatch.
    const unboundRows = boundRows.length >= cappedLimit
      ? []
      : await db
          .select({
            questionId: workQuestions.id,
            companyId: workQuestions.companyId,
            idempotencyKey: workQuestionContinuationRequests.downstreamIdempotencyKey,
            runId: internalAgentRuns.id,
            status: internalAgentRuns.status,
            error: internalAgentRuns.errorMessage,
          })
          .from(workQuestions)
          .innerJoin(workQuestionContinuationRequests, and(
            eq(workQuestionContinuationRequests.companyId, workQuestions.companyId),
            eq(workQuestionContinuationRequests.questionId, workQuestions.id),
            eq(workQuestionContinuationRequests.status, "dispatched"),
          ))
          .innerJoin(agentWakeupRequests, and(
            eq(agentWakeupRequests.companyId, workQuestions.companyId),
            eq(agentWakeupRequests.idempotencyKey, workQuestionContinuationRequests.downstreamIdempotencyKey),
          ))
          .innerJoin(internalAgentRuns, and(
            eq(internalAgentRuns.companyId, workQuestions.companyId),
            eq(internalAgentRuns.id, agentWakeupRequests.runId),
          ))
          .where(and(
            eq(workQuestions.continuationRunKind, "internal_agent"),
            eq(workQuestions.continuationStatus, "dispatched"),
            isNull(workQuestions.continuationRunId),
            inArray(agentWakeupRequests.status, ["succeeded", "failed", "cancelled"]),
            inArray(internalAgentRuns.status, ["completed", "failed", "cancelled"]),
          ))
          .orderBy(asc(workQuestions.id), desc(agentWakeupRequests.updatedAt))
          .limit(cappedLimit - boundRows.length);

    let finalized = 0;
    const seenQuestions = new Set<string>();
    for (const row of boundRows) {
      seenQuestions.add(row.questionId);
      const questionId = await finalizeInternalAgentWorkQuestionContinuation(db, {
        companyId: row.companyId,
        runId: row.runId,
        status: row.status as "completed" | "failed" | "cancelled",
        error: row.error,
      });
      if (questionId) finalized += 1;
    }
    for (const row of unboundRows) {
      if (seenQuestions.has(row.questionId)) continue;
      seenQuestions.add(row.questionId);
      const bound = await bindInternalAgentWorkQuestionContinuation(db, {
        companyId: row.companyId,
        runId: row.runId,
        idempotencyKey: row.idempotencyKey,
      });
      if (!bound) continue;
      const questionId = await finalizeInternalAgentWorkQuestionContinuation(db, {
        companyId: row.companyId,
        runId: row.runId,
        status: row.status as "completed" | "failed" | "cancelled",
        error: row.error,
      });
      if (questionId) finalized += 1;
    }
    return finalized;
  }

  return {
    claimDue,
    dispatch,
    reconcileHeartbeatTerminals,
    reconcileInternalAgentTerminals,
    async processDue(now = new Date(), limit = 25) {
      await Promise.all([
        reconcileHeartbeatTerminals(),
        reconcileInternalAgentTerminals(),
      ]);
      const results = [];
      let claimedCount = 0;
      for (let index = 0; index < Math.min(limit, 100); index += 1) {
        const [request] = await claimDue(index === 0 ? now : new Date(), 1);
        if (!request) break;
        claimedCount += 1;
        results.push(await dispatch(request));
      }
      return {
        claimed: claimedCount,
        dispatched: results.filter((result) => result.status === "dispatched").length,
        failed: results.filter((result) => result.status === "failed").length,
        cancelled: results.filter((result) => result.status === "cancelled").length,
      };
    },
  };
}
