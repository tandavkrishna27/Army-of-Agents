// -----------------------------------------------------------------------------
// DEP-012 Slice 1 · Unit B1 — the adapter-manager capability VERIFY.
//
// A cheap, DB-free ~15-line node:crypto check (R1 CONFIRMED: no auth-surface import,
// no DB reach). It loads the pinned control-plane PUBLIC key, rebuilds the SHARED
// canonical over ALL signed fields, verifies ONE detached Ed25519 signature, and
// checks version + audience + expiry. It is FAIL-CLOSED: any failure throws
// CapabilityVerificationError — the execute gate collapses that (and every other
// refusal cause) to the UNIFORM ResourceNotAvailableError, so a verify failure is
// byte-indistinguishable from foreign / not-found (R2 — leaks nothing).
//
// It returns the caller's OWN labels (from the verified token) — the ONLY missing
// input `#requireOwned` needs to gate `execute` AM-local. It never reaches a provider,
// a DB, or a session key.
// -----------------------------------------------------------------------------

import { verify as cryptoVerify, type KeyObject } from "node:crypto";

import type { ResourceLabels } from "@armyofagents/worker-daemon";
import {
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  buildOwnedLabelsCapabilityCanonical,
  type OwnedLabelsCapability,
  // Import from the SUBPATH (not the package barrel) so the verifier's runtime closure
  // stays minimal — it never side-effect-loads the codec/driver. DEP-011 §1.2.0 re-homed
  // the primitive to the `@armyofagents/provider-capability` leaf; `provider-wire/capability`
  // now RE-EXPORTS it verbatim, so mint (control plane) + verify (here) still resolve to the
  // ONE shared `buildOwnedLabelsCapabilityCanonical`. Kept on the provider-wire subpath (not
  // the leaf directly) so adapter-manager's β2 runtime-dependency boundary is unchanged —
  // the leaf is an adapter-manager DEVdependency for the component test only.
} from "@armyofagents/provider-wire/capability";

/** The closed failure mode of capability verification. The execute gate maps this to
 * the uniform ResourceNotAvailableError (so it never distinguishes a verify failure
 * from a foreign / not-found sandbox). It carries NO detail about which check failed. */
export class CapabilityVerificationError extends Error {
  constructor() {
    super("capability verification failed");
    this.name = "CapabilityVerificationError";
  }
}

/**
 * Verify an owned-labels capability against the pinned control-plane public key and
 * return its owned labels, or throw CapabilityVerificationError. `now` is injected
 * (ms-epoch) so the expiry check is deterministic in tests and callable off any clock.
 *
 * Order is deliberate — cheap structural + version + audience checks, then the
 * signature, then expiry. Every failure path throws the SAME error (no oracle).
 */
export function verifyOwnedLabelsCapability(
  capability: OwnedLabelsCapability,
  controlPlanePublicKey: KeyObject,
  now: number,
): ResourceLabels {
  // The pinned key must be Ed25519 — a foreign algorithm is a fail-closed refusal,
  // never a silent mis-verify.
  if (controlPlanePublicKey.asymmetricKeyType !== "ed25519") throw new CapabilityVerificationError();
  // Only the version this verifier understands (a v:2 token — B2's coarse-identity
  // extension — is refused here until the verifier is upgraded).
  if (capability.v !== OWNED_LABELS_CAPABILITY_VERSION) throw new CapabilityVerificationError();
  if (capability.audience !== OWNED_LABELS_CAPABILITY_AUDIENCE) throw new CapabilityVerificationError();
  // Fail-closed on a non-finite / non-integer expiry BEFORE trusting the `> now` compare:
  // JSON.stringify(Infinity|NaN) === "null" (an ambiguous canonical) and `!(Infinity > now)`
  // never expires. The TS `number` type is not trusted at this security boundary.
  if (!Number.isInteger(capability.expiresAt)) throw new CapabilityVerificationError();

  const canonical = buildOwnedLabelsCapabilityCanonical({
    v: capability.v,
    audience: capability.audience,
    ownedLabels: capability.ownedLabels,
    expiresAt: capability.expiresAt,
  });
  let signatureOk = false;
  try {
    signatureOk = cryptoVerify(null, canonical, controlPlanePublicKey, Buffer.from(capability.sig, "base64url"));
  } catch {
    // A malformed signature encoding is a refusal, not a throw out of verify.
    throw new CapabilityVerificationError();
  }
  if (!signatureOk) throw new CapabilityVerificationError();

  // Strict expiry: a token expiring exactly now is expired.
  if (!(capability.expiresAt > now)) throw new CapabilityVerificationError();

  return capability.ownedLabels;
}
