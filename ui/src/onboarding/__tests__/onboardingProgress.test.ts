import { describe, it, expect } from "vitest";
import {
  computeOnboardingPosition,
  computeOnboardingBase,
  countVisibleSpineSteps,
  journeyHasFirstRunMap,
} from "../onboardingProgress";
import type { StepContext, StepDefinition } from "../registry";
import type { OnboardingState } from "@armyofagents/shared";

// A tiny placeholder component — the count model never renders it.
const NoopComponent = (() => null) as unknown as StepDefinition["Component"];

function step(
  id: string,
  order: number,
  state: OnboardingState,
  journeys: StepDefinition["journeys"],
  shouldInclude: (ctx: StepContext) => boolean = () => true,
): StepDefinition {
  return {
    id,
    order,
    state,
    journeys,
    dependsOn: [],
    canSkip: false,
    shouldInclude,
    isComplete: () => false,
    Component: NoopComponent,
    title: id,
  };
}

describe("computeOnboardingPosition (continuous onboarding counter)", () => {
  it("spine mid-way: shows spineIndex+1 of base", () => {
    expect(computeOnboardingPosition({ phase: "spine", base: 7, spineIndex: 0 })).toEqual({
      current: 1,
      total: 7,
    });
    expect(computeOnboardingPosition({ phase: "spine", base: 7, spineIndex: 2 })).toEqual({
      current: 3,
      total: 7,
    });
    // Last spine step is base-1 of base — one below the Map, so the count is
    // continuous into it (no jump).
    expect(computeOnboardingPosition({ phase: "spine", base: 7, spineIndex: 5 })).toEqual({
      current: 6,
      total: 7,
    });
  });

  it("at the Map: base of base (the Map is the BASE-th step)", () => {
    expect(computeOnboardingPosition({ phase: "map", base: 7 })).toEqual({ current: 7, total: 7 });
  });

  it("in_flight surfaces EXTEND the total: base 7 + S 5 -> '8 of 12' .. '12 of 12'", () => {
    const base = 7;
    const S = 5;
    // surface 0 immediately follows the Map (base) -> base+1 of base+S
    expect(
      computeOnboardingPosition({
        phase: "inflight",
        base,
        persona: "in_flight",
        inflightIndex: 0,
        inflightApplicable: S,
      }),
    ).toEqual({ current: 8, total: 12 });
    expect(
      computeOnboardingPosition({
        phase: "inflight",
        base,
        persona: "in_flight",
        inflightIndex: 4,
        inflightApplicable: S,
      }),
    ).toEqual({ current: 12, total: 12 });
  });

  it("explorer past the Map: no counter (null)", () => {
    expect(
      computeOnboardingPosition({
        phase: "inflight",
        base: 7,
        persona: "explorer",
        inflightIndex: 0,
        inflightApplicable: 5,
      }),
    ).toBeNull();
  });

  it("in_flight with zero applicable surfaces: null (nothing meaningful to show)", () => {
    expect(
      computeOnboardingPosition({
        phase: "inflight",
        base: 7,
        persona: "in_flight",
        inflightIndex: 0,
        inflightApplicable: 0,
      }),
    ).toBeNull();
  });

  it("base<=1 suppression: null in every phase", () => {
    expect(computeOnboardingPosition({ phase: "spine", base: 1, spineIndex: 0 })).toBeNull();
    expect(computeOnboardingPosition({ phase: "map", base: 1 })).toBeNull();
    expect(computeOnboardingPosition({ phase: "map", base: 0 })).toBeNull();
  });
});

describe("journeyHasFirstRunMap", () => {
  it("only the founder journey has the post-spine Map phase", () => {
    expect(journeyHasFirstRunMap("founder")).toBe(true);
    expect(journeyHasFirstRunMap("invited")).toBe(false);
  });
});

describe("countVisibleSpineSteps / computeOnboardingBase", () => {
  const registry: StepDefinition[] = [
    step("a", 1, "PROFILE_SET", ["founder", "invited"]),
    step("b", 2, "ORGANIZATION_CREATED", ["founder"]),
    step("c", 3, "ENVIRONMENT_READY", ["founder"], (ctx) => ctx.completedStates.includes("PROFILE_SET")),
  ];

  const ctx = (journey: StepContext["journey"], completed: OnboardingState[]): StepContext => ({
    userId: "u",
    companyId: "c",
    journey,
    completedStates: completed,
  });

  it("counts only steps applicable to the journey (journey + shouldInclude filter)", () => {
    // founder with PROFILE_SET completed: all 3 apply
    expect(countVisibleSpineSteps(registry, ctx("founder", ["PROFILE_SET"]))).toBe(3);
    // founder without PROFILE_SET: step c's shouldInclude is false -> 2
    expect(countVisibleSpineSteps(registry, ctx("founder", []))).toBe(2);
    // invited: only step a is in the journey
    expect(countVisibleSpineSteps(registry, ctx("invited", []))).toBe(1);
  });

  it("BASE = visible spine steps + Map (founder) / +0 (invited)", () => {
    expect(computeOnboardingBase(registry, ctx("founder", ["PROFILE_SET"]))).toBe(4); // 3 + Map
    expect(computeOnboardingBase(registry, ctx("invited", []))).toBe(1); // 1 + 0 (no Map)
  });
});
