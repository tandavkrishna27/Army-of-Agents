// packages/worker-daemon/src/enrollment/idempotency.ts
//
// DSK-001 — the enrollment idempotency key, and the reason a retry after a FAILED
// enroll is safe (I7).
//
// The server stores this as `text` and compares it with exact equality
// (`server/src/services/worker-enrollment.ts:325`), replaying an
// already-committed submission when it matches instead of treating the retry as a
// fresh enrolment. So the key must be a pure function of the IDENTITY — stable
// across restarts, across processes, and across however many attempts it takes.
//
// **No secret is an input.** The enrollment code is deliberately excluded, so the
// value that crosses the wire is not a derivative of a live bearer credential.
// That is structural rather than remembered: the function has no parameter
// through which a secret could arrive, the same shape that makes the command
// planner unable to leak a key into argv.
//
// **Lowercase is significant.** The column is `text` and the comparison is
// `!==`, so an uppercase rendering would never match a stored lowercase one and
// every retry would look like a new submission — which is precisely the
// double-mint this key exists to prevent.

import { createHash } from "node:crypto";

/**
 * Domain separator. Versioned so a future change to the derivation is a
 * deliberate migration rather than a silent change in which submissions replay.
 */
const DOMAIN = "aoa.worker.enroll.idem.v1";

/**
 * Derive the idempotency key for one (worker, target, generation) identity.
 *
 * The `|` separators make the encoding injective: without them `("ab","c")` and
 * `("a","bc")` would hash identically, so two different identities could share a
 * key and one would replay as the other.
 */
export function deriveEnrollmentIdempotencyKey(
  workerId: string,
  targetId: string,
  deviceGeneration: number,
): string {
  const digest = createHash("sha256")
    .update(`${DOMAIN}|${workerId}|${targetId}|${deviceGeneration}`, "utf8")
    .digest();

  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  // RFC-4122 version 5 + variant bits, so the value is a well-formed UUID and
  // survives any column, client, or tool that validates the shape.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
