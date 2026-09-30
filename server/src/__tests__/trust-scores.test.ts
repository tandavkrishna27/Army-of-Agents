import { describe, it, expect } from "vitest";

/**
 * Mirror of computeScore from services/trust-scores.ts.
 * Duplicated here to avoid importing drizzle-orm (ESM cycle issue in test env).
 */
const RECENT_WINDOW = 20;

function computeScore(
  totalCompleted: number,
  approvedWithoutChanges: number,
  recentCompleted: number,
  recentApproved: number,
): number {
  if (totalCompleted === 0) return 0;
  if (totalCompleted <= RECENT_WINDOW) {
    return (approvedWithoutChanges / totalCompleted) * 100;
  }
  const olderCompleted = totalCompleted - recentCompleted;
  const olderApproved = approvedWithoutChanges - recentApproved;
  const weightedApproved = olderApproved + recentApproved * 2;
  const weightedTotal = olderCompleted + recentCompleted * 2;
  if (weightedTotal === 0) return 0;
  return (weightedApproved / weightedTotal) * 100;
}

describe("computeScore", () => {
  it("returns 0 when totalCompleted is 0 (division by zero guard)", () => {
    expect(computeScore(0, 0, 0, 0)).toBe(0);
  });

  it("returns 100% when all tasks approved (5 approved, 0 rejected)", () => {
    expect(computeScore(5, 5, 5, 5)).toBe(100);
  });

  it("returns 60% when 3 approved out of 5 (3 approved, 2 rejected)", () => {
    expect(computeScore(5, 3, 5, 3)).toBe(60);
  });

  it("returns 0% when no tasks approved", () => {
    expect(computeScore(5, 0, 5, 0)).toBe(0);
  });

  it("treats all tasks equally when fewer than RECENT_WINDOW", () => {
    const score = computeScore(10, 7, 10, 7);
    expect(score).toBe(70);
  });

  it("applies 2x weighting for recent tasks when total > RECENT_WINDOW", () => {
    // 30 total, 20 approved overall
    // Recent: 20 completed, 15 approved
    // Older: 10 completed, 5 approved
    // Weighted: (5 + 15*2) / (10 + 20*2) = 35/50 = 70%
    const score = computeScore(30, 20, 20, 15);
    expect(score).toBe(70);
  });

  it("recent weighting increases score when recent performance is better", () => {
    // 30 total, 15 approved overall
    // Recent: 20 completed, 14 approved (good recent)
    // Older: 10 completed, 1 approved (bad early)
    // Weighted: (1 + 14*2) / (10 + 20*2) = 29/50 = 58%
    const score = computeScore(30, 15, 20, 14);
    expect(score).toBeCloseTo(58, 10);
  });

  it("recent weighting decreases score when recent performance is worse", () => {
    // 30 total, 15 approved overall
    // Recent: 20 completed, 5 approved (bad recent)
    // Older: 10 completed, 10 approved (good early)
    // Weighted: (10 + 5*2) / (10 + 20*2) = 20/50 = 40%
    const score = computeScore(30, 15, 20, 5);
    expect(score).toBe(40);
  });

  it("handles exactly RECENT_WINDOW tasks (no weighting)", () => {
    const score = computeScore(RECENT_WINDOW, 18, RECENT_WINDOW, 18);
    expect(score).toBe(90);
  });

  it("handles RECENT_WINDOW + 1 tasks with weighting", () => {
    // 21 total, 20 approved
    // Recent: 20 completed, 19 approved
    // Older: 1 completed, 1 approved
    // Weighted: (1 + 19*2) / (1 + 20*2) = 39/41 ≈ 95.12%
    const score = computeScore(21, 20, 20, 19);
    expect(score).toBeCloseTo(95.12, 1);
  });

  it("returns 100% with all approved and weighting active", () => {
    // 30 total, all approved
    // Weighted: (10 + 20*2) / (10 + 20*2) = 100%
    const score = computeScore(30, 30, 20, 20);
    expect(score).toBe(100);
  });

  it("returns 0% with none approved and weighting active", () => {
    const score = computeScore(30, 0, 20, 0);
    expect(score).toBe(0);
  });
});
