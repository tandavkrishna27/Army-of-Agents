import { describe, it, expect } from "vitest";
import { normalizeProgressRow } from "../services/onboarding.js";

describe("normalizeProgressRow", () => {
  it("maps legacy ORGANIZATION_CREATED to COMPANY_CREATED on read", () => {
    const row = normalizeProgressRow({
      currentState: "ORGANIZATION_CREATED",
      completedStates: ["AUTHENTICATED", "PROFILE_SET", "ORGANIZATION_CREATED"],
    } as any);
    expect(row.currentState).toBe("COMPANY_CREATED");
    expect(row.completedStates).toContain("COMPANY_CREATED");
    expect(row.completedStates).not.toContain("ORGANIZATION_CREATED");
  });

  it("leaves current-name rows unchanged", () => {
    const row = normalizeProgressRow({
      currentState: "COMPANY_CREATED",
      completedStates: ["AUTHENTICATED", "PROFILE_SET", "COMPANY_CREATED"],
    } as any);
    expect(row.currentState).toBe("COMPANY_CREATED");
    expect(row.completedStates).toEqual(["AUTHENTICATED", "PROFILE_SET", "COMPANY_CREATED"]);
  });
});
