import type { FinanceKindRow } from "@/api/finance";
import { Card, CardContent } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";

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

export interface FinanceKindCardProps {
  rows: FinanceKindRow[];
}

export function FinanceKindCard({ rows }: FinanceKindCardProps) {
  return (
    <Card data-testid="finance-kind-card">
      <CardContent className="p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Financial event mix</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Account-level charges grouped by event kind.
          </p>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No finance events in this period.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <div
                key={row.eventKind}
                className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {kindLabel(row.eventKind)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {row.eventCount} event{row.eventCount === 1 ? "" : "s"} ·{" "}
                    {row.billerCount} biller{row.billerCount === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="text-right tabular-nums shrink-0">
                  <p className="text-sm font-medium">
                    {formatCents(row.netCents)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatCents(row.debitCents)} debits
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
