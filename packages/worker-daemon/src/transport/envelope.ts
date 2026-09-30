/**
 * Enrollment request envelope assembly (WRK-002).
 *
 * Builds the frozen-E1 `enrollmentRequestV1Schema` body and serializes it to the
 * EXACT transport bytes ONCE. The device proof digests these same bytes
 * (`sha256(rawBody)`), so the server's transport-boundary digest matches
 * byte-for-byte — the worker never re-serializes the body between signing and
 * sending. The audience is the binding literal `target_enrollment` (frozen E1);
 * `protocolVersion`, `correlationId`, `issuedAt`, `nonce`, and `idempotencyKey`
 * are the anti-replay/idempotency envelope fields.
 */

import {
  enrollmentRequestV1Schema,
  type EnrollmentRequestV1,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";

export interface BuildEnrollmentRequestInput {
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** RFC3339 envelope timestamp (distinct from the device-proof issuedAt). */
  readonly issuedAt: string;
  readonly nonce: string;
  readonly hello: WorkerHelloV1;
}

export interface EnrollmentRequestEnvelope {
  readonly request: EnrollmentRequestV1;
  /** The exact bytes to POST (and to digest for the device proof). */
  readonly bytes: Buffer;
}

/**
 * Assemble + validate the enrollment request and freeze its transport bytes.
 * Throws (via zod) if the assembled body is not a valid frozen-E1 enrollment
 * request — a local contract failure surfaced before any network I/O.
 */
export function buildEnrollmentRequest(input: BuildEnrollmentRequestInput): EnrollmentRequestEnvelope {
  const request = enrollmentRequestV1Schema.parse({
    protocolVersion: 1,
    correlationId: input.correlationId,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    audience: "target_enrollment",
    idempotencyKey: input.idempotencyKey,
    hello: input.hello,
  });
  const bytes = Buffer.from(JSON.stringify(request), "utf8");
  return { request, bytes };
}
