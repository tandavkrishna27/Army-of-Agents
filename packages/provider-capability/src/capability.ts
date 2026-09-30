// -----------------------------------------------------------------------------
// DEP-011 Slice 1 · packaging (§1.2.0) — the PURE owned-labels-capability primitive
// re-homed into a LEAF package (`@armyofagents/provider-capability`).
//
// Extracted, BYTE-FOR-BYTE, from `@armyofagents/provider-wire/capability` (DEP-012
// Unit B1). The schema + the shared canonical + the mint primitive live HERE so the
// CONTROL-PLANE image (server) can import the mint WITHOUT dragging `worker-daemon`
// + `sandbox-e2b-provider` into its runtime closure (`docker/control-plane/Dockerfile`
// excludes them; `check-image-deps-stages.mjs` enforces exact). The leaf's ONLY runtime
// dependency is `node:crypto`; `ResourceLabels` is a TYPE-only import, so `worker-daemon`
// is a devDependency, never a runtime one.
//
// `provider-wire/capability.ts` now RE-EXPORTS from this leaf, and the adapter-manager
// verify imports its canonical from HERE — so mint and verify go through the ONE shared
// `buildOwnedLabelsCapabilityCanonical` (the device-proof parity lesson: a drifted
// canonicalizer is a silent forgery hole). This module is a mechanical RE-HOME, NOT a
// schema/behavior change (a mint↔verify byte-parity test pins it).
//
// ---------------------------------------------------------------------------------
// (original DEP-012 Unit B1 rationale, preserved verbatim:)
//
// The control plane mints a short-lived SIGNED token binding a worker's OWN ordered
// resource-label TUPLE. `adapter-manager` verifies ONE detached Ed25519 signature
// (the control-plane public key) — no DB, no session keys — then gates `execute`
// server-side against a FIELD-WISE label compare (`#requireOwned`'s check, relocated).
//
// ★ It carries the ORDERED TUPLE, NOT `hashResourceLabels` (R2): the hash is a
// space-JOIN built for logging, and two distinct tuples with a space in a field
// collide under it — a canonicalization bypass. Authorization must compare fields,
// so the token carries the fields and the gate compares them with `labelsEqual`.
//
// ★ The `v` discriminant is MANDATORY forward-compat (R4): B2 extends the capability
// with coarse identity for `list` (a clean `v:2` bump); a bare struct signature is not
// additive-tolerant, so it is versioned from B1.
//
// Decision #104: the token carries owned LABELS (the caller's OWN identity) + expiry,
// NEVER a provider/model key or a redeemed secret; a codec must not log `sig`.
// -----------------------------------------------------------------------------

import { sign as cryptoSign, type KeyObject } from "node:crypto";

import type { ResourceLabels } from "@armyofagents/worker-daemon";

export const OWNED_LABELS_CAPABILITY_VERSION = 1 as const;
export const OWNED_LABELS_CAPABILITY_AUDIENCE = "adapter-manager" as const;

/**
 * A signed, short-lived owned-labels capability. `sig` is a detached Ed25519
 * signature (base64url) over the UNAMBIGUOUS canonical of ALL other fields. The
 * caller's own labels in a signed token are NOT a disclosure — the F2 redaction
 * rule concerns OTHER workers' labels (via inspect/list), not the caller's own.
 */
export interface OwnedLabelsCapability {
  readonly v: typeof OWNED_LABELS_CAPABILITY_VERSION;
  readonly audience: typeof OWNED_LABELS_CAPABILITY_AUDIENCE;
  readonly ownedLabels: ResourceLabels;
  /** Absolute ms-epoch expiry. The gate refuses `expiresAt <= now`. */
  readonly expiresAt: number;
  readonly sig: string;
}

/** The signed fields — the capability MINUS its signature. */
export type OwnedLabelsCapabilitySignedFields = Omit<OwnedLabelsCapability, "sig">;

/**
 * Build the UNAMBIGUOUS canonical bytes signed by a capability — a fixed-order
 * JSON array of ALL signed fields, with `ownedLabels` itself flattened to a
 * fixed-order array (never the object: object key order is not a guaranteed,
 * attacker-independent property). This is UNLIKE `hashResourceLabels`' space-join:
 * field boundaries are preserved, so no two distinct tuples share a canonical.
 *
 * ★ Sign and verify MUST build the canonical through THIS one function — the
 * device-proof parity lesson: a drifted canonicalizer is a silent forgery hole.
 */
export function buildOwnedLabelsCapabilityCanonical(fields: OwnedLabelsCapabilitySignedFields): Buffer {
  const l = fields.ownedLabels;
  const canonical = JSON.stringify([
    fields.v,
    fields.audience,
    [l.organizationId, l.targetId, l.workerId, l.jobId, l.attempt, l.leaseId, l.deviceGeneration],
    fields.expiresAt,
  ]);
  return Buffer.from(canonical, "utf8");
}

/**
 * Mint (sign) an owned-labels capability with a control-plane Ed25519 PRIVATE key.
 *
 * ★ DEP-012 B1 used this ONLY with a TEST keypair (the component test). DEP-011
 * Slice 1 is the FIRST production caller: it mints inside the fenced
 * `resolveExecutionSecret` reply, where JWT+device-proof-verified labels already
 * exist, under an INJECTED control-plane key (a test keypair for the component; the
 * REAL key + provisioning/rotation are deploy/Slice 5). The primitive is shared so
 * the production mint cannot drift from the adapter-manager verify.
 */
export function signOwnedLabelsCapability(
  fields: OwnedLabelsCapabilitySignedFields,
  privateKey: KeyObject,
): OwnedLabelsCapability {
  // Never mint a non-finite / non-integer expiry: JSON.stringify(Infinity|NaN) === "null"
  // (an AMBIGUOUS canonical) and `!(Infinity > now)` never expires (an IMMORTAL token). The
  // producer refuses so a bad value can never be minted — the verify enforces the same at
  // the authorization boundary (defense in depth; the type alone is not trusted).
  if (!Number.isInteger(fields.expiresAt)) {
    throw new Error("owned-labels capability expiresAt must be a finite integer ms-epoch");
  }
  const sig = cryptoSign(null, buildOwnedLabelsCapabilityCanonical(fields), privateKey).toString("base64url");
  return { ...fields, sig };
}
