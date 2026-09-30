import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";
import type { ExecutionWorkspace, Project } from "@armyofagents/shared";

import { executionWorkspacesApi } from "../api/execution-workspaces";
import { projectsApi } from "../api/projects";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "@/lib/utils";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { EmptyState } from "../components/EmptyState";
import { WorkspaceSettingsSheet } from "../components/workspace/WorkspaceSettingsSheet";
import { ExecutionWorkspaceCloseDialog } from "../components/workspace/ExecutionWorkspaceCloseDialog";

type StatusFilter = "all" | "active" | "archived";
type ModeFilter = "all" | "isolated" | "shared";

const STATUS_BADGE_CLASSES: Record<string, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  idle: "bg-muted text-muted-foreground",
  in_review: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  archived: "bg-muted text-muted-foreground",
  cleanup_failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

function formatRelativeTime(date: Date | string): string {
  const now = Date.now();
  const diffMs = now - new Date(date).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo ago`;
}

function FilterChip({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active || undefined}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

const UNGROUPED_KEY = "__ungrouped__";

export function WorkspacesList() {
  const { selectedCompanyId } = useCompany();
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Workspaces" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";

  const workspacesQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.list(companyId),
    queryFn: () => executionWorkspacesApi.list(companyId),
    enabled: !!companyId,
  });

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });

  const projectMap = useMemo(() => {
    const m = new Map<string, Project>();
    (projectsQuery.data ?? []).forEach((p) => m.set(p.id, p));
    return m;
  }, [projectsQuery.data]);

  const filtered = useMemo(() => {
    return (workspacesQuery.data ?? []).filter((w) => {
      if (statusFilter === "active" && w.status === "archived") return false;
      if (statusFilter === "archived" && w.status !== "archived") return false;
      if (modeFilter === "isolated" && w.mode !== "isolated_workspace") return false;
      if (modeFilter === "shared" && w.mode !== "shared_workspace") return false;
      return true;
    });
  }, [workspacesQuery.data, statusFilter, modeFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, ExecutionWorkspace[]>();
    for (const w of filtered) {
      const key = w.projectId ?? UNGROUPED_KEY;
      const list = map.get(key);
      if (list) {
        list.push(w);
      } else {
        map.set(key, [w]);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
    }
    return map;
  }, [filtered]);

  const isLoading = workspacesQuery.isLoading || projectsQuery.isLoading;
  const isEmpty = !isLoading && (workspacesQuery.data?.length ?? 0) === 0;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold" data-testid="workspaces-list-heading">
          Workspaces
        </h1>
      </div>

      <div className="flex flex-wrap items-center gap-2" data-testid="workspaces-list-filters">
        <span className="text-xs text-muted-foreground">Status:</span>
        <FilterChip
          active={statusFilter === "all"}
          onClick={() => setStatusFilter("all")}
          testId="workspaces-filter-status-all"
        >
          All
        </FilterChip>
        <FilterChip
          active={statusFilter === "active"}
          onClick={() => setStatusFilter("active")}
          testId="workspaces-filter-status-active"
        >
          Active
        </FilterChip>
        <FilterChip
          active={statusFilter === "archived"}
          onClick={() => setStatusFilter("archived")}
          testId="workspaces-filter-status-archived"
        >
          Archived
        </FilterChip>
        <span className="mx-2 text-xs text-muted-foreground">Mode:</span>
        <FilterChip
          active={modeFilter === "all"}
          onClick={() => setModeFilter("all")}
          testId="workspaces-filter-mode-all"
        >
          All
        </FilterChip>
        <FilterChip
          active={modeFilter === "isolated"}
          onClick={() => setModeFilter("isolated")}
          testId="workspaces-filter-mode-isolated"
        >
          Isolated
        </FilterChip>
        <FilterChip
          active={modeFilter === "shared"}
          onClick={() => setModeFilter("shared")}
          testId="workspaces-filter-mode-shared"
        >
          Shared
        </FilterChip>
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground" data-testid="workspaces-list-loading">
          Loading...
        </p>
      )}

      {isEmpty && (
        <EmptyState
          icon={FolderGit2}
          message="No workspaces yet"
          description="Create one from a task or project."
        />
      )}

      {!isLoading && !isEmpty && filtered.length === 0 && (
        <p
          className="text-sm text-muted-foreground"
          data-testid="workspaces-list-filtered-empty"
        >
          No workspaces match the current filters.
        </p>
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="space-y-4" data-testid="workspaces-list-groups">
          {Array.from(grouped.entries()).map(([key, list]) => {
            const project = key === UNGROUPED_KEY ? null : projectMap.get(key);
            const groupLabel = project?.name ?? "No project";
            return (
              <Collapsible key={key} defaultOpen data-testid={`workspaces-group-${key}`}>
                <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-border bg-card px-4 py-2 text-left">
                  <span className="text-sm font-medium">
                    {groupLabel} <span className="text-muted-foreground">({list.length})</span>
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 divide-y divide-border rounded-md border border-border bg-card">
                    {list.map((w) => {
                      const statusClass =
                        STATUS_BADGE_CLASSES[w.status] ?? "bg-muted text-muted-foreground";
                      const isIsolated = w.mode === "isolated_workspace";
                      const displayName = w.branchName ?? w.name;
                      return (
                        <div
                          key={w.id}
                          className="flex items-center gap-3 px-4 py-3 text-sm"
                          data-testid={`workspaces-row-${w.id}`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-medium truncate">
                                {displayName}
                              </span>
                              {w.branchName && w.branchName !== w.name && (
                                <span className="text-xs text-muted-foreground truncate">
                                  {w.name}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <span
                                className={cn(
                                  "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize shrink-0",
                                  statusClass,
                                )}
                              >
                                {w.status}
                              </span>
                              <span
                                className={cn(
                                  "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0",
                                  isIsolated
                                    ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                                    : "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
                                )}
                              >
                                {isIsolated ? "Isolated" : "Shared"}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {formatRelativeTime(w.lastUsedAt)}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              variant="outline"
                              size="sm"
                              data-testid={`workspaces-open-${w.id}`}
                              onClick={() =>
                                navigate(`/${companyPrefix ?? ""}/workspaces/${w.id}`)
                              }
                            >
                              Open
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              data-testid={`workspaces-settings-${w.id}`}
                              onClick={() => setSettingsId(w.id)}
                            >
                              Settings
                            </Button>
                            {w.status !== "archived" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                data-testid={`workspaces-archive-${w.id}`}
                                onClick={() => setArchiveId(w.id)}
                              >
                                Archive
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}

      {settingsId && (
        <WorkspaceSettingsSheet
          workspaceId={settingsId}
          companyId={companyId}
          open={!!settingsId}
          onOpenChange={(v) => {
            if (!v) setSettingsId(null);
          }}
        />
      )}

      {archiveId && (
        <ExecutionWorkspaceCloseDialog
          workspaceId={archiveId}
          open={!!archiveId}
          onOpenChange={(v) => {
            if (!v) setArchiveId(null);
          }}
          onArchived={() => setArchiveId(null)}
        />
      )}
    </div>
  );
}
