import { describe, it, expect } from "vitest";
import { ONBOARDING_STATES, FOUNDER_PHASE1_STATES, normalizeLegacyOnboardingState } from "../onboarding.js";

describe("company-created onboarding state", () => {
  it("uses COMPANY_CREATED in the founder sequence", () => {
    expect(FOUNDER_PHASE1_STATES).toContain("COMPANY_CREATED");
  });
  it("keeps ORGANIZATION_CREATED valid for legacy rows", () => {
    expect(ONBOARDING_STATES).toContain("ORGANIZATION_CREATED");
    expect(ONBOARDING_STATES).toContain("COMPANY_CREATED");
  });
  it("normalizes the legacy alias", () => {
    expect(normalizeLegacyOnboardingState("ORGANIZATION_CREATED")).toBe("COMPANY_CREATED");
    expect(normalizeLegacyOnboardingState("PROFILE_SET")).toBe("PROFILE_SET");
  });
});
