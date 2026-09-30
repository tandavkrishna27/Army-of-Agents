import { useQuery } from "@tanstack/react-query";
import { CircleDollarSign } from "lucide-react";
import { dashboardApi } from "../../../api/dashboard";
import { queryKeys } from "../../../lib/queryKeys";
import { formatDollars } from "../money";
import { WidgetShell } from "./WidgetShell";
import { WidgetEmpty, WidgetLoading } from "./WidgetStates";
import { WidgetRowLink } from "./WidgetRowLink";
import type { WidgetProps } from "./types";

export function BudgetWidget({ companyId, editing }: WidgetProps) {
  const { data, isLoading, isError } = useQuery({ queryKey: queryKeys.dashboard(companyId), queryFn: () => dashboardApi.summary(companyId), enabled: !!companyId });
  return (
    <WidgetShell title="Budget" icon={CircleDollarSign} to="/budget" editing={editing}>
      {isLoading ? (
        <WidgetLoading />
      ) : isError || !data ? (
        <WidgetEmpty icon={CircleDollarSign} message="Couldn't load" />
      ) : (
        <WidgetRowLink to="/budget" editing={editing} className="block rounded-md border border-border px-4 py-3 text-inherit no-underline transition-colors hover:bg-accent/50">
          <div className="flex items-center gap-2">
            <CircleDollarSign className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-2xl font-semibold tabular-nums">{formatDollars(data.costs.monthSpendCents)}</span>
            <span className="text-sm text-muted-foreground">of {formatDollars(data.costs.monthBudgetCents)} this month</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.min(100, Math.max(0, Math.round(data.costs.monthUtilizationPercent)))}%` }} // server-computed; clamp only the bar width
            />
          </div>
        </WidgetRowLink>
      )}
    </WidgetShell>
  );
}
