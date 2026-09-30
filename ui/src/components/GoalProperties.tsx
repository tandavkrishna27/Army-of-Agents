import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Goal } from "@armyofagents/shared";
import { GOAL_STATUSES, GOAL_LEVELS } from "@armyofagents/shared";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { formatDate, cn, agentUrl, projectUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";

interface GoalPropertiesProps {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">{children}</div>
    </div>
  );
}

function label(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function PickerButton({
  current,
  options,
  onChange,
  children,
}: {
  current: string;
  options: readonly string[];
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer hover:opacity-80 transition-opacity">
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        {options.map((opt) => (
          <Button
            key={opt}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start text-xs", opt === current && "bg-accent")}
            onClick={() => {
              onChange(opt);
              setOpen(false);
            }}
          >
            {label(opt)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function GoalProperties({ goal, onUpdate }: GoalPropertiesProps) {
  const { selectedCompanyId } = useCompany();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: allProjects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const [projectsPickerOpen, setProjectsPickerOpen] = useState(false);

  const ownerAgent = goal.ownerAgentId
    ? agents?.find((a) => a.id === goal.ownerAgentId)
    : null;

  const parentGoal = goal.parentId
    ? allGoals?.find((g) => g.id === goal.parentId)
    : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Status">
          {onUpdate ? (
            <PickerButton
              current={goal.status}
              options={GOAL_STATUSES}
              onChange={(status) => onUpdate({ status })}
            >
              <StatusBadge status={goal.status} />
            </PickerButton>
          ) : (
            <StatusBadge status={goal.status} />
          )}
        </PropertyRow>

        <PropertyRow label="Level">
          {onUpdate ? (
            <PickerButton
              current={goal.level}
              options={GOAL_LEVELS}
              onChange={(level) => onUpdate({ level })}
            >
              <span className="text-sm capitalize">{goal.level}</span>
            </PickerButton>
          ) : (
            <span className="text-sm capitalize">{goal.level}</span>
          )}
        </PropertyRow>

        <PropertyRow label="Owner">
          {ownerAgent ? (
            <Link
              to={agentUrl(ownerAgent)}
              className="text-sm hover:underline"
            >
              {ownerAgent.name}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </PropertyRow>

        {goal.parentId && (
          <PropertyRow label="Parent Goal">
            <Link
              to={`/goals/${goal.parentId}`}
              className="text-sm hover:underline"
            >
              {parentGoal?.title ?? goal.parentId.slice(0, 8)}
            </Link>
          </PropertyRow>
        )}

        <PropertyRow label="Depts/Projects">
          {onUpdate ? (
            <Popover open={projectsPickerOpen} onOpenChange={setProjectsPickerOpen}>
              <PopoverTrigger asChild>
                <button className="cursor-pointer hover:opacity-80 transition-opacity">
                  {(!goal.projects || goal.projects.length === 0) ? (
                    <span className="text-sm text-amber-600">Unassigned</span>
                  ) : (
                    <div className="flex items-center gap-1 flex-wrap">
                      {goal.projects.map((p) => (
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
                      ))}
                    </div>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-1" align="end">
                {(allProjects ?? [])
                  .slice()
                  .sort((a, b) => {
                    if (a.type === b.type) return a.name.localeCompare(b.name);
                    return a.type === "department" ? -1 : 1;
                  })
                  .map((p) => {
                    const selected = goal.projectIds?.includes(p.id) ?? false;
                    return (
                      <button
                        key={p.id}
                        className={cn(
                          "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                          selected && "bg-accent",
                        )}
                        onClick={() => {
                          const currentIds = goal.projectIds ?? [];
                          const newIds = selected
                            ? currentIds.filter((id) => id !== p.id)
                            : [...currentIds, p.id];
                          onUpdate({ projectIds: newIds });
                        }}
                      >
                        {selected ? (
                          <Check className="h-3 w-3 shrink-0" />
                        ) : (
                          <span className="w-3 shrink-0" />
                        )}
                        <span className="truncate">{p.name}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground capitalize">
                          {p.type}
                        </span>
                      </button>
                    );
                  })}
              </PopoverContent>
            </Popover>
          ) : (
            <div className="flex items-center gap-1 flex-wrap">
              {(!goal.projects || goal.projects.length === 0) ? (
                <span className="text-sm text-amber-600">Unassigned</span>
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
          )}
        </PropertyRow>
      </div>

      <Separator />

      <div className="space-y-1">
        <PropertyRow label="Created">
          <span className="text-sm">{formatDate(goal.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{formatDate(goal.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
