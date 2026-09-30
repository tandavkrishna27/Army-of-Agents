import type {
  PendingDraftAttempt,
  UniverseDraftPayload,
} from "@armyofagents/shared";

type StructuredKind = Extract<
  UniverseDraftPayload["kind"],
  "question" | "runtime_decision" | "approval"
>;

export interface StructuredDraftState {
  revision: number;
  payload: UniverseDraftPayload;
  pendingAttempt: PendingDraftAttempt | null;
}

export interface FrozenStructuredAttempt {
  payload: UniverseDraftPayload;
  attempt: PendingDraftAttempt;
}

export function createStructuredAttempt(input: {
  kind: StructuredKind;
  draftRevision: number;
  payloadHash: string;
  attemptId: string;
  idempotencyKey?: string;
}): PendingDraftAttempt {
  if (input.kind === "approval" && input.idempotencyKey) {
    throw new Error("Approval attempts cannot invent an idempotency key");
  }
  if (input.kind !== "approval" && !input.idempotencyKey) {
    throw new Error(`${input.kind} attempts require their source idempotency key`);
  }
  return {
    attemptId: input.attemptId,
    draftRevision: input.draftRevision,
    payloadHash: input.payloadHash,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    state: "pending",
  };
}

export function markStructuredAttemptUnknown(
  attempt: PendingDraftAttempt,
): PendingDraftAttempt {
  return { ...attempt, state: "unknown" };
}

function samePayload(a: UniverseDraftPayload, b: UniverseDraftPayload) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emptyStructuredPayload(payload: UniverseDraftPayload): UniverseDraftPayload {
  switch (payload.kind) {
    case "question":
      return { ...payload, text: "", selectedValues: [] };
    case "runtime_decision":
      return payload.answer.kind === "permission"
        ? { ...payload, answer: { ...payload.answer, decision: null } }
        : { ...payload, answer: { ...payload.answer, fields: {} } };
    case "approval":
      return { ...payload, decision: null, decisionNote: "" };
    default:
      throw new Error(`${payload.kind} is not a structured-answer draft`);
  }
}

/**
 * Applies a canonical acknowledgement to the exact frozen answer only. A newer
 * edit survives, while the matching pending marker is removed in both cases.
 * Approval attempts carry local correlation only; this helper never turns that
 * correlation into retry authority.
 */
export function acknowledgeStructuredAttempt(
  current: StructuredDraftState,
  sent: FrozenStructuredAttempt,
): StructuredDraftState {
  const matchingAttempt = current.pendingAttempt?.attemptId === sent.attempt.attemptId;
  if (!matchingAttempt) return current;
  const unchanged =
    current.revision === sent.attempt.draftRevision &&
    current.payload.kind === sent.payload.kind &&
    samePayload(current.payload, sent.payload);
  return {
    ...current,
    payload: unchanged ? emptyStructuredPayload(current.payload) : current.payload,
    pendingAttempt: null,
  };
}
