import type { AgentTrustScore } from "@armyofagents/shared";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../lib/utils";
import {
  formatTrustScorePercent,
  getTrustScoreTone,
  getTrustScoreToneClasses,
  getTrustScoreTooltip,
  hasTrustScoreData,
} from "../lib/trust-score";

export function TrustScoreBadge({ score }: { score?: AgentTrustScore | null }) {
  if (!hasTrustScoreData(score)) return null;
  const trustScore = score as AgentTrustScore;

  const tone = getTrustScoreTone(trustScore.currentScore);
  const classes = getTrustScoreToneClasses(tone);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="secondary"
          className={cn("text-[11px] px-2 py-0.5", classes.badge)}
          data-testid="trust-score-badge"
          data-tone={tone}
        >
          {formatTrustScorePercent(trustScore.currentScore)}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top">{getTrustScoreTooltip(trustScore)}</TooltipContent>
    </Tooltip>
  );
}
