/**
 * Vendored worker-control HTTP header names (WRK-002).
 *
 * The `@armyofagents/shared` package is NOT an allowed runtime dependency of the
 * isolated worker daemon (E4-D01 boundary), so the eight transport-boundary
 * header names are VENDORED here rather than imported. The source of truth is
 * `packages/shared/src/constants.ts` (WORKER_CONTROL_HEADERS); the contract test
 * `transport-headers.contract.test.ts` imports `@armyofagents/shared` as a
 * devDependency and asserts these vendored values equal the shared set exactly,
 * so any drift fails CI. These are the JOB-002 transport-only device-proof /
 * session headers — the frozen E1 enrollment JSON carries none of them.
 */

export const WORKER_CONTROL_HEADERS = Object.freeze({
  /** The one-time enrollment code presented on the enroll request. */
  enrollmentCode: "aoa-enrollment-code",
  /** Device-proof scheme version (currently `"1"`). */
  proofVersion: "aoa-device-proof-version",
  /** Base64url SPKI DER of the device Ed25519 public key. */
  publicKey: "aoa-device-public-key",
  /** Base64url Ed25519 signature over the canonical proof string. */
  signature: "aoa-device-signature",
  /** ISO-8601 UTC instant the proof was issued (anti-replay skew window). */
  issuedAt: "aoa-device-issued-at",
  /** Per-proof unique id (server dedups it to reject a replayed proof). */
  proofId: "aoa-device-proof-id",
  /** Optional transport request id (tracing / correlation echo). */
  requestId: "aoa-device-request-id",
  /** Short-lived session token issued by the control plane on enroll. */
  session: "aoa-worker-session",
} as const);

export type WorkerControlHeaderKey = keyof typeof WORKER_CONTROL_HEADERS;
export type WorkerControlHeaderName = (typeof WORKER_CONTROL_HEADERS)[WorkerControlHeaderKey];
