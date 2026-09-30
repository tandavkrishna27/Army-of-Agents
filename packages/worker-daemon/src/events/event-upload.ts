/**
 * Single `event_upload` op-caller (WRK-006, slice 3) — the build→sign→POST→
 * classify unit, modeled one-for-one on `lease/lease-renewal.ts` `renewLeaseOnce`.
 *
 * It binds the FROZEN `eventUploadOperationRequestV1Schema` /
 * `eventUploadOperationResponseV1Schema` (a pure consumer — zero worker-protocol
 * changes), signs a device proof over the client's plain `eventUploadPath` + the
 * EXACT request bytes, POSTs via `client.eventUpload`, and maps the response +
 * transport failures to a closed {@link EventUploadAttempt} union the drain acts
 * on. A transport failure maps to a transient/terminal outcome (never throws),
 * exactly like `renewLeaseOnce`; a non-transport throw propagates for the drain's
 * fail-closed wrapper to catch.
 *
 * Runtime imports: relative modules + the frozen protocol on the wire — E4-D01.
 */

import { randomUUID } from "node:crypto";

import {
  eventUploadOperationRequestV1Schema,
  eventUploadOperationResponseV1Schema,
  protocolErrorV1Schema,
  type EventUploadOperationRequestV1,
  type WorkerEventV1,
} from "@armyofagents/worker-protocol";

import type { DeviceKey } from "../identity/device-key.js";
import { signDeviceProof } from "../identity/device-proof.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import {
  ControlPlaneTransportError,
  type ControlPlaneClient,
  type WorkerOperationHttpResponse,
} from "../transport/client.js";
import type { TransientLabel } from "../poll/poll-loop.js";
import type { EventStreamIdentity } from "./event-outbox-store.js";

/** The classification of ONE event-upload round-trip (mirrors `RenewAttempt`). */
export type EventUploadAttempt =
  | { readonly kind: "accepted"; readonly acceptedThroughSeq: number; readonly expectedNextSeq: number }
  | { readonly kind: "gap"; readonly acceptedThroughSeq: number; readonly expectedNextSeq: number }
  | { readonly kind: "hash_mismatch"; readonly rejectedEventId: string; readonly acceptedThroughSeq: number }
  | { readonly kind: "stream_lost"; readonly reason: "stale_fence" | "target_revoked" | "terminal" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "transient"; readonly label: TransientLabel; readonly retryAfterMs: number | null }
  | { readonly kind: "terminal"; readonly code: string };

export interface EventUploadRequestEnvelope {
  readonly request: EventUploadOperationRequestV1;
  readonly bytes: Buffer;
}

export interface BuildEventUploadRequestInput {
  readonly identity: EventStreamIdentity;
  readonly events: readonly WorkerEventV1[];
  readonly correlationId: string;
  readonly issuedAt: string;
  readonly nonce: string;
  readonly idempotencyKey: string;
}

/** Assemble + validate the event-upload operation (audience `worker_run`). The
 * frozen batch schema enforces 1–500 events, contiguous `seq`, unique `eventId`,
 * and identity-repeat — a malformed batch fails HERE, never on the wire. */
export function buildEventUploadRequest(input: BuildEventUploadRequestInput): EventUploadRequestEnvelope {
  const request = eventUploadOperationRequestV1Schema.parse({
    protocolVersion: 1,
    correlationId: input.correlationId,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    audience: "worker_run",
    idempotencyKey: input.idempotencyKey,
    body: {
      protocolVersion: 1,
      organizationId: input.identity.organizationId,
      companyId: input.identity.companyId,
      workerId: input.identity.workerId,
      jobId: input.identity.jobId,
      attempt: input.identity.attempt,
      leaseId: input.identity.leaseId,
      fenceToken: input.identity.fenceToken,
      events: input.events,
    },
  });
  return { request, bytes: Buffer.from(JSON.stringify(request), "utf8") };
}

function defaultProofId(): string {
  return `prf_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export interface UploadEventBatchOnceDeps {
  readonly client: ControlPlaneClient;
  readonly session: WorkerSession;
  readonly identity: EventStreamIdentity;
  readonly events: readonly WorkerEventV1[];
  readonly key: DeviceKey;
  /** The idempotency key — CONTROLLED by the caller so a transient retry replays
   * the SAME key (idempotent_retry) and a new flush mints a fresh one (D6). */
  readonly idempotencyKey: string;
  readonly now?: () => number;
  readonly newCorrelationId?: () => string;
  readonly newProofId?: () => string;
  readonly newNonce?: () => string;
}

/**
 * Perform ONE upload: build + sign (over `client.eventUploadPath` + exact bytes) +
 * POST, then classify. A transport failure maps to a transient/terminal outcome
 * (never throws), exactly like `renewLeaseOnce`.
 */
export async function uploadEventBatchOnce(deps: UploadEventBatchOnceDeps): Promise<EventUploadAttempt> {
  const now = deps.now ?? (() => Date.now());
  const correlationId = (deps.newCorrelationId ?? randomUUID)();
  const nonce = (deps.newNonce ?? randomUUID)();
  const envelope = buildEventUploadRequest({
    identity: deps.identity,
    events: deps.events,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    nonce,
    idempotencyKey: deps.idempotencyKey,
  });
  const proof = signDeviceProof({
    method: "POST",
    path: deps.client.eventUploadPath,
    rawBody: envelope.bytes,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    proofId: (deps.newProofId ?? defaultProofId)(),
    key: deps.key,
  });

  let response: WorkerOperationHttpResponse;
  try {
    response = await deps.client.eventUpload({
      bytes: envelope.bytes,
      sessionToken: deps.session.token,
      proofHeaders: proof.headers,
      requestId: correlationId,
    });
  } catch (err) {
    if (err instanceof ControlPlaneTransportError) {
      if (err.kind === "timeout") return { kind: "transient", label: "timeout", retryAfterMs: null };
      if (err.kind === "network") return { kind: "transient", label: "socket_error", retryAfterMs: null };
      // request_too_large: a batch that cannot shrink never fits → terminal.
      return { kind: "terminal", code: "request_too_large" };
    }
    throw err;
  }
  return classifyEventUploadResponse(response);
}

/** Map an HTTP response to a closed {@link EventUploadAttempt} (mirrors
 * `classifyRenewResponse`). PURE — no I/O, no state. */
export function classifyEventUploadResponse(response: WorkerOperationHttpResponse): EventUploadAttempt {
  if (response.status === 200) {
    const parsed = eventUploadOperationResponseV1Schema.safeParse(response.body);
    if (!parsed.success) return { kind: "terminal", code: "malformed" };
    const ack = parsed.data.ack;
    switch (ack.status) {
      case "accepted":
        return { kind: "accepted", acceptedThroughSeq: ack.acceptedThroughSeq, expectedNextSeq: ack.expectedNextSeq };
      case "gap":
        return { kind: "gap", acceptedThroughSeq: ack.acceptedThroughSeq, expectedNextSeq: ack.expectedNextSeq };
      case "hash_mismatch":
        // The frozen schema guarantees rejectedEventId is present for this status.
        return {
          kind: "hash_mismatch",
          rejectedEventId: ack.rejectedEventId as string,
          acceptedThroughSeq: ack.acceptedThroughSeq,
        };
      case "stale_fence":
        return { kind: "stream_lost", reason: "stale_fence" };
      case "target_revoked":
        return { kind: "stream_lost", reason: "target_revoked" };
      case "terminal":
        return { kind: "stream_lost", reason: "terminal" };
      default:
        return { kind: "terminal", code: "malformed" };
    }
  }
  const err = protocolErrorV1Schema.safeParse(response.body);
  const code = err.success ? err.data.code : null;
  const retryAfterMs = err.success ? err.data.retryAfterMs : null;

  if (response.status === 401) return { kind: "unauthorized" };
  if (code === "target_revoked") return { kind: "stream_lost", reason: "target_revoked" };
  if (code === "throttled" || response.status === 429) return { kind: "transient", label: "throttled", retryAfterMs };
  if (code === "internal_unavailable" || response.status === 503) {
    return { kind: "transient", label: "internal_unavailable", retryAfterMs };
  }
  return { kind: "terminal", code: code ?? `http_${response.status}` };
}
