import type { IssueMonitor } from "@armyofagents/shared";
import { CheckCircle2, Clock3, Radio, XCircle } from "lucide-react";
import { cn, formatDateTime } from "../lib/utils";

const statusCopy = {
  scheduled: "Monitor scheduled",
  triggered: "Monitor triggered",
  cleared: "Monitor cleared",
  cancelled: "Monitor cancelled",
} as const;

const statusStyles = {
  scheduled: "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  triggered: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  cleared: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  cancelled: "border-border bg-muted/40 text-muted-foreground",
} as const;

const statusIcons = {
  scheduled: Clock3,
  triggered: Radio,
  cleared: CheckCircle2,
  cancelled: XCircle,
} as const;

function humanizeReason(reason: string | null): string | null {
  if (!reason) return null;
  const text = reason.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function primaryDate(monitor: IssueMonitor): Date | string | null {
  if (monitor.status === "scheduled") return monitor.nextCheckAt;
  if (monitor.status === "triggered") return monitor.lastTriggeredAt;
  if (monitor.status === "cleared" || monitor.status === "cancelled") return monitor.clearedAt;
  return monitor.updatedAt;
}

export function IssueMonitorActivityCard({ monitor }: { monitor: IssueMonitor }) {
  const status = monitor.status in statusCopy ? monitor.status : "scheduled";
  const Icon = statusIcons[status];
  const date = primaryDate(monitor);
  const attempts = monitor.maxAttempts == null
    ? `${monitor.attemptCount} attempts`
    : `${monitor.attemptCount} / ${monitor.maxAttempts} attempts`;
  const reason = humanizeReason(monitor.clearReason);

  return (
    <article className={cn("rounded-md border px-3 py-2 text-sm", statusStyles[status])}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium text-foreground">{statusCopy[status]}</p>
            <span className="shrink-0 text-xs text-muted-foreground">{attempts}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{monitor.kind.replace(/_/g, " ")}</span>
            {date ? <span>{formatDateTime(date)}</span> : null}
            {reason ? <span>{reason}</span> : null}
          </div>
          {monitor.notes ? <p className="mt-1 text-xs text-muted-foreground">{monitor.notes}</p> : null}
        </div>
      </div>
    </article>
  );
}
