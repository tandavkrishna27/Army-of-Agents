/**
 * Orphan-output quarantine routing (WRK-005; CAV-004).
 *
 * After the fence has closed, any output the run still produces is an ORPHAN: the
 * ordinary (fenced) artifact-commit path is disabled, so the ONLY route that may
 * carry it is the DEVICE-AUTHENTICATED quarantine path. Quarantine:
 *
 *   - authenticates by `targetId` + `deviceGeneration` (a DEVICE session), NOT a
 *     live lease — so it SURVIVES lease loss; the observed lease/fence are recorded
 *     as non-authoritative identity only;
 *   - writes under the DISTINCT `quarantine/…` object-key prefix (never the ordinary
 *     attempt prefix);
 *   - carries a ≤5-minute non-promotable upload grant; and
 *   - has NO apply / promote / select-checkpoint / attempt-mutation field — the
 *     CAV-004 NON-PROMOTION invariant. The only disposition is `quarantined`.
 *
 * **F007 bound:** quarantine still needs a LIVE device session. If the session is
 * terminal (E4-F007 — a lease cannot outlive its session today), even quarantine
 * cannot run and the orphan output is DROPPED with a redacted terminal log. The
 * sustained-session fix is E3/JOB-002.
 *
 * Runtime imports: relative modules + the frozen protocol — the E4-D01 boundary.
 */

import { randomUUID } from "node:crypto";

import {
  expectedAttemptObjectPrefix,
  expectedQuarantineObjectPrefix,
  quarantineFinalizeOperationRequestV1Schema,
  quarantineFinalizeOperationResponseV1Schema,
  quarantineGrantOperationRequestV1Schema,
  quarantineGrantOperationResponseV1Schema,
  type QuarantineFinalizeOperationRequestV1,
  type QuarantineGrantOperationRequestV1,
  type QuarantineReason,
  type QuarantineUploadReceiptV1,
} from "@armyofagents/worker-protocol";

import type { DeviceKey } from "../identity/device-key.js";
import { signDeviceProof } from "../identity/device-proof.js";
import { QUARANTINE_METRIC, type Metrics } from "../metrics/metrics.js";
import type { Logger } from "../logging/logger.js";
import {
  SessionTerminalError,
  type SessionProvider,
  type TransientLabel,
} from "../poll/poll-loop.js";
import {
  ControlPlaneTransportError,
  type ControlPlaneClient,
  type WorkerOperationHttpResponse,
} from "../transport/client.js";

// --- Reason classification ---------------------------------------------------

/** The condition under which orphan output is being routed to quarantine. */
export interface OrphanOutputCondition {
  /** The fence closed (lease loss / cancel / completion) — the default orphan case. */
  readonly fenceClosed?: boolean;
  readonly staleFence?: boolean;
  readonly hashMismatch?: boolean;
  readonly wrongPrefix?: boolean;
  readonly sizeMismatch?: boolean;
  readonly unknownArtifact?: boolean;
  readonly corruptCheckpoint?: boolean;
}

/**
 * Classify orphan output into the frozen {@link QuarantineReason}. Post-fence-close
 * output with no other signal is `late_output`; more specific integrity conditions
 * take precedence. NEVER returns a non-vocabulary value.
 */
export function classifyOrphanOutput(condition: OrphanOutputCondition): QuarantineReason {
  if (condition.corruptCheckpoint) return "corrupt_checkpoint";
  if (condition.unknownArtifact) return "unknown_artifact";
  if (condition.hashMismatch) return "hash_mismatch";
  if (condition.sizeMismatch) return "size_mismatch";
  if (condition.wrongPrefix) return "wrong_prefix";
  if (condition.staleFence) return "stale_fence";
  return "late_output";
}

// --- Payload builders --------------------------------------------------------

/** The device identity + observed (non-authoritative) lease the orphan is bound to. */
export interface QuarantineIdentity {
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  readonly organizationId: string;
  readonly companyId: string;
  readonly jobId: string;
  readonly attempt: number;
  /** The lease/fence OBSERVED at production time — recorded, never authoritative. */
  readonly observedLeaseId: string;
  readonly observedFenceToken: string;
}

/** The orphan artifact's identity/hash/size + its relative name under the attempt. */
export interface QuarantineArtifact {
  readonly artifactId: string;
  readonly expectedSha256: string;
  readonly sizeBytes: number;
  /** A safe relative suffix appended under the attempt prefix (e.g. `output.log`). */
  readonly objectSuffix: string;
  readonly contentType?: string;
  readonly kind?:
    | "workspace_snapshot"
    | "workspace_patch"
    | "log"
    | "screenshot"
    | "dom_snapshot"
    | "browser_cookie_state"
    | "browser_storage_state"
    | "playwright_trace"
    | "browser_video"
    | "download"
    | "service_checkpoint"
    | "other";
  readonly retention?: "ephemeral" | "run" | "audit" | "checkpoint";
  readonly createdAt?: string;
}

/** The DISTINCT quarantine object key for this orphan (under `quarantine/…`). */
export function quarantineObjectKey(identity: QuarantineIdentity, suffix: string): string {
  return `${expectedQuarantineObjectPrefix(identity)}${suffix}`;
}

/** The ordinary attempt object key the manifest records (where it WOULD have gone). */
function ordinaryObjectKey(identity: QuarantineIdentity, suffix: string): string {
  return `${expectedAttemptObjectPrefix(identity)}${suffix}`;
}

export interface BuildQuarantineGrantInput {
  readonly identity: QuarantineIdentity;
  readonly artifact: QuarantineArtifact;
  readonly reason: QuarantineReason;
  readonly correlationId: string;
  readonly issuedAt: string;
  readonly nonce: string;
  readonly idempotencyKey: string;
}

export interface QuarantineGrantRequestEnvelope {
  readonly request: QuarantineGrantOperationRequestV1;
  readonly bytes: Buffer;
}

/**
 * Build the device-authenticated quarantine GRANT operation. The payload binds the
 * distinct quarantine prefix + the exact org/job/attempt/hash/size and carries NO
 * promote/apply/select field (the schema does not permit one — CAV-004).
 */
export function buildQuarantineGrantRequest(input: BuildQuarantineGrantInput): QuarantineGrantRequestEnvelope {
  const request = quarantineGrantOperationRequestV1Schema.parse({
    protocolVersion: 1,
    correlationId: input.correlationId,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    audience: "device_session",
    idempotencyKey: input.idempotencyKey,
    body: {
      protocolVersion: 1,
      workerId: input.identity.workerId,
      targetId: input.identity.targetId,
      deviceGeneration: input.identity.deviceGeneration,
      organizationId: input.identity.organizationId,
      companyId: input.identity.companyId,
      jobId: input.identity.jobId,
      attempt: input.identity.attempt,
      observedLeaseId: input.identity.observedLeaseId,
      observedFenceToken: input.identity.observedFenceToken,
      reason: input.reason,
      artifactId: input.artifact.artifactId,
      expectedObjectKey: quarantineObjectKey(input.identity, input.artifact.objectSuffix),
      expectedSha256: input.artifact.expectedSha256,
      sizeBytes: input.artifact.sizeBytes,
    },
  });
  return { request, bytes: Buffer.from(JSON.stringify(request), "utf8") };
}

export interface BuildQuarantineFinalizeInput extends BuildQuarantineGrantInput {}

export interface QuarantineFinalizeRequestEnvelope {
  readonly request: QuarantineFinalizeOperationRequestV1;
  readonly bytes: Buffer;
}

/**
 * Build the device-authenticated quarantine FINALIZE operation. It records the
 * artifact manifest (ordinary attempt object key) against the observed quarantine
 * object; the manifest identity/hash/size must match. NO promote/apply disposition
 * exists — the receipt's only disposition is `quarantined` (CAV-004).
 */
export function buildQuarantineFinalizeRequest(input: BuildQuarantineFinalizeInput): QuarantineFinalizeRequestEnvelope {
  const { identity, artifact } = input;
  const request = quarantineFinalizeOperationRequestV1Schema.parse({
    protocolVersion: 1,
    correlationId: input.correlationId,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    audience: "device_session",
    idempotencyKey: input.idempotencyKey,
    body: {
      protocolVersion: 1,
      workerId: identity.workerId,
      targetId: identity.targetId,
      deviceGeneration: identity.deviceGeneration,
      organizationId: identity.organizationId,
      companyId: identity.companyId,
      jobId: identity.jobId,
      attempt: identity.attempt,
      observedLeaseId: identity.observedLeaseId,
      observedFenceToken: identity.observedFenceToken,
      reason: input.reason,
      artifactId: artifact.artifactId,
      quarantineObjectKey: quarantineObjectKey(identity, artifact.objectSuffix),
      expectedSha256: artifact.expectedSha256,
      sizeBytes: artifact.sizeBytes,
      manifest: {
        protocolVersion: 1,
        organizationId: identity.organizationId,
        companyId: identity.companyId,
        jobId: identity.jobId,
        attempt: identity.attempt,
        artifactId: artifact.artifactId,
        kind: artifact.kind ?? "other",
        sensitivity: "restricted",
        retention: artifact.retention ?? "run",
        objectKey: ordinaryObjectKey(identity, artifact.objectSuffix),
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.expectedSha256,
        contentType: artifact.contentType ?? "application/octet-stream",
        createdAt: artifact.createdAt ?? input.issuedAt,
      },
    },
  });
  return { request, bytes: Buffer.from(JSON.stringify(request), "utf8") };
}

// --- Device-session orchestration --------------------------------------------

export type QuarantineOutcome =
  | { readonly status: "quarantined"; readonly receipt: QuarantineUploadReceiptV1 }
  | { readonly status: "rejected"; readonly stage: "grant" | "finalize"; readonly code: string }
  | { readonly status: "dropped"; readonly cause: "session_terminal" }
  | { readonly status: "failed"; readonly stage: "grant" | "finalize"; readonly label: TransientLabel | "malformed" };

export interface RunOrphanQuarantineDeps {
  readonly client: ControlPlaneClient;
  readonly session: SessionProvider;
  readonly key: DeviceKey;
  readonly identity: QuarantineIdentity;
  readonly artifact: QuarantineArtifact;
  readonly reason: QuarantineReason;
  readonly metrics?: Metrics;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly newCorrelationId?: () => string;
  readonly newProofId?: () => string;
  readonly newNonce?: () => string;
  readonly newIdempotencyKey?: () => string;
}

function defaultProofId(): string {
  return `prf_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function transportLabel(err: unknown): TransientLabel | "malformed" {
  if (err instanceof ControlPlaneTransportError) {
    if (err.kind === "timeout") return "timeout";
    if (err.kind === "network") return "socket_error";
    return "malformed";
  }
  throw err;
}

/**
 * Route orphan output through the device-session quarantine path. It first
 * requires a LIVE session — a terminal session (F007) DROPS the output (never the
 * disabled ordinary-commit path). Otherwise it posts the grant, then the finalize,
 * both at audience `device_session` (the PROVISIONAL binding pending E5/DAT).
 */
export async function runOrphanQuarantine(deps: RunOrphanQuarantineDeps): Promise<QuarantineOutcome> {
  const now = deps.now ?? (() => Date.now());
  const emit = (outcome: string): void => deps.metrics?.inc(QUARANTINE_METRIC, { outcome });
  const newCorrelationId = deps.newCorrelationId ?? randomUUID;
  const newNonce = deps.newNonce ?? randomUUID;
  const newProofId = deps.newProofId ?? defaultProofId;
  const newIdempotencyKey = deps.newIdempotencyKey ?? randomUUID;

  // F007 bound: quarantine still needs a live device session.
  let session;
  try {
    session = await deps.session.get();
  } catch (err) {
    if (err instanceof SessionTerminalError) {
      emit("dropped");
      deps.logger?.info(
        { jobId: deps.identity.jobId, deviceGeneration: deps.identity.deviceGeneration, cause: "session_terminal" },
        "quarantine: session terminal; orphan output dropped (redacted)",
      );
      return { status: "dropped", cause: "session_terminal" };
    }
    throw err;
  }

  // --- grant ---
  const grantCorrelation = newCorrelationId();
  const grantEnvelope = buildQuarantineGrantRequest({
    identity: deps.identity,
    artifact: deps.artifact,
    reason: deps.reason,
    correlationId: grantCorrelation,
    issuedAt: new Date(now()).toISOString(),
    nonce: newNonce(),
    idempotencyKey: newIdempotencyKey(),
  });
  const grantProof = signDeviceProof({
    method: "POST",
    path: deps.client.quarantineGrantPath,
    rawBody: grantEnvelope.bytes,
    correlationId: grantCorrelation,
    issuedAt: new Date(now()).toISOString(),
    proofId: newProofId(),
    key: deps.key,
  });
  let grantResponse: WorkerOperationHttpResponse;
  try {
    grantResponse = await deps.client.quarantineGrant({
      bytes: grantEnvelope.bytes,
      sessionToken: session.token,
      proofHeaders: grantProof.headers,
      requestId: grantCorrelation,
    });
  } catch (err) {
    return { status: "failed", stage: "grant", label: transportLabel(err) };
  }
  const grantParsed = quarantineGrantOperationResponseV1Schema.safeParse(grantResponse.body);
  if (grantResponse.status !== 200 || !grantParsed.success) {
    return { status: "failed", stage: "grant", label: "malformed" };
  }
  if (grantParsed.data.outcome === "rejected") {
    return { status: "rejected", stage: "grant", code: grantParsed.data.reason };
  }
  emit("granted");

  // --- finalize ---
  const finalizeCorrelation = newCorrelationId();
  const finalizeEnvelope = buildQuarantineFinalizeRequest({
    identity: deps.identity,
    artifact: deps.artifact,
    reason: deps.reason,
    correlationId: finalizeCorrelation,
    issuedAt: new Date(now()).toISOString(),
    nonce: newNonce(),
    idempotencyKey: newIdempotencyKey(),
  });
  const finalizeProof = signDeviceProof({
    method: "POST",
    path: deps.client.quarantineFinalizePath,
    rawBody: finalizeEnvelope.bytes,
    correlationId: finalizeCorrelation,
    issuedAt: new Date(now()).toISOString(),
    proofId: newProofId(),
    key: deps.key,
  });
  let finalizeResponse: WorkerOperationHttpResponse;
  try {
    finalizeResponse = await deps.client.quarantineFinalize({
      bytes: finalizeEnvelope.bytes,
      sessionToken: session.token,
      proofHeaders: finalizeProof.headers,
      requestId: finalizeCorrelation,
    });
  } catch (err) {
    return { status: "failed", stage: "finalize", label: transportLabel(err) };
  }
  const finalizeParsed = quarantineFinalizeOperationResponseV1Schema.safeParse(finalizeResponse.body);
  if (finalizeResponse.status !== 200 || !finalizeParsed.success) {
    return { status: "failed", stage: "finalize", label: "malformed" };
  }
  if (finalizeParsed.data.outcome === "rejected") {
    return { status: "rejected", stage: "finalize", code: finalizeParsed.data.reason };
  }
  emit("quarantined");
  return { status: "quarantined", receipt: finalizeParsed.data.receipt };
}
