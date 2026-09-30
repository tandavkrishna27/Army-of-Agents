import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface SecretRunPreviewItem {
  key: string;
  source: "plain" | "secret";
  safeDisplayValue: string;
  status: "ok" | "missing" | "disabled";
  required?: boolean;
}

export function SecretRunPreviewCard({ items }: { items: SecretRunPreviewItem[] }) {
  const needsAttention = items.some((item) => item.status !== "ok" && item.required !== false);

  return (
    <section className="rounded-md border border-border bg-card/30">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h3 className="text-sm font-semibold">Resolved preview</h3>
        {needsAttention ? (
          <Badge variant="outline" className="border-amber-500/40 text-amber-400">
            Needs attention
          </Badge>
        ) : (
          <Badge variant="outline" className="border-emerald-500/40 text-emerald-400">
            Ready
          </Badge>
        )}
      </div>
      <div className="divide-y divide-border">
        {items.map((item) => (
          <div key={item.key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate font-mono text-xs">{item.key}</div>
              <div className="truncate text-xs text-muted-foreground">{item.safeDisplayValue}</div>
            </div>
            {item.status === "ok" ? (
              <CheckCircle2 className="size-4 text-emerald-400" aria-label={`${item.key} ready`} />
            ) : (
              <AlertTriangle className="size-4 text-amber-400" aria-label={`${item.key} needs attention`} />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
