import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { getCollapsedSet, toggleCollapsed } from "@/lib/inbox";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { groupBy } from "../lib/groupBy";
import { formatDate, cn } from "../lib/utils";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { EmptyState } from "./EmptyState";
import { Identity } from "./Identity";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { CircleDot, Plus, Filter, ArrowUpDown, Layers, Check, X, ChevronRight, List, Columns3, User, Search, ArrowDown, Link2, ListTree } from "lucide-react";
import { KanbanBoard } from "./KanbanBoard";
import type { Issue } from "@armyofagents/shared";

/* ── Helpers ── */

const statusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
const priorityOrder = ["critical", "high", "medium", "low"];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── View state ── */

export type IssueViewState = {
  statuses: string[];
  priorities: string[];
  assignees: string[];
  labels: string[];
  sortField: "status" | "priority" | "title" | "created" | "updated";
  sortDir: "asc" | "desc";
  groupBy: "status" | "priority" | "assignee" | "none";
  viewMode: "list" | "board";
  collapsedGroups: string[];
};

const defaultViewState: IssueViewState = {
  statuses: [],
  priorities: [],
  assignees: [],
  labels: [],
  sortField: "updated",
  sortDir: "desc",
  groupBy: "none",
  viewMode: "board",
  collapsedGroups: [],
};

const quickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  { label: "Active", statuses: ["todo", "in_progress", "in_review", "blocked"] },
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Done", statuses: ["done", "cancelled"] },
];

function getViewState(key: string): IssueViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...defaultViewState, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...defaultViewState };
}

function saveViewState(key: string, state: IssueViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function toggleInArray(arr: string[], value: string): string[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

function applyFilters(issues: Issue[], state: IssueViewState): Issue[] {
  let result = issues;
  if (state.statuses.length > 0) result = result.filter((i) => state.statuses.includes(i.status));
  if (state.priorities.length > 0) result = result.filter((i) => state.priorities.includes(i.priority));
  if (state.assignees.length > 0) result = result.filter((i) => i.assigneeAgentId != null && state.assignees.includes(i.assigneeAgentId));
  if (state.labels.length > 0) result = result.filter((i) => (i.labelIds ?? []).some((id) => state.labels.includes(id)));
  return result;
}

function sortIssues(issues: Issue[], state: IssueViewState): Issue[] {
  const sorted = [...issues];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (state.sortField) {
      case "status":
        return dir * (statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
      case "priority":
        return dir * (priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority));
      case "title":
        return dir * a.title.localeCompare(b.title);
      case "created":
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case "updated":
        return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
      default:
        return 0;
    }
  });
  return sorted;
}

function countActiveFilters(state: IssueViewState): number {
  let count = 0;
  if (state.statuses.length > 0) count++;
  if (state.priorities.length > 0) count++;
  if (state.assignees.length > 0) count++;
  if (state.labels.length > 0) count++;
  return count;
}

/* ── Component ── */

interface Agent {
  id: string;
  name: string;
}

interface IssuesListProps {
  issues: Issue[];
  isLoading?: boolean;
  error?: Error | null;
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  initialAssignees?: string[];
  initialSearch?: string;
  onSearchChange?: (search: string) => void;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
  onSelectIssue?: (issueIdentifier: string) => void;
  /** When true, issues are grouped into parent-child trees with collapsible children. */
  nestingEnabled?: boolean;
}

export function IssuesList({
  issues,
  isLoading,
  error,
  agents,
  liveIssueIds,
  projectId,
  viewStateKey,
  initialAssignees,
  initialSearch,
  onSearchChange,
  onUpdateIssue,
  onSelectIssue,
  nestingEnabled = false,
}: IssuesListProps) {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();

  // Scope the storage key per company so folding/view state is independent across companies.
  const scopedKey = selectedCompanyId ? `${viewStateKey}:${selectedCompanyId}` : viewStateKey;

  const [viewState, setViewState] = useState<IssueViewState>(() => {
    if (initialAssignees) {
      return { ...defaultViewState, assignees: initialAssignees, statuses: [] };
    }
    return getViewState(scopedKey);
  });
  const [assigneePickerIssueId, setAssigneePickerIssueId] = useState<string | null>(null);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [issueSearch, setIssueSearch] = useState(initialSearch ?? "");
  const [debouncedIssueSearch, setDebouncedIssueSearch] = useState(issueSearch);
  const normalizedIssueSearch = debouncedIssueSearch.trim();

  useEffect(() => {
    setIssueSearch(initialSearch ?? "");
  }, [initialSearch]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedIssueSearch(issueSearch);
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [issueSearch]);

  // Reload view state from localStorage when company changes (scopedKey changes).
  const prevScopedKey = useRef(scopedKey);
  useEffect(() => {
    if (prevScopedKey.current !== scopedKey) {
      prevScopedKey.current = scopedKey;
      setViewState(initialAssignees
        ? { ...defaultViewState, assignees: initialAssignees, statuses: [] }
        : getViewState(scopedKey));
    }
  }, [scopedKey, initialAssignees]);

  const updateView = useCallback((patch: Partial<IssueViewState>) => {
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      saveViewState(scopedKey, next);
      return next;
    });
  }, [scopedKey]);

  const { data: searchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.search(selectedCompanyId!, normalizedIssueSearch, projectId),
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: normalizedIssueSearch, projectId }),
    enabled: !!selectedCompanyId && normalizedIssueSearch.length > 0,
  });

  const agentName = useCallback((id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  }, [agents]);

  // Compute subtask counts per parent issue
  const subtaskStats = useMemo(() => {
    const stats = new Map<string, { total: number; done: number }>();
    for (const issue of issues) {
      if (!issue.parentId) continue;
      const entry = stats.get(issue.parentId) ?? { total: 0, done: 0 };
      entry.total++;
      if (issue.status === "done" || issue.status === "cancelled") entry.done++;
      stats.set(issue.parentId, entry);
    }
    return stats;
  }, [issues]);

  const filtered = useMemo(() => {
    const sourceIssues = normalizedIssueSearch.length > 0 ? searchedIssues : issues;
    const filteredByControls = applyFilters(sourceIssues, viewState);
    return sortIssues(filteredByControls, viewState);
  }, [issues, searchedIssues, viewState, normalizedIssueSearch]);

  // Parent-child nesting: group filtered issues into top-level + children
  const nestingGrouped = useMemo(() => {
    if (!nestingEnabled) return null;
    const issueIds = new Set(filtered.map((i) => i.id));
    const childrenByParent = new Map<string, Issue[]>();
    for (const i of filtered) {
      if (i.parentId && issueIds.has(i.parentId)) {
        const arr = childrenByParent.get(i.parentId) ?? [];
        arr.push(i);
        childrenByParent.set(i.parentId, arr);
      }
    }
    const topLevel = filtered.filter((i) => !i.parentId || !issueIds.has(i.parentId));
    return { childrenByParent, topLevel };
  }, [filtered, nestingEnabled]);

  const [nestingCollapsed, setNestingCollapsed] = useState<Set<string>>(() => getCollapsedSet());

  function handleNestingToggleCollapse(parentId: string) {
    const next = toggleCollapsed(parentId);
    setNestingCollapsed(new Set(next));
  }

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeFilterCount = countActiveFilters(viewState);

  const [showScrollBottom, setShowScrollBottom] = useState(false);
  useEffect(() => {
    const el = document.getElementById("main-content");
    if (!el) return;
    const check = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBottom(distanceFromBottom > 300);
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    return () => el.removeEventListener("scroll", check);
  }, [filtered.length]);

  const scrollToBottom = useCallback(() => {
    const el = document.getElementById("main-content");
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const groupedContent = useMemo(() => {
    if (viewState.groupBy === "none") {
      return [{ key: "__all", label: null as string | null, items: filtered }];
    }
    if (viewState.groupBy === "status") {
      const groups = groupBy(filtered, (i) => i.status);
      return statusOrder
        .filter((s) => groups[s]?.length)
        .map((s) => ({ key: s, label: statusLabel(s), items: groups[s]! }));
    }
    if (viewState.groupBy === "priority") {
      const groups = groupBy(filtered, (i) => i.priority);
      return priorityOrder
        .filter((p) => groups[p]?.length)
        .map((p) => ({ key: p, label: statusLabel(p), items: groups[p]! }));
    }
    // assignee
    const groups = groupBy(filtered, (i) => i.assigneeAgentId ?? "__unassigned");
    return Object.keys(groups).map((key) => ({
      key,
      label: key === "__unassigned" ? "Unassigned" : (agentName(key) ?? key.slice(0, 8)),
      items: groups[key]!,
    }));
  }, [filtered, viewState.groupBy, agents]); // eslint-disable-line react-hooks/exhaustive-deps

  const newIssueDefaults = (groupKey?: string) => {
    const defaults: Record<string, string> = {};
    if (projectId) defaults.projectId = projectId;
    if (groupKey) {
      if (viewState.groupBy === "status") defaults.status = groupKey;
      else if (viewState.groupBy === "priority") defaults.priority = groupKey;
      else if (viewState.groupBy === "assignee" && groupKey !== "__unassigned") defaults.assigneeAgentId = groupKey;
    }
    return defaults;
  };

  const assignIssue = (issueId: string, assigneeAgentId: string | null) => {
    onUpdateIssue(issueId, { assigneeAgentId, assigneeUserId: null });
    setAssigneePickerIssueId(null);
    setAssigneeSearch("");
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button size="sm" variant="outline" onClick={() => openNewIssue(newIssueDefaults())}>
            <Plus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">New Task</span>
          </Button>
          <div className="relative w-48 sm:w-64 md:w-80">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={issueSearch}
              onChange={(e) => {
                setIssueSearch(e.target.value);
                onSearchChange?.(e.target.value);
              }}
              placeholder="Search tasks..."
              className="pl-7 text-xs sm:text-sm"
              aria-label="Search tasks"
            />
          </div>
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          {/* View mode toggle */}
          <div className="flex items-center border border-border rounded-md overflow-hidden mr-1">
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "list" })}
              title="List view"
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "board" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "board" })}
              title="Board view"
            >
              <Columns3 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Filter */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className={`text-xs ${activeFilterCount > 0 ? "text-blue-600 dark:text-blue-400" : ""}`}>
                <Filter className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                <span className="hidden sm:inline">{activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}</span>
                {activeFilterCount > 0 && (
                  <span className="sm:hidden text-[10px] font-medium ml-0.5">{activeFilterCount}</span>
                )}
                {activeFilterCount > 0 && (
                  <X
                    className="h-3 w-3 ml-1 hidden sm:block"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateView({ statuses: [], priorities: [], assignees: [], labels: [] });
                    }}
                  />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(480px,calc(100vw-2rem))] p-0">
              <div className="p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Filters</span>
                  {activeFilterCount > 0 && (
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => updateView({ statuses: [], priorities: [], assignees: [], labels: [] })}
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* Quick filters */}
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Quick filters</span>
                  <div className="flex flex-wrap gap-1.5">
                    {quickFilterPresets.map((preset) => {
                      const isActive = arraysEqual(viewState.statuses, preset.statuses);
                      return (
                        <button
                          key={preset.label}
                          className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                            isActive
                              ? "bg-primary text-primary-foreground border-primary"
                              : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                          }`}
                          onClick={() => updateView({ statuses: isActive ? [] : [...preset.statuses] })}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-border" />

                {/* Multi-column filter sections */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                  {/* Status */}
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Status</span>
                    <div className="space-y-0.5">
                      {statusOrder.map((s) => (
                        <label key={s} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                          <Checkbox
                            checked={viewState.statuses.includes(s)}
                            onCheckedChange={() => updateView({ statuses: toggleInArray(viewState.statuses, s) })}
                          />
                          <StatusIcon status={s} />
                          <span className="text-sm">{statusLabel(s)}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Priority + Assignee stacked in right column */}
                  <div className="space-y-3">
                    {/* Priority */}
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Priority</span>
                      <div className="space-y-0.5">
                        {priorityOrder.map((p) => (
                          <label key={p} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                            <Checkbox
                              checked={viewState.priorities.includes(p)}
                              onCheckedChange={() => updateView({ priorities: toggleInArray(viewState.priorities, p) })}
                            />
                            <PriorityIcon priority={p} />
                            <span className="text-sm">{statusLabel(p)}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Assignee */}
                    {agents && agents.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Assignee</span>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {agents.map((agent) => (
                            <label key={agent.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                              <Checkbox
                                checked={viewState.assignees.includes(agent.id)}
                                onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, agent.id) })}
                              />
                              <span className="text-sm">{agent.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {labels && labels.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Labels</span>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {labels.map((label) => (
                            <label key={label.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                              <Checkbox
                                checked={viewState.labels.includes(label.id)}
                                onCheckedChange={() => updateView({ labels: toggleInArray(viewState.labels, label.id) })}
                              />
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: label.color }} />
                              <span className="text-sm">{label.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {/* Sort (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs">
                  <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Sort</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["title", "Title"],
                    ["created", "Created"],
                    ["updated", "Updated"],
                  ] as const).map(([field, label]) => (
                    <button
                      key={field}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.sortField === field ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground"
                      }`}
                      onClick={() => {
                        if (viewState.sortField === field) {
                          updateView({ sortDir: viewState.sortDir === "asc" ? "desc" : "asc" });
                        } else {
                          updateView({ sortField: field, sortDir: "asc" });
                        }
                      }}
                    >
                      <span>{label}</span>
                      {viewState.sortField === field && (
                        <span className="text-xs text-muted-foreground">
                          {viewState.sortDir === "asc" ? "\u2191" : "\u2193"}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {/* Group (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs">
                  <Layers className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Group</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["assignee", "Assignee"],
                    ["none", "None"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.groupBy === value ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground"
                      }`}
                      onClick={() => updateView({ groupBy: value })}
                    >
                      <span>{label}</span>
                      {viewState.groupBy === value && <Check className="h-3.5 w-3.5" />}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {isLoading && <PageSkeleton variant="issues-list" />}
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && filtered.length === 0 && viewState.viewMode === "list" && (
        <EmptyState
          icon={CircleDot}
          message="No tasks match the current filters or search"
          description="Try adjusting your filters, or create a new task to get started."
          action="Create Task"
          onAction={() => openNewIssue(newIssueDefaults())}
          entityColor="var(--entity-task)"
        />
      )}

      {viewState.viewMode === "list" && nestingGrouped && (
        <div>
          {nestingGrouped.topLevel.map((parent) => {
            const children = nestingGrouped.childrenByParent.get(parent.id) ?? [];
            const isCollapsed = nestingCollapsed.has(parent.id);
            const subtaskStat = subtaskStats.get(parent.id);
            const descriptionPreview = parent.description
              ? parent.description.split("\n")[0].slice(0, 120)
              : null;
            return (
              <div key={parent.id}>
                {/* Parent row */}
                <div className="relative flex items-center">
                  {children.length > 0 && (
                    <button
                      type="button"
                      onClick={() => handleNestingToggleCollapse(parent.id)}
                      className="absolute left-0 z-10 flex h-full items-center pl-1 text-muted-foreground hover:text-foreground"
                      aria-label={isCollapsed ? "Expand children" : "Collapse children"}
                      aria-expanded={!isCollapsed}
                    >
                      <ChevronRight
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 transition-transform",
                          !isCollapsed && "rotate-90",
                        )}
                      />
                    </button>
                  )}
                  <Link
                    to={`/issues/${parent.identifier ?? parent.id}`}
                    className="group/row flex flex-1 items-start gap-2 py-2.5 pl-6 pr-3 text-sm border-b border-border last:border-b-0 cursor-pointer hover:bg-accent/50 transition-all duration-150 no-underline text-inherit border-l-2 border-l-transparent hover:border-l-[var(--entity-task)]"
                    onClick={onSelectIssue ? (e) => {
                      e.preventDefault();
                      onSelectIssue(parent.identifier ?? parent.id);
                    } : undefined}
                  >
                    <div className="shrink-0 mt-0.5" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                      <StatusIcon
                        status={parent.status}
                        onChange={(s) => onUpdateIssue(parent.id, { status: s })}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground font-mono shrink-0">
                          {parent.identifier ?? parent.id.slice(0, 8)}
                        </span>
                        <span className="truncate">{parent.title}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {descriptionPreview && (
                          <span className="text-xs text-muted-foreground/70 truncate max-w-[300px] hidden md:inline">
                            {descriptionPreview}
                          </span>
                        )}
                        {(parent.labels ?? []).length > 0 && (
                          <div className="hidden md:flex items-center gap-1">
                            {(parent.labels ?? []).slice(0, 3).map((label) => (
                              <span
                                key={label.id}
                                className="inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium leading-4"
                                style={{
                                  borderColor: label.color,
                                  color: label.color,
                                  backgroundColor: `${label.color}1f`,
                                }}
                              >
                                {label.name}
                              </span>
                            ))}
                            {(parent.labels ?? []).length > 3 && (
                              <span className="text-[10px] text-muted-foreground">+{(parent.labels ?? []).length - 3}</span>
                            )}
                          </div>
                        )}
                        {parent.status === "blocked" && (
                          <span className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                            <Link2 className="h-3 w-3" />
                          </span>
                        )}
                        {parent.workMode === "planning" && (
                          <span className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-full px-1.5 py-0 font-medium">
                            Planning
                          </span>
                        )}
                        {subtaskStat && (
                          <span className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                            <ListTree className="h-3 w-3" />
                            {subtaskStat.done}/{subtaskStat.total}
                          </span>
                        )}
                        {children.length > 0 && (
                          <span className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                            <ListTree className="h-3 w-3" />
                            {children.length} {children.length === 1 ? "subtask" : "subtasks"}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-auto mt-0.5">
                      {liveIssueIds?.has(parent.id) && (
                        <span className="inline-flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-0.5 rounded-full bg-blue-500/10">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                          </span>
                          <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hidden sm:inline">Live</span>
                        </span>
                      )}
                      <div className="hidden sm:block">
                        {parent.assigneeAgentId && agentName(parent.assigneeAgentId) ? (
                          <Identity name={agentName(parent.assigneeAgentId)!} size="xs" />
                        ) : null}
                      </div>
                      <span className="text-xs text-muted-foreground hidden sm:inline">
                        {formatDate(parent.createdAt)}
                      </span>
                    </div>
                  </Link>
                </div>
                {/* Children rows (visible when not collapsed) */}
                {!isCollapsed && children.map((child) => {
                  const childDescPreview = child.description
                    ? child.description.split("\n")[0].slice(0, 120)
                    : null;
                  return (
                    <Link
                      key={child.id}
                      to={`/issues/${child.identifier ?? child.id}`}
                      className="group/row flex items-start gap-2 py-2 pl-10 pr-3 text-sm border-b border-border last:border-b-0 cursor-pointer hover:bg-accent/50 transition-all duration-150 no-underline text-inherit border-l-2 border-l-transparent hover:border-l-[var(--entity-task)] bg-muted/20"
                      onClick={onSelectIssue ? (e) => {
                        e.preventDefault();
                        onSelectIssue(child.identifier ?? child.id);
                      } : undefined}
                    >
                      <div className="shrink-0 mt-0.5" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                        <StatusIcon
                          status={child.status}
                          onChange={(s) => onUpdateIssue(child.id, { status: s })}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground font-mono shrink-0">
                            {child.identifier ?? child.id.slice(0, 8)}
                          </span>
                          <span className="truncate">{child.title}</span>
                        </div>
                        {childDescPreview && (
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-muted-foreground/70 truncate max-w-[300px] hidden md:inline">
                              {childDescPreview}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-auto mt-0.5">
                        {liveIssueIds?.has(child.id) && (
                          <span className="inline-flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-0.5 rounded-full bg-blue-500/10">
                            <span className="relative flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                            </span>
                            <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hidden sm:inline">Live</span>
                          </span>
                        )}
                        <div className="hidden sm:block">
                          {child.assigneeAgentId && agentName(child.assigneeAgentId) ? (
                            <Identity name={agentName(child.assigneeAgentId)!} size="xs" />
                          ) : null}
                        </div>
                        <span className="text-xs text-muted-foreground hidden sm:inline">
                          {formatDate(child.createdAt)}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {viewState.viewMode === "board" ? (
        <KanbanBoard
          issues={filtered}
          agents={agents}
          liveIssueIds={liveIssueIds}
          onUpdateIssue={onUpdateIssue}
          onSelectIssue={onSelectIssue}
        />
      ) : (!nestingGrouped && groupedContent.map((group) => (
          <Collapsible
            key={group.key}
            open={!viewState.collapsedGroups.includes(group.key)}
            onOpenChange={(open) => {
              updateView({
                collapsedGroups: open
                  ? viewState.collapsedGroups.filter((k) => k !== group.key)
                  : [...viewState.collapsedGroups, group.key],
              });
            }}
          >
            {group.label && (
              <div className="flex items-center py-1.5 pl-1 pr-3">
                <CollapsibleTrigger className="flex items-center gap-1.5">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
                  <span className="text-sm font-semibold uppercase tracking-wide">
                    {group.label}
                  </span>
                </CollapsibleTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto text-muted-foreground"
                  onClick={() => openNewIssue(newIssueDefaults(group.key))}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
            )}
            <CollapsibleContent>
              {group.items.map((issue) => {
                const subtaskStat = subtaskStats.get(issue.id);
                const descriptionPreview = issue.description
                  ? issue.description.split("\n")[0].slice(0, 120)
                  : null;
                return (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="group/row flex items-start gap-2 py-2.5 pl-1 pr-3 text-sm border-b border-border last:border-b-0 cursor-pointer hover:bg-accent/50 transition-all duration-150 no-underline text-inherit border-l-2 border-l-transparent hover:border-l-[var(--entity-task)]"
                  onClick={onSelectIssue ? (e) => {
                    e.preventDefault();
                    onSelectIssue(issue.identifier ?? issue.id);
                  } : undefined}
                >
                  {/* Spacer matching caret width so status icon aligns with group title (hidden on mobile) */}
                  <div className="w-3.5 shrink-0 hidden sm:block mt-0.5" />
                  <div className="shrink-0 mt-0.5" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                    <StatusIcon
                      status={issue.status}
                      onChange={(s) => onUpdateIssue(issue.id, { status: s })}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground font-mono shrink-0">
                        {issue.identifier ?? issue.id.slice(0, 8)}
                      </span>
                      <span className="truncate">{issue.title}</span>
                    </div>
                    {/* Description preview + metadata row */}
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {descriptionPreview && (
                        <span className="text-xs text-muted-foreground/70 truncate max-w-[300px] hidden md:inline">
                          {descriptionPreview}
                        </span>
                      )}
                      {/* Labels */}
                      {(issue.labels ?? []).length > 0 && (
                        <div className="hidden md:flex items-center gap-1">
                          {(issue.labels ?? []).slice(0, 3).map((label) => (
                            <span
                              key={label.id}
                              className="inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium leading-4"
                              style={{
                                borderColor: label.color,
                                color: label.color,
                                backgroundColor: `${label.color}1f`,
                              }}
                            >
                              {label.name}
                            </span>
                          ))}
                          {(issue.labels ?? []).length > 3 && (
                            <span className="text-[10px] text-muted-foreground">+{(issue.labels ?? []).length - 3}</span>
                          )}
                        </div>
                      )}
                      {/* Dependency indicator */}
                      {issue.status === "blocked" && (
                        <span className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                          <Link2 className="h-3 w-3" />
                        </span>
                      )}
                      {/* Planning mode pill */}
                      {issue.workMode === "planning" && (
                        <span className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-full px-1.5 py-0 font-medium">
                          Planning
                        </span>
                      )}
                      {/* Subtask progress */}
                      {subtaskStat && (
                        <span className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                          <ListTree className="h-3 w-3" />
                          {subtaskStat.done}/{subtaskStat.total}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-auto mt-0.5">
                    {liveIssueIds?.has(issue.id) && (
                      <span className="inline-flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-0.5 rounded-full bg-blue-500/10">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                        </span>
                        <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hidden sm:inline">Live</span>
                      </span>
                    )}
                    {/* Hover quick actions (status + assignee) */}
                    <div className="hidden sm:flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
                      <Popover
                        open={assigneePickerIssueId === issue.id}
                        onOpenChange={(open) => {
                          setAssigneePickerIssueId(open ? issue.id : null);
                          if (!open) setAssigneeSearch("");
                        }}
                      >
                        <PopoverTrigger asChild>
                          <button
                            className="flex shrink-0 items-center rounded-md px-1.5 py-0.5 hover:bg-accent transition-colors"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                          >
                            {issue.assigneeAgentId && agentName(issue.assigneeAgentId) ? (
                              <Identity name={agentName(issue.assigneeAgentId)!} size="xs" />
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30">
                                  <User className="h-2.5 w-2.5" />
                                </span>
                              </span>
                            )}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-56 p-1"
                          align="end"
                          onClick={(e) => e.stopPropagation()}
                          onPointerDownOutside={() => setAssigneeSearch("")}
                        >
                          <input
                            className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
                            placeholder="Search agents..."
                            value={assigneeSearch}
                            onChange={(e) => setAssigneeSearch(e.target.value)}
                            autoFocus
                          />
                          <div className="max-h-48 overflow-y-auto overscroll-contain">
                            <button
                              className={cn(
                                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                                !issue.assigneeAgentId && "bg-accent"
                              )}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                assignIssue(issue.id, null);
                              }}
                            >
                              No assignee
                            </button>
                            {(agents ?? [])
                              .filter((agent) => {
                                if (!assigneeSearch.trim()) return true;
                                return agent.name.toLowerCase().includes(assigneeSearch.toLowerCase());
                              })
                              .map((agent) => (
                                <button
                                  key={agent.id}
                                  className={cn(
                                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                                    issue.assigneeAgentId === agent.id && "bg-accent"
                                  )}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    assignIssue(issue.id, agent.id);
                                  }}
                                >
                                  <Identity name={agent.name} size="sm" className="min-w-0" />
                                </button>
                              ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                    {/* Always-visible assignee (non-hover) */}
                    <div className="hidden sm:block group-hover/row:hidden">
                      {issue.assigneeAgentId && agentName(issue.assigneeAgentId) ? (
                        <Identity name={agentName(issue.assigneeAgentId)!} size="xs" />
                      ) : null}
                    </div>
                    <span className="text-xs text-muted-foreground hidden sm:inline">
                      {formatDate(issue.createdAt)}
                    </span>
                  </div>
                </Link>
                );
              })}
            </CollapsibleContent>
          </Collapsible>
        ))
      )}
      {showScrollBottom && (
        <button
          onClick={scrollToBottom}
          className="fixed bottom-6 right-6 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background shadow-md hover:bg-accent transition-colors"
          aria-label="Scroll to bottom"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
