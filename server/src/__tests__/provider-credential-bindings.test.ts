import { describe, expect, it } from "vitest";
import {
  ProviderCredentialBindingError,
  chooseGovernedSubscriptionBinding,
  mayUseLegacySubscriptionHome,
  resolveAgentSubscriptionEnvironment,
} from "../services/provider-credential-bindings.js";

describe("resolveAgentSubscriptionEnvironment multi_tenant chokepoint (BUG A residual fix)", () => {
  it("fails closed BEFORE any DB read when trustBoundary is multi_tenant", async () => {
    // The guard is the first statement, so a dummy db is never touched — proving no
    // personal-subscription home can be materialized on a shared multi-tenant host,
    // regardless of caller (new-model resolver deps OR the heartbeat legacy closure).
    await expect(
      resolveAgentSubscriptionEnvironment({} as never, {
        companyId: "co1",
        agentId: "ag1",
        provider: "anthropic",
        executionTargetId: "control-plane",
        trustBoundary: "multi_tenant",
      }),
    ).rejects.toMatchObject({ code: "subscription_disabled_multi_tenant" });
  });
});

const base = {
  credentialId: "credential-1",
  credentialCompanyId: "company-1",
  provider: "openai",
  ownerUserId: "user-1",
  executionTargetId: "target-1",
  kind: "personal_subscription",
  state: "verified",
  approvedAt: new Date(),
  bindingRevokedAt: null,
  ownerMembershipStatus: "active",
};

const expected = {
  companyId: "company-1",
  provider: "openai" as const,
  executionTargetId: "target-1",
};

function codeOf(fn: () => unknown) {
  try {
    fn();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderCredentialBindingError);
    return (error as ProviderCredentialBindingError).code;
  }
}

describe("governed provider credential binding", () => {
  it("selects exactly one approved, verified, target-matched binding", () => {
    expect(chooseGovernedSubscriptionBinding([base], expected).credentialId).toBe("credential-1");
  });

  it("fails closed for missing, unapproved, wrong-target, inactive-owner, and ambiguous bindings", () => {
    expect(codeOf(() => chooseGovernedSubscriptionBinding([], expected))).toBe("binding_missing");
    expect(
      codeOf(() => chooseGovernedSubscriptionBinding([{ ...base, approvedAt: null }], expected)),
    ).toBe("binding_not_approved");
    expect(
      codeOf(() =>
        chooseGovernedSubscriptionBinding(
          [{ ...base, executionTargetId: "another-target" }],
          expected,
        ),
      ),
    ).toBe("credential_target_mismatch");
    expect(
      codeOf(() =>
        chooseGovernedSubscriptionBinding(
          [{ ...base, ownerMembershipStatus: "suspended" }],
          expected,
        ),
      ),
    ).toBe("credential_owner_inactive");
    expect(codeOf(() => chooseGovernedSubscriptionBinding([base, { ...base }], expected))).toBe(
      "binding_ambiguous",
    );
  });

  it("allows legacy global-home fallback only for an absent binding when enforcement is off", () => {
    const missing = new ProviderCredentialBindingError("binding_missing", "missing");
    const revoked = new ProviderCredentialBindingError("binding_not_approved", "revoked");

    expect(mayUseLegacySubscriptionHome(missing, false)).toBe(true);
    expect(mayUseLegacySubscriptionHome(missing, true)).toBe(false);
    expect(mayUseLegacySubscriptionHome(revoked, false)).toBe(false);
    expect(mayUseLegacySubscriptionHome(new Error("database unavailable"), false)).toBe(false);
  });
});
