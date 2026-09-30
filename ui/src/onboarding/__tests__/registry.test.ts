import { describe, it, expect } from "vitest";
import {
  resolveNextStep,
  validateRegistry,
  type StepDefinition,
  type StepContext,
} from "../registry";
import { ONBOARDING_STEPS } from "../steps";

const dummyComponent = null as unknown as StepDefinition["Component"];

function step(over: Partial<StepDefinition>): StepDefinition {
  return {
    id: "s",
    order: 0,
    state: "PROFILE_SET",
    journeys: ["founder"],
    dependsOn: [],
    canSkip: false,
    shouldInclude: () => true,
    isComplete: () => false,
    Component: dummyComponent,
    title: "s",
    ...over,
  };
}

const ctx = (over: Partial<StepContext> = {}): StepContext => ({
  userId: "u1",
  companyId: null,
  journey: "founder",
  completedStates: ["AUTHENTICATED"],
  ...over,
});

describe("resolveNextStep (Stage B / B5)", () => {
  it("returns the first applicable step by order", () => {
    const reg = [
      step({ id: "b", order: 2, state: "ORGANIZATION_CREATED", dependsOn: ["PROFILE_SET"] }),
      step({ id: "a", order: 1, state: "PROFILE_SET", dependsOn: ["AUTHENTICATED"] }),
    ];
    expect(resolveNextStep(reg, ctx())?.id).toBe("a");
  });

  it("skips steps whose dependencies are unmet", () => {
    const reg = [step({ id: "org", order: 1, state: "ORGANIZATION_CREATED", dependsOn: ["PROFILE_SET"] })];
    expect(resolveNextStep(reg, ctx())).toBeNull();
  });

  it("filters by journey", () => {
    const reg = [step({ id: "inv", journeys: ["invited"], state: "JOIN_REQUESTED", dependsOn: ["PROFILE_SET"] })];
    expect(resolveNextStep(reg, ctx({ journey: "founder" }))).toBeNull();
  });

  it("skips completed and not-applicable steps", () => {
    const reg = [
      step({ id: "done", order: 1, isComplete: () => true }),
      step({ id: "hidden", order: 2, shouldInclude: () => false }),
      step({ id: "next", order: 3, state: "PROFILE_SET", dependsOn: ["AUTHENTICATED"] }),
    ];
    expect(resolveNextStep(reg, ctx())?.id).toBe("next");
  });

  it("returns null when nothing remains", () => {
    expect(resolveNextStep([], ctx())).toBeNull();
  });

  it("does not deadlock cloud founders before their human profile", () => {
    const cloudCtx = ctx({ deploymentMode: "cloud_auth" });
    expect(resolveNextStep(ONBOARDING_STEPS, cloudCtx)?.id).toBe("human-profile");

    expect(
      resolveNextStep(
        ONBOARDING_STEPS,
        ctx({ deploymentMode: "cloud_auth", completedStates: ["AUTHENTICATED", "PROFILE_SET"] }),
      )?.id,
    ).toBe("organization");
  });
});

describe("validateRegistry (Stage B / B5 + RC-P2)", () => {
  it("passes a well-formed registry", () => {
    const reg = [
      step({ id: "a", order: 1, state: "PROFILE_SET", dependsOn: ["AUTHENTICATED"] }),
      step({ id: "b", order: 2, state: "COMPANY_CREATED", dependsOn: ["PROFILE_SET"] }),
    ];
    expect(validateRegistry(reg)).toEqual([]);
  });

  it("flags duplicate ids", () => {
    const reg = [step({ id: "x", order: 1 }), step({ id: "x", order: 2 })];
    expect(validateRegistry(reg).some((e) => e.code === "dup_id")).toBe(true);
  });

  it("flags duplicate order within a journey", () => {
    const reg = [step({ id: "a", order: 1 }), step({ id: "b", order: 1 })];
    expect(validateRegistry(reg).some((e) => e.code === "dup_order")).toBe(true);
  });

  it("flags a dependency not in the journey", () => {
    const reg = [step({ id: "a", order: 1, state: "PROFILE_SET", dependsOn: ["JOIN_REQUESTED"] })];
    expect(validateRegistry(reg).some((e) => e.code === "dep_not_in_journey")).toBe(true);
  });

  it("flags a dependency that does not precede the step's state", () => {
    const reg = [step({ id: "a", order: 1, state: "PROFILE_SET", dependsOn: ["COMPANY_CREATED"] })];
    expect(validateRegistry(reg).some((e) => e.code === "dep_not_before_state")).toBe(true);
  });
});
