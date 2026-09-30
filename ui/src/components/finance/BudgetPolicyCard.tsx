import { AlertTriangle, Pencil, ShieldAlert, Trash2, Wallet } from "lucide-react";
import type { BudgetPolicySummary } from "@armyofagents/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn, formatCents } from "@/lib/utils";

function statusLabel(status: BudgetPolicySummary["status"]) {
  if (status === "hard_stop") return "Hard stop";
  if (status === "warning") return "Warning";
  return "Healthy";
}

function statusTone(status: BudgetPolicySummary["status"]) {
  if (status === "hard_stop") {
    return "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400";
  }
  if (status === "warning") {
    return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
}

function barColor(status: BudgetPolicySummary["status"]) {
  if (status === "hard_stop") return "bg-red-500";
  if (status === "warning") return "bg-amber-500";
  return "bg-emerald-500";
}

function windowLabel(windowKind: string) {
  if (windowKind === "lifetime") return "Lifetime budget";
  if (windowKind === "month_utc") return "Monthly UTC budget";
  return `${windowKind} budget`;
}

export interface BudgetPolicyCardProps {
  policy: BudgetPolicySummary;
  onEdit?: (policy: BudgetPolicySummary) => void;
  onDelete?: (policy: BudgetPolicySummary) => void;
}

export function BudgetPolicyCard({ policy, onEdit, onDelete }: BudgetPolicyCardProps) {
  const progress = policy.amountCents > 0
    ? Math.min(100, Math.max(0, policy.utilizationPercent))
    : 0;
  const StatusIcon = policy.status === "hard_stop"
    ? ShieldAlert
    : policy.status === "warning"
      ? AlertTriangle
      : Wallet;
  const remainingCents = Math.max(0, policy.amountCents - policy.observedCents);

  return (
    <Card
      data-testid="budget-policy-card"
      className={cn(!policy.isActive && "opacity-60")}
    >
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              {policy.scopeType}
            </p>
            <h3 className="text-sm font-semibold mt-0.5 truncate">
              {policy.scopeName}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {windowLabel(policy.windowKind)} · {policy.metric}
            </p>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              statusTone(policy.status),
            )}
          >
            <StatusIcon className="h-3 w-3" />
            {statusLabel(policy.status)}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md border border-border/70 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Observed
            </p>
            <p className="text-base font-semibold tabular-nums mt-0.5">
              {formatCents(policy.observedCents)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {policy.amountCents > 0
                ? `${policy.utilizationPercent}% of limit`
                : "No cap configured"}
            </p>
          </div>
          <div className="rounded-md border border-border/70 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Budget
            </p>
            <p className="text-base font-semibold tabular-nums mt-0.5">
              {policy.amountCents > 0 ? formatCents(policy.amountCents) : "Disabled"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Soft alert at {policy.warnPercent}%
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Remaining</span>
            <span>
              {policy.amountCents > 0 ? formatCents(remainingCents) : "Unlimited"}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              data-testid="budget-policy-utilization-bar"
              className={cn(
                "h-full rounded-full transition-[width,background-color] duration-200",
                barColor(policy.status),
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {(onEdit || onDelete) && (
          <div className="flex justify-end gap-1">
            {onEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => onEdit(policy)}
              >
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                Edit
              </Button>
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-red-600 hover:text-red-700 dark:text-red-400"
                onClick={() => onDelete(policy)}
                aria-label={`Delete ${policy.scopeName} budget policy`}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
