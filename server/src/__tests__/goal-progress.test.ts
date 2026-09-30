import { describe, it, expect } from "vitest";
import { computeGoalProgressPercent } from "../services/goal-progress.js";

describe("computeGoalProgressPercent", () => {
  it("is 0 with no tasks", () => {
    expect(computeGoalProgressPercent({ total: 0, done: 0, cancelled: 0 })).toBe(0);
  });
  it("excludes cancelled from the denominator (1 done + 1 cancelled = 100%, not 50%)", () => {
    expect(computeGoalProgressPercent({ total: 2, done: 1, cancelled: 1 })).toBe(100);
  });
  it("rounds to nearest integer", () => {
    expect(computeGoalProgressPercent({ total: 3, done: 1, cancelled: 0 })).toBe(33);
  });
  it("is 0 when every task is cancelled", () => {
    expect(computeGoalProgressPercent({ total: 2, done: 0, cancelled: 2 })).toBe(0);
  });
});
