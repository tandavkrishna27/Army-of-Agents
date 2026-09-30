import { useEffect, useMemo, useState, useRef, lazy, Suspense } from "react";
import { useParams, useNavigate, useLocation, Navigate, Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PROJECT_COLORS, isUuidLike } from "@armyofagents/shared";
import { projectsApi } from "../api/projects";
import type { ProjectAgentAssignment, ProjectBudget } from "../api/projects";
import { TaskSlideOver } from "../components/TaskSlideOver";
import { issuesApi } from "../api/issues";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ProjectSettings } from "../components/project/ProjectSettings";
import { InlineEditor } from "../components/InlineEditor";
import { StatusBadge } from "../components/StatusBadge";
import { IssuesList } from "../components/IssuesList";
import { GoalTree } from "../components/GoalTree";
import { PageSkeleton } from "../components/PageSkeleton";
import { projectRouteRef, cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Plus, Bot, X, DollarSign, AlertTriangle, MessageSquare, ClipboardPen, PenLine, Mic, Plug, ChevronDown, ChevronRight } from "lucide-react";
import { discussionsApi, type DiscussionListItem } from "../api/discussions";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ExecutionWorkspaceCloseDialog } from "../components/workspace/ExecutionWorkspaceCloseDialog";
import { EmptyState } from "../components/EmptyState";
import { ProjectEnvironmentSection } from "../components/ProjectEnvironmentSection";
import type { ExecutionWorkspace } from "@armyofagents/shared";

// Lazy-load GitCommandCentre so D3 (~150KB gzip) is code-split and only
// downloaded when a user opens a software_development project's Workspaces tab.
const GitCommandCentre = lazy(() =>
  import("../components/workspace/GitCommandCentre").then((m) => ({ default: m.GitCommandCentre })),
);

/* ── Top-level tab types ── */

type ProjectTab = "overview" | "list" | "goals" | "team" | "budget" | "discussions" | "workspaces" | "settings";

function resolveProjectTab(pathname: string, projectId: string): ProjectTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectsIdx = segments.indexOf("projects");
  if (projectsIdx === -1 || segments[projectsIdx + 1] !== projectId) return null;
  const tab = segments[projectsIdx + 2];
  if (tab === "overview") return "overview";
  if (tab === "issues") return "list";
  if (tab === "goals") return "goals";
  if (tab === "team") return "team";
  if (tab === "budget") return "budget";
  if (tab === "discussions") return "discussions";
  if (tab === "workspaces") return "workspaces";
  if (tab === "settings") return "settings";
  return null;
}

/* ── Overview tab content ── */

function OverviewContent({
  project,
  onUpdate,
}: {
  project: { description: string | null; functionType?: string | null };
  onUpdate: (data: Record<string, unknown>) => void;
}) {
  const [description, setDescription] = useState(project.description ?? "");

  useEffect(() => {
    setDescription(project.description ?? "");
  }, [project.description]);

  const functionLabel = project.functionType === "software_development"
    ? "Software department"
    : project.functionType
      ? `${project.functionType.replace(/_/g, " ")} department`
      : "Department";

  return (
    <div className="max-w-3xl space-y-4 pt-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          className="rounded-md border border-border/70 bg-card/60 px-2 py-1 capitalize"
          data-testid="project-function-type-badge"
        >
          {functionLabel}
        </span>
      </div>
      <div className="rounded-lg border border-border/70 bg-card/30 p-4">
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => {
            if (description !== (project.description ?? "")) {
              onUpdate({ description });
            }
          }}
          placeholder="Add a department description..."
          className="min-h-32 w-full resize-y bg-transparent text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
    </div>
  );
}

/* ── Color picker popover ── */

function ColorPicker({
  currentColor,
  onSelect,
}: {
  currentColor: string;
  onSelect: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="shrink-0 h-5 w-5 rounded-md cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-[box-shadow]"
        style={{ backgroundColor: currentColor }}
        aria-label="Change project color"
      />
      {open && (
        <div className="absolute top-full left-0 mt-2 p-2 bg-popover border border-border rounded-lg shadow-lg z-50 w-max">
          <div className="grid grid-cols-5 gap-1.5">
            {PROJECT_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => {
                  onSelect(color);
                  setOpen(false);
                }}
                className={`h-6 w-6 rounded-md cursor-pointer transition-[transform,box-shadow] duration-150 hover:scale-110 ${
                  color === currentColor
                    ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                    : "hover:ring-2 hover:ring-foreground/30"
                }`}
                style={{ backgroundColor: color }}
                aria-label={`Select color ${color}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── List (issues) tab content ── */

function ProjectIssuesList({
  projectId,
  companyId,
  onSelectIssue,
}: {
  projectId: string;
  companyId: string;
  onSelectIssue?: (issueIdentifier: string) => void;
}) {
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey={`aoa:project-view:${projectId}`}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
      onSelectIssue={onSelectIssue}
    />
  );
}

/* ── Goals tab content ── */

function ProjectGoals({ projectId, companyId }: { projectId: string; companyId: string }) {
  const { openNewGoal } = useDialog();

  const { data: goals, isLoading } = useQuery({
    queryKey: queryKeys.goals.listByProject(companyId, projectId),
    queryFn: () => goalsApi.list(companyId, projectId),
    enabled: !!companyId,
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading goals…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          {goals?.length ?? 0} {(goals?.length ?? 0) === 1 ? "goal" : "goals"}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => openNewGoal({ projectIds: [projectId] })}
        >
          <Plus className="h-3.5 w-3.5" />
          New Goal
        </Button>
      </div>
      <GoalTree goals={goals ?? []} goalLink={(g) => `/goals/${g.id}`} />
    </div>
  );
}

/* ── Team tab content ── */

function ProjectTeam({ projectId, companyId, projectType }: { projectId: string; companyId: string; projectType?: string }) {
  const queryClient = useQueryClient();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data: assignedAgents, isLoading } = useQuery({
    queryKey: queryKeys.projects.agents(projectId),
    queryFn: () => projectsApi.listAgents(projectId),
    enabled: !!projectId,
  });

  const { data: allAgents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const assignMutation = useMutation({
    mutationFn: (agentId: string) => projectsApi.assignAgent(projectId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.agents(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.budget(projectId) });
      setShowDropdown(false);
    },
  });

  const unassignMutation = useMutation({
    mutationFn: (agentId: string) => projectsApi.unassignAgent(projectId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.agents(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.budget(projectId) });
    },
  });

  useEffect(() => {
    if (!showDropdown) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showDropdown]);

  const assignedIds = new Set(assignedAgents?.map((a) => a.agentId) ?? []);
  const availableAgents = (allAgents ?? []).filter(
    (a) => !assignedIds.has(a.id) && a.status !== "terminated",
  );

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading team…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          {assignedAgents?.length ?? 0} agent{(assignedAgents?.length ?? 0) === 1 ? "" : "s"} assigned
        </h3>
        <div className="relative" ref={dropdownRef}>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => setShowDropdown(!showDropdown)}
          >
            <Plus className="h-3.5 w-3.5" />
            Assign Agent
          </Button>
          {showDropdown && (
            <div className="absolute right-0 top-full mt-1 w-56 bg-popover border border-border rounded-md shadow-lg z-50 overflow-hidden">
              {availableAgents.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">No agents available</p>
              ) : (
                availableAgents.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => assignMutation.mutate(agent.id)}
                    className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent/50 transition-colors text-left"
                  >
                    <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate">{agent.name}</span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">{agent.role}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {(assignedAgents?.length ?? 0) === 0 ? (
        <div className="border border-border rounded-md p-6 text-center">
          <Bot className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No agents assigned to this {projectType === "project" ? "project" : "department"} yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Assign agents to track their work and spending here.
          </p>
        </div>
      ) : (
        <div className="border border-border divide-y divide-border rounded-md overflow-hidden">
          {assignedAgents?.map((agent) => (
            <div
              key={agent.agentId}
              className="flex items-center gap-3 px-4 py-3 text-sm"
            >
              <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
              <Link
                to={`/agents/${agent.agentId}`}
                className="font-medium hover:underline no-underline text-inherit"
              >
                {agent.name}
              </Link>
              <span className="text-xs text-muted-foreground">{agent.role}</span>
              {agent.title && (
                <span className="text-xs text-muted-foreground">· {agent.title}</span>
              )}
              <StatusBadge status={agent.status} />
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto shrink-0"
                onClick={() => unassignMutation.mutate(agent.agentId)}
                title="Unassign agent"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Budget tab content ── */

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function ProjectBudgetTab({ projectId, companyId, projectType }: { projectId: string; companyId: string; projectType?: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.projects.budget(projectId),
    queryFn: () => projectsApi.budget(projectId),
    enabled: !!projectId,
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading budget…</p>;
  }

  if (!data || data.agents.length === 0) {
    return (
      <div className="border border-border rounded-md p-6 text-center">
        <DollarSign className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No spending data available.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Assign agents to this {projectType === "project" ? "project" : "department"} to track their budget usage.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">This Month</h3>
        <span className="text-sm font-semibold">{formatCents(data.totalSpendCents)} total</span>
      </div>

      <div className="border border-border divide-y divide-border rounded-md overflow-hidden">
        <div className="grid grid-cols-4 gap-2 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide bg-muted/30">
          <span>Agent</span>
          <span className="text-right">Budget</span>
          <span className="text-right">Spent</span>
          <span className="text-right">Usage</span>
        </div>
        {data.agents.map((agent) => {
          const usagePercent =
            agent.budgetMonthlyCents > 0
              ? Math.round((agent.spendCents / agent.budgetMonthlyCents) * 100)
              : null;
          const isOverBudget = usagePercent !== null && usagePercent >= 100;

          return (
            <div
              key={agent.agentId}
              className="grid grid-cols-4 gap-2 px-4 py-2.5 text-sm items-center"
            >
              <Link
                to={`/agents/${agent.agentId}`}
                className="font-medium truncate hover:underline no-underline text-inherit"
              >
                {agent.agentName}
              </Link>
              <span className="text-right text-muted-foreground">
                {agent.budgetMonthlyCents > 0 ? formatCents(agent.budgetMonthlyCents) : "—"}
              </span>
              <span className={`text-right ${isOverBudget ? "text-destructive font-medium" : ""}`}>
                {formatCents(agent.spendCents)}
              </span>
              <span className="text-right">
                {usagePercent !== null ? (
                  <span className={`inline-flex items-center gap-1 ${isOverBudget ? "text-destructive" : ""}`}>
                    {isOverBudget && <AlertTriangle className="h-3 w-3" />}
                    {usagePercent}%
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Workspaces tab content ── */

const STATUS_BADGE_CLASSES: Record<string, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  idle: "bg-muted text-muted-foreground",
  in_review: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  archived: "bg-muted text-muted-foreground",
  cleanup_failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - new Date(date).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo ago`;
}

function WorkspaceRow({
  workspace,
  companyPrefix,
  onArchive,
}: {
  workspace: ExecutionWorkspace;
  companyPrefix: string;
  onArchive?: (id: string) => void;
}) {
  const navigate = useNavigate();
  const displayName = workspace.branchName ?? workspace.name;
  const statusClass = STATUS_BADGE_CLASSES[workspace.status] ?? "bg-muted text-muted-foreground";
  const isIsolated = workspace.mode === "isolated_workspace";

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent/30 transition-colors cursor-pointer"
      data-testid={`workspace-row-${workspace.id}`}
      onClick={() => navigate(`/${companyPrefix}/workspaces/${workspace.id}`)}
    >
      <span className="font-mono text-xs font-medium truncate flex-1">{displayName}</span>
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize shrink-0",
          statusClass,
        )}
      >
        {workspace.status}
      </span>
      <span className="text-xs text-muted-foreground shrink-0">
        {formatRelativeTime(workspace.lastUsedAt)}
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
      {onArchive && workspace.status !== "archived" && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          data-testid={`archive-workspace-${workspace.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onArchive(workspace.id);
          }}
        >
          Archive
        </button>
      )}
    </div>
  );
}

function ProjectWorkspaces({
  projectId,
  companyId,
  companyPrefix,
}: {
  projectId: string;
  companyId: string;
  companyPrefix: string;
}) {
  const queryClient = useQueryClient();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);

  const { data: workspaces, isLoading } = useQuery({
    queryKey: queryKeys.executionWorkspaces.listForProject(companyId, projectId),
    queryFn: () => executionWorkspacesApi.list(companyId, { projectId }),
    enabled: !!companyId && !!projectId,
  });

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="workspaces-loading">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!workspaces || workspaces.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        message="No workspaces yet"
        description="Workspaces are automatically created when agents start working on tasks."
        entityColor="var(--entity-agent)"
      />
    );
  }

  const activeWorkspaces = workspaces.filter((w) => w.status !== "archived");
  const archivedWorkspaces = workspaces.filter((w) => w.status === "archived");

  return (
    <div className="space-y-4">
      {activeWorkspaces.length > 0 ? (
        <div className="border border-border divide-y divide-border rounded-md overflow-hidden">
          <div
            className="grid px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide bg-muted/30"
            style={{ gridTemplateColumns: "1fr auto auto auto auto" }}
          >
            <span>Name</span>
            <span>Status</span>
            <span>Last used</span>
            <span>Mode</span>
            <span />
          </div>
          {activeWorkspaces.map((ws) => (
            <WorkspaceRow
              key={ws.id}
              workspace={ws}
              companyPrefix={companyPrefix}
              onArchive={(id) => setArchiveTarget(id)}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">All workspaces are archived.</p>
      )}

      {archivedWorkspaces.length > 0 && (
        <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="archived-workspaces-trigger">
            {archivedOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Archived ({archivedWorkspaces.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 border border-border divide-y divide-border rounded-md overflow-hidden" data-testid="archived-workspaces-list">
              {archivedWorkspaces.map((ws) => (
                <WorkspaceRow key={ws.id} workspace={ws} companyPrefix={companyPrefix} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {archiveTarget && (
        <ExecutionWorkspaceCloseDialog
          workspaceId={archiveTarget}
          open={!!archiveTarget}
          onOpenChange={(open) => { if (!open) setArchiveTarget(null); }}
          onArchived={() => {
            queryClient.invalidateQueries({
              queryKey: queryKeys.executionWorkspaces.listForProject(companyId, projectId),
            });
            setArchiveTarget(null);
          }}
        />
      )}
    </div>
  );
}

/* ── Discussions tab content ── */

const SOURCE_BADGES: Record<string, { label: string; class: string; icon: typeof ClipboardPen }> = {
  paste: { label: "Paste", class: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300", icon: ClipboardPen },
  write: { label: "Write", class: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300", icon: PenLine },
  voice: { label: "Voice", class: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300", icon: Mic },
  mcp: { label: "MCP", class: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300", icon: Plug },
};

function ProjectDiscussions({
  projectId,
  companyId,
  projectType,
}: {
  projectId: string;
  companyId: string;
  projectType?: string;
}) {
  const { openDiscussionCapture } = useDialog();
  const scopeType = projectType === "project" ? "project" : "department";

  const { data, isLoading } = useQuery({
    queryKey: [...queryKeys.discussions.list(companyId), "scoped", projectId],
    queryFn: () =>
      discussionsApi.list(companyId, { scopeType, scopeId: projectId }),
    enabled: !!companyId,
  });

  const discussions = data?.discussions ?? [];

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading discussions…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          {discussions.length} {discussions.length === 1 ? "discussion" : "discussions"}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() =>
            openDiscussionCapture({ scopeType, scopeId: projectId })
          }
        >
          <Plus className="h-3.5 w-3.5" />
          New Discussion
        </Button>
      </div>

      {discussions.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          message={`No discussions for this ${projectType === "project" ? "project" : "department"} yet`}
          description="Start a discussion to capture and process raw content into structured tasks, decisions, and memory items."
          entityColor="var(--entity-brief)"
        />
      ) : (
        <div className="space-y-2">
          {discussions.map((discussion) => (
            <ProjectDiscussionRow key={discussion.id} discussion={discussion} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectDiscussionRow({ discussion }: { discussion: DiscussionListItem }) {
  const hasPending = discussion.pendingItemCount > 0;
  const source = discussion.lastEntryInputType
    ? SOURCE_BADGES[discussion.lastEntryInputType]
    : null;
  const SourceIcon = source?.icon ?? MessageSquare;

  return (
    <Link
      to={`/discussions/${discussion.id}`}
      className={cn(
        "flex items-center justify-between rounded-lg border p-4 transition-colors",
        hasPending
          ? "border-blue-300 bg-blue-50/60 hover:bg-blue-100/60 dark:border-blue-800 dark:bg-blue-950/30 dark:hover:bg-blue-950/50"
          : "border-border bg-card hover:bg-accent/50",
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <MessageSquare
          className={cn(
            "h-4 w-4 shrink-0",
            hasPending ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground",
          )}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium truncate">{discussion.title}</p>
            {hasPending && (
              <span className="inline-flex items-center rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-semibold text-white shrink-0">
                {discussion.pendingItemCount} pending
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {discussion.lastEntryAt && (
              <span className="text-xs text-muted-foreground">
                {new Date(discussion.lastEntryAt).toLocaleDateString()}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {discussion.entryCount} {discussion.entryCount === 1 ? "entry" : "entries"}
            </span>
            {source && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                  source.class,
                )}
              >
                <SourceIcon className="h-3 w-3" />
                {source.label}
              </span>
            )}
            {discussion.tags.length > 0 &&
              discussion.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
          </div>
        </div>
      </div>
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-medium shrink-0 capitalize",
          discussion.status === "archived"
            ? "bg-muted text-muted-foreground"
            : "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
        )}
      >
        {discussion.status}
      </span>
    </Link>
  );
}

/* ── Main project page ── */

export function ProjectDetail() {
  const { companyPrefix, projectId, filter } = useParams<{
    companyPrefix?: string;
    projectId: string;
    filter?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const routeProjectRef = projectId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchProject = routeProjectRef.length > 0 && (isUuidLike(routeProjectRef) || Boolean(lookupCompanyId));

  const activeTab = routeProjectRef ? resolveProjectTab(location.pathname, routeProjectRef) : null;
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);

  const { data: project, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: canFetchProject,
  });
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const projectLookupRef = project?.id ?? routeProjectRef;
  const resolvedCompanyId = project?.companyId ?? selectedCompanyId;
  const resolvedPrefix = companyPrefix ?? companies.find((c) => c.id === resolvedCompanyId)?.issuePrefix ?? "";

  useEffect(() => {
    if (!project?.companyId || project.companyId === selectedCompanyId) return;
    setSelectedCompanyId(project.companyId, { source: "route_sync" });
  }, [project?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
    }
  };

  const updateProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId),
    onSuccess: invalidateProject,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: project?.name ?? routeProjectRef ?? "Project" },
    ]);
  }, [setBreadcrumbs, project, routeProjectRef]);

  useEffect(() => {
    if (!project) return;
    if (routeProjectRef === canonicalProjectRef) return;
    if (activeTab === "list" && filter) {
      navigate(`/projects/${canonicalProjectRef}/issues/${filter}`, { replace: true });
      return;
    }
    const tabPaths: Record<ProjectTab, string> = {
      overview: "overview",
      list: "issues",
      goals: "goals",
      team: "team",
      budget: "budget",
      discussions: "discussions",
      workspaces: "workspaces",
      settings: "settings",
    };
    if (activeTab) {
      navigate(`/projects/${canonicalProjectRef}/${tabPaths[activeTab]}`, { replace: true });
      return;
    }
    navigate(`/projects/${canonicalProjectRef}`, { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, activeTab, filter, navigate]);

  // Redirect bare /projects/:id to /projects/:id/issues
  if (routeProjectRef && activeTab === null) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!project) return null;

  const handleTabChange = (tab: ProjectTab) => {
    if (tab !== "list") setSelectedIssueId(null);
    const tabPaths: Record<ProjectTab, string> = {
      overview: "overview",
      list: "issues",
      goals: "goals",
      team: "team",
      budget: "budget",
      discussions: "discussions",
      workspaces: "workspaces",
      settings: "settings",
    };
    navigate(`/projects/${canonicalProjectRef}/${tabPaths[tab]}`);
  };

  const tabContent = (
    <>
      {/* Top-level project tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "overview"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("overview")}
        >
          Overview
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "list"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("list")}
        >
          Board
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "goals"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("goals")}
        >
          Goals
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "team"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("team")}
        >
          Team
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "budget"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("budget")}
        >
          Budget
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "discussions"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("discussions")}
        >
          Discussions
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "workspaces"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("workspaces")}
        >
          Workspaces
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "settings"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("settings")}
        >
          Settings
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "overview" && (
        <OverviewContent
          project={project}
          onUpdate={(data) => updateProject.mutate(data)}
        />
      )}

      {activeTab === "list" && project?.id && resolvedCompanyId && (
        <ProjectIssuesList
          projectId={project.id}
          companyId={resolvedCompanyId}
          onSelectIssue={setSelectedIssueId}
        />
      )}

      {activeTab === "goals" && project?.id && resolvedCompanyId && (
        <ProjectGoals projectId={project.id} companyId={resolvedCompanyId} />
      )}

      {activeTab === "team" && project?.id && resolvedCompanyId && (
        <ProjectTeam projectId={project.id} companyId={resolvedCompanyId} projectType={project.type} />
      )}

      {activeTab === "budget" && project?.id && resolvedCompanyId && (
        <ProjectBudgetTab projectId={project.id} companyId={resolvedCompanyId} projectType={project.type} />
      )}

      {activeTab === "discussions" && project?.id && resolvedCompanyId && (
        <ProjectDiscussions projectId={project.id} companyId={resolvedCompanyId} projectType={project.type} />
      )}

      {activeTab === "workspaces" && project?.id && resolvedCompanyId && (
        project.functionType === "software_development" ? (
          // Git Command Centre — only for software projects; D3 is lazy-loaded
          <Suspense fallback={<div className="flex-1 animate-pulse bg-muted/20 rounded m-4" style={{ minHeight: 200 }} />}>
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              <GitCommandCentre
                projectId={project.id}
                companyId={resolvedCompanyId}
                isWorkspacesTabActive={activeTab === "workspaces"}
                onSelectIssue={(id) => setSelectedIssueId(id)}
              />
            </div>
          </Suspense>
        ) : (
          // For non-software projects, keep the existing workspace list
          <ProjectWorkspaces projectId={project.id} companyId={resolvedCompanyId} companyPrefix={resolvedPrefix} />
        )
      )}

      {activeTab === "settings" && (
        <ProjectSettings
          project={project}
          onUpdate={(data) => updateProject.mutate(data)}
          environmentContent={project.id ? <ProjectEnvironmentSection projectId={project.id} /> : undefined}
        />
      )}
    </>
  );

  const headerContent = (
    <div className="flex items-start gap-3">
      <div className="h-7 flex items-center">
        <ColorPicker
          currentColor={project.color ?? "#6366f1"}
          onSelect={(color) => updateProject.mutate({ color })}
        />
      </div>
      <InlineEditor
        value={project.name}
        onSave={(name) => updateProject.mutate({ name })}
        as="h1"
        className="text-xl font-bold"
      />
    </div>
  );

  return (
    <div
      className={
        // The Map (Git Command Centre) needs to fill the viewport without the
        // page scrolling, so the root becomes a bounded flex column ONLY for the
        // workspaces tab; its flex-1 canvas wrapper then shrinks to fit. Other
        // tabs keep the normal block + scroll layout.
        activeTab === "workspaces"
          ? "flex flex-col gap-6 h-full min-h-0"
          : "space-y-6"
      }
    >
      {headerContent}
      {tabContent}
      <TaskSlideOver
        issueId={selectedIssueId}
        open={!!selectedIssueId}
        onClose={() => setSelectedIssueId(null)}
      />
    </div>
  );
}
