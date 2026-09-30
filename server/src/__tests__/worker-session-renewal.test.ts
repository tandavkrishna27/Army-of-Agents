import { describe, it, expect } from "vitest";
import {
  WORKER_SESSION_RENEWAL_TTL_MS,
  SESSION_RENEW_DESCRIPTOR,
  sessionRenewRequestSchema,
  mintRenewedSession,
  createWorkerSessionRenewalService,
} from "../services/worker-session-renewal.js";
import {
  SESSION_MAX_MS,
  createWorkerSessionToken,
  verifyWorkerSessionToken,
  WorkerSessionError,
  type VerifiedTargetPrincipal,
  type WorkerSessionClaims,
} from "../middleware/worker-session-auth.js";
import type { DeviceProofHeaders } from "../services/worker-device-proof.js";

// WRK-010 slice 1 — the renewal SERVICE (schema, descriptor, mint, orchestration).
//
// These are the plain-unit-tier tests §7 Step 3 names. The full authority matrix lives
// ONLY in worker-session-renewal.integration.test.ts (§10 R6) — do not add it here.

const SIGNING_KEY = "test-signing-key-at-least-32-bytes";
const THUMBPRINT = "a".repeat(64);
const PROFILE_HASH = "b".repeat(64);
const WORKER_ID = "73000000-0000-4000-8000-000000000001";
const TARGET_ID = "72000000-0000-4000-8000-000000000001";
const ORG_ID = "71000000-0000-4000-8000-000000000001";
const CID = "74000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-25T12:00:00.000Z");

function principal(overrides: Partial<VerifiedTargetPrincipal> = {}): VerifiedTargetPrincipal {
  return {
    workerId: WORKER_ID,
    targetId: TARGET_ID,
    targetGeneration: 3,
    deviceThumbprint: THUMBPRINT,
    profileHash: PROFILE_HASH,
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    organizationId: ORG_ID,
    scope: "organization",
    targetScope: "organization",
    ...overrides,
  };
}

const proof: DeviceProofHeaders = {
  version: "1", publicKey: "pub", signature: "sig", issuedAt: NOW.toISOString(), proofId: "proof-1",
};
const request = {
  authorization: "Bearer token",
  rawBody: Buffer.from("{}"),
  proof,
  method: "POST",
  path: "/api/worker-control/session/renew",
  correlationId: CID,
};

/** An authenticator stub that either returns a principal or throws. */
function fakeAuthenticator(result: VerifiedTargetPrincipal | Error) {
  return { authenticate: async () => { if (result instanceof Error) throw result; return result; } };
}

function baseClaims(iat: number, exp: number): WorkerSessionClaims {
  return {
    aud: "device_session", sub: WORKER_ID, organizationId: ORG_ID, targetId: TARGET_ID,
    generation: 3, scope: "organization", deviceThumbprint: THUMBPRINT, profileHash: PROFILE_HASH, iat, exp,
  };
}

describe("WRK-010 renewal constants and descriptor", () => {
  it("binds the renewal TTL to SESSION_MAX_MS === 15 minutes (no second constant to drift)", () => {
    expect(WORKER_SESSION_RENEWAL_TTL_MS).toBe(SESSION_MAX_MS);
    expect(SESSION_MAX_MS).toBe(15 * 60_000);
  });

  it("shapes the local descriptor with a device_session audience and a bounded body", () => {
    expect(SESSION_RENEW_DESCRIPTOR.audience).toBe("device_session");
    expect(SESSION_RENEW_DESCRIPTOR.maxRequestBytes).toBe(2 * 1024);
  });

  it("accepts a well-formed renewal request and rejects extra keys (strict)", () => {
    expect(sessionRenewRequestSchema.safeParse({
      protocolVersion: 1, audience: "device_session", correlationId: CID,
    }).success).toBe(true);
    expect(sessionRenewRequestSchema.safeParse({
      protocolVersion: 1, audience: "device_session", correlationId: CID, extra: 1,
    }).success).toBe(false);
    expect(sessionRenewRequestSchema.safeParse({
      protocolVersion: 1, audience: "worker_run", correlationId: CID,
    }).success).toBe(false);
  });
});

describe("mintRenewedSession — a NEW 15-minute session, never an extension", () => {
  it("stamps exp - iat === 900 and the token verifies", () => {
    const minted = mintRenewedSession(SIGNING_KEY, {
      aud: "device_session", sub: WORKER_ID, organizationId: ORG_ID, targetId: TARGET_ID,
      generation: 3, scope: "organization", deviceThumbprint: THUMBPRINT, profileHash: PROFILE_HASH,
    }, NOW);
    expect(minted.exp - minted.iat).toBe(900);
    expect(minted.deviceGeneration).toBe(3);
    const claims = verifyWorkerSessionToken(SIGNING_KEY, minted.session, NOW);
    expect(claims.sub).toBe(WORKER_ID);
    expect(claims.scope).toBe("organization");
    expect(claims.exp).toBe(minted.exp);
  });

  it("★ the 15-minute ceiling is enforced BY THE MINT HELPER, for anyone: exp=iat+901 throws, +900 does not", () => {
    const iat = Math.floor(NOW.getTime() / 1000);
    // +900 (exactly the ceiling) is issuable.
    expect(() => createWorkerSessionToken(SIGNING_KEY, baseClaims(iat, iat + 900))).not.toThrow();
    // +901 (one second over) is refused at the mint — a WorkerSessionError, not a longer token.
    expect(() => createWorkerSessionToken(SIGNING_KEY, baseClaims(iat, iat + 901)))
      .toThrow(WorkerSessionError);
  });
});

describe("createWorkerSessionRenewalService.renew — the mint/authenticator error split", () => {
  it("renews a valid org principal (exp - iat === 900)", async () => {
    const svc = createWorkerSessionRenewalService({
      authenticator: fakeAuthenticator(principal()), sessionSigningKey: SIGNING_KEY, now: () => NOW,
    });
    const outcome = await svc.renew(request);
    expect(outcome.outcome).toBe("renewed");
    if (outcome.outcome !== "renewed") return;
    expect(outcome.exp - outcome.iat).toBe(900);
    expect(verifyWorkerSessionToken(SIGNING_KEY, outcome.session, NOW).sub).toBe(WORKER_ID);
  });

  it("an AUTHENTICATOR WorkerSessionError('target_revoked') → refused, logReason target_revoked", async () => {
    const svc = createWorkerSessionRenewalService({
      authenticator: fakeAuthenticator(new WorkerSessionError("target_revoked")),
      sessionSigningKey: SIGNING_KEY, now: () => NOW,
    });
    const outcome = await svc.renew(request);
    expect(outcome).toEqual({ outcome: "refused", logReason: "target_revoked" });
  });

  it("an AUTHENTICATOR WorkerSessionError('unauthorized') → refused, logReason unauthorized", async () => {
    const svc = createWorkerSessionRenewalService({
      authenticator: fakeAuthenticator(new WorkerSessionError("unauthorized")),
      sessionSigningKey: SIGNING_KEY, now: () => NOW,
    });
    const outcome = await svc.renew(request);
    expect(outcome).toEqual({ outcome: "refused", logReason: "unauthorized" });
  });

  it("an admission refusal (platform physical) → refused, logReason platform_physical_unsupported", async () => {
    const svc = createWorkerSessionRenewalService({
      authenticator: fakeAuthenticator(principal({ organizationId: null, scope: "platform" })),
      sessionSigningKey: SIGNING_KEY, now: () => NOW,
    });
    const outcome = await svc.renew(request);
    expect(outcome).toEqual({ outcome: "refused", logReason: "platform_physical_unsupported" });
  });

  it("★ a MINT WorkerSessionError is UNAVAILABLE, not refused — the split M7 collapses", async () => {
    // Same error CLASS as the authenticator throws (WorkerSessionError), opposite handling.
    // A route/service that catches WorkerSessionError in ONE place would render this as 401
    // unauthorized and stop a healthy worker permanently. It must be internal_unavailable.
    const svc = createWorkerSessionRenewalService({
      authenticator: fakeAuthenticator(principal()),
      sessionSigningKey: SIGNING_KEY,
      now: () => NOW,
      mint: () => { throw new WorkerSessionError("unauthorized"); },
    });
    const outcome = await svc.renew(request);
    expect(outcome).toEqual({ outcome: "unavailable" });
  });
});
