import type { AgentTrustScore } from "@armyofagents/shared";
import { Info, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../lib/utils";
import {
  formatTrustScorePercent,
  getRecentTrustScore,
  getTrustScoreTone,
  getTrustScoreToneClasses,
  getTrustScoreTrend,
  hasTrustScoreData,
} from "../lib/trust-score";

function TrendIndicator({ trend }: { trend: "up" | "down" | "stable" }) {
  if (trend === "up") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-300" data-testid="trust-trend" data-trend="up">
        <TrendingUp className="h-3.5 w-3.5" />
        Improving
      </span>
    );
  }

  if (trend === "down") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-300" data-testid="trust-trend" data-trend="down">
        <TrendingDown className="h-3.5 w-3.5" />
        Declining
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="trust-trend" data-trend="stable">
      <Minus className="h-3.5 w-3.5" />
      Stable
    </span>
  );
}

export function AgentTrustScoreCard({ score }: { score?: AgentTrustScore | null }) {
  if (!hasTrustScoreData(score)) {
    return (
      <div className="border border-border rounded-lg p-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Trust Score</h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Trust score explanation">
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              Trust score measures how often this agent&apos;s work is approved without changes. Last 20 tasks are weighted 2x to reflect recent performance.
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">No data yet</p>
      </div>
    );
  }
  const trustScore = score as AgentTrustScore;

  const tone = getTrustScoreTone(trustScore.currentScore);
  const classes = getTrustScoreToneClasses(tone);
  const recentScore = getRecentTrustScore(trustScore);
  const trend = getTrustScoreTrend(trustScore);

  return (
    <div className="border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Trust Score</h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Trust score explanation">
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              Trust score measures how often this agent&apos;s work is approved without changes. Last 20 tasks are weighted 2x to reflect recent performance.
            </TooltipContent>
          </Tooltip>
        </div>
        <TrendIndicator trend={trend} />
      </div>

      <div className="flex items-end justify-between gap-3">
        <div>
          <div className={cn("text-4xl font-semibold tracking-tight", classes.text)}>
            {formatTrustScorePercent(trustScore.currentScore)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {trustScore.approvedWithoutChanges} of {trustScore.totalCompleted} tasks approved without changes
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-[width]", classes.progress)}
            style={{ width: `${Math.max(0, Math.min(trustScore.currentScore, 100))}%` }}
            data-testid="trust-score-progress"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Recent performance: Last 20 tasks: {trustScore.recentApproved} of {trustScore.recentCompleted} approved
          {recentScore !== null ? ` (${formatTrustScorePercent(recentScore)})` : ""}
        </p>
      </div>
    </div>
  );
}
