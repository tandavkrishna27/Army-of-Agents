import { z } from "zod";
import { canonicalizeJsonV1 } from "./canonical-json.js";
import {
  artifactIdSchema,
  attemptNumberSchema,
  companyIdSchema,
  eventIdSchema,
  eventSequenceSchema,
  fenceTokenSchema,
  jobIdSchema,
  leaseIdSchema,
  organizationIdSchema,
  sandboxIdSchema,
  serviceIdSchema,
  serviceInstanceIdSchema,
  sha256DigestSchema,
  workerIdSchema,
} from "./ids.js";
import {
  addWireExtensionArrayIssues,
  wireExtensionsArraySchema,
} from "./extensions.js";
import { timestampV1Schema } from "./job.js";
import { addForbiddenWireKeyIssues } from "./wire-safety.js";

// -----------------------------------------------------------------------------
// Sequenced worker → control-plane events, submitted in batches and cumulatively
// acknowledged. Every event carries its full delivery identity plus an
// `eventDigest` (SHA-256 of the RFC 8785 canonical event bytes with `eventDigest`
// omitted; the shared `canonical-json.ts` is the single canonicalizer). The
// receiver authorizes all self-presented tenant/worker identities against its
// lease record — they are correlation fields, never independent authority.
//
// `usage` is metering evidence only; provider/model/biller/billing-type/rate/
// rounding/cost fields are rejected — JOB-012 creates the authoritative charge
// from immutable registry facts. Service-instance transition + provider
// interruption/resume events are distinct from the generic attempt `terminal`
// (which stays succeeded|failed|cancelled|expired; never healthy/stopped/lost).
// -----------------------------------------------------------------------------

const nonNegativeIntSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** A UTF-8-byte-bounded non-empty string (bounds after encoding, not code units). */
function boundedUtf8(maxBytes: number): z.ZodEffects<z.ZodString, string, string> {
  return z.string().min(1).superRefine((value, ctx) => {
    if (new TextEncoder().encode(value).byteLength > maxBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `exceeds ${maxBytes} UTF-8 bytes` });
    }
  });
}

// --- Event payload schemas ---------------------------------------------------

export const attemptStartedPayloadV1Schema = z.object({ sandboxId: sandboxIdSchema }).strict();
export type AttemptStartedPayloadV1 = z.infer<typeof attemptStartedPayloadV1Schema>;

export const LOG_STREAMS = ["stdout", "stderr", "system"] as const;
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const logPayloadV1Schema = z
  .object({
    stream: z.enum(LOG_STREAMS),
    level: z.enum(LOG_LEVELS),
    message: z.string().max(65_536),
  })
  .strict();
export type LogPayloadV1 = z.infer<typeof logPayloadV1Schema>;

// `percent` is an INTEGER 0–100 (nullable), NOT a float: the FND-004-locked
// eventDigest canonical subset accepts finite safe integers only, so a fractional
// percent would be undigestable / diverge between the two canonicalizers.
export const progressPayloadV1Schema = z
  .object({
    message: z.string().max(2000),
    percent: z.number().int().min(0).max(100).nullable(),
  })
  .strict();
export type ProgressPayloadV1 = z.infer<typeof progressPayloadV1Schema>;

// Evidentiary only. `.strict()` rejects costMicros/provider/model/biller/
// billingType/rate/rounding and every other pricing or charge field.
export const usagePayloadV1Schema = z
  .object({
    inputTokens: nonNegativeIntSchema,
    outputTokens: nonNegativeIntSchema,
    cachedInputTokens: nonNegativeIntSchema,
    runtimeMillis: nonNegativeIntSchema,
  })
  .strict();
export type UsagePayloadV1 = z.infer<typeof usagePayloadV1Schema>;

export const artifactPreparedPayloadV1Schema = z
  .object({ artifactId: artifactIdSchema, kind: z.string().min(1).max(100) })
  .strict();
export type ArtifactPreparedPayloadV1 = z.infer<typeof artifactPreparedPayloadV1Schema>;

export const browserObservationPayloadV1Schema = z
  .object({
    artifactIds: z.array(artifactIdSchema).max(128),
    url: z.string().max(4096).nullable(),
    title: z.string().max(1000).nullable(),
  })
  .strict();
export type BrowserObservationPayloadV1 = z.infer<typeof browserObservationPayloadV1Schema>;

export const browserApprovalRequestedPayloadV1Schema = z
  .object({
    approvalId: z.string().uuid(),
    action: z.string().min(1).max(200),
    summary: z.string().max(4000),
  })
  .strict();
export type BrowserApprovalRequestedPayloadV1 = z.infer<typeof browserApprovalRequestedPayloadV1Schema>;

// --- runtime_decision_requested: strict permission | work_question union -----

const WORK_QUESTION_VALUE_MAX_BYTES = 16_384; // 16 KiB canonical UTF-8
const WORK_QUESTION_VALUE_MAX_DEPTH = 8;

/** Reject a JSON value nested deeper than `maxDepth` container levels. */
function addBoundedJsonDepthIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  maxDepth: number,
): void {
  const walk = (node: unknown, depth: number, nodePath: Array<string | number>): void => {
    if (Array.isArray(node)) {
      if (depth + 1 > maxDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: nodePath, message: `value exceeds ${maxDepth} container levels` });
        return;
      }
      node.forEach((item, index) => walk(item, depth + 1, [...nodePath, index]));
      return;
    }
    if (node !== null && typeof node === "object") {
      if (depth + 1 > maxDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: nodePath, message: `value exceeds ${maxDepth} container levels` });
        return;
      }
      for (const key of Object.keys(node as Record<string, unknown>)) {
        walk((node as Record<string, unknown>)[key], depth + 1, [...nodePath, key]);
      }
    }
  };
  walk(value, 0, path);
}

/** A bounded JSON answer value: ≤16 KiB canonical UTF-8 bytes and ≤8 levels.
 * A value outside the RFC 8785 subset (float/unsafe int/lone surrogate) is
 * non-canonicalizable and fails closed. */
const boundedJsonValueSchema = z.unknown().superRefine((value, ctx) => {
  addBoundedJsonDepthIssues(value, ctx, [], WORK_QUESTION_VALUE_MAX_DEPTH);
  try {
    const bytes = new TextEncoder().encode(canonicalizeJsonV1(value)).byteLength;
    if (bytes > WORK_QUESTION_VALUE_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `value exceeds ${WORK_QUESTION_VALUE_MAX_BYTES} canonical UTF-8 bytes` });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value is not canonicalizable" });
  }
});

const runtimeDecisionCommonShape = {
  requestId: z.string().uuid(),
  nonce: boundedUtf8(200),
  requestDigest: sha256DigestSchema,
  schemaVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceRevision: nonNegativeIntSchema,
  expiresAt: timestampV1Schema,
  title: z.string().max(500),
  summary: z.string().max(4000).nullable(),
} as const;

export const PERMISSION_TIMEOUT_POLICIES = ["deny", "cancel_run", "park_run", "continue_with_default", "escalate"] as const;
export const permissionTimeoutPolicySchema = z.enum(PERMISSION_TIMEOUT_POLICIES);
export type PermissionTimeoutPolicy = (typeof PERMISSION_TIMEOUT_POLICIES)[number];

// `allow_always` is deliberately NOT a timeout default (a persistent trust grant
// is never auto-selected on timeout); the enum omits it.
export const PERMISSION_DEFAULT_DECISIONS = ["allow_once", "allow_run", "deny"] as const;
export const permissionDefaultDecisionSchema = z.enum(PERMISSION_DEFAULT_DECISIONS);
export type PermissionDefaultDecision = (typeof PERMISSION_DEFAULT_DECISIONS)[number];

export const permissionRuntimeDecisionRequestV1Schema = z
  .object({
    decisionKind: z.literal("permission"),
    ...runtimeDecisionCommonShape,
    timeoutPolicy: permissionTimeoutPolicySchema,
    defaultDecision: permissionDefaultDecisionSchema.nullable(),
    toolName: z.string().max(200).nullable(),
    command: z.string().max(4096).nullable(),
    cwd: z.string().max(4096).nullable(),
    path: z.string().max(4096).nullable(),
    networkTarget: z.string().max(1000).nullable(),
    riskClass: z.string().max(100).nullable(),
  })
  .strict();
export type PermissionRuntimeDecisionRequestV1 = z.infer<typeof permissionRuntimeDecisionRequestV1Schema>;

export const WORK_QUESTION_TIMEOUT_POLICIES = ["cancel_run", "park_run", "continue_with_default", "escalate"] as const;
export const workQuestionTimeoutPolicySchema = z.enum(WORK_QUESTION_TIMEOUT_POLICIES);
export type WorkQuestionTimeoutPolicy = (typeof WORK_QUESTION_TIMEOUT_POLICIES)[number];

export const workQuestionOptionV1Schema = z
  .object({
    optionId: boundedUtf8(200),
    label: boundedUtf8(1000),
    value: boundedJsonValueSchema,
    isDefault: z.boolean(),
  })
  .strict();
export type WorkQuestionOptionV1 = z.infer<typeof workQuestionOptionV1Schema>;

export const workQuestionRuntimeDecisionRequestV1Schema = z
  .object({
    decisionKind: z.literal("work_question"),
    ...runtimeDecisionCommonShape,
    timeoutPolicy: workQuestionTimeoutPolicySchema,
    promptText: z.string().max(8000),
    options: z.array(workQuestionOptionV1Schema).max(32),
  })
  .strict();
export type WorkQuestionRuntimeDecisionRequestV1 = z.infer<typeof workQuestionRuntimeDecisionRequestV1Schema>;

/**
 * The request side of PRT-007's durable runtime decision. `continue_with_default`
 * fail-closed rules: permission requires a non-null `defaultDecision` (every other
 * policy requires null); a work question requires exactly one `isDefault` option
 * (every other policy requires zero). Cross-kind fields are rejected by `.strict()`.
 */
export const runtimeDecisionRequestV1Schema = z
  .discriminatedUnion("decisionKind", [
    permissionRuntimeDecisionRequestV1Schema,
    workQuestionRuntimeDecisionRequestV1Schema,
  ])
  .superRefine((request, ctx) => {
    if (request.decisionKind === "permission") {
      if (request.timeoutPolicy === "continue_with_default") {
        if (request.defaultDecision === null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultDecision"], message: "continue_with_default requires a non-null defaultDecision" });
        }
      } else if (request.defaultDecision !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultDecision"], message: "defaultDecision must be null unless timeoutPolicy is continue_with_default" });
      }
      return;
    }
    const defaults = request.options.filter((option) => option.isDefault === true).length;
    if (request.timeoutPolicy === "continue_with_default") {
      if (defaults !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "continue_with_default requires exactly one isDefault option" });
      }
    } else if (defaults !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "options may not carry a default unless timeoutPolicy is continue_with_default" });
    }
  });
export type RuntimeDecisionRequestV1 = z.infer<typeof runtimeDecisionRequestV1Schema>;

// --- Service-instance transition + provider interruption/resume payloads -----

const serviceInstanceRefShape = {
  serviceId: serviceIdSchema,
  serviceInstanceId: serviceInstanceIdSchema,
  generation: positiveGenerationSchema,
} as const;

export const serviceInstanceStartedPayloadV1Schema = z
  .object({ ...serviceInstanceRefShape, providerResourceId: z.string().min(1).max(200) })
  .strict();
export type ServiceInstanceStartedPayloadV1 = z.infer<typeof serviceInstanceStartedPayloadV1Schema>;

export const SERVICE_HEALTH_STATUSES = ["healthy", "unhealthy"] as const;
export const serviceHealthPayloadV1Schema = z
  .object({ ...serviceInstanceRefShape, status: z.enum(SERVICE_HEALTH_STATUSES), detail: z.string().max(4000).nullable() })
  .strict();
export type ServiceHealthPayloadV1 = z.infer<typeof serviceHealthPayloadV1Schema>;

export const serviceCheckpointPreparedPayloadV1Schema = z
  .object({ artifactId: artifactIdSchema, ...serviceInstanceRefShape })
  .strict();
export type ServiceCheckpointPreparedPayloadV1 = z.infer<typeof serviceCheckpointPreparedPayloadV1Schema>;

export const serviceCheckpointRestoredPayloadV1Schema = z
  .object({ artifactId: artifactIdSchema, ...serviceInstanceRefShape })
  .strict();
export type ServiceCheckpointRestoredPayloadV1 = z.infer<typeof serviceCheckpointRestoredPayloadV1Schema>;

export const serviceGracefulStopObservedPayloadV1Schema = z
  .object({ ...serviceInstanceRefShape, deadline: timestampV1Schema })
  .strict();
export type ServiceGracefulStopObservedPayloadV1 = z.infer<typeof serviceGracefulStopObservedPayloadV1Schema>;

export const serviceInstanceStoppedPayloadV1Schema = z
  .object({ ...serviceInstanceRefShape, exitCode: z.number().int().nullable() })
  .strict();
export type ServiceInstanceStoppedPayloadV1 = z.infer<typeof serviceInstanceStoppedPayloadV1Schema>;

export const serviceInstanceLostPayloadV1Schema = z
  .object({ ...serviceInstanceRefShape, reason: z.string().min(1).max(1000) })
  .strict();
export type ServiceInstanceLostPayloadV1 = z.infer<typeof serviceInstanceLostPayloadV1Schema>;

export const serviceProviderInterruptedPayloadV1Schema = z
  .object({ ...serviceInstanceRefShape, reason: z.string().min(1).max(1000) })
  .strict();
export type ServiceProviderInterruptedPayloadV1 = z.infer<typeof serviceProviderInterruptedPayloadV1Schema>;

export const serviceProviderResumedPayloadV1Schema = z
  .object({ ...serviceInstanceRefShape, providerResourceId: z.string().min(1).max(200) })
  .strict();
export type ServiceProviderResumedPayloadV1 = z.infer<typeof serviceProviderResumedPayloadV1Schema>;

export const NETWORK_DENIAL_CLASSES = ["metadata", "private", "control_plane", "not_allowlisted"] as const;
export const networkDeniedPayloadV1Schema = z
  .object({ destinationClass: z.enum(NETWORK_DENIAL_CLASSES), reason: z.string().min(1).max(1000) })
  .strict();
export type NetworkDeniedPayloadV1 = z.infer<typeof networkDeniedPayloadV1Schema>;

export const TERMINAL_EVENT_STATUSES = ["succeeded", "failed", "cancelled", "expired"] as const;
export const terminalEventStatusSchema = z.enum(TERMINAL_EVENT_STATUSES);
export type TerminalEventStatus = (typeof TERMINAL_EVENT_STATUSES)[number];
export const terminalEventPayloadV1Schema = z
  .object({
    status: terminalEventStatusSchema,
    exitCode: z.number().int().nullable(),
    errorCode: z.string().max(100).nullable(),
    errorMessage: z.string().max(4000).nullable(),
  })
  .strict();
export type TerminalEventPayloadV1 = z.infer<typeof terminalEventPayloadV1Schema>;

// --- Base event identity + discriminated union -------------------------------

const eventBaseShape = {
  protocolVersion: z.literal(1),
  eventId: eventIdSchema,
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  workerId: workerIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema,
  seq: eventSequenceSchema,
  eventDigest: sha256DigestSchema,
  occurredAt: timestampV1Schema,
  extensions: wireExtensionsArraySchema,
} as const;

const eventVariant = <K extends string, P extends z.ZodTypeAny>(eventType: K, payload: P) =>
  z.object({ ...eventBaseShape, eventType: z.literal(eventType), payload }).strict();

export const WORKER_EVENT_TYPES = [
  "attempt_started",
  "log",
  "progress",
  "usage",
  "artifact_prepared",
  "browser_observation",
  "browser_approval_requested",
  "runtime_decision_requested",
  "service_instance_started",
  "service_health",
  "service_checkpoint_prepared",
  "service_checkpoint_restored",
  "service_graceful_stop_observed",
  "service_instance_stopped",
  "service_instance_lost",
  "service_provider_interrupted",
  "service_provider_resumed",
  "network_denied",
  "terminal",
] as const;
export const workerEventTypeSchema = z.enum(WORKER_EVENT_TYPES);
export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];

/** The strict V1 worker-event union, discriminated by `eventType`, with a
 * recursive forbidden-credential-key scan and the ONE shared bounded-extension
 * container (`addWireExtensionArrayIssues`) applied to every event — identical to
 * job/lease enforcement (E1-F005). */
export const workerEventV1Schema = z
  .discriminatedUnion("eventType", [
    eventVariant("attempt_started", attemptStartedPayloadV1Schema),
    eventVariant("log", logPayloadV1Schema),
    eventVariant("progress", progressPayloadV1Schema),
    eventVariant("usage", usagePayloadV1Schema),
    eventVariant("artifact_prepared", artifactPreparedPayloadV1Schema),
    eventVariant("browser_observation", browserObservationPayloadV1Schema),
    eventVariant("browser_approval_requested", browserApprovalRequestedPayloadV1Schema),
    eventVariant("runtime_decision_requested", runtimeDecisionRequestV1Schema),
    eventVariant("service_instance_started", serviceInstanceStartedPayloadV1Schema),
    eventVariant("service_health", serviceHealthPayloadV1Schema),
    eventVariant("service_checkpoint_prepared", serviceCheckpointPreparedPayloadV1Schema),
    eventVariant("service_checkpoint_restored", serviceCheckpointRestoredPayloadV1Schema),
    eventVariant("service_graceful_stop_observed", serviceGracefulStopObservedPayloadV1Schema),
    eventVariant("service_instance_stopped", serviceInstanceStoppedPayloadV1Schema),
    eventVariant("service_instance_lost", serviceInstanceLostPayloadV1Schema),
    eventVariant("service_provider_interrupted", serviceProviderInterruptedPayloadV1Schema),
    eventVariant("service_provider_resumed", serviceProviderResumedPayloadV1Schema),
    eventVariant("network_denied", networkDeniedPayloadV1Schema),
    eventVariant("terminal", terminalEventPayloadV1Schema),
  ])
  .superRefine((event, ctx) => {
    addForbiddenWireKeyIssues(event, ctx);
    addWireExtensionArrayIssues(event.extensions, ctx, ["extensions"]);
  });
export type WorkerEventV1 = z.infer<typeof workerEventV1Schema>;

// --- Batch + cumulative ACK --------------------------------------------------

const deliveryIdentityShape = {
  protocolVersion: z.literal(1),
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  workerId: workerIdSchema,
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  leaseId: leaseIdSchema,
  fenceToken: fenceTokenSchema,
} as const;

/**
 * A submitted batch of 1–500 events. Every event must repeat the batch
 * organization/company/worker/job/attempt/lease/fence, event IDs are unique, and
 * sequences are contiguous (each `seq` exactly one greater than the previous).
 */
export const workerEventBatchV1Schema = z
  .object({ ...deliveryIdentityShape, events: z.array(workerEventV1Schema).min(1).max(500) })
  .strict()
  .superRefine((batch, ctx) => {
    addForbiddenWireKeyIssues(batch, ctx);
    const seenEventIds = new Set<string>();
    batch.events.forEach((event, index) => {
      const path: Array<string | number> = ["events", index];
      const mismatches: Array<[keyof typeof deliveryIdentityShape, string]> = [
        ["organizationId", event.organizationId],
        ["companyId", event.companyId],
        ["workerId", event.workerId],
        ["jobId", event.jobId],
        ["leaseId", event.leaseId],
        ["fenceToken", event.fenceToken],
      ];
      for (const [field, value] of mismatches) {
        if (value !== (batch[field] as unknown as string)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, field], message: `event ${String(field)} must repeat the batch identity` });
        }
      }
      if (event.attempt !== batch.attempt) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "attempt"], message: "event attempt must repeat the batch identity" });
      }
      if (seenEventIds.has(event.eventId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "eventId"], message: "duplicate event ID in batch" });
      }
      seenEventIds.add(event.eventId);
      if (index > 0 && event.seq !== batch.events[index - 1].seq + 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "seq"], message: "event sequences must be contiguous" });
      }
    });
  });
export type WorkerEventBatchV1 = z.infer<typeof workerEventBatchV1Schema>;

export const WORKER_EVENT_ACK_STATUSES = [
  "accepted",
  "gap",
  "hash_mismatch",
  "stale_fence",
  "target_revoked",
  "terminal",
] as const;
export const workerEventAckStatusSchema = z.enum(WORKER_EVENT_ACK_STATUSES);
export type WorkerEventAckStatus = (typeof WORKER_EVENT_ACK_STATUSES)[number];

/**
 * A cumulative ACK. `expectedNextSeq === acceptedThroughSeq + 1`. A
 * `hash_mismatch` names the conflicting `rejectedEventId`; every non-conflict
 * status forbids it. Negative sequences are rejected.
 */
export const workerEventAckV1Schema = z
  .object({
    ...deliveryIdentityShape,
    acceptedThroughSeq: nonNegativeIntSchema,
    expectedNextSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: workerEventAckStatusSchema,
    rejectedEventId: eventIdSchema.optional(),
  })
  .strict()
  .superRefine((ack, ctx) => {
    addForbiddenWireKeyIssues(ack, ctx);
    if (ack.expectedNextSeq !== ack.acceptedThroughSeq + 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedNextSeq"], message: "expectedNextSeq must equal acceptedThroughSeq + 1" });
    }
    if (ack.status === "hash_mismatch") {
      if (ack.rejectedEventId === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rejectedEventId"], message: "hash_mismatch requires the conflicting rejectedEventId" });
      }
    } else if (ack.rejectedEventId !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rejectedEventId"], message: "rejectedEventId is only valid for a hash_mismatch ACK" });
    }
  });
export type WorkerEventAckV1 = z.infer<typeof workerEventAckV1Schema>;
