import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { formatCents, formatTokens } from "@/lib/utils";

export interface SubscriptionRollup {
  spendCents: number;
  eventCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ClaudeSubscriptionPanelProps {
  rollup: SubscriptionRollup | null;
  settingsHref?: string;
}

export function ClaudeSubscriptionPanel({
  rollup,
  settingsHref = "/settings",
}: ClaudeSubscriptionPanelProps) {
  const hasActivity = rollup != null && rollup.eventCount > 0;

  return (
    <Card data-testid="claude-subscription-panel">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Anthropic subscription
            </p>
            <h3 className="text-sm font-semibold mt-0.5">Claude Pro / Max</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Spend on <span className="font-mono">claude_local</span> adapter runs.
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-lg font-semibold tabular-nums">
              {formatCents(rollup?.spendCents ?? 0)}
            </p>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              period spend
            </p>
          </div>
        </div>

        {hasActivity ? (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border border-border/70 px-2.5 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Events
              </p>
              <p className="text-sm font-medium tabular-nums mt-0.5">
                {rollup!.eventCount}
              </p>
            </div>
            <div className="rounded-md border border-border/70 px-2.5 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Input
              </p>
              <p className="text-sm font-medium tabular-nums mt-0.5">
                {formatTokens(rollup!.inputTokens)}
              </p>
            </div>
            <div className="rounded-md border border-border/70 px-2.5 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Output
              </p>
              <p className="text-sm font-medium tabular-nums mt-0.5">
                {formatTokens(rollup!.outputTokens)}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No Claude subscription activity in this period.
          </p>
        )}

        <div className="pt-1 border-t border-border/70">
          <Link
            to={settingsHref}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Configure subscription limits
            <ExternalLink className="h-3 w-3" />
          </Link>
          <p className="text-[10px] text-muted-foreground mt-1">
            Subscription caps are tracked per-provider in Settings · coming soon.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
