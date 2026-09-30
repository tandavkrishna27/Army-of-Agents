import { and, eq, isNull, or } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  workQuestionContinuationRequests,
  workQuestions,
  type Db,
} from "@armyofagents/db";

export type HeartbeatContinuationTerminalStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type InternalAgentContinuationTerminalStatus = "completed" | "failed" | "cancelled";

export async function bindHeartbeatWorkQuestionContinuation(
  db: Db,
  input: { companyId: string; runId: string; idempotencyKey: string },
) {
  const request = await db.select({ questionId: workQuestionContinuationRequests.questionId })
    .from(workQuestionContinuationRequests)
    .where(and(
      eq(workQuestionContinuationRequests.companyId, input.companyId),
      eq(workQuestionContinuationRequests.downstreamIdempotencyKey, input.idempotencyKey),
      eq(workQuestionContinuationRequests.targetRunKind, "heartbeat"),
      eq(workQuestionContinuationRequests.status, "dispatched"),
    ))
    .then((rows) => rows[0] ?? null);
  if (!request) return null;

  const [question] = await db.update(workQuestions).set({
    continuationRunId: input.runId,
    updatedAt: new Date(),
  }).where(and(
    eq(workQuestions.companyId, input.companyId),
    eq(workQuestions.id, request.questionId),
    eq(workQuestions.status, "answered"),
    eq(workQuestions.continuationRunKind, "heartbeat"),
    eq(workQuestions.continuationStatus, "dispatched"),
    or(isNull(workQuestions.continuationRunId), eq(workQuestions.continuationRunId, input.runId)),
  )).returning({ id: workQuestions.id });
  return question?.id ?? null;
}

export async function bindInternalAgentWorkQuestionContinuation(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    idempotencyKey: string;
    agentId?: string;
    wakeupId?: string;
  },
) {
  return db.transaction(async (tx) => {
    if (input.wakeupId && input.agentId) {
      await tx.update(agentWakeupRequests).set({
        runId: input.runId,
        updatedAt: new Date(),
      }).where(and(
        eq(agentWakeupRequests.id, input.wakeupId),
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        eq(agentWakeupRequests.status, "processing"),
        or(isNull(agentWakeupRequests.runId), eq(agentWakeupRequests.runId, input.runId)),
      ));
    }

    const request = await tx.select({ questionId: workQuestionContinuationRequests.questionId })
      .from(workQuestionContinuationRequests)
      .where(and(
        eq(workQuestionContinuationRequests.companyId, input.companyId),
        eq(workQuestionContinuationRequests.downstreamIdempotencyKey, input.idempotencyKey),
        eq(workQuestionContinuationRequests.targetRunKind, "internal_agent"),
        eq(workQuestionContinuationRequests.status, "dispatched"),
      ))
      .then((rows) => rows[0] ?? null);
    if (!request) return null;

    const [question] = await tx.update(workQuestions).set({
      continuationRunId: input.runId,
      updatedAt: new Date(),
    }).where(and(
      eq(workQuestions.id, request.questionId),
      eq(workQuestions.companyId, input.companyId),
      eq(workQuestions.continuationRunKind, "internal_agent"),
      eq(workQuestions.continuationStatus, "dispatched"),
      or(isNull(workQuestions.continuationRunId), eq(workQuestions.continuationRunId, input.runId)),
    )).returning({ id: workQuestions.id });
    return question?.id ?? null;
  });
}

export async function failUnstartedInternalAgentWorkQuestionContinuation(
  db: Db,
  input: { companyId: string; idempotencyKey: string; error: string },
) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [request] = await tx.update(workQuestionContinuationRequests).set({
      status: "failed",
      lastError: input.error.slice(0, 4000),
      updatedAt: now,
    }).where(and(
      eq(workQuestionContinuationRequests.companyId, input.companyId),
      eq(workQuestionContinuationRequests.downstreamIdempotencyKey, input.idempotencyKey),
      eq(workQuestionContinuationRequests.targetRunKind, "internal_agent"),
      eq(workQuestionContinuationRequests.status, "dispatched"),
    )).returning({ questionId: workQuestionContinuationRequests.questionId });
    if (!request) return null;
    const [question] = await tx.update(workQuestions).set({
      continuationStatus: "failed",
      continuationError: input.error.slice(0, 4000),
      updatedAt: now,
    }).where(and(
      eq(workQuestions.id, request.questionId),
      eq(workQuestions.companyId, input.companyId),
      eq(workQuestions.continuationRunKind, "internal_agent"),
      eq(workQuestions.continuationStatus, "dispatched"),
      isNull(workQuestions.continuationRunId),
    )).returning({ id: workQuestions.id });
    if (!question) return null;
    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "work-question-continuation",
      action: "work_question.continuation_failed",
      entityType: "work_question",
      entityId: question.id,
      details: {
        continuationRunKind: "internal_agent",
        continuationRunId: null,
        runStatus: "not_started",
        error: input.error,
      },
    });
    return question.id;
  });
}

async function finalizeWorkQuestionContinuation(
  db: Db,
  input: {
    companyId: string;
    runKind: "heartbeat" | "internal_agent";
    runId: string;
    completed: boolean;
    runStatus: string;
    error?: string | null;
  },
) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [question] = await tx
      .update(workQuestions)
      .set({
        continuationStatus: input.completed ? "completed" : "failed",
        continuationError: input.completed
          ? null
          : (input.error ?? `Continuation run ${input.runStatus}`).slice(0, 4000),
        updatedAt: now,
      })
      .where(and(
        eq(workQuestions.companyId, input.companyId),
        eq(workQuestions.continuationRunKind, input.runKind),
        eq(workQuestions.continuationRunId, input.runId),
        eq(workQuestions.continuationStatus, "dispatched"),
      ))
      .returning({ id: workQuestions.id });
    if (!question) return null;

    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "work-question-continuation",
      action: input.completed
        ? "work_question.continuation_completed"
        : "work_question.continuation_failed",
      entityType: "work_question",
      entityId: question.id,
      details: {
        continuationRunKind: input.runKind,
        continuationRunId: input.runId,
        runStatus: input.runStatus,
        ...(input.completed ? {} : { error: input.error ?? null }),
      },
    });
    return question.id;
  });
}

export function finalizeHeartbeatWorkQuestionContinuation(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    status: HeartbeatContinuationTerminalStatus;
    error?: string | null;
  },
) {
  return finalizeWorkQuestionContinuation(db, {
    companyId: input.companyId,
    runKind: "heartbeat",
    runId: input.runId,
    completed: input.status === "succeeded",
    runStatus: input.status,
    error: input.error,
  });
}

export function finalizeInternalAgentWorkQuestionContinuation(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    status: InternalAgentContinuationTerminalStatus;
    error?: string | null;
  },
) {
  return finalizeWorkQuestionContinuation(db, {
    companyId: input.companyId,
    runKind: "internal_agent",
    runId: input.runId,
    completed: input.status === "completed",
    runStatus: input.status,
    error: input.error,
  });
}
