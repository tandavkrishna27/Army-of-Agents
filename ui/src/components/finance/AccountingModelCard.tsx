import type { CostByModelRow } from "@/api/costs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn, formatCents, formatTokens } from "@/lib/utils";

export interface AccountingModelCardProps {
  rows: CostByModelRow[];
}

export function AccountingModelCard({ rows }: AccountingModelCardProps) {
  const sorted = [...rows].sort((a, b) => b.totalCostCents - a.totalCostCents);
  const topModel = sorted[0];

  return (
    <Card data-testid="accounting-model-card">
      <CardContent className="p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Spend by model</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Per-model token usage and billed spend across the period.
          </p>
        </div>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No cost events in this period.
          </p>
        ) : (
          <div className="space-y-2">
            {sorted.map((row) => {
              const isTop = row === topModel && row.totalCostCents > 0;
              return (
                <div
                  key={row.model ?? "__unknown"}
                  className={cn(
                    "rounded-md border px-3 py-2",
                    isTop ? "border-amber-500/40 bg-amber-500/5" : "border-border/70",
                  )}
                  data-testid="accounting-model-row"
                  data-top={isTop ? "true" : "false"}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium font-mono truncate">
                          {row.model ?? "(unspecified)"}
                        </p>
                        {isTop && (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-400"
                          >
                            Top spend
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {row.eventCount} event{row.eventCount === 1 ? "" : "s"} ·{" "}
                        {formatTokens(row.totalInputTokens)} in ·{" "}
                        {formatTokens(row.totalOutputTokens)} out
                        {row.totalCachedInputTokens > 0
                          ? ` · ${formatTokens(row.totalCachedInputTokens)} cached`
                          : ""}
                      </p>
                    </div>
                    <p className="text-sm font-semibold tabular-nums shrink-0">
                      {formatCents(row.totalCostCents)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
