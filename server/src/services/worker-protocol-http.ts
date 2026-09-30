import type { Request, Response } from "express";
import {
  OPERATION_DESCRIPTORS,
  isRetryableProtocolErrorCode,
  protocolErrorV1Schema,
  type ProtocolErrorCode,
  type ProtocolErrorV1,
  type WorkerProtocolOperation,
} from "@armyofagents/worker-protocol";
import { WORKER_CONTROL_HEADERS } from "@armyofagents/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENROLLMENT_ERRORS: ReadonlySet<string> = new Set(OPERATION_DESCRIPTORS.enrollment.errors);

export type WorkerHttpProtocolErrorCode = Extract<
  ProtocolErrorCode,
  "malformed" | "unauthorized" | "internal_unavailable"
>;

function correlationId(req: Request): string | null {
  const bodyValue = req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>).correlationId
    : null;
  const headerValue = req.header(WORKER_CONTROL_HEADERS.requestId);
  const candidate = typeof bodyValue === "string" ? bodyValue : headerValue;
  return candidate && UUID.test(candidate) ? candidate : null;
}

export function workerProtocolErrorV1(
  req: Request,
  code: WorkerHttpProtocolErrorCode,
  now: Date = new Date(),
): ProtocolErrorV1 {
  if (!ENROLLMENT_ERRORS.has(code)) throw new Error(`Unsupported enrollment protocol error code: ${code}`);
  return protocolErrorV1Schema.parse({
    protocolVersion: 1,
    code,
    correlationId: correlationId(req),
    message: code === "malformed"
      ? "Worker control request malformed"
      : code === "internal_unavailable"
        ? "Worker control temporarily unavailable"
        : "Worker control request denied",
    retryAfterMs: code === "internal_unavailable" ? 1_000 : null,
    serverTime: now.toISOString(),
    redaction: "secret",
    detail: {},
  });
}

export function workerOperationProtocolErrorV1(
  req: Request,
  operation: WorkerProtocolOperation,
  code: ProtocolErrorCode,
  now: Date = new Date(),
): ProtocolErrorV1 {
  if (!OPERATION_DESCRIPTORS[operation].errors.includes(code)) {
    throw new Error(`Unsupported ${operation} protocol error code: ${code}`);
  }
  return protocolErrorV1Schema.parse({
    protocolVersion: 1,
    code,
    correlationId: correlationId(req),
    message: code === "malformed"
      ? "Worker control request malformed"
      : code === "internal_unavailable" || code === "throttled"
        ? "Worker control temporarily unavailable"
        : "Worker control request denied",
    retryAfterMs: isRetryableProtocolErrorCode(code) ? 1_000 : null,
    serverTime: now.toISOString(),
    redaction: "secret",
    detail: {},
  });
}

export function sendWorkerOperationProtocolError(
  req: Request,
  res: Response,
  operation: WorkerProtocolOperation,
  code: ProtocolErrorCode,
  now: Date = new Date(),
): void {
  const status = code === "malformed"
    ? 400
    : code === "internal_unavailable"
      ? 503
      : code === "throttled"
        ? 429
        : code === "unauthorized"
          ? 401
          : 409;
  res.status(status).json(workerOperationProtocolErrorV1(req, operation, code, now));
}

export function sendWorkerProtocolError(
  req: Request,
  res: Response,
  code: WorkerHttpProtocolErrorCode,
  now: Date = new Date(),
): void {
  const status = code === "malformed" ? 400 : code === "internal_unavailable" ? 503 : 401;
  res.status(status).json(workerProtocolErrorV1(req, code, now));
}

/**
 * The refusal code for an over-ceiling body, DERIVED from the operation's OWN
 * frozen error vocabulary.
 *
 * ★ WHY THIS IS NOT A CONSTANT. Six handlers refuse an oversized body, and four
 * of them hard-coded `payload_too_large`. But only event_upload,
 * artifact_transfer_grant, quarantine_grant and quarantine_finalize DECLARE that
 * code; artifact_commit and control_command do not. `workerOperationProtocolErrorV1`
 * THROWS on a code outside the operation's vocabulary, that throw is caught by the
 * route's own catch, and the fallthrough answers `internal_unavailable` -> 503 with
 * a bounded retryAfterMs. Both operations are `idempotent_retry`, so a body that can
 * NEVER succeed would be retried forever.
 *
 * That was harmless only while the express 100 KB default kept those two guards dead
 * by construction (256 KiB > 102400 is unreachable when rawBody can never exceed
 * 102400). BRW-003d-1 raises the mount, which makes them live -- so the ticket that
 * revives a guard is also the ticket that has to make it speak a legal word.
 *
 * `malformed` is the honest fallback: it IS in every one of the ten vocabularies,
 * it is what poll / lease_ack / lease_renew already emit for the same condition,
 * and it is NON-retryable, so an oversized body terminates instead of looping.
 */
export function sizeRefusalCode(
  operation: WorkerProtocolOperation,
): ProtocolErrorCode {
  return OPERATION_DESCRIPTORS[operation].errors.includes("payload_too_large")
    ? "payload_too_large"
    : "malformed";
}

export function isEnrollmentWorkerControlPath(url: string): boolean {
  return /^\/(?:api\/)?worker-control\/enroll(?:\?|$)/.test(url);
}
