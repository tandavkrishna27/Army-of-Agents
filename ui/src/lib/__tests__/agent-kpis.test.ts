import { describe, it, expect } from "vitest";
import { computeAgentKpis } from "../agent-kpis";

const NOW = new Date("2026-06-24T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe("computeAgentKpis", () => {
  it("windows to the last 7 days and computes success rate over completed runs", () => {
    const runs = [
      { status: "succeeded", createdAt: daysAgo(1), usageJson: { cost_usd: 1 }, resultJson: null },
      { status: "failed", createdAt: daysAgo(2), usageJson: { cost_usd: 0.5 }, resultJson: null },
      { status: "running", createdAt: daysAgo(1), usageJson: null, resultJson: null },
      { status: "succeeded", createdAt: daysAgo(30), usageJson: { cost_usd: 9 }, resultJson: null },
    ];
    const issues = [
      { status: "done", createdAt: daysAgo(1) },
      { status: "done", createdAt: daysAgo(30) },
      { status: "in_progress", createdAt: daysAgo(1) },
    ];
    const kpis = computeAgentKpis({ runs, assignedIssues: issues, now: NOW });
    expect(kpis.completedRuns).toBe(2);
    expect(kpis.successRate).toBe(50);
    expect(kpis.tasksCompleted).toBe(1);
    expect(kpis.cost).toBeCloseTo(1.5);
  });

  it("returns null success rate when no completed runs", () => {
    const kpis = computeAgentKpis({ runs: [], assignedIssues: [], now: NOW });
    expect(kpis.successRate).toBeNull();
    expect(kpis.cost).toBe(0);
    expect(kpis.tasksCompleted).toBe(0);
  });
});
