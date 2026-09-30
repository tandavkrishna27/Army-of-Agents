// server/src/__tests__/commander-provider-resolution.test.ts
import { describe, it, expect } from "vitest";
import { candidatePassesStaticGates } from "../services/provider-resolution.js";

describe("commander owner_only enforcement (stands in for #310 subscription_commander_only)", () => {
  it("rejects a personal subscription for a commander user who is not the owner", () => {
    const r = candidatePassesStaticGates({
      authMethod: "personal_subscription",
      scopeType: "agent_override",
      state: "verified",
      termsAttestedAt: new Date(),
      sharingPolicy: "owner_only",
      actorKind: "commander",
      connectionCompanyId: "co1",
      requestCompanyId: "co1",
      connectionOwnerUserId: "owner",
      requestOwnerUserId: "intruder",
    });
    expect(r.ok).toBe(false);
  });

  it("passes when the acting commander user IS the owner", () => {
    const r = candidatePassesStaticGates({
      authMethod: "personal_subscription",
      scopeType: "agent_override",
      state: "verified",
      termsAttestedAt: new Date(),
      sharingPolicy: "owner_only",
      actorKind: "commander",
      connectionCompanyId: "co1",
      requestCompanyId: "co1",
      connectionOwnerUserId: "owner",
      requestOwnerUserId: "owner",
    });
    expect(r.ok).toBe(true);
  });
});
