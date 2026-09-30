import { describe, it, expect } from "vitest";
import {
  buildPlanStepsFromItems,
  shouldFinalizeScope,
} from "../services/internal-agent/aoa-agents/scribe-living-scope.js";

describe("buildPlanStepsFromItems", () => {
  it("turns task-type items into ordered, linked plan steps", () => {
    const steps = buildPlanStepsFromItems([
      { id: "a", type: "task", title: "Write spec", createdAt: "1" },
      { id: "b", type: "insight", title: "Users churn", createdAt: "2" },
      { id: "c", type: "task", title: "Build API", createdAt: "3" },
    ]);
    expect(steps).toEqual([
      { title: "Write spec", linkedItemId: "a" },
      { title: "Build API", linkedItemId: "c" },
    ]);
  });
  it("returns an empty plan when there are no task items", () => {
    expect(buildPlanStepsFromItems([{ id: "x", type: "reference", title: "doc", createdAt: "1" }])).toEqual([]);
  });
});

describe("shouldFinalizeScope", () => {
  it("finalizes when advancing discuss→scope with at least one item", () => {
    expect(shouldFinalizeScope({ fromPhase: "discuss", toPhase: "scope", itemCount: 2 })).toBe(true);
  });
  it("does not finalize while still in discuss", () => {
    expect(shouldFinalizeScope({ fromPhase: "discuss", toPhase: "discuss", itemCount: 5 })).toBe(false);
  });
  it("does not finalize on an empty scope", () => {
    expect(shouldFinalizeScope({ fromPhase: "discuss", toPhase: "scope", itemCount: 0 })).toBe(false);
  });
});
