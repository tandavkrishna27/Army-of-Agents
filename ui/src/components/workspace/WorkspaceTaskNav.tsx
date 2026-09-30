import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  PanelLeft,
  PanelLeftClose,
  Search,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { StatusIcon } from "../StatusIcon";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "../../context/ToastContext";
import { cn } from "../../lib/utils";
import type { Issue } from "@armyofagents/shared";

interface WorkspaceTaskNavProps {
  companyId: string;
  companyPrefix: string;
  projectId: string;
  selectedIssueId: string | null;
  onSelectIssue: (issueId: string, executionWorkspaceId?: string | null) => void;
  onBack: () => void;
  departmentName: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onExpandAndShowGroup?: (groupLabel: string) => void;
  scrollToGroup?: { group: string; nonce: number } | null;
}

type TaskGroup = {
  label: string;
  statuses: string[];
  icon: LucideIcon;
};

const TASK_GROUPS: TaskGroup[] = [
  { label: "Needs Attention", statuses: ["blocked", "in_review"], icon: AlertTriangle },
  { label: "Running", statuses: ["in_progress"], icon: Zap },
  { label: "Idle", statuses: ["backlog", "todo"], icon: Clock },
  { label: "Completed", statuses: ["done", "cancelled"], icon: CheckCircle },
];

export function WorkspaceTaskNav({
  companyId,
  companyPrefix,
  projectId,
  selectedIssueId,
  onSelectIssue,
  onBack,
  departmentName,
  collapsed = false,
  onToggleCollapse,
  onExpandAndShowGroup,
  scrollToGroup,
}: WorkspaceTaskNavProps) {
  const [search, setSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set(["Completed"]));
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const { data: allIssues = [], isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId && !!projectId,
  });

  const { pushToast } = useToast();

  useEffect(() => {
    if (error) {
      pushToast({ tone: "error", title: "Failed to load tasks", body: (error as Error).message });
    }
  }, [error, pushToast]);

  // Only tasks with workspaces
  const issues = useMemo(
    () => allIssues.filter((i) => i.executionWorkspaceId != null),
    [allIssues],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return issues;
    const q = search.toLowerCase();
    return issues.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        (i.identifier?.toLowerCase().includes(q) ?? false),
    );
  }, [issues, search]);

  const toggleGroup = (label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  // Scroll to the requested group when the nonce changes (from parent when user clicks a collapsed-rail icon)
  useEffect(() => {
    if (!scrollToGroup || collapsed) return;
    const el = groupRefs.current[scrollToGroup.group];
    if (!el) return;
    // Ensure the group is not collapsed
    setCollapsedGroups((prev) => {
      if (!prev.has(scrollToGroup.group)) return prev;
      const next = new Set(prev);
      next.delete(scrollToGroup.group);
      return next;
    });
    // Scroll after next paint so the group content is visible
    requestAnimationFrame(() => {
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }, [scrollToGroup, collapsed]);

  // ── Collapsed icon rail ──
  if (collapsed) {
    return (
      <div
        className="flex flex-col h-full items-center gap-1"
        data-testid="workspace-task-nav-collapsed"
      >
        <div className="flex h-[42px] w-full shrink-0 items-center justify-center border-b border-border" data-testid="workspace-task-nav-header">
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Expand tasks"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            data-testid="workspace-task-nav-expand"
            aria-label="Expand task list"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>

        <div className="w-6 h-px bg-border my-1" />

        {TASK_GROUPS.map((group) => {
          const count = filtered.filter((i) => group.statuses.includes(i.status)).length;
          if (count === 0) return null;
          const Icon = group.icon;
          const groupSlug = group.label.toLowerCase().replace(/\s+/g, "-");
          return (
            <button
              key={group.label}
              type="button"
              onClick={() => onExpandAndShowGroup?.(group.label)}
              title={`${group.label} (${count})`}
              className="relative flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              data-testid={`workspace-rail-group-${groupSlug}`}
              aria-label={`${group.label} (${count})`}
            >
              <Icon className="h-4 w-4" />
              <span
                className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-accent text-accent-foreground text-[10px] font-medium flex items-center justify-center"
                data-testid={`workspace-rail-badge-${groupSlug}`}
              >
                {count > 99 ? "99+" : count}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  // ── Expanded (existing behavior) ──
  return (
    <div className="flex flex-col h-full" data-testid="workspace-task-nav">
      {/* Back button + collapse chevron */}
      <div className="flex h-[42px] items-center border-b border-border shrink-0" data-testid="workspace-task-nav-header">
        <button
          type="button"
          onClick={onBack}
          title={`Back to ${departmentName}`}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="workspace-back-btn"
        >
          <ChevronLeft className="h-4 w-4 shrink-0" />
          <span className="truncate">{departmentName}</span>
        </button>
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Collapse tasks"
            className="mr-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            data-testid="workspace-task-nav-collapse"
            aria-label="Collapse task list"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Filter tasks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground min-w-0"
            data-testid="workspace-task-search"
          />
        </div>
      </div>

      {/* Task groups */}
      {isLoading ? (
        <div className="p-3 space-y-2" data-testid="task-nav-skeleton">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto" data-testid="workspace-task-list">
          {TASK_GROUPS.map((group) => {
            const groupIssues = filtered.filter((i) => group.statuses.includes(i.status));
            if (groupIssues.length === 0) return null;
            const isCollapsed = collapsedGroups.has(group.label);
            const groupSlug = group.label.toLowerCase().replace(/\s+/g, "-");

            return (
              <div
                key={group.label}
                ref={(el) => {
                  groupRefs.current[group.label] = el;
                }}
              >
                <button
                  type="button"
                  onClick={() => toggleGroup(group.label)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  data-testid={`workspace-group-${groupSlug}`}
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  )}
                  {group.label}
                  <span className="ml-auto text-xs text-muted-foreground/60">{groupIssues.length}</span>
                </button>

                {!isCollapsed && (
                  <div>
                    {groupIssues.map((issue) => (
                      <TaskRow
                        key={issue.id}
                        issue={issue}
                        isSelected={issue.id === selectedIssueId}
                        onSelect={() => onSelectIssue(issue.id, issue.executionWorkspaceId)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {search ? "No tasks match your search" : "No tasks with workspaces"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  issue,
  isSelected,
  onSelect,
}: {
  issue: Issue;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50",
        isSelected && "bg-accent/10 text-accent-foreground",
      )}
      data-testid={`workspace-task-row-${issue.id}`}
    >
      <StatusIcon status={issue.status} className="shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {issue.identifier && (
            <span className="text-xs text-muted-foreground shrink-0">{issue.identifier}</span>
          )}
          <span className="truncate text-xs">{issue.title}</span>
        </div>
      </div>
    </button>
  );
}
