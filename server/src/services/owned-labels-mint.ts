// server/src/services/owned-labels-mint.ts
//
// DEP-011 Slice 1 — the server-side owned-labels-capability MINT (§1.2–§1.6).
//
// The control plane mints a short-lived SIGNED OwnedLabelsCapability over a worker's OWN
// 7-field resource-label tuple, in the sandbox-local `resolveExecutionSecret` ALLOW reply.
// A networked worker's later `create` can then be gated by `adapter-manager` (β1/β2), which
// verifies ONE Ed25519 signature and enforces `labelsEqual(spec.resourceLabels, cap.ownedLabels)`.
// Ships INERT: nothing consumes the capability yet (Slice 2); the worker reads the reply as a
// plain record and ignores unknown keys.
//
// THREE invariants govern this module:
//
//   PARITY (§1.3) — the minted `ownedLabels` MUST equal the worker's `labelsFor(handoff)`
//     field-for-field, or the gate rejects EVERY networked create. `ownedLabelsFromFenceIdentity`
//     is a FRESH 7-field object literal — NEVER `{...fenceIdentity}` (a spread leaks the fence
//     token) and NEVER `as ResourceLabels` (the cast silences excess-property checking). Note the
//     field-name map: `attempt ← attemptNumber`, `deviceGeneration ← targetGeneration`; and the
//     coercions — String() the three the worker strings, keep attempt/deviceGeneration NUMERIC
//     (`labelsEqual` is strict `===`, so a number/string drift is fatal).
//
//   #104 (§1.6) — the mint site has TWO secrets in scope beyond the 7 labels: the redeemed model
//     `value` AND the fence bearer token (+ targetAuthorityKey / profileHash / providerConstraintHash).
//     The capability is signed over the 7 LABELS ONLY; the fresh-literal rule keeps everything else
//     out. This module logs nothing.
//
//   EXPIRY (§1.4) — `expiresAt = min(authorityNow + shortTtlMs, leaseDeadline)`: a finite integer
//     (the primitive rejects a non-integer) clamped to the lease deadline (a token must not outlive
//     the lease it authorizes).

import type { KeyObject } from "node:crypto";

import type { ActiveFenceRequest } from "@armyofagents/db";
import type { ResourceLabels } from "@armyofagents/worker-daemon";
import {
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  signOwnedLabelsCapability,
  type OwnedLabelsCapability,
} from "@armyofagents/provider-capability";

import type { SecretResolveOutcome } from "./secret-broker.js";

/** A short default TTL, clamped to the lease deadline. The absolute bound is the lease
 * deadline (§1.4); this is the "never longer than" ceiling for a healthy short lease. */
export const OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS = 5 * 60_000;

/** The device-proof-verified fence context the mint reads — the fields
 * `resolveWorkerFenceContext` already resolves inside the broker tenant-tx closure. */
export interface OwnedLabelsMintContext {
  readonly fenceIdentity: ActiveFenceRequest;
  /** The injected DB clock (`currentDatabaseTime`), never a JS wall-clock. */
  readonly authorityNow: Date;
  /** The locked lease's `expires_at`, the absolute expiry bound. */
  readonly leaseDeadline: Date;
}

export interface OwnedLabelsMintOptions {
  /** The control-plane Ed25519 PRIVATE key. Absent ⇒ the mint is OMITTED (inert) — never a throw.
   * A TEST keypair for the component; the REAL key + provisioning are deploy/Slice 5. */
  readonly controlPlaneSigningKey?: KeyObject;
  readonly shortTtlMs: number;
}

/**
 * The FRESH 7-field label literal — the parity + #104 containment core. Built by name from
 * `ActiveFenceRequest`, NEVER spread from it (that would leak the fence token / hashes into a
 * worker-visible reply). The field-name map + coercions match the worker's `labelsFor`.
 */
export function ownedLabelsFromFenceIdentity(fenceIdentity: ActiveFenceRequest): ResourceLabels {
  return {
    organizationId: String(fenceIdentity.organizationId),
    targetId: fenceIdentity.targetId,
    workerId: String(fenceIdentity.workerId),
    jobId: String(fenceIdentity.jobId),
    attempt: fenceIdentity.attemptNumber, // NUMBER — do NOT String()
    leaseId: fenceIdentity.leaseId,
    deviceGeneration: fenceIdentity.targetGeneration, // NUMBER — do NOT String()
  };
}

/**
 * Mint the signed capability: fresh labels + the lease-clamped expiry, signed with the
 * control-plane key. The clamp is `min(now + TTL, leaseDeadline)`; `Date.getTime()` yields
 * an integer ms-epoch, so the result is always the finite integer the primitive requires.
 */
export function mintOwnedLabelsCapability(
  ctx: OwnedLabelsMintContext,
  controlPlaneSigningKey: KeyObject,
  shortTtlMs: number,
): OwnedLabelsCapability {
  const expiresAt = Math.min(ctx.authorityNow.getTime() + shortTtlMs, ctx.leaseDeadline.getTime());
  return signOwnedLabelsCapability(
    {
      v: OWNED_LABELS_CAPABILITY_VERSION,
      audience: OWNED_LABELS_CAPABILITY_AUDIENCE,
      ownedLabels: ownedLabelsFromFenceIdentity(ctx.fenceIdentity),
      expiresAt,
    },
    controlPlaneSigningKey,
  );
}

/**
 * The POSITIVE mint gate (§1.5): augment the resolve outcome with the capability ONLY on
 * EXACTLY `resolved ∧ seam === "sandbox_local_only"` AND only when a control-plane key is
 * configured. Every other outcome — `device_handoff`, `denied`, a non-sandbox-local seam,
 * or no key — is returned UNCHANGED. NEVER throws: a mint decision must not fail the resolve.
 */
export function applyOwnedLabelsCapability(
  outcome: SecretResolveOutcome,
  ctx: OwnedLabelsMintContext,
  opts: OwnedLabelsMintOptions,
): SecretResolveOutcome {
  if (!opts.controlPlaneSigningKey) return outcome;
  if (outcome.outcome !== "resolved" || outcome.seam !== "sandbox_local_only") return outcome;
  const ownedLabelsCapability = mintOwnedLabelsCapability(ctx, opts.controlPlaneSigningKey, opts.shortTtlMs);
  return { ...outcome, ownedLabelsCapability };
}
