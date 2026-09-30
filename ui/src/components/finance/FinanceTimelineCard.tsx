import type { FinanceEvent } from "@/api/finance";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime, formatCents } from "@/lib/utils";

const KIND_LABELS: Record<string, string> = {
  usage: "Usage",
  top_up: "Top-up",
  refund: "Refund",
  fee: "Fee",
  credit: "Credit",
  commitment: "Commitment",
  adjustment: "Adjustment",
  expiry: "Credit expiry",
};

function kindLabel(kind: string): string {
  const key = kind.toLowerCase();
  return (
    KIND_LABELS[key] ??
    kind
      .split(/[_\s]+/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ")
  );
}

function directionLabel(direction: "debit" | "credit"): string {
  return direction === "debit" ? "Debit" : "Credit";
}

export interface FinanceTimelineCardProps {
  rows: FinanceEvent[];
  emptyMessage?: string;
}

export function FinanceTimelineCard({
  rows,
  emptyMessage = "No financial events in this period.",
}: FinanceTimelineCardProps) {
  return (
    <Card data-testid="finance-timeline-card">
      <CardContent className="p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Recent financial events</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Top-ups, fees, credits, commitments, and other non-request charges.
          </p>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <div
                key={row.id}
                className="rounded-md border border-border/70 p-3"
                data-testid="finance-timeline-event"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary" className="text-[10px]">
                        {kindLabel(row.eventKind)}
                      </Badge>
                      <Badge
                        variant={row.direction === "credit" ? "outline" : "secondary"}
                        className="text-[10px]"
                      >
                        {directionLabel(row.direction)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(row.occurredAt)}
                      </span>
                    </div>
                    <p className="text-sm font-medium truncate">
                      {row.biller}
                      {row.provider ? ` → ${row.provider}` : ""}
                      {row.model ? (
                        <span className="ml-1 font-mono text-xs text-muted-foreground">
                          {row.model}
                        </span>
                      ) : null}
                    </p>
                    {(row.description ||
                      row.externalInvoiceId ||
                      row.region ||
                      row.pricingTier) && (
                      <div className="space-y-0.5 text-xs text-muted-foreground">
                        {row.description ? <p>{row.description}</p> : null}
                        {row.externalInvoiceId ? (
                          <p>invoice {row.externalInvoiceId}</p>
                        ) : null}
                        {row.region ? <p>region {row.region}</p> : null}
                        {row.pricingTier ? <p>tier {row.pricingTier}</p> : null}
                      </div>
                    )}
                  </div>
                  <div className="text-right tabular-nums shrink-0">
                    <p className="text-sm font-semibold">
                      {formatCents(row.amountCents)}
                    </p>
                    <p className="text-xs text-muted-foreground">{row.currency}</p>
                    {row.estimated ? (
                      <p className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
                        estimated
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
