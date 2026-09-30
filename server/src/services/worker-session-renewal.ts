// server/src/services/worker-session-renewal.ts
//
// WRK-010 slice 1 — the device-proof-bound session RENEWAL surface (server side).
//
// A worker that still holds a LIVE session and can still sign with its enrolled device
// key exchanges both for a NEW bounded session, on a route that never touches the
// enrollment code table. The heavy lifting — the nine-of-ten authority guards — is the
// SHIPPED `createWorkerSessionAuthenticator`; this module wires it, runs the one pure
// decision the authenticator does not make (`admitSessionRenewal`), and stamps the mint.
//
// The renewal operation is NOT a frozen wire op (E4-D02 keeps WORKER_PROTOCOL_OPERATIONS
// a closed ten), so the descriptor below is LOCAL — the same choice DAT-008 made at
// execution-secret-resolve.ts:78. It exists because a route without a descriptor silently
// has no size ceiling, no timeout and no audience declaration.

import { z } from "zod";
import type { AuthAudience } from "@armyofagents/worker-protocol";
import {
  SESSION_MAX_MS,
  createWorkerSessionToken,
  WorkerSessionError,
  type VerifiedTargetPrincipal,
} from "../middleware/worker-session-auth.js";
import type { DeviceProofHeaders } from "./worker-device-proof.js";
import {
  admitSessionRenewal,
  type SessionRenewalIdentity,
  type SessionRenewalRefusal,
} from "./worker-session-renewal-admission.js";

/**
 * The renewal TTL is bound to SESSION_MAX_MS, not a second constant: binding them makes
 * the agreement between "the ceiling" and "what renewal issues" structural rather than
 * coincidental. A renewal can never issue a session longer than the shared middleware
 * would verify.
 */
export const WORKER_SESSION_RENEWAL_TTL_MS = SESSION_MAX_MS;

/**
 * The LOCAL descriptor for this operation. Shaped like `OperationDescriptorV1` so the
 * route reads the same way the frozen ten do, but it lives here — the frozen package is
 * not extended (E4-D02). `audience` is `device_session`: the credential this route both
 * consumes and issues.
 */
export const SESSION_RENEW_DESCRIPTOR = {
  operation: "session_renew",
  audience: "device_session" as AuthAudience,
  idempotent: false,
  /** A protocol version, an audience literal and one UUID — larger is not one of ours. */
  maxRequestBytes: 2 * 1024,
  timeoutMs: 10_000,
} as const;

/**
 * The request body. `correlationId` is a UUID because `workerProtocolErrorV1` only echoes
 * a UUID (worker-protocol-http.ts:20-27); a looser type would silently drop it from
 * refusals. The proof signs it, so it is not a second, unsigned identity source.
 */
export const sessionRenewRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    audience: z.literal("device_session"),
    correlationId: z.string().uuid(),
  })
  .strict();

export type SessionRenewRequest = z.infer<typeof sessionRenewRequestSchema>;

export interface MintedRenewalSession {
  readonly session: string;
  readonly expiresAt: string;
  readonly deviceGeneration: number;
  readonly iat: number;
  readonly exp: number;
}

export type SessionRenewalMint = (identity: SessionRenewalIdentity, now: Date) => MintedRenewalSession;

/**
 * Stamp iat/exp from the service clock onto the admitted identity and mint. The
 * 15-minute ceiling is NOT re-checked here: `createWorkerSessionToken`
 * (worker-session-auth.ts:80) asserts it at mint, so a defect that tried to issue a
 * longer session throws there rather than shipping.
 */
export function mintRenewedSession(
  sessionSigningKey: string,
  identity: SessionRenewalIdentity,
  now: Date,
): MintedRenewalSession {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = Math.floor((now.getTime() + WORKER_SESSION_RENEWAL_TTL_MS) / 1000);
  const session = createWorkerSessionToken(sessionSigningKey, {
    aud: "device_session",
    sub: identity.sub,
    organizationId: identity.organizationId,
    targetId: identity.targetId,
    generation: identity.generation,
    scope: identity.scope,
    deviceThumbprint: identity.deviceThumbprint,
    profileHash: identity.profileHash,
    iat,
    exp,
  });
  return { session, expiresAt: new Date(exp * 1000).toISOString(), deviceGeneration: identity.generation, iat, exp };
}

/**
 * The one request shape the authenticator consumes. Structurally identical to
 * `createWorkerSessionAuthenticator(...).authenticate`'s parameter, declared as an
 * interface so tests can inject a stub without a database.
 */
export interface WorkerSessionAuthenticatorLike {
  authenticate(request: {
    authorization: string;
    rawBody: Buffer;
    proof: DeviceProofHeaders;
    method: string;
    path: string;
    correlationId: string;
  }): Promise<VerifiedTargetPrincipal>;
}

/**
 * The outcome the route renders. `refused` renders 401 `unauthorized` on the wire (the
 * `logReason` is the operator-log discriminant only — never on the wire, §5); `unavailable`
 * renders 503 `internal_unavailable`. Every refusal is coarse on the wire so the route
 * cannot become an oracle for target existence, generation or revocation state.
 */
export type SessionRenewalOutcome =
  | {
      readonly outcome: "renewed";
      readonly session: string;
      readonly expiresAt: string;
      readonly deviceGeneration: number;
      readonly iat: number;
      readonly exp: number;
    }
  | { readonly outcome: "refused"; readonly logReason: "target_revoked" | "unauthorized" | SessionRenewalRefusal }
  | { readonly outcome: "unavailable" };

export function createWorkerSessionRenewalService(deps: {
  authenticator: WorkerSessionAuthenticatorLike;
  sessionSigningKey: string;
  now?: () => Date;
  /** Overridable for tests: the default binds the signing key to `mintRenewedSession`. */
  mint?: SessionRenewalMint;
}) {
  const now = deps.now ?? (() => new Date());
  const mint: SessionRenewalMint = deps.mint
    ?? ((identity, at) => mintRenewedSession(deps.sessionSigningKey, identity, at));

  return {
    async renew(request: {
      authorization: string;
      rawBody: Buffer;
      proof: DeviceProofHeaders;
      method: string;
      path: string;
      correlationId: string;
    }): Promise<SessionRenewalOutcome> {
      // The authority read. A WorkerSessionError here is a fact about the CALLER — coarse
      // `unauthorized` on the wire, split two ways in the log only (§5). Anything else is
      // unexpected and propagates to the route's internal_unavailable handler.
      let principal: VerifiedTargetPrincipal;
      try {
        principal = await deps.authenticator.authenticate(request);
      } catch (err) {
        if (err instanceof WorkerSessionError) return { outcome: "refused", logReason: err.code };
        throw err;
      }

      const decision = admitSessionRenewal({
        principalOrganizationId: principal.organizationId,
        principalScope: principal.scope,
        principalTargetScope: principal.targetScope,
        hasSharedPlatformAuthority: principal.sharedPlatformAuthority !== undefined,
        workerId: principal.workerId,
        targetId: principal.targetId,
        generation: principal.targetGeneration,
        deviceThumbprint: principal.deviceThumbprint,
        profileHash: principal.profileHash,
      });
      if (!decision.admit) return { outcome: "refused", logReason: decision.refusal };

      // The mint in its OWN try. ★ This catch is DEFENSIVE and UNREACHABLE in production:
      // WORKER_SESSION_RENEWAL_TTL_MS === SESSION_MAX_MS makes exp-iat exactly 900, so the ceiling
      // assertion (worker-session-auth.ts:80) never trips, and assertClaims cannot fail for an
      // identity the authenticator already validated. It exists so that a FUTURE defect — the
      // ceiling assertion tripping, a bad key — is a SERVER answer (internal_unavailable, 503), not
      // a fact about the caller: it must NOT collapse into the `unauthorized` bucket the
      // authenticator error uses, or a healthy worker would be told it is unauthorized for our bug
      // and stop permanently. Killed by an INJECTED-mint test seam (not a reachable condition), the
      // same discipline the two unreachable admission guards get.
      try {
        const minted = mint(decision.identity, now());
        return { outcome: "renewed", ...minted };
      } catch {
        return { outcome: "unavailable" };
      }
    },
  };
}
