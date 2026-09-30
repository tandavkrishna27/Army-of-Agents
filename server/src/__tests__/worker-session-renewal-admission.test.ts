import { describe, it, expect } from "vitest";
import {
  admitSessionRenewal,
  sessionRenewalRefusalWireCode,
  type SessionRenewalInput,
  type SessionRenewalRefusal,
} from "../services/worker-session-renewal-admission.js";

// WRK-010 slice 1 — the pure session-renewal admission decision.
//
// ★ THE SUITE OPENS WITH A POSITIVE CONTROL, and the reason is E1-F008: five
// placement guards were deletable with their own named tests still PASSING, because
// every fixture refused earlier for an unrelated reason and each test asserted a bare
// `toBe(false)` it got from the wrong refusal. A refusal suite with no positive control
// cannot tell "correctly refused" from "never got there". So two rules hold here, by
// construction: (1) the shared `input()` fixture is proven to ADMIT before any refusal
// case is built on it; (2) every refusal case asserts the SPECIFIC reason, never a bare
// `admit: false`.

const THUMBPRINT = "a".repeat(64);
const PROFILE_HASH = "b".repeat(64);
const WORKER_ID = "73000000-0000-4000-8000-000000000001";
const TARGET_ID = "72000000-0000-4000-8000-000000000001";
const ORG_ID = "71000000-0000-4000-8000-000000000001";

/**
 * A principal the shipped authenticator would actually produce for an
 * organization-scoped worker: a non-null org, matching worker/target scope, no
 * shared-platform authority. This ADMITS; the refusal cases override single fields.
 */
function input(overrides: Partial<SessionRenewalInput> = {}): SessionRenewalInput {
  return {
    principalOrganizationId: ORG_ID,
    principalScope: "organization",
    principalTargetScope: "organization",
    hasSharedPlatformAuthority: false,
    workerId: WORKER_ID,
    targetId: TARGET_ID,
    generation: 3,
    deviceThumbprint: THUMBPRINT,
    profileHash: PROFILE_HASH,
    ...overrides,
  };
}

describe("admitSessionRenewal — positive controls (the fixture ADMITS before any refusal is built on it)", () => {
  it("admits an organization-scope principal and stamps scope: organization", () => {
    const decision = admitSessionRenewal(input({ principalScope: "organization" }));
    expect(decision.admit).toBe(true);
    if (!decision.admit) return;
    expect(decision.identity).toEqual({
      aud: "device_session",
      sub: WORKER_ID,
      organizationId: ORG_ID,
      targetId: TARGET_ID,
      generation: 3,
      scope: "organization",
      deviceThumbprint: THUMBPRINT,
      profileHash: PROFILE_HASH,
    });
  });

  it("admits an owner-scope principal and stamps scope: owner", () => {
    const decision = admitSessionRenewal(input({ principalScope: "owner", principalTargetScope: "owner" }));
    expect(decision.admit).toBe(true);
    if (!decision.admit) return;
    expect(decision.identity.scope).toBe("owner");
  });

  it("admits a SHARED-PLATFORM TENANT worker (org-scoped worker, platform target) with authority resolved", () => {
    const decision = admitSessionRenewal(input({
      principalScope: "organization",
      principalTargetScope: "platform",
      hasSharedPlatformAuthority: true,
    }));
    expect(decision.admit).toBe(true);
    if (!decision.admit) return;
    expect(decision.identity.scope).toBe("organization");
  });
});

describe("admitSessionRenewal — R1 (platform-physical) and R2 (shared-platform authority)", () => {
  it("R1 arm 1 (REACHABLE): a null-org principal is refused platform_physical_unsupported", () => {
    // A platform PHYSICAL session authenticates through the operator DB
    // (worker-session-auth.ts:180-182) with organizationId === null. The transport verifier
    // used to refuse it for us; the authenticator does not, so R1 must.
    // ★ ISOLATES ARM 1: scope is left at the fixture's "organization", NOT "platform" — so
    // ONLY the `=== null` arm can fire. If this case carried scope "platform", arm 2 would
    // mask a deleted arm 1 and Step 6's M1 mutant would survive unnoticed (the mirror image
    // of the M2 trap). This shape is unreachable in production (assertClaims pins the two
    // together) but the pure function is directly constructible.
    const decision = admitSessionRenewal(input({ principalOrganizationId: null }));
    expect(decision.admit).toBe(false);
    if (decision.admit) return;
    expect(decision.refusal).toBe("platform_physical_unsupported");
  });

  it("R1 arm 2 (UNREACHABLE — assertClaims pins scope↔org): scope 'platform' with a NON-NULL org is still refused", () => {
    // ★ This shape cannot occur in production: assertClaims pins
    // (scope === 'platform') === (organizationId === null) at worker-session-auth.ts:69.
    // It is a real test of code that is really there, NOT evidence the refusal ever fires
    // in production. The NON-NULL org is load-bearing: with a null org, arm 1 would fire
    // and this case would pass for the wrong reason (Step 6 M2 would survive unnoticed).
    const decision = admitSessionRenewal(input({
      principalOrganizationId: ORG_ID,
      principalScope: "platform",
    }));
    expect(decision.admit).toBe(false);
    if (decision.admit) return;
    expect(decision.refusal).toBe("platform_physical_unsupported");
  });

  it("R2 (UNREACHABLE — authenticator never returns platform target w/o authority): platform target, no shared authority is refused", () => {
    // ★ Also unreachable (§4.2): a principal surviving R1 with targetScope 'platform'
    // ALWAYS carries a resolved sharedPlatformAuthority (worker-session-auth.ts:186-205).
    // Written and mutation-killed as defence-in-depth for a future refactor that drops
    // the operator read — NOT counted as coverage of a live condition.
    const decision = admitSessionRenewal(input({
      principalScope: "organization",
      principalTargetScope: "platform",
      hasSharedPlatformAuthority: false,
    }));
    expect(decision.admit).toBe(false);
    if (decision.admit) return;
    expect(decision.refusal).toBe("platform_authority_unresolved");
  });

  it("ANTI-VACUITY: hasSharedPlatformAuthority is IGNORED for a NON-platform target (admits)", () => {
    // A guard that fired for every target would pass the R2 case above AND break every
    // organization-scoped worker in production (M4). This pins that R2 is conjoined on
    // targetScope === 'platform'.
    const decision = admitSessionRenewal(input({
      principalScope: "owner",
      principalTargetScope: "owner",
      hasSharedPlatformAuthority: false,
    }));
    expect(decision.admit).toBe(true);
  });
});

describe("sessionRenewalRefusalWireCode — every refusal is coarse `unauthorized` on the wire", () => {
  it("maps both refusals to unauthorized (exhaustiveness)", () => {
    const refusals: SessionRenewalRefusal[] = [
      "platform_physical_unsupported",
      "platform_authority_unresolved",
    ];
    for (const refusal of refusals) {
      expect(sessionRenewalRefusalWireCode(refusal)).toBe("unauthorized");
    }
  });
});
