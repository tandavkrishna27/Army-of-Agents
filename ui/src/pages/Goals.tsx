import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Goal } from "@armyofagents/shared";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Target, Plus, AlertTriangle, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

function GoalCard({ goal, subGoalCount }: { goal: Goal; subGoalCount: number }) {
  const isUnassigned = !goal.projects || goal.projects.length === 0;

  return (
    <Link
      to={`/goals/${goal.id}`}
      className="block rounded-lg border border-border p-4 hover:border-foreground/20 hover:shadow-md transition-all duration-150 no-underline text-inherit"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {goal.level}
          </span>
          <StatusBadge status={goal.status} />
        </div>
        {subGoalCount > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
            <ChevronRight className="h-3 w-3" />
            {subGoalCount} sub-goal{subGoalCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      <h3 className="text-sm font-semibold mb-1 truncate">{goal.title}</h3>

      {goal.description && (
        <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
          {goal.description}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {isUnassigned ? (
          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 text-amber-600 px-1.5 py-0.5 text-[10px] font-medium">
            <AlertTriangle className="h-2.5 w-2.5" />
            Unassigned
          </span>
        ) : (
          goal.projects.map((p) => (
            <span
              key={p.id}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                p.type === "department"
                  ? "bg-blue-500/15 text-blue-600"
                  : "bg-purple-500/15 text-purple-600",
              )}
            >
              {p.name}
            </span>
          ))
        )}
      </div>
    </Link>
  );
}

export function Goals() {
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { setSubtitle, setEntityColor } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
    setEntityColor("var(--entity-goal)");
    return () => { setSubtitle(null); setEntityColor(null); };
  }, [setBreadcrumbs, setSubtitle, setEntityColor]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Compute subtitle counts
  useEffect(() => {
    if (!goals) return;
    const active = goals.filter((g) => g.status === "active").length;
    const atRisk = goals.filter((g) => g.status === "at_risk").length;
    const parts: string[] = [];
    if (active > 0) parts.push(`${active} active`);
    if (atRisk > 0) parts.push(`${atRisk} at risk`);
    setSubtitle(parts.length > 0 ? parts.join(" \u00B7 ") : null);
  }, [goals, setSubtitle]);

  // Count sub-goals per parent
  const subGoalCounts = useMemo(() => {
    if (!goals) return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const g of goals) {
      if (g.parentId) {
        counts.set(g.parentId, (counts.get(g.parentId) ?? 0) + 1);
      }
    }
    return counts;
  }, [goals]);

  // Root goals (no parent, or parent not in the list)
  const rootGoals = useMemo(() => {
    if (!goals) return [];
    const goalIds = new Set(goals.map((g) => g.id));
    return goals.filter((g) => !g.parentId || !goalIds.has(g.parentId));
  }, [goals]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[1.6rem] font-bold tracking-tight">
          Goals<span className="text-brand">.</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          High-level objectives that align your agents' work toward measurable outcomes.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {goals && goals.length === 0 && (
        <EmptyState
          icon={Target}
          message="No goals yet"
          description="Goals help you track high-level objectives and align your agents' work toward measurable outcomes."
          action="Create your first goal"
          onAction={() => openNewGoal()}
          entityColor="var(--entity-goal)"
        />
      )}

      {rootGoals.length > 0 && (
        <>
          <div className="flex items-center justify-start">
            <Button size="sm" variant="outline" onClick={() => openNewGoal()}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Goal
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {rootGoals.map((goal) => (
              <GoalCard
                key={goal.id}
                goal={goal}
                subGoalCount={subGoalCounts.get(goal.id) ?? 0}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
