// -----------------------------------------------------------------------------
// DEP-011 Slice 2a — the worker-daemon-LOCAL owned-labels-capability shape.
//
// worker-daemon treats the control-plane-minted capability as OPAQUE. It must NOT
// import the leaf `@armyofagents/provider-capability`'s `OwnedLabelsCapability`
// type: `check-worker-daemon-boundary` scans every non-`*.test.ts` source and its
// extractor has NO `import type` awareness (`worker-protocol-boundary.mjs`), so an
// `import type { OwnedLabelsCapability }` in runtime source is a forbidden runtime
// import. And provider-wire's `isValidCapability` is module-PRIVATE. So the daemon
// declares a LOCAL structural type + VENDORS the shape-guard here.
//
// The guard is a faithful mirror of `provider-wire/codec.ts`'s private
// `isValidCapability` (the ordered-label-tuple + version/audience/expiry/sig
// primitive-type check). It confirms only the SHAPE — the SIGNATURE is verified
// server-side by the adapter-manager against the pinned control-plane public key.
// `owned-labels-capability-guard.contract.test.ts` PINS this guard against a REAL
// minted capability so it cannot drift (the "vendor + pin" pattern
// `secret-redemption.ts` already uses for the resolve request body).
//
// Structural assignability bridges this LOCAL type to the leaf's real
// `OwnedLabelsCapability` at the OUTSIDE composition root (2b) / the `.test.ts`,
// where the real `NetworkedProviderDriver` binds the capability — the daemon itself
// never names the leaf type.
// -----------------------------------------------------------------------------

import type { ResourceLabels } from "../supervisor/provider.js";

/**
 * The worker-daemon's OPAQUE, local view of a control-plane owned-labels capability.
 * Deliberately WIDER than the leaf's `OwnedLabelsCapability` (`v: number`/`audience:
 * string`, not the `1`/`"adapter-manager"` literals) — the daemon carries it through
 * unexamined; the adapter-manager verify enforces the exact version/audience/signature.
 */
export interface OwnedLabelsCapabilityLike {
  readonly v: number;
  readonly audience: string;
  readonly ownedLabels: ResourceLabels;
  readonly expiresAt: number;
  readonly sig: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural validation of an opaque wire capability — a faithful vendored mirror of
 * `provider-wire/codec.ts`'s private `isValidCapability`. Confirms only the SHAPE (an
 * ordered label tuple + version/audience/expiry/sig of the right primitive types); the
 * SIGNATURE is verified server-side. A malformed capability is treated as ABSENT so junk
 * never reaches the per-run driver / the server gate as if valid.
 */
export function isOwnedLabelsCapabilityShape(value: unknown): value is OwnedLabelsCapabilityLike {
  if (!isRecord(value)) return false;
  if (typeof value.v !== "number" || typeof value.audience !== "string") return false;
  if (typeof value.expiresAt !== "number" || typeof value.sig !== "string") return false;
  const labels = value.ownedLabels;
  if (!isRecord(labels)) return false;
  return (
    typeof labels.organizationId === "string" &&
    typeof labels.targetId === "string" &&
    typeof labels.workerId === "string" &&
    typeof labels.jobId === "string" &&
    typeof labels.attempt === "number" &&
    typeof labels.leaseId === "string" &&
    typeof labels.deviceGeneration === "number"
  );
}

/**
 * The identity tuple two per-handle capabilities must AGREE on to dedup (§2a.2, review
 * MED-3): `ownedLabels` + `v` + `audience` ONLY — NEVER `expiresAt`/`sig`, which a 2-key
 * run's caps legitimately differ on by a few ms (`min(authorityNow+TTL, D)` with a fresh
 * `authorityNow` per handle). A canonical JSON of the ordered tuple, so a comparison is a
 * plain string equality (no field-order ambiguity).
 */
export function ownedLabelsCapabilityIdentity(cap: OwnedLabelsCapabilityLike): string {
  const l = cap.ownedLabels;
  return JSON.stringify([
    cap.v,
    cap.audience,
    [l.organizationId, l.targetId, l.workerId, l.jobId, l.attempt, l.leaseId, l.deviceGeneration],
  ]);
}
