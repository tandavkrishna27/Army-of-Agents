// server/src/services/device-local-activation-policy.ts
//
// DSK-002 Lane D (D7/I10/I11) — the device-local activation POLICY: how long an
// activation may live, and what form it should take.
//
// THE BOUND DSK-001 DEFERRED HERE, verbatim from `device-local-broker.ts`:
//
//   "D10 specifies `expiresAt <= the lease deadline`. NOTHING ENFORCES THAT BOUND
//    TODAY, and this comment is here so the field does not imply a guarantee it does
//    not have … an explicit deferral to DSK-002."
//
// That was safe only because `failClosedDeviceLocalBroker` throws, so nothing could mint
// an activation at all. The bound has to exist BEFORE anything can.
//
// WHY A NON-MATERIALIZING ACTIVATION IS PREFERRED (D7). Deadline destruction is only as
// good as what is left behind when the destructor does not run:
//
//   proxy_endpoint  a loopback endpoint the broker owns   process death IS destruction
//   env_name        a value in a child's environment      dies with the child
//   file_path       BYTES ON DISK                         a kill -9 orphans them
//
// This is the difference between a deadline that is ENFORCED and one that is REQUESTED.
// §7 of the design records the `file_path` residual honestly rather than claiming the
// timer closes it.
//
// PURE — no clock, no fs, no OS. Every input is passed in, which is what makes the clamp
// and the ranking testable, and is the same shape as Lane A's `bindGrantToDevice`.

import type { DeviceLocalActivationReferenceKind } from "./device-local-broker.js";

/**
 * Reference kinds, most to least preferred. OUR ranking, not the caller's: a consumer
 * that lists `file_path` first is expressing what it supports, not what it should get.
 */
export const ACTIVATION_REFERENCE_PREFERENCE = [
  "proxy_endpoint",
  "env_name",
  "file_path",
] as const satisfies readonly DeviceLocalActivationReferenceKind[];

/**
 * The best reference kind the consumer supports, or `null` when it supports none we
 * offer. Fail closed — an unrecognised kind is not a reason to guess, and returning a
 * default here would hand out `file_path` to a consumer that never asked for it.
 */
export function preferredReferenceKind(
  supported: readonly DeviceLocalActivationReferenceKind[],
): DeviceLocalActivationReferenceKind | null {
  const offered = new Set<string>(supported);
  return ACTIVATION_REFERENCE_PREFERENCE.find((kind) => offered.has(kind)) ?? null;
}

export const ACTIVATION_EXPIRY_REJECTIONS = [
  "no_lease_deadline",
  "lease_expired",
  "invalid_ttl",
] as const;

export type ActivationExpiryRejection = (typeof ACTIVATION_EXPIRY_REJECTIONS)[number];

export type ActivationExpiryResult =
  | { readonly ok: true; readonly expiresAtMs: number }
  | { readonly ok: false; readonly reason: ActivationExpiryRejection };

export interface ActivationExpiryInput {
  readonly nowMs: number;
  readonly requestedTtlMs: number;
  /** The lease deadline. Absent or non-finite is a REFUSAL, never "unbounded". */
  readonly leaseExpiresAtMs: number | undefined;
}

/**
 * The activation's expiry: the requested TTL, clamped to the lease deadline.
 *
 * Three refusals rather than three silent coercions, because each would otherwise mint
 * something that has to be remembered as special later:
 *
 *  - **no_lease_deadline** — an absent deadline read as "no limit" is exactly the
 *    forever-activation DSK-001 warned about. `NaN` is folded in here because every
 *    comparison against it is false, so an unchecked `NaN` would sail through the clamp.
 *  - **lease_expired** — at or past the deadline there is nothing to clamp TO. Minting a
 *    zero-length activation would leave something downstream obliged to treat it as
 *    already dead, and Lane C's gate exists precisely so nobody has to.
 *  - **invalid_ttl** — a non-positive TTL is a caller bug, not a request for an
 *    instantly-dead credential.
 */
export function clampActivationExpiry(input: ActivationExpiryInput): ActivationExpiryResult {
  const { nowMs, requestedTtlMs, leaseExpiresAtMs } = input;
  if (leaseExpiresAtMs === undefined || !Number.isFinite(leaseExpiresAtMs)) {
    return { ok: false, reason: "no_lease_deadline" };
  }
  if (requestedTtlMs <= 0) return { ok: false, reason: "invalid_ttl" };
  if (nowMs >= leaseExpiresAtMs) return { ok: false, reason: "lease_expired" };
  return { ok: true, expiresAtMs: Math.min(nowMs + requestedTtlMs, leaseExpiresAtMs) };
}
