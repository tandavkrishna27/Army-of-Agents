import { describe, it, expect } from "vitest";
import {
  ONBOARDING_STATES,
  ONBOARDING_JOURNEYS,
  FOUNDER_PHASE1_STATES,
  INVITED_PHASE1_STATES,
  orderedStatesFor,
} from "../onboarding.js";

describe("onboarding states (Stage B / B2)", () => {
  it("includes JOIN_REQUESTED and the terminal state", () => {
    expect(ONBOARDING_STATES).toContain("JOIN_REQUESTED");
    expect(ONBOARDING_STATES).toContain("SETUP_COMPLETE");
  });

  it("journeys are founder + invited", () => {
    expect([...ONBOARDING_JOURNEYS]).toEqual(["founder", "invited"]);
  });

  it("founder sequence excludes JOIN_REQUESTED; invited is the short approval path", () => {
    expect(FOUNDER_PHASE1_STATES).not.toContain("JOIN_REQUESTED");
    expect(FOUNDER_PHASE1_STATES[0]).toBe("AUTHENTICATED");
    expect(FOUNDER_PHASE1_STATES.at(-1)).toBe("SETUP_COMPLETE");
    expect(INVITED_PHASE1_STATES).toEqual([
      "AUTHENTICATED",
      "PROFILE_SET",
      "JOIN_REQUESTED",
      "SETUP_COMPLETE",
    ]);
  });

  it("WS0c: founder sequence no longer gates on DEPARTMENT_CREATED/AGENT_ASSIGNED, but the values stay valid for stored rows", () => {
    expect(FOUNDER_PHASE1_STATES).not.toContain("DEPARTMENT_CREATED");
    expect(FOUNDER_PHASE1_STATES).not.toContain("AGENT_ASSIGNED");
    expect(FOUNDER_PHASE1_STATES).toEqual([
      "AUTHENTICATED",
      "PROFILE_SET",
      "COMPANY_CREATED",
      "ENVIRONMENT_READY",
      "COMMANDER_SELECTED",
      "COMMANDER_VERIFIED",
      "SETUP_COMPLETE",
    ]);
    expect(ONBOARDING_STATES).toContain("DEPARTMENT_CREATED");
    expect(ONBOARDING_STATES).toContain("AGENT_ASSIGNED");
  });

  it("orderedStatesFor picks the right sequence per journey", () => {
    expect(orderedStatesFor("founder")).toBe(FOUNDER_PHASE1_STATES);
    expect(orderedStatesFor("invited")).toBe(INVITED_PHASE1_STATES);
  });
});
