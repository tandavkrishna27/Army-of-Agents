import { describe, it, expect } from "vitest";
import { onboardingProgress } from "@armyofagents/db";

describe("onboarding_progress schema (Stage B / B1)", () => {
  it("exposes the expected columns", () => {
    const table = onboardingProgress as unknown as Record<string, unknown>;
    for (const col of [
      "id",
      "userId",
      "companyId",
      "journey",
      "currentState",
      "completedStates",
      "version",
      "createdAt",
      "updatedAt",
    ]) {
      expect(table[col]).toBeDefined();
    }
  });

  it("companyId is nullable (user-layer rows) and version defaults present", () => {
    const companyId = (onboardingProgress as any).companyId;
    const version = (onboardingProgress as any).version;
    // notNull() sets .notNull = true; companyId omits it, version has a default.
    expect(companyId.notNull).toBe(false);
    expect(version.notNull).toBe(true);
    expect(version.hasDefault).toBe(true);
  });
});
