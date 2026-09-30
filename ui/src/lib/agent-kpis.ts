import type { HeartbeatRun } from "@armyofagents/shared";
import { runMetrics } from "./run-metrics";

export interface AgentKpiInput {
  runs: Pick<HeartbeatRun, "status" | "createdAt" | "usageJson" | "resultJson">[];
  assignedIssues: { status: string; createdAt: Date | string }[];
  now?: Date;
  windowDays?: number;
}

export interface AgentKpis {
  tasksCompleted: number;
  successRate: number | null;
  completedRuns: number;
  cost: number;
}

/**
 * Pure computation of the agent's at-a-glance KPIs over a trailing window.
 * `now` is injectable for deterministic tests. Mirrors the previous inline
 * math in AgentOverview (AgentDetail.tsx) exactly.
 */
export function computeAgentKpis({
  runs,
  assignedIssues,
  now = new Date(),
  windowDays = 7,
}: AgentKpiInput): AgentKpis {
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const runsInWindow = runs.filter((r) => new Date(r.createdAt) >= since);
  const completed = runsInWindow.filter(
    (r) => r.status === "succeeded" || r.status === "failed",
  );
  const succeeded = runsInWindow.filter((r) => r.status === "succeeded").length;
  const successRate =
    completed.length > 0 ? Math.round((succeeded / completed.length) * 100) : null;
  const tasksCompleted = assignedIssues.filter(
    (i) => i.status === "done" && new Date(i.createdAt) >= since,
  ).length;
  const cost = runsInWindow.reduce((sum, r) => sum + runMetrics(r).cost, 0);
  return { tasksCompleted, successRate, completedRuns: completed.length, cost };
}
