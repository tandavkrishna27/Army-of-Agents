import { RefreshCw } from "lucide-react";
import type { ProviderQuotaWindow } from "@/api/quotas";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn, relativeTime } from "@/lib/utils";
import { QuotaBar } from "./QuotaBar";

const STALE_THRESHOLD_MS = 10 * 60 * 1000;

// Provider display names — mirrors Paperclip's `providerDisplayName` util, inlined
// so we don't introduce a utils change for just 4 providers.
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  aws_bedrock: "AWS Bedrock",
  openai: "OpenAI",
  google: "Google",
  cursor: "Cursor",
};

function providerLabel(provider: string): string {
  return (
    PROVIDER_LABELS[provider.toLowerCase()] ??
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

function windowOrder(kind: string): number {
  const order: Record<string, number> = { "5h": 0, "24h": 1, "7d": 2 };
  return order[kind] ?? 99;
}

function isStale(lastUpdatedAt: string | null): boolean {
  if (!lastUpdatedAt) return true;
  return Date.now() - new Date(lastUpdatedAt).getTime() > STALE_THRESHOLD_MS;
}

export interface ProviderQuotaCardProps {
  provider: string;
  windows: ProviderQuotaWindow[];
  lastUpdatedAt: string | null;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function ProviderQuotaCard({
  provider,
  windows,
  lastUpdatedAt,
  onRefresh,
  isRefreshing = false,
}: ProviderQuotaCardProps) {
  const sorted = [...windows].sort(
    (a, b) => windowOrder(a.windowKind) - windowOrder(b.windowKind),
  );
  const stale = isStale(lastUpdatedAt);
  const isEmpty = sorted.length === 0 && lastUpdatedAt == null;

  return (
    <Card data-testid="provider-quota-card">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{providerLabel(provider)}</h3>
            <p
              data-testid="quota-freshness"
              data-stale={stale ? "true" : "false"}
              className={cn(
                "text-xs mt-0.5",
                stale
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground",
              )}
            >
              {lastUpdatedAt
                ? `Last updated ${relativeTime(lastUpdatedAt)}`
                : "Never refreshed"}
            </p>
          </div>
          {onRefresh && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5"
              disabled={isRefreshing}
              onClick={onRefresh}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
              />
              Refresh
            </Button>
          )}
        </div>

        {isEmpty ? (
          <p className="text-xs text-muted-foreground">
            No quota data for this provider yet. Refresh to pull the latest
            snapshot.
          </p>
        ) : sorted.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No active quota windows for this provider.
          </p>
        ) : (
          <div className="space-y-3">
            {sorted.map((w) => (
              <QuotaBar
                key={w.id}
                label={w.label ?? w.windowKind}
                used={w.usedValue ?? 0}
                limit={w.limitValue ?? 0}
                valueLabel={w.valueLabel ?? undefined}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
