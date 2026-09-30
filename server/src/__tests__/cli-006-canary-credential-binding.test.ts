// CLI-006 (Task 1) — the canary credential binding asserts nothing about credentials.
//
// These tests exist to stop a future edit from "enriching" the CREDENTIAL fields — they are
// the REPLAY + ROUTING guard for CLI-007 (E7-F001). The canary DOES now receive a Company
// provider_key credential, but it is delivered OUT OF BAND (the preflight-established
// `mintCredentialAuthority`, see canary-mint-authority.ts), never through this binding.
// The three credential-shaped fields (`credentialId`, `credentialKind`, `pinnedTargetId`)
// must stay null because the binding is the sole credential input to the placement replay
// digest AND to target routing: a non-null value there would change the digest value
// (breaking replay against already-placed attempts) and/or re-open owner routing.
//
// E11-F004 (canary org-routing) set the FOURTH field, `executionTargetSlug`, to a stable
// well-known constant (`CANARY_EXECUTION_TARGET_SLUG`). The slug is a ROUTING key, not a
// credential: with the three credential fields null, target routing takes neither the pin
// branch nor the personal_subscription branch — it takes the slug arm, which resolves ONLY
// a `dedicated_worker` (normalizing as `organization_dedicated`) or null. A `dedicated_worker`
// can ONLY normalize as `organization_dedicated` (TARGET_KIND_BY_CLASS maps `owner_desktop`
// to {desktop, local_host} only), so there is still NO reachable path to an owner_desktop
// target — the DE-29 owner-misrouting class stays structurally excluded.
//
// That matters because the check that would otherwise catch owner misrouting is
// tautological: `credentialOwnerId` is read off the ROUTED target's profile
// (job-placement.ts:279-281) and `requiredOwnerPrincipalId` off the SAME profile
// (:289), so `candidateFits` compares a value to itself (:557-563).

import { describe, expect, it } from "vitest";
import {
  CANARY_CREDENTIAL_BINDING,
  CANARY_EXECUTION_TARGET_SLUG,
  resolveCanaryCredentialBinding,
} from "../services/canary-credential-binding.js";

describe("CLI-006 — canary credential binding", () => {
  // Three null credential fields + one routing-only well-known slug. A non-null value in
  // any of the three credential fields re-opens owner routing or breaks placement replay.
  it("names no credential; routes by a well-known slug only", () => {
    expect(resolveCanaryCredentialBinding()).toEqual({
      credentialId: null,
      credentialKind: null,
      executionTargetSlug: CANARY_EXECUTION_TARGET_SLUG,
      pinnedTargetId: null,
    });
  });

  // `credentialKind: "personal_subscription"` would take the owner-routing branch of
  // `chooseExecutionTargetRow`; a non-null `pinnedTargetId` would take the pin branch.
  // Both re-open the DE-29 owner-misrouting class the null credential fields structurally
  // exclude. `credentialId` is the third credential-shaped input the digest hashes.
  it.each(["credentialId", "credentialKind", "pinnedTargetId"] as const)(
    "keeps credential field `%s` null — a value there re-opens owner routing or the pin branch",
    (field) => {
      expect(resolveCanaryCredentialBinding()[field]).toBeNull();
    },
  );

  // The slug ROUTES the canary to a tenant-creatable org `dedicated_worker` (E11-F004).
  // It must be present (a null slug falls back to the operator-uncreatable pooled_gvisor
  // pool — the original blocker) and stable (see the replay test below).
  it("carries the well-known execution-target slug (E11-F004 org routing)", () => {
    expect(resolveCanaryCredentialBinding().executionTargetSlug).toBe(CANARY_EXECUTION_TARGET_SLUG);
    expect(typeof CANARY_EXECUTION_TARGET_SLUG).toBe("string");
    expect(CANARY_EXECUTION_TARGET_SLUG.length).toBeGreaterThan(0);
  });

  // The binding is hashed into placementInputDigest/placementPolicyDigest
  // (job-placement.ts:315 → :333-335). A digest that changes between the first
  // placement and a retry throws `placement_already_decided`
  // (job-placement-transaction.ts:219-221) → transfer_error → that run falls back
  // to legacy permanently. So the binding must be byte-stable across calls — which is
  // why the slug is a compile-time constant, never a rotating value.
  it("is byte-stable across calls (placement replay depends on a stable digest)", () => {
    const a = JSON.stringify(resolveCanaryCredentialBinding());
    const b = JSON.stringify(resolveCanaryCredentialBinding());
    expect(a).toBe(b);
  });

  it("ignores its inputs entirely — it takes no db handle and performs no read", () => {
    const withArgs = (resolveCanaryCredentialBinding as unknown as (i: unknown) => unknown)({
      organizationId: "org-a",
      companyId: "co-a",
      jobId: "job-a",
      sourceKind: "task_run",
    });
    expect(withArgs).toEqual(resolveCanaryCredentialBinding());
    expect(resolveCanaryCredentialBinding.length).toBe(0);
  });

  // The key SET is part of the digest — canonical JSON serializes Object.keys —
  // so an omitted key is a DIFFERENT digest, not an equivalent one.
  it("always carries all four keys, so the canonical key set is stable", () => {
    expect(Object.keys(resolveCanaryCredentialBinding()).sort()).toEqual([
      "credentialId",
      "credentialKind",
      "executionTargetSlug",
      "pinnedTargetId",
    ]);
  });

  it("hands out a copy, so a caller cannot mutate the shared constant", () => {
    const first = resolveCanaryCredentialBinding() as Record<string, unknown>;
    first.credentialKind = "personal_subscription";
    first.executionTargetSlug = "hijacked";
    expect(resolveCanaryCredentialBinding().credentialKind).toBeNull();
    expect(resolveCanaryCredentialBinding().executionTargetSlug).toBe(CANARY_EXECUTION_TARGET_SLUG);
    expect(CANARY_CREDENTIAL_BINDING.credentialKind).toBeNull();
    expect(CANARY_CREDENTIAL_BINDING.executionTargetSlug).toBe(CANARY_EXECUTION_TARGET_SLUG);
  });
});
