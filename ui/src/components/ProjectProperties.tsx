import { useState, type ReactNode } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@armyofagents/shared";
import { StatusBadge } from "./StatusBadge";
import { cn, formatDate } from "../lib/utils";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, X } from "lucide-react";

const PROJECT_STATUSES = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

interface ProjectPropertiesProps {
  project: Project;
  onUpdate?: (data: Record<string, unknown>) => void;
}

function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

function ProjectStatusPicker({ status, onChange }: { status: string; onChange: (status: string) => void }) {
  const [open, setOpen] = useState(false);
  const colorClass = statusBadge[status] ?? statusBadgeDefault;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium transition-opacity hover:opacity-80",
            colorClass,
          )}
        >
          {status.replace("_", " ")}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="start">
        {PROJECT_STATUSES.map((s) => (
          <Button
            key={s.value}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start gap-2 text-xs", s.value === status && "bg-accent")}
            onClick={() => {
              onChange(s.value);
              setOpen(false);
            }}
          >
            {s.label}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function ProjectProperties({ project, onUpdate }: ProjectPropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const [goalOpen, setGoalOpen] = useState(false);

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const linkedGoalIds = (project.goalIds ?? []).length > 0
    ? project.goalIds ?? []
    : project.goalId
      ? [project.goalId]
      : [];

  const linkedGoals = (project.goals ?? []).length > 0
    ? project.goals
    : linkedGoalIds.map((id) => ({
        id,
        title: allGoals?.find((g) => g.id === id)?.title ?? id.slice(0, 8),
      }));

  const availableGoals = (allGoals ?? []).filter((g) => !linkedGoalIds.includes(g.id));

  const removeGoal = (goalId: string) => {
    if (!onUpdate) return;
    onUpdate({ goalIds: linkedGoalIds.filter((id) => id !== goalId) });
  };

  const addGoal = (goalId: string) => {
    if (!onUpdate || linkedGoalIds.includes(goalId)) return;
    onUpdate({ goalIds: [...linkedGoalIds, goalId] });
    setGoalOpen(false);
  };

  return (
    <div className="space-y-1">
      <PropertyRow label="Status">
        {onUpdate ? (
          <ProjectStatusPicker status={project.status} onChange={(status) => onUpdate({ status })} />
        ) : (
          <StatusBadge status={project.status} />
        )}
      </PropertyRow>

      {project.leadAgentId && (
        <PropertyRow label="Lead">
          <span className="font-mono text-sm">{project.leadAgentId.slice(0, 8)}</span>
        </PropertyRow>
      )}

      <div className="py-1.5">
        <div className="flex items-start justify-between gap-2">
          <span className="text-xs text-muted-foreground">Goals</span>
          <div className="flex flex-col items-end gap-1.5">
            {linkedGoals.length === 0 ? (
              <span className="text-sm text-muted-foreground">None</span>
            ) : (
              <div className="flex max-w-[220px] flex-wrap justify-end gap-1.5">
                {linkedGoals.map((goal) => (
                  <span key={goal.id} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
                    <Link to={`/goals/${goal.id}`} className="max-w-[140px] truncate hover:underline">
                      {goal.title}
                    </Link>
                    {onUpdate && (
                      <button
                        className="text-muted-foreground hover:text-foreground"
                        type="button"
                        onClick={() => removeGoal(goal.id)}
                        aria-label={`Remove goal ${goal.title}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {onUpdate && (
              <Popover open={goalOpen} onOpenChange={setGoalOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="xs" className="h-6 px-2" disabled={availableGoals.length === 0}>
                    <Plus className="mr-1 h-3 w-3" />
                    Goal
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-56 p-1" align="end">
                  {availableGoals.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">All goals linked.</div>
                  ) : (
                    availableGoals.map((goal) => (
                      <button
                        key={goal.id}
                        className="flex w-full items-center rounded px-2 py-1.5 text-xs hover:bg-accent/50"
                        onClick={() => addGoal(goal.id)}
                      >
                        {goal.title}
                      </button>
                    ))
                  )}
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </div>

      {project.targetDate && (
        <PropertyRow label="Target Date">
          <span className="text-sm">{formatDate(project.targetDate)}</span>
        </PropertyRow>
      )}

      <PropertyRow label="Created">
        <span className="text-sm">{formatDate(project.createdAt)}</span>
      </PropertyRow>
      <PropertyRow label="Updated">
        <span className="text-sm">{formatDate(project.updatedAt)}</span>
      </PropertyRow>
    </div>
  );
}
