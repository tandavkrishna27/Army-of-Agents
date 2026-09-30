// server/src/__tests__/provider-resolution-gate.test.ts
import { describe, it, expect } from "vitest";
import { candidatePassesStaticGates, type GateInput } from "../services/provider-resolution.js";

const base: GateInput = {
  authMethod: "api_key",
  scopeType: "company_default",
  state: "verified",
  termsAttestedAt: new Date(),
  sharingPolicy: "company_agents",
  actorKind: "crew",
  connectionCompanyId: "co1",
  requestCompanyId: "co1",
  connectionOwnerUserId: null,
  requestOwnerUserId: null,
};

describe("candidatePassesStaticGates", () => {
  it("passes a verified, attested, company-shared api_key for crew", () => {
    expect(candidatePassesStaticGates(base).ok).toBe(true);
  });
  it("rejects non-verified state", () => {
    expect(candidatePassesStaticGates({ ...base, state: "suspended" }).ok).toBe(false);
  });
  it("rejects un-attested terms", () => {
    expect(candidatePassesStaticGates({ ...base, termsAttestedAt: null }).ok).toBe(false);
  });
  it("rejects personal_subscription as an org_default (owner-only, locked)", () => {
    expect(
      candidatePassesStaticGates({
        ...base,
        authMethod: "personal_subscription",
        scopeType: "org_default",
      }).ok,
    ).toBe(false);
  });
  it("owner_only rejects an actor who is not the owner", () => {
    expect(
      candidatePassesStaticGates({
        ...base,
        sharingPolicy: "owner_only",
        connectionOwnerUserId: "owner1",
        requestOwnerUserId: "someoneElse",
      }).ok,
    ).toBe(false);
  });
  it("owner_only passes when the acting user IS the owner", () => {
    expect(
      candidatePassesStaticGates({
        ...base,
        sharingPolicy: "owner_only",
        connectionOwnerUserId: "owner1",
        requestOwnerUserId: "owner1",
      }).ok,
    ).toBe(true);
  });
});
