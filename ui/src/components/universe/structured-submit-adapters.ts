import {
  answerWorkQuestionSchema,
  runtimeDecisionAnswerSchema,
  type AnswerWorkQuestionInput,
  type RuntimeDecisionAnswerInput,
  type UniverseDraftPayload,
} from "@armyofagents/shared";

type QuestionPayload = Extract<UniverseDraftPayload, { kind: "question" }>;
type RuntimePayload = Extract<UniverseDraftPayload, { kind: "runtime_decision" }>;
type ApprovalPayload = Extract<UniverseDraftPayload, { kind: "approval" }>;

export function buildWorkQuestionSubmission(
  payload: QuestionPayload,
  idempotencyKey: string,
  canonicalOptionValues: readonly string[],
): AnswerWorkQuestionInput {
  const allowed = new Set(canonicalOptionValues);
  if (payload.selectedValues.some((value) => !allowed.has(value))) {
    throw new Error("The work-question option changed; review the current question before sending");
  }
  return answerWorkQuestionSchema.parse({
    answer: {
      ...(payload.text.trim() ? { text: payload.text.trim() } : {}),
      ...(payload.selectedValues.length ? { selectedValues: payload.selectedValues } : {}),
    },
    expectedVersion: payload.expectedVersion,
    idempotencyKey,
  });
}

export function buildRuntimeDecisionSubmission(
  payload: RuntimePayload,
  canonical: {
    sourceRevision: number;
    nonce: string;
    idempotencyKey: string;
  },
): RuntimeDecisionAnswerInput {
  if (payload.expectedSourceRevision !== canonical.sourceRevision) {
    throw new Error("The runtime decision changed; review it before sending");
  }
  const common = {
    expectedSourceRevision: payload.expectedSourceRevision,
    nonce: canonical.nonce,
    idempotencyKey: canonical.idempotencyKey,
  };
  return runtimeDecisionAnswerSchema.parse(
    payload.answer.kind === "permission"
      ? { ...common, kind: "permission", decision: payload.answer.decision }
      : { ...common, kind: "work_question", answer: payload.answer.fields },
  );
}

export function buildApprovalSubmission(
  payload: ApprovalPayload,
  canonicalUpdatedAt: string,
): { action: "approve" | "reject"; decisionNote?: string } {
  if (payload.observedUpdatedAt !== canonicalUpdatedAt) {
    throw new Error("The approval changed; review it before sending");
  }
  if (!payload.decision) throw new Error("Choose approve or reject before sending");
  return {
    action: payload.decision,
    ...(payload.decisionNote.trim() ? { decisionNote: payload.decisionNote.trim() } : {}),
  };
}
