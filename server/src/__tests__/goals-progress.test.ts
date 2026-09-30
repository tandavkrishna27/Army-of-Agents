import { describe, it, expect } from "vitest";
import {
  computeGoalProgress,
  suggestGoalStatus,
  isScopeWithinParent,
  findCycleParent,
} from "../services/goals.js";

describe("computeGoalProgress", () => {
  it("returns zeros for no issues", () => {
    expect(computeGoalProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
  });

  it("excludes cancelled from the total", () => {
    expect(
      computeGoalProgress(["done", "done", "in_progress", "cancelled"]),
    ).toEqual({ done: 2, total: 3, percent: 67 });
  });

  it("is 100% when all non-cancelled work is done", () => {
    expect(computeGoalProgress(["done", "done", "cancelled"])).toEqual({
      done: 2,
      total: 2,
      percent: 100,
    });
  });

  it("is 0% when nothing is done", () => {
    expect(computeGoalProgress(["todo", "in_progress"])).toEqual({
      done: 0,
      total: 2,
      percent: 0,
    });
  });
});

describe("suggestGoalStatus", () => {
  it("suggests achieved when all work is done (from active)", () => {
    expect(suggestGoalStatus("active", { total: 4, done: 4, atRisk: 0 })).toBe(
      "achieved",
    );
  });

  it("suggests achieved from at_risk too", () => {
    expect(suggestGoalStatus("at_risk", { total: 2, done: 2, atRisk: 0 })).toBe(
      "achieved",
    );
  });

  it("does NOT suggest achieved from planned (illegal transition)", () => {
    expect(
      suggestGoalStatus("planned", { total: 2, done: 2, atRisk: 0 }),
    ).toBeNull();
  });

  it("suggests at_risk when risk is present (from active)", () => {
    expect(suggestGoalStatus("active", { total: 4, done: 1, atRisk: 2 })).toBe(
      "at_risk",
    );
  });

  it("does not re-suggest at_risk when already at_risk", () => {
    expect(
      suggestGoalStatus("at_risk", { total: 4, done: 1, atRisk: 2 }),
    ).toBeNull();
  });

  it("returns null when there is nothing to suggest", () => {
    expect(
      suggestGoalStatus("active", { total: 4, done: 1, atRisk: 0 }),
    ).toBeNull();
  });

  it("returns null for an empty goal (total 0)", () => {
    expect(
      suggestGoalStatus("active", { total: 0, done: 0, atRisk: 0 }),
    ).toBeNull();
  });
});

describe("isScopeWithinParent (child ⊆ parent)", () => {
  it("company-wide parent allows any child", () => {
    expect(isScopeWithinParent(["p1", "p2"], [])).toBe(true);
    expect(isScopeWithinParent([], [])).toBe(true);
  });

  it("rejects a company-wide child under a scoped parent", () => {
    expect(isScopeWithinParent([], ["p1"])).toBe(false);
  });

  it("accepts a child whose projects are a subset of the parent's", () => {
    expect(isScopeWithinParent(["p1"], ["p1", "p2"])).toBe(true);
    expect(isScopeWithinParent(["p1", "p2"], ["p1", "p2"])).toBe(true);
  });

  it("rejects a child with a project outside the parent's scope", () => {
    expect(isScopeWithinParent(["p1", "p3"], ["p1", "p2"])).toBe(false);
  });
});

describe("findCycleParent", () => {
  it("flags a goal set as its own parent", () => {
    expect(findCycleParent("g1", ["g1"], new Set())).toBe("g1");
  });

  it("flags a descendant set as a parent (would close a loop)", () => {
    expect(findCycleParent("g1", ["g2"], new Set(["g2", "g3"]))).toBe("g2");
  });

  it("returns null when all parents are safe", () => {
    expect(findCycleParent("g1", ["gX", "gY"], new Set(["g2"]))).toBeNull();
  });
});
