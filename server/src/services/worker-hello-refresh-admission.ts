// server/src/services/worker-hello-refresh-admission.ts
//
// WRK-011 (Sprint 2.75) — may this ALREADY-AUTHENTICATED worker replace its enrolled
// self-model snapshot with a REFRESHED hello?
//
// ★ READ THIS BEFORE ADDING A GUARD. The caller has already been through
// `createWorkerSessionAuthenticator` (worker-session-auth.ts:112-213), which proved the
// session's HMAC + expiry, the device proof's signature/skew/path/body binding, that the
// proof's key is the session's, that the proof is not a replay (it BURNS it), that the
// authority row exists and is not revoked/disabled, that the owner membership is live,
// that both generations agree with the token, and that the row's scope, org, profile
// hash, thumbprint and PUBLIC KEY match — the same nine-of-ten map WRK-010 §3.4 records.
// Re-checking any of that here would be a second authority surface that can drift out of
// agreement with the first. This function decides only the four things the authenticator
// does not know about (§4.1), and PRODUCES the canonical digest to write.
//
// PURE: no database, no clock, no request, no crypto. The `digestOf` dependency is
// INJECTED so the unit matrix drives G4 both ways without computing sha256, and so the
// production wiring — the single place `JSON.stringify` meets the zod-parsed hello — has
// exactly one call site to mutate (design §8 M11).
//
// Tenancy is deliberately absent: the route carries no identifier at all, so cross-tenant
// reach is answered by construction at the authenticator, not by a check here that could
// drift. A platform PHYSICAL worker (organizationId === null) is a §10 non-goal and is
// refused at the route by the type-forced `runInTenant` org narrow — it never reaches a
// tenant `workers` write.

import type { WorkerHelloV1 } from "@armyofagents/worker-protocol";

export type HelloRefusalReason =
  | "identity_mismatch"
  | "capability_not_granted"
  | "policy_stale"
  | "profile_unratified";

export type HelloRefreshDecision =
  | { readonly admit: true; readonly changed: false }
  | { readonly admit: true; readonly changed: true; readonly profileHash: string }
  | { readonly admit: false; readonly reason: HelloRefusalReason };

export interface HelloRefreshInput {
  readonly principal: {
    readonly workerId: string;
    readonly targetId: string;
    readonly targetGeneration: number;
  };
  /** ALREADY zod-parsed by the caller (`workerHelloV1Schema`). */
  readonly hello: WorkerHelloV1;
  /** The admin-ratified ceiling for this target, or null when none is ratified. */
  readonly ratified: { readonly capabilityCeiling: readonly string[]; readonly policyHash: string } | null;
  readonly currentProfileHash: string | null;
  /** Injected. Production = sha256(JSON.stringify(zod-parsed hello)). */
  readonly digestOf: (hello: WorkerHelloV1) => string;
}

/**
 * Every hello-refresh refusal answers `unauthorized` on the wire, coarse by design so the
 * route cannot become an oracle for target existence/configuration state (§5.3). The
 * discriminant reaches the operator LOG only. The `_r` exhaustiveness parameter makes a
 * future reason without a wire mapping a compile error — mirrors
 * `sessionRenewalRefusalWireCode` (worker-session-renewal-admission.ts:78).
 */
export function helloRefreshRefusalWireCode(_r: HelloRefusalReason): "unauthorized" {
  return "unauthorized";
}

export function admitHelloRefresh(input: HelloRefreshInput): HelloRefreshDecision {
  // profile_unratified — no admin has ratified a placement profile for this target.
  // RETRYABLE in spirit (an admin may configure it later, §5.3), but coarse `unauthorized`
  // on the wire like every other refusal; a worker re-reads its self-model and tries again.
  if (!input.ratified) return { admit: false, reason: "profile_unratified" };

  const h = input.hello;

  // G1 — identity. The presented hello must be ABOUT this worker. The generation arm is
  // not decoration: the matcher compares `worker.deviceGeneration !== profile.deviceGeneration`
  // (capabilities.ts:460) and placement compares it to the registry generation
  // (job-placement.ts:533), so a snapshot at the wrong generation is unplaceable in exactly
  // the way this ticket exists to end. The hello's own ids are a CLAIM checked against the
  // principal, never a second identity source (§3.4).
  if (
    String(h.workerId) !== input.principal.workerId ||
    String(h.targetId) !== input.principal.targetId ||
    h.deviceGeneration !== input.principal.targetGeneration
  ) {
    return { admit: false, reason: "identity_mismatch" };
  }

  // G2 — capability ceiling, as a SUBSET and not an intersection. Refuse, do not clamp
  // (§2.2): the durable snapshot must record only claims the device was entitled to make,
  // and the refusal names an ungranted capability for the operator log. The `ceiling.has`
  // conjunct is what makes this a subset rather than set-equality (design §8 M6).
  const ceiling = new Set(input.ratified.capabilityCeiling.map(String));
  for (const cap of h.reportedCapabilities) {
    if (!ceiling.has(String(cap))) return { admit: false, reason: "capability_not_granted" };
  }

  // G3 — policy coherence (an ANTI-STALENESS check, not an authorisation one, §4.2). The
  // matcher demands `worker.policyHash === profile.policyHash` (capabilities.ts:475), so a
  // snapshot that fails this could never match anything; refusing turns a silent permanent
  // non-match into a named, retryable refusal a daemon acts on by re-reading its self-model.
  if (String(h.policyHash) !== String(input.ratified.policyHash)) {
    return { admit: false, reason: "policy_stale" };
  }

  // G4 — idempotency. When the computed digest already equals the row's hash the refresh is
  // a no-op: write nothing, mint nothing (§4.2). Without it every boot of every worker
  // rewrites the row and mints a session — a fleet restart becomes a session-churn storm
  // against a table under FORCE RLS.
  const profileHash = input.digestOf(h);
  if (profileHash === input.currentProfileHash) return { admit: true, changed: false };
  return { admit: true, changed: true, profileHash };
}
