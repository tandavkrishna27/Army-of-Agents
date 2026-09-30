// server/src/services/worker-session-renewal-admission.ts
//
// WRK-010 — may this ALREADY-AUTHENTICATED principal mint a fresh bounded device session?
//
// ★ READ THIS BEFORE ADDING A GUARD. The caller has already been through
// `createWorkerSessionAuthenticator` (worker-session-auth.ts:109-210), which proved: the
// session's HMAC and expiry, the device proof's signature/skew/path/body binding, that the
// proof's key is the session's, that the proof is not a replay (it BURNS it), that the
// authority row exists and is not revoked/disabled, that the owner membership is live, that
// both generations agree with the token, that the row's scope, org, profile hash, thumbprint
// and PUBLIC KEY match, and — for a shared platform target — that the operator-side physical
// authority agrees. Re-checking any of that here would create a second authority surface that
// can drift out of agreement with the first. That was the defect this file was rewritten to
// remove; see the design doc §0(c).
//
// PURE: no database, no clock, no request, no crypto.
//
// The 15-minute ceiling is deliberately ABSENT: `createWorkerSessionToken`
// (worker-session-auth.ts:80) asserts it at mint, so a defect trying to issue a longer session
// throws there rather than passing here. iat/exp are likewise absent — they need a clock, and
// this function does not have one. It returns the IDENTITY half; the service stamps the window.
//
// Tenancy is deliberately absent too. The route carries no identifier at all, so cross-tenant
// reach is answered by construction at the authenticator, not by a check here that could drift.

export type SessionRenewalRefusal =
  | "platform_physical_unsupported"
  | "platform_authority_unresolved";

export interface SessionRenewalInput {
  /** `VerifiedTargetPrincipal.organizationId` — null ONLY for a platform PHYSICAL session. */
  readonly principalOrganizationId: string | null;
  /** The WORKER's scope, bound to the row by worker-session-auth.ts:165. */
  readonly principalScope: "platform" | "organization" | "owner";
  /** The TARGET's scope, read from the row at worker-session-auth.ts:177. */
  readonly principalTargetScope: "platform" | "organization" | "owner";
  /** `principal.sharedPlatformAuthority !== undefined` (worker-session-auth.ts:198-205). */
  readonly hasSharedPlatformAuthority: boolean;
  readonly workerId: string;
  readonly targetId: string;
  readonly generation: number;
  readonly deviceThumbprint: string;
  readonly profileHash: string;
}

/**
 * The IDENTITY half of the claims to mint — never iat/exp (the service stamps those from its
 * clock) and never the 15-minute ceiling (the mint helper asserts it). `organizationId` is a
 * non-null string and `scope` cannot be "platform": both are narrowed by R1.
 */
export interface SessionRenewalIdentity {
  readonly aud: "device_session";
  readonly sub: string;
  readonly organizationId: string;
  readonly targetId: string;
  readonly generation: number;
  readonly scope: "organization" | "owner";
  readonly deviceThumbprint: string;
  readonly profileHash: string;
}

export type SessionRenewalDecision =
  | { readonly admit: true; readonly identity: SessionRenewalIdentity }
  | { readonly admit: false; readonly refusal: SessionRenewalRefusal };

function refuse(refusal: SessionRenewalRefusal): SessionRenewalDecision {
  return { admit: false, refusal };
}

/**
 * Every renewal refusal is TERMINAL, and that is a decision rather than an omission.
 * `unauthorized` is non-retryable; only `throttled`/`internal_unavailable` may carry
 * retryAfterMs. Unlike the self-model read — where "not configured yet" resolves by itself —
 * both refusals here are structural facts about the caller's identity class that no amount of
 * waiting changes. Making either retryable would put a worker that can never renew into a loop
 * against the control plane. The exhaustiveness test in §7 Step 2 is what enforces it.
 */
export function sessionRenewalRefusalWireCode(_r: SessionRenewalRefusal): "unauthorized" {
  return "unauthorized";
}

export function admitSessionRenewal(input: SessionRenewalInput): SessionRenewalDecision {
  // R1. A platform PHYSICAL identity may not renew here (design §3.5(ii), §9). This USED to be
  //     free: verifyWorkerOperationProof denies it at the transport (worker-operation-proof.ts:50).
  //     The authenticator does NOT — it serves platform physical via the operator DB at
  //     worker-session-auth.ts:180-182 — so the refusal has to be written down.
  //
  //     Narrowing here is what types the mint: `scope` below cannot be "platform".
  //
  //     Arm 2 (`principalScope === "platform"` with a non-null org) is UNREACHABLE:
  //     assertClaims pins (scope === "platform") === (organizationId === null) at
  //     worker-session-auth.ts:69, so the two arms never disagree in production. Written
  //     because it costs one `||`, and mutation-killed by a directly-constructed input.
  if (input.principalOrganizationId === null || input.principalScope === "platform") {
    return refuse("platform_physical_unsupported");
  }
  const scope: "organization" | "owner" = input.principalScope;

  // R2. A SHARED platform target's real device lives in the operator database. The
  //     authenticator only attaches `sharedPlatformAuthority` AFTER proving it
  //     (worker-session-auth.ts:186-205). Absent here means that proof did not run, so refuse
  //     rather than mint on unverified authority.
  //
  //     UNREACHABLE today (§4.2): a principal surviving R1 with targetScope "platform" always
  //     carries a resolved authority. Defence-in-depth for a future refactor that drops the
  //     operator read — NOT counted as coverage of a live condition.
  if (input.principalTargetScope === "platform" && !input.hasSharedPlatformAuthority) {
    return refuse("platform_authority_unresolved");
  }

  return { admit: true, identity: {
    aud: "device_session",
    sub: input.workerId,
    organizationId: input.principalOrganizationId,
    targetId: input.targetId,
    generation: input.generation,
    scope,
    deviceThumbprint: input.deviceThumbprint,
    profileHash: input.profileHash,
  } };
}
