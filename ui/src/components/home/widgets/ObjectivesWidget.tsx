import type { GoalProgress } from "@armyofagents/shared";
import { Target } from "lucide-react";
import { useHomeSummary } from "../../../hooks/useHomeSummary";
import { useDialog } from "../../../context/DialogContext";
import { WidgetShell } from "./WidgetShell";
import { WidgetEmpty, WidgetLoading, WidgetOverflow } from "./WidgetStates";
import { WidgetRowLink } from "./WidgetRowLink";
import { rowsForSize } from "./widgetSizing";
import type { WidgetProps } from "./types";

export function ObjectivesWidget({ companyId, editing, size }: WidgetProps) {
  const { data, isLoading, isError } = useHomeSummary(companyId);
  const { openNewGoal } = useDialog();
  const allGoals = data?.goalProgress ?? [];
  const maxRows = rowsForSize(size);
  const goals = allGoals.slice(0, maxRows);
  const overflow = allGoals.length - goals.length;
  return (
    <WidgetShell title="Objectives" icon={Target} to="/objectives" editing={editing}>
      {isLoading ? (
        <WidgetLoading />
      ) : isError ? (
        <WidgetEmpty icon={Target} message="Couldn't load objectives" />
      ) : goals.length === 0 ? (
        // CTA is hidden while editing so an add-dialog can't fire mid-drag (review P2).
        <WidgetEmpty
          icon={Target}
          message="No objectives yet"
          ctaLabel={editing ? undefined : "+ New goal"}
          onCta={editing ? undefined : openNewGoal}
        />
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {goals.map((goal: GoalProgress) => (
            <WidgetRowLink
              key={goal.id}
              to={`/goals/${goal.id}`}
              editing={editing}
              className="flex items-center gap-3 px-4 py-3 text-sm text-inherit no-underline transition-colors hover:bg-accent/50"
            >
              <Target className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{goal.title}</span>
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs ${goal.status === "at_risk" ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-primary/10 text-primary"}`}>
                    {goal.status === "at_risk" ? "At Risk" : "Active"}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  {goal.totalTasks > 0 ? (
                    <>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${goal.progressPercent}%` }} />
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{goal.doneTasks}/{goal.totalTasks} tasks</span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">no tasks yet</span>
                  )}
                </div>
              </div>
            </WidgetRowLink>
          ))}
          <WidgetOverflow count={overflow} />
        </div>
      )}
    </WidgetShell>
  );
}
