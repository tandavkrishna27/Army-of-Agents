import type { FinanceBillerRow } from "@/api/finance";
import { Card, CardContent } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";

const BILLER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  cursor: "Cursor",
  claude_local: "Claude (local)",
  codex_local: "Codex (local)",
};

function billerLabel(biller: string | null): string {
  if (!biller) return "Unknown";
  const key = biller.toLowerCase();
  return (
    BILLER_LABELS[key] ??
    biller.charAt(0).toUpperCase() + biller.slice(1)
  );
}

export interface FinanceBillerCardProps {
  row: FinanceBillerRow;
}

export function FinanceBillerCard({ row }: FinanceBillerCardProps) {
  return (
    <Card data-testid="finance-biller-card">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate">{billerLabel(row.biller)}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {row.eventCount} event{row.eventCount === 1 ? "" : "s"} ·{" "}
              {row.kindCount} kind{row.kindCount === 1 ? "" : "s"}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-lg font-semibold tabular-nums">
              {formatCents(row.netCents)}
            </p>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              net
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md border border-border/70 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Debits
            </p>
            <p className="text-sm font-medium tabular-nums mt-0.5">
              {formatCents(row.debitCents)}
            </p>
          </div>
          <div className="rounded-md border border-border/70 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Credits
            </p>
            <p className="text-sm font-medium tabular-nums mt-0.5">
              {formatCents(row.creditCents)}
            </p>
          </div>
          <div className="rounded-md border border-border/70 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Estimated
            </p>
            <p className="text-sm font-medium tabular-nums mt-0.5">
              {formatCents(row.estimatedDebitCents)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
