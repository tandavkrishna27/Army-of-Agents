import type { AgentTrustScore } from "@armyofagents/shared";

export type TrustScoreTone = "high" | "moderate" | "low";
export type TrustScoreTrend = "up" | "down" | "stable";

const STABLE_DELTA = 2;

export function hasTrustScoreData(score: AgentTrustScore | null | undefined) {
  return Boolean(score && score.totalCompleted > 0);
}

export function formatTrustScorePercent(value: number) {
  return `${Math.round(value)}%`;
}

export function getTrustScoreTone(value: number): TrustScoreTone {
  if (value > 80) return "high";
  if (value >= 50) return "moderate";
  return "low";
}

export function getTrustScoreToneClasses(tone: TrustScoreTone) {
  switch (tone) {
    case "high":
      return {
        badge: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
        text: "text-green-700 dark:text-green-300",
        progress: "bg-green-500",
      };
    case "moderate":
      return {
        badge: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
        text: "text-yellow-700 dark:text-yellow-300",
        progress: "bg-yellow-500",
      };
    case "low":
      return {
        badge: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
        text: "text-red-700 dark:text-red-300",
        progress: "bg-red-500",
      };
  }
}

export function getRecentTrustScore(score: Pick<AgentTrustScore, "recentCompleted" | "recentApproved">) {
  if (score.recentCompleted <= 0) return null;
  return Math.round((score.recentApproved / score.recentCompleted) * 100);
}

export function getTrustScoreTrend(score: Pick<AgentTrustScore, "currentScore" | "recentCompleted" | "recentApproved">): TrustScoreTrend {
  const recentScore = getRecentTrustScore(score);
  if (recentScore === null) return "stable";
  const delta = recentScore - score.currentScore;
  if (delta >= STABLE_DELTA) return "up";
  if (delta <= -STABLE_DELTA) return "down";
  return "stable";
}

export function getTrustScoreTooltip(score: Pick<AgentTrustScore, "currentScore" | "totalCompleted" | "approvedWithoutChanges">) {
  return `Trust Score: ${formatTrustScorePercent(score.currentScore)} — based on ${score.totalCompleted} tasks (${score.approvedWithoutChanges} approved without changes)`;
}
