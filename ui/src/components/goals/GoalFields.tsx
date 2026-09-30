import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GOAL_STATUSES } from "@armyofagents/shared";
import { goalsApi } from "../../api/goals";
import { projectsApi } from "../../api/projects";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { Input } from "@/components/ui/input";
import { Building2, FolderOpen, Square, CheckSquare, Search } from "lucide-react";

/** Goal scope: company-wide (no projects) or specific to a set of dept/projects. */
export interface GoalScope {
  mode: "company" | "specific";
  projectIds: string[];
}

/**
 * UX-only mirror of the server's isScopeWithinParent (server is the real gate
 * in goalService — this just hides incompatible parents from the picker):
 * - company-wide parent allows any child
 * - company-wide child cannot nest under a scoped parent
 * - otherwise the child's projects must be a subset of the parent's
 */
export function isCompatibleParent(
  childProjectIds: string[],
  parentProjectIds: string[],
): boolean {
  if (parentProjectIds.length === 0) return true;
  if (childProjectIds.length === 0) return false;
  const parent = new Set(parentProjectIds);
  return childProjectIds.every((id) => parent.has(id));
}

export interface GoalFieldsProps {
  companyId: string;
  /** Status row is shown only when onStatusChange is provided (thread→goal omits it — always planned). */
  status?: string;
  onStatusChange?: (status: string) => void;
  scope: GoalScope;
  onScopeChange: (scope: GoalScope) => void;
  parentIds: string[];
  onParentsChange: (ids: string[]) => void;
  /** Goal ids to hide from the parent picker (e.g. self + descendants when re-parenting). */
  excludeIds?: string[];
  /** Show only the parent-goals picker (hide status + scope) — used by the re-parent dialog. */
  parentsOnly?: boolean;
}

const LABEL_CLS =
  "text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block";

export function GoalFields({
  companyId,
  status,
  onStatusChange,
  scope,
  onScopeChange,
  parentIds,
  onParentsChange,
  excludeIds = [],
  parentsOnly = false,
}: GoalFieldsProps) {
  const [parentQuery, setParentQuery] = useState("");

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: !!companyId,
  });

  const sortedProjects = useMemo(
    () =>
      (projects ?? []).slice().sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === "department" ? -1 : 1;
      }),
    [projects],
  );

  const exclude = useMemo(() => new Set(excludeIds), [excludeIds]);
  const parentCandidates = useMemo(() => {
    const q = parentQuery.trim().toLowerCase();
    return (goals ?? []).filter((g) => {
      if (exclude.has(g.id)) return false;
      if (!isCompatibleParent(scope.projectIds, g.projectIds)) return false;
      if (q && !g.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [goals, exclude, scope.projectIds, parentQuery]);

  function toggleProject(id: string) {
    const has = scope.projectIds.includes(id);
    const next = has
      ? scope.projectIds.filter((p) => p !== id)
      : [...scope.projectIds, id];
    onScopeChange({ mode: "specific", projectIds: next });
  }

  function toggleParent(id: string) {
    onParentsChange(
      parentIds.includes(id)
        ? parentIds.filter((p) => p !== id)
        : [...parentIds, id],
    );
  }

  function setMode(mode: "company" | "specific") {
    if (mode === "company") onScopeChange({ mode: "company", projectIds: [] });
    else onScopeChange({ mode: "specific", projectIds: scope.projectIds });
  }

  return (
    <div className="space-y-4" data-testid="goal-fields">
      {/* Status (only when the host wants to control it) */}
      {onStatusChange && (
        <div>
          <span className={LABEL_CLS}>Status</span>
          <div className="flex flex-wrap gap-1.5">
            {GOAL_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                data-testid={`goal-status-${s}`}
                aria-pressed={status === s}
                onClick={() => onStatusChange(s)}
                className={cn(
                  "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors",
                  status === s
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:bg-muted/80",
                )}
              >
                {s.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scope */}
      {!parentsOnly && (
      <div>
        <span className={LABEL_CLS}>Scope</span>
        <div className="flex gap-1.5 mb-2">
          <button
            type="button"
            data-testid="goal-scope-company"
            aria-pressed={scope.mode === "company"}
            onClick={() => setMode("company")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              scope.mode === "company"
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border hover:border-muted-foreground",
            )}
          >
            <Building2 className="h-3.5 w-3.5" /> Company-wide
          </button>
          <button
            type="button"
            data-testid="goal-scope-specific"
            aria-pressed={scope.mode === "specific"}
            onClick={() => setMode("specific")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              scope.mode === "specific"
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border hover:border-muted-foreground",
            )}
          >
            <FolderOpen className="h-3.5 w-3.5" /> Specific
          </button>
        </div>

        {scope.mode === "specific" && (
          <div>
            {sortedProjects.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No departments or projects found.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                {sortedProjects.map((p) => {
                  const selected = scope.projectIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      data-testid={`goal-project-${p.id}`}
                      aria-pressed={selected}
                      onClick={() => toggleProject(p.id)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors border",
                        selected
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-card text-muted-foreground border-border hover:border-muted-foreground",
                      )}
                    >
                      {p.name}
                      <span className="text-[10px] opacity-70 capitalize">
                        {p.type}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {scope.projectIds.length === 0 && (
              <p className="text-[11px] text-destructive mt-1">
                Pick at least one department or project.
              </p>
            )}
          </div>
        )}
      </div>
      )}

      {/* Parent goals */}
      <div>
        <span className={LABEL_CLS}>Parent goals (optional)</span>
        <div className="relative mb-1.5">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            data-testid="goal-parent-search"
            value={parentQuery}
            onChange={(e) => setParentQuery(e.target.value)}
            placeholder="Search goals to nest under…"
            className="pl-7 h-8 text-xs"
          />
        </div>
        {parentCandidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {(goals ?? []).length === 0
              ? "No existing goals — this will be a top-level goal."
              : "No scope-compatible goals. Leave empty for a top-level goal."}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5 max-h-32 overflow-y-auto">
            {parentCandidates.map((g) => {
              const selected = parentIds.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  data-testid={`goal-parent-${g.id}`}
                  role="checkbox"
                  aria-checked={selected}
                  onClick={() => toggleParent(g.id)}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                    selected && "bg-accent",
                  )}
                >
                  {selected ? (
                    <CheckSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
                  ) : (
                    <Square className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{g.title}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {g.projectIds.length === 0
                      ? "company"
                      : `${g.projectIds.length} scope`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
