import { z } from "zod";
import { canonicalizeJsonV1 } from "./canonical-json.js";
import {
  artifactCommitPayloadV1Schema,
  artifactDownloadGrantV1Schema,
  artifactTransferGrantRequestV1Schema,
  artifactUploadGrantV1Schema,
  quarantineFinalizePayloadV1Schema,
  quarantineGrantPayloadV1Schema,
  quarantineUploadGrantV1Schema,
  quarantineUploadReceiptV1Schema,
} from "./artifacts.js";
import { workerCapacitySchema, workerHelloV1Schema } from "./capabilities.js";
import { protocolErrorCodeSchema, type ProtocolErrorCode } from "./errors.js";
import {
  permissionTimeoutPolicySchema,
  workQuestionTimeoutPolicySchema,
  type RuntimeDecisionRequestV1,
} from "./events.js";
import { workerEventAckV1Schema, workerEventBatchV1Schema } from "./events.js";
import {
  artifactIdSchema,
  attemptNumberSchema,
  companyIdSchema,
  fenceTokenSchema,
  jobIdSchema,
  leaseIdSchema,
  organizationIdSchema,
  sha256DigestSchema,
  targetIdSchema,
  workerIdSchema,
} from "./ids.js";
import {
  leaseAckV1Schema,
  leaseOfferV1Schema,
  leaseRenewRequestV1Schema,
  leaseRenewResponseV1Schema,
  providerConstraintRefV1Schema,
  timestampV1Schema,
} from "./job.js";
import { principalV1Schema } from "./source.js";
import { addForbiddenWireKeyIssues } from "./wire-safety.js";

// -----------------------------------------------------------------------------
// Framework-neutral operation request/response wrappers.
//
// Every operation NESTS the strict PRT-003/004/005 domain payload as `body`; the
// bare payload is NEVER sent as an authenticated request. HTTP method/path/status
// concerns stay OUT of this package — an operation carries only its protocol-level
// contract: `protocolVersion`, a correlation ID, an idempotency key where a
// mutation can be retried, the authentication audience (a binding literal, so a
// message presented to the wrong audience fails closed), a bounded anti-replay
// timestamp + nonce, and — on responses — `serverTime` plus `retryAfterMs` where
// a retry is meaningful. Per-operation payload ceilings, client timeouts, retry
// rules, and stable errors are contract facts in `OPERATION_DESCRIPTORS` +
// `operations.md`, not wire fields.
//
// Product approvals and runtime decisions are SEPARATE, versioned, idempotent
// controls issued on the control channel (never worker-creatable) and are NOT
// conflatable — a `product_approval_result` command cannot carry a runtime
// decision and vice versa (the discriminated union + `.strict()` enforce it).
//
// Operation pairing is CLOSED: an ordinary commit returns only committed|rejected;
// a device-authenticated quarantine grant returns only its short-lived PUT grant
// or a rejection; finalize returns only its verified receipt or a rejection; no
// stale ordinary commit is auto-converted to quarantine.
//
// The receiver-decision functions (`decideControlReceiverV1` /
// `decideEventReceiverV1`) are PURE — they specify how a later transactional
// receiver classifies a command/event against prior accepted state; Zod alone is
// not claimed to remember prior state.
//
// Runtime source imports only `zod` + relative modules and touches no Node API
// (`TextEncoder` is a standard global; never `Buffer`).
// -----------------------------------------------------------------------------

const encoder = new TextEncoder();
const nonNegativeIntSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveIntSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const correlationIdSchema = z.string().uuid();
const idempotencyKeySchema = z.string().uuid();

/** A UTF-8-byte-bounded non-empty string (bounds after encoding, not code units). */
function boundedUtf8(maxBytes: number): z.ZodEffects<z.ZodString, string, string> {
  return z.string().min(1).superRefine((value, ctx) => {
    if (encoder.encode(value).byteLength > maxBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `exceeds ${maxBytes} UTF-8 bytes` });
    }
  });
}

/** The anti-replay nonce carried by every operation request. */
const nonceSchema = boundedUtf8(200);

// The work-question answer bound is the SAME contract as the runtime_decision
// request option value (events.ts): ≤16 KiB canonical UTF-8 bytes, ≤8 container
// levels, and out-of-subset values (float/unsafe int/lone surrogate) fail closed.
// Both sit on the SINGLE shared canonicalizer `canonicalizeJsonV1`, so the byte
// semantics are identical; only this thin wrapper is local (transport is a
// distinct surface and the events schema does not export the wrapper).
const WORK_QUESTION_ANSWER_MAX_BYTES = 16_384;
const WORK_QUESTION_ANSWER_MAX_DEPTH = 8;

function addBoundedJsonDepthIssues(value: unknown, ctx: z.RefinementCtx, maxDepth: number): void {
  const walk = (node: unknown, depth: number, path: Array<string | number>): void => {
    if (Array.isArray(node)) {
      if (depth + 1 > maxDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `answer exceeds ${maxDepth} container levels` });
        return;
      }
      node.forEach((item, index) => walk(item, depth + 1, [...path, index]));
      return;
    }
    if (node !== null && typeof node === "object") {
      if (depth + 1 > maxDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `answer exceeds ${maxDepth} container levels` });
        return;
      }
      for (const key of Object.keys(node as Record<string, unknown>)) {
        walk((node as Record<string, unknown>)[key], depth + 1, [...path, key]);
      }
    }
  };
  walk(value, 0, []);
}

const workQuestionAnswerValueSchema = z.unknown().superRefine((value, ctx) => {
  addBoundedJsonDepthIssues(value, ctx, WORK_QUESTION_ANSWER_MAX_DEPTH);
  try {
    if (encoder.encode(canonicalizeJsonV1(value)).byteLength > WORK_QUESTION_ANSWER_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `answer exceeds ${WORK_QUESTION_ANSWER_MAX_BYTES} canonical UTF-8 bytes` });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "answer is not canonicalizable" });
  }
});

// --- Authentication audiences ------------------------------------------------

/** The closed set of operation authentication audiences. Each operation binds a
 * literal audience so a message presented to the wrong audience fails closed. */
export const AUTH_AUDIENCES = [
  "target_enrollment",
  "worker_poll",
  "worker_run",
  "device_session",
  "control_channel",
] as const;
export const authAudienceSchema = z.enum(AUTH_AUDIENCES);
export type AuthAudience = (typeof AUTH_AUDIENCES)[number];

// --- Shared envelope field shapes --------------------------------------------

const requestEnvelopeShape = {
  protocolVersion: z.literal(1),
  correlationId: correlationIdSchema,
  issuedAt: timestampV1Schema,
  nonce: nonceSchema,
} as const;

const responseEnvelopeShape = {
  protocolVersion: z.literal(1),
  correlationId: correlationIdSchema,
  serverTime: timestampV1Schema,
} as const;

/** The delivery identity a control command binds to a specific fenced run. */
const controlDeliveryIdentityShape = {
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  workerId: workerIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema,
} as const;

function forbiddenKeyRefine(value: unknown, ctx: z.RefinementCtx): void {
  addForbiddenWireKeyIssues(value, ctx);
}

// =============================================================================
// Enrollment.
// =============================================================================

export const enrollmentRequestV1Schema = z
  .object({
    ...requestEnvelopeShape,
    audience: z.literal("target_enrollment"),
    idempotencyKey: idempotencyKeySchema,
    hello: workerHelloV1Schema,
  })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type EnrollmentRequestV1 = z.infer<typeof enrollmentRequestV1Schema>;

export const enrollmentResponseV1Schema = z
  .discriminatedUnion("outcome", [
    z
      .object({
        ...responseEnvelopeShape,
        outcome: z.literal("enrolled"),
        workerId: workerIdSchema,
        targetId: targetIdSchema,
        deviceGeneration: positiveIntSchema,
        providerConstraints: providerConstraintRefV1Schema,
      })
      .strict(),
    z
      .object({
        ...responseEnvelopeShape,
        outcome: z.literal("rejected"),
        reason: protocolErrorCodeSchema,
        retryAfterMs: nonNegativeIntSchema.nullable(),
      })
      .strict(),
  ])
  .superRefine(forbiddenKeyRefine);
export type EnrollmentResponseV1 = z.infer<typeof enrollmentResponseV1Schema>;

// =============================================================================
// Poll (offer | no_work | drain).
// =============================================================================

export const pollRequestV1Schema = z
  .object({
    ...requestEnvelopeShape,
    audience: z.literal("worker_poll"),
    workerId: workerIdSchema,
    targetId: targetIdSchema,
    deviceGeneration: positiveIntSchema,
    capacity: workerCapacitySchema,
  })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type PollRequestV1 = z.infer<typeof pollRequestV1Schema>;

export const POLL_RESPONSE_OUTCOMES = ["offer", "no_work", "drain"] as const;

export const pollResponseV1Schema = z
  .discriminatedUnion("outcome", [
    z.object({ ...responseEnvelopeShape, outcome: z.literal("offer"), body: leaseOfferV1Schema }).strict(),
    z.object({ ...responseEnvelopeShape, outcome: z.literal("no_work"), retryAfterMs: nonNegativeIntSchema }).strict(),
    z
      .object({
        ...responseEnvelopeShape,
        outcome: z.literal("drain"),
        retryAfterMs: nonNegativeIntSchema.nullable(),
        reason: z.string().max(1000).nullable(),
      })
      .strict(),
  ])
  .superRefine(forbiddenKeyRefine);
export type PollResponseV1 = z.infer<typeof pollResponseV1Schema>;

// =============================================================================
// Lease ack / renew operations.
// =============================================================================

export const leaseAckOperationRequestV1Schema = z
  .object({
    ...requestEnvelopeShape,
    audience: z.literal("worker_run"),
    idempotencyKey: idempotencyKeySchema,
    body: leaseAckV1Schema,
  })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type LeaseAckOperationRequestV1 = z.infer<typeof leaseAckOperationRequestV1Schema>;

export const leaseAckOperationResponseV1Schema = z
  .discriminatedUnion("outcome", [
    z
      .object({ ...responseEnvelopeShape, outcome: z.literal("acknowledged"), leaseId: leaseIdSchema, expiresAt: timestampV1Schema })
      .strict(),
    z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict(),
  ])
  .superRefine(forbiddenKeyRefine);
export type LeaseAckOperationResponseV1 = z.infer<typeof leaseAckOperationResponseV1Schema>;

export const leaseRenewOperationRequestV1Schema = z
  .object({
    ...requestEnvelopeShape,
    audience: z.literal("worker_run"),
    idempotencyKey: idempotencyKeySchema,
    body: leaseRenewRequestV1Schema,
  })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type LeaseRenewOperationRequestV1 = z.infer<typeof leaseRenewOperationRequestV1Schema>;

export const leaseRenewOperationResponseV1Schema = z
  .discriminatedUnion("outcome", [
    z.object({ ...responseEnvelopeShape, outcome: z.literal("renewed"), body: leaseRenewResponseV1Schema }).strict(),
    z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict(),
  ])
  .superRefine(forbiddenKeyRefine);
export type LeaseRenewOperationResponseV1 = z.infer<typeof leaseRenewOperationResponseV1Schema>;

// =============================================================================
// Event upload.
// =============================================================================

export const eventUploadOperationRequestV1Schema = z
  .object({
    ...requestEnvelopeShape,
    audience: z.literal("worker_run"),
    idempotencyKey: idempotencyKeySchema,
    body: workerEventBatchV1Schema,
  })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type EventUploadOperationRequestV1 = z.infer<typeof eventUploadOperationRequestV1Schema>;

export const eventUploadOperationResponseV1Schema = z
  .object({ ...responseEnvelopeShape, ack: workerEventAckV1Schema })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type EventUploadOperationResponseV1 = z.infer<typeof eventUploadOperationResponseV1Schema>;

// =============================================================================
// Artifact transfer grant (upload_granted | download_granted | rejected).
// =============================================================================

export const artifactTransferGrantOperationRequestV1Schema = z
  .object({
    ...requestEnvelopeShape,
    audience: z.literal("worker_run"),
    idempotencyKey: idempotencyKeySchema,
    body: artifactTransferGrantRequestV1Schema,
  })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type ArtifactTransferGrantOperationRequestV1 = z.infer<typeof artifactTransferGrantOperationRequestV1Schema>;

export const ARTIFACT_TRANSFER_GRANT_OUTCOMES = ["upload_granted", "download_granted", "rejected"] as const;

export const artifactTransferGrantOperationResponseV1Schema = z
  .discriminatedUnion("outcome", [
    z.object({ ...responseEnvelopeShape, outcome: z.literal("upload_granted"), grant: artifactUploadGrantV1Schema }).strict(),
    z.object({ ...responseEnvelopeShape, outcome: z.literal("download_granted"), grant: artifactDownloadGrantV1Schema }).strict(),
    z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict(),
  ])
  .superRefine(forbiddenKeyRefine);
export type ArtifactTransferGrantOperationResponseV1 = z.infer<typeof artifactTransferGrantOperationResponseV1Schema>;

/** The CLOSED transfer-grant pairing: an upload request may only be answered by
 * `upload_granted` or `rejected`; a download request only by `download_granted`
 * or `rejected`. No cross grant is permitted. */
export function isTransferGrantResponsePairedV1(
  requestOperation: "upload" | "download",
  responseOutcome: string,
): boolean {
  if (responseOutcome === "rejected") return true;
  if (requestOperation === "upload") return responseOutcome === "upload_granted";
  if (requestOperation === "download") return responseOutcome === "download_granted";
  return false;
}

// =============================================================================
// Artifact commit (committed | rejected) — closed, never converts to quarantine.
// =============================================================================

export const artifactCommitOperationRequestV1Schema = z
  .object({
    ...requestEnvelopeShape,
    audience: z.literal("worker_run"),
    idempotencyKey: idempotencyKeySchema,
    body: artifactCommitPayloadV1Schema,
  })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type ArtifactCommitOperationRequestV1 = z.infer<typeof artifactCommitOperationRequestV1Schema>;

export const ARTIFACT_COMMIT_OUTCOMES = ["committed", "rejected"] as const;

export const artifactCommitOperationResponseV1Schema = z
  .discriminatedUnion("outcome", [
    z
      .object({
        ...responseEnvelopeShape,
        outcome: z.literal("committed"),
        artifactId: artifactIdSchema,
        versionNumber: positiveIntSchema,
        committedAt: timestampV1Schema,
      })
      .strict(),
    z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict(),
  ])
  .superRefine(forbiddenKeyRefine);
export type ArtifactCommitOperationResponseV1 = z.infer<typeof artifactCommitOperationResponseV1Schema>;

// =============================================================================
// Quarantine grant + finalize (device-authenticated; never a lease grant).
// =============================================================================

export const quarantineGrantOperationRequestV1Schema = z
  .object({
    ...requestEnvelopeShape,
    audience: z.literal("device_session"),
    idempotencyKey: idempotencyKeySchema,
    body: quarantineGrantPayloadV1Schema,
  })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type QuarantineGrantOperationRequestV1 = z.infer<typeof quarantineGrantOperationRequestV1Schema>;

export const quarantineGrantOperationResponseV1Schema = z
  .discriminatedUnion("outcome", [
    z
      .object({ ...responseEnvelopeShape, outcome: z.literal("quarantine_upload_granted"), grant: quarantineUploadGrantV1Schema })
      .strict(),
    z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict(),
  ])
  .superRefine(forbiddenKeyRefine);
export type QuarantineGrantOperationResponseV1 = z.infer<typeof quarantineGrantOperationResponseV1Schema>;

export const quarantineFinalizeOperationRequestV1Schema = z
  .object({
    ...requestEnvelopeShape,
    audience: z.literal("device_session"),
    idempotencyKey: idempotencyKeySchema,
    body: quarantineFinalizePayloadV1Schema,
  })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type QuarantineFinalizeOperationRequestV1 = z.infer<typeof quarantineFinalizeOperationRequestV1Schema>;

export const quarantineFinalizeOperationResponseV1Schema = z
  .discriminatedUnion("outcome", [
    z.object({ ...responseEnvelopeShape, outcome: z.literal("quarantined"), receipt: quarantineUploadReceiptV1Schema }).strict(),
    z.object({ ...responseEnvelopeShape, outcome: z.literal("rejected"), reason: protocolErrorCodeSchema }).strict(),
  ])
  .superRefine(forbiddenKeyRefine);
export type QuarantineFinalizeOperationResponseV1 = z.infer<typeof quarantineFinalizeOperationResponseV1Schema>;

// =============================================================================
// Product approval result (durable, versioned, idempotent — SEPARATE control).
// =============================================================================

export const PRODUCT_APPROVAL_DECISIONS = ["approved", "rejected", "expired"] as const;
export const productApprovalDecisionSchema = z.enum(PRODUCT_APPROVAL_DECISIONS);
export type ProductApprovalDecision = (typeof PRODUCT_APPROVAL_DECISIONS)[number];

export const governedActionRefSchema = z
  .object({ kind: z.string().min(1).max(100), id: z.string().uuid() })
  .strict();
export type GovernedActionRefV1 = z.infer<typeof governedActionRefSchema>;

/**
 * A durable product-approval result. It authorizes EXACTLY the bound
 * `governedActionRef` — it cannot authorize a different governed action. The
 * deciding principal is typed; the decision is versioned + idempotency-keyed so a
 * lost response can be re-delivered without re-approving.
 */
export const productApprovalResultV1Schema = z
  .object({
    approvalId: z.string().uuid(),
    approvalKind: z.string().min(1).max(100),
    approvalVersion: positiveIntSchema,
    decision: productApprovalDecisionSchema,
    decidedBy: principalV1Schema,
    decidedAt: timestampV1Schema,
    idempotencyKey: idempotencyKeySchema,
    governedActionRef: governedActionRefSchema,
  })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type ProductApprovalResultV1 = z.infer<typeof productApprovalResultV1Schema>;

/** True iff `result` authorizes exactly `action` (same governed action kind+id). */
export function productApprovalAuthorizesActionV1(result: ProductApprovalResultV1, action: GovernedActionRefV1): boolean {
  return (
    result.decision === "approved" &&
    String(result.governedActionRef.kind) === String(action.kind) &&
    String(result.governedActionRef.id) === String(action.id)
  );
}

// =============================================================================
// Runtime decision result (strict permission | work_question union — SEPARATE).
// =============================================================================

export const PERMISSION_DECISIONS = ["allow_once", "allow_run", "allow_always", "deny", "expired", "cancelled"] as const;
export const permissionDecisionSchema = z.enum(PERMISSION_DECISIONS);
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

export const WORK_QUESTION_OUTCOMES = ["answered", "expired", "cancelled"] as const;
export const workQuestionOutcomeSchema = z.enum(WORK_QUESTION_OUTCOMES);
export type WorkQuestionOutcome = (typeof WORK_QUESTION_OUTCOMES)[number];

/** The bound-request identity every runtime-decision result must echo verbatim. */
const runtimeDecisionResultCommonShape = {
  requestId: z.string().uuid(),
  nonce: nonceSchema,
  requestDigest: sha256DigestSchema,
  schemaVersion: positiveIntSchema,
  sourceRevision: nonNegativeIntSchema,
  expiresAt: timestampV1Schema,
  decidedBy: principalV1Schema,
  decidedAt: timestampV1Schema,
  idempotencyKey: idempotencyKeySchema,
} as const;

export const permissionRuntimeDecisionResultV1Schema = z
  .object({
    decisionKind: z.literal("permission"),
    ...runtimeDecisionResultCommonShape,
    timeoutPolicy: permissionTimeoutPolicySchema,
    decision: permissionDecisionSchema,
  })
  .strict();
export type PermissionRuntimeDecisionResultV1 = z.infer<typeof permissionRuntimeDecisionResultV1Schema>;

export const workQuestionRuntimeDecisionResultV1Schema = z
  .object({
    decisionKind: z.literal("work_question"),
    ...runtimeDecisionResultCommonShape,
    timeoutPolicy: workQuestionTimeoutPolicySchema,
    outcome: workQuestionOutcomeSchema,
    answer: workQuestionAnswerValueSchema.nullable(),
  })
  .strict();
export type WorkQuestionRuntimeDecisionResultV1 = z.infer<typeof workQuestionRuntimeDecisionResultV1Schema>;

/**
 * The strict runtime-decision result union answering a previously accepted
 * `runtime_decision_requested` event. Cross-kind fields are rejected by
 * `.strict()`; a permission decision is exactly one of the six permission
 * literals; a work-question answer is bounded (≤16 KiB canonical, ≤8 levels) and
 * required only for `answered` (the answer rule sits on the union `superRefine`
 * because `discriminatedUnion` members must be bare `ZodObject`s).
 */
export const runtimeDecisionResultV1Schema = z
  .discriminatedUnion("decisionKind", [permissionRuntimeDecisionResultV1Schema, workQuestionRuntimeDecisionResultV1Schema])
  .superRefine((result, ctx) => {
    if (result.decisionKind !== "work_question") return;
    const answered = result.outcome === "answered";
    if (answered && result.answer === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["answer"], message: "an answered work question requires an answer" });
    }
    if (!answered && result.answer !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["answer"], message: "answer must be null unless the outcome is answered" });
    }
  });
export type RuntimeDecisionResultV1 = z.infer<typeof runtimeDecisionResultV1Schema>;

/** Why a runtime-decision result failed to bind to its request (fail-closed). */
export const RUNTIME_DECISION_MATCH_REASONS = [
  "missing_request",
  "kind_mismatch",
  "request_mismatch",
  "expired",
] as const;
export type RuntimeDecisionMatchReason = (typeof RUNTIME_DECISION_MATCH_REASONS)[number];

export type RuntimeDecisionMatchResultV1 = { ok: true } | { ok: false; reason: RuntimeDecisionMatchReason };

/**
 * Bind a runtime-decision result to the previously accepted request. Fails closed
 * on: a missing request, a cross-kind pairing, any echoed-field mismatch
 * (requestId / nonce / requestDigest / schemaVersion / sourceRevision / expiry /
 * timeoutPolicy), or a late positive decision made after expiry. The worker may
 * REQUEST a decision but never mints the authoritative result, so this pairing is
 * evaluated by the control plane, never self-asserted.
 */
export function matchRuntimeDecisionResultToRequestV1(
  request: RuntimeDecisionRequestV1 | null | undefined,
  result: RuntimeDecisionResultV1,
): RuntimeDecisionMatchResultV1 {
  if (request === null || request === undefined) return { ok: false, reason: "missing_request" };
  if (request.decisionKind !== result.decisionKind) return { ok: false, reason: "kind_mismatch" };
  const echoed: Array<"requestId" | "nonce" | "requestDigest" | "schemaVersion" | "sourceRevision" | "expiresAt" | "timeoutPolicy"> = [
    "requestId",
    "nonce",
    "requestDigest",
    "schemaVersion",
    "sourceRevision",
    "expiresAt",
    "timeoutPolicy",
  ];
  for (const field of echoed) {
    if (String((request as Record<string, unknown>)[field]) !== String((result as Record<string, unknown>)[field])) {
      return { ok: false, reason: "request_mismatch" };
    }
  }
  const positive =
    result.decisionKind === "permission"
      ? result.decision !== "expired" && result.decision !== "cancelled"
      : result.outcome === "answered";
  if (positive && Date.parse(result.decidedAt) > Date.parse(result.expiresAt)) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

// =============================================================================
// Sequenced control commands + ACK.
// =============================================================================

export const CONTROL_COMMAND_KINDS = [
  "cancel",
  "product_approval_result",
  "runtime_decision_result",
  "checkpoint",
  "graceful_stop",
  "drain",
] as const;

const controlCommandBaseShape = {
  protocolVersion: z.literal(1),
  audience: z.literal("control_channel"),
  commandId: z.string().uuid(),
  commandSeq: positiveIntSchema,
  idempotencyKey: idempotencyKeySchema,
  issuedAt: timestampV1Schema,
  nonce: nonceSchema,
  ...controlDeliveryIdentityShape,
} as const;

/**
 * A durable, sequenced control command issued on the control channel. Product
 * approvals and runtime decisions are SEPARATE variants and are NOT conflatable.
 * Controls are never worker-creatable: the audience literal is `control_channel`
 * and the worker only ACKs.
 */
export const controlCommandV1Schema = z
  .discriminatedUnion("commandKind", [
    z.object({ ...controlCommandBaseShape, commandKind: z.literal("cancel"), reason: z.string().max(1000), graceful: z.boolean() }).strict(),
    z
      .object({ ...controlCommandBaseShape, commandKind: z.literal("product_approval_result"), result: productApprovalResultV1Schema })
      .strict(),
    z
      .object({ ...controlCommandBaseShape, commandKind: z.literal("runtime_decision_result"), result: runtimeDecisionResultV1Schema })
      .strict(),
    z.object({ ...controlCommandBaseShape, commandKind: z.literal("checkpoint"), deadline: timestampV1Schema }).strict(),
    z.object({ ...controlCommandBaseShape, commandKind: z.literal("graceful_stop"), deadline: timestampV1Schema }).strict(),
    z.object({ ...controlCommandBaseShape, commandKind: z.literal("drain"), reason: z.string().max(1000).nullable() }).strict(),
  ])
  .superRefine(forbiddenKeyRefine);
export type ControlCommandV1 = z.infer<typeof controlCommandV1Schema>;

export const CONTROL_ACK_STATUSES = ["accepted", "completed", "rejected", "stale"] as const;
export const controlCommandAckStatusSchema = z.enum(CONTROL_ACK_STATUSES);
export type ControlCommandAckStatus = (typeof CONTROL_ACK_STATUSES)[number];

/** The worker's ACK for a control command: it echoes the command ID + sequence
 * and reports a closed status. An unknown status fails closed. */
export const controlCommandAckV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    correlationId: correlationIdSchema,
    commandId: z.string().uuid(),
    commandSeq: positiveIntSchema,
    status: controlCommandAckStatusSchema,
    observedAt: timestampV1Schema,
    detail: z.string().max(1000).nullable(),
  })
  .strict()
  .superRefine(forbiddenKeyRefine);
export type ControlCommandAckV1 = z.infer<typeof controlCommandAckV1Schema>;

// =============================================================================
// Pure receiver-decision functions (prior-state specifications, not schemas).
// =============================================================================

export const CONTROL_RECEIVER_DECISIONS = ["accept", "replay", "gap", "conflict", "stale"] as const;
export const controlReceiverDecisionSchema = z.enum(CONTROL_RECEIVER_DECISIONS);
export type ControlReceiverDecisionV1 = (typeof CONTROL_RECEIVER_DECISIONS)[number];

/** The prior accepted state a control receiver decides against. `acceptedThroughSeq`
 * is the highest contiguous command sequence accepted (0 = none); `activeFenceToken`
 * is the current authoritative fence; `priorForCommandId` is the recorded record
 * for THIS command's ID (null = never seen). */
export interface ControlReceiverStateV1 {
  readonly acceptedThroughSeq: number;
  readonly activeFenceToken: string;
  readonly priorForCommandId: { readonly seq: number; readonly bodyDigest: string } | null;
}

export interface ControlReceiverCommandV1 {
  readonly commandId: string;
  readonly commandSeq: number;
  readonly fenceToken: string;
  readonly bodyDigest: string;
}

/**
 * Classify a control command against prior accepted state. Idempotency wins first
 * (same ID → replay on an identical body, conflict on a changed body); a command
 * bound to a superseded fence is stale; an already-accepted sequence replays; a
 * skipped sequence is a gap; the next contiguous sequence is accepted.
 */
export function decideControlReceiverV1(
  state: ControlReceiverStateV1,
  command: ControlReceiverCommandV1,
): ControlReceiverDecisionV1 {
  if (state.priorForCommandId !== null) {
    return state.priorForCommandId.bodyDigest === command.bodyDigest ? "replay" : "conflict";
  }
  if (command.fenceToken !== state.activeFenceToken) return "stale";
  if (command.commandSeq <= state.acceptedThroughSeq) return "replay";
  if (command.commandSeq > state.acceptedThroughSeq + 1) return "gap";
  return "accept";
}

export const EVENT_RECEIVER_DECISIONS = ["accept", "replay", "gap", "hash_mismatch", "stale_fence", "terminal"] as const;
export const eventReceiverDecisionSchema = z.enum(EVENT_RECEIVER_DECISIONS);
export type EventReceiverDecisionV1 = (typeof EVENT_RECEIVER_DECISIONS)[number];

/** The prior accepted state an event receiver decides against. `priorDigestForEventId`
 * is the recomputed digest stored for THIS event's ID (null = never seen). */
export interface EventReceiverStateV1 {
  readonly acceptedThroughSeq: number;
  readonly activeFenceToken: string;
  readonly terminalReached: boolean;
  readonly priorDigestForEventId: string | null;
}

export interface EventReceiverInputV1 {
  readonly eventId: string;
  readonly seq: number;
  readonly fenceToken: string;
  readonly suppliedDigest: string;
  readonly recomputedDigest: string;
}

/**
 * Classify a worker event against prior accepted state. The receiver recomputes
 * the digest FIRST: a supplied digest that disagrees with the recomputation is
 * `hash_mismatch` before any persistence/idempotency handling. Then a superseded
 * fence is `stale_fence`; a terminal attempt is `terminal`; a previously seen ID
 * replays on an identical digest and is `hash_mismatch` on a changed digest; an
 * already-accepted sequence replays; a skipped sequence is a gap; the next
 * contiguous sequence is accepted.
 */
export function decideEventReceiverV1(
  state: EventReceiverStateV1,
  input: EventReceiverInputV1,
): EventReceiverDecisionV1 {
  if (input.suppliedDigest !== input.recomputedDigest) return "hash_mismatch";
  if (input.fenceToken !== state.activeFenceToken) return "stale_fence";
  if (state.terminalReached) return "terminal";
  if (state.priorDigestForEventId !== null) {
    return state.priorDigestForEventId === input.recomputedDigest ? "replay" : "hash_mismatch";
  }
  if (input.seq <= state.acceptedThroughSeq) return "replay";
  if (input.seq > state.acceptedThroughSeq + 1) return "gap";
  return "accept";
}

// =============================================================================
// Operation descriptor registry (the source the operation document mirrors).
// =============================================================================

/** The ten framework-neutral worker-protocol operations. */
export const WORKER_PROTOCOL_OPERATIONS = [
  "enrollment",
  "poll",
  "lease_ack",
  "lease_renew",
  "event_upload",
  "artifact_transfer_grant",
  "artifact_commit",
  "quarantine_grant",
  "quarantine_finalize",
  "control_command",
] as const;
export type WorkerProtocolOperation = (typeof WORKER_PROTOCOL_OPERATIONS)[number];

/** The retry rule for an operation: a safe read may be freely re-issued; an
 * idempotency-keyed mutation may be retried with the same key; a non-retryable
 * operation must not be blindly retried. */
export type OperationRetryRule = "safe_read" | "idempotent_retry" | "no_retry";

export interface OperationDescriptorV1 {
  readonly operation: WorkerProtocolOperation;
  readonly audience: AuthAudience;
  readonly idempotent: boolean;
  readonly retry: OperationRetryRule;
  readonly maxRequestBytes: number;
  readonly timeoutMs: number;
  readonly successOutcomes: readonly string[];
  readonly errors: readonly ProtocolErrorCode[];
}

const KiB = 1024;
const MiB = 1024 * 1024;

/** Every operation's contract facts (audience, correlation/idempotency, retry
 * rule, payload ceiling, client timeout, success outcomes, stable errors). The
 * operation document (`operations.md`) mirrors exactly this set, and the contract
 * test proves each exported operation has a row and vice versa. */
export const OPERATION_DESCRIPTORS: Readonly<Record<WorkerProtocolOperation, OperationDescriptorV1>> = {
  enrollment: {
    operation: "enrollment",
    audience: "target_enrollment",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 256 * KiB,
    timeoutMs: 15_000,
    successOutcomes: ["enrolled", "rejected"],
    errors: ["malformed", "unauthorized", "incompatible_protocol", "incompatible_policy", "throttled", "internal_unavailable"],
  },
  poll: {
    operation: "poll",
    audience: "worker_poll",
    idempotent: false,
    retry: "safe_read",
    maxRequestBytes: 64 * KiB,
    timeoutMs: 30_000,
    successOutcomes: ["offer", "no_work", "drain"],
    errors: [
      "malformed",
      "unauthorized",
      "incompatible_protocol",
      "incompatible_capability",
      "incompatible_policy",
      "target_revoked",
      "throttled",
      "internal_unavailable",
    ],
  },
  lease_ack: {
    operation: "lease_ack",
    audience: "worker_run",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 64 * KiB,
    timeoutMs: 15_000,
    successOutcomes: ["acknowledged", "rejected"],
    errors: ["malformed", "unauthorized", "stale_fence", "target_revoked", "attempt_terminal", "throttled", "internal_unavailable"],
  },
  lease_renew: {
    operation: "lease_renew",
    audience: "worker_run",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 64 * KiB,
    timeoutMs: 15_000,
    successOutcomes: ["renewed", "rejected"],
    errors: ["malformed", "unauthorized", "stale_fence", "target_revoked", "attempt_terminal", "throttled", "internal_unavailable"],
  },
  event_upload: {
    operation: "event_upload",
    audience: "worker_run",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 4 * MiB,
    timeoutMs: 30_000,
    successOutcomes: ["accepted", "gap", "hash_mismatch", "stale_fence", "target_revoked", "terminal"],
    errors: [
      "malformed",
      "unauthorized",
      "stale_fence",
      "sequence_gap",
      "event_hash_mismatch",
      "target_revoked",
      "attempt_terminal",
      "payload_too_large",
      "throttled",
      "internal_unavailable",
    ],
  },
  artifact_transfer_grant: {
    operation: "artifact_transfer_grant",
    audience: "worker_run",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 64 * KiB,
    timeoutMs: 15_000,
    successOutcomes: ["upload_granted", "download_granted", "rejected"],
    errors: ["malformed", "unauthorized", "stale_fence", "target_revoked", "payload_too_large", "throttled", "internal_unavailable"],
  },
  artifact_commit: {
    operation: "artifact_commit",
    audience: "worker_run",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 256 * KiB,
    timeoutMs: 15_000,
    successOutcomes: ["committed", "rejected"],
    errors: ["malformed", "unauthorized", "stale_fence", "target_revoked", "attempt_terminal", "throttled", "internal_unavailable"],
  },
  quarantine_grant: {
    operation: "quarantine_grant",
    audience: "device_session",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 64 * KiB,
    timeoutMs: 15_000,
    successOutcomes: ["quarantine_upload_granted", "rejected"],
    errors: ["malformed", "unauthorized", "target_revoked", "payload_too_large", "throttled", "internal_unavailable"],
  },
  quarantine_finalize: {
    operation: "quarantine_finalize",
    audience: "device_session",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 256 * KiB,
    timeoutMs: 15_000,
    successOutcomes: ["quarantined", "rejected"],
    errors: ["malformed", "unauthorized", "target_revoked", "event_hash_mismatch", "payload_too_large", "throttled", "internal_unavailable"],
  },
  control_command: {
    operation: "control_command",
    audience: "control_channel",
    idempotent: true,
    retry: "idempotent_retry",
    maxRequestBytes: 256 * KiB,
    timeoutMs: 15_000,
    successOutcomes: ["accepted", "completed", "rejected", "stale"],
    errors: ["malformed", "unauthorized", "stale_fence", "attempt_terminal", "throttled", "internal_unavailable"],
  },
};
