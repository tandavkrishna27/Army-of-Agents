import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi, type IssueContextBundle } from "../api/issues";
import { feedbackApi } from "../api/feedback";
import { contextPackagingApi } from "../api/context-packaging";
import { artifactsApi } from "../api/artifacts";
import { outputDetectionApi, type DetectedOutputForUI } from "../api/output-detection";
import { dependenciesApi } from "../api/dependencies";
import { activityApi } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { useTeamAccess } from "../hooks/useTeamAccess";
import { relativeTime, cn, formatTokens } from "../lib/utils";
import { InlineEditor } from "./InlineEditor";
import { CommentThread } from "./CommentThread";
import { IssueDocumentsSection } from "./IssueDocumentsSection";
import { IssueProperties } from "./IssueProperties";
import { LiveRunWidget } from "./LiveRunWidget";
import { WorkspaceTimeline } from "./workspace/WorkspaceTimeline";
import { IssueWorkspaceCard } from "./IssueWorkspaceCard";
import { ImageGalleryModal } from "./ImageGalleryModal";
import {
  TASK_DETAIL_TAB_ORDER,
  getDefaultTaskDetailTab,
  getTaskDetailTabLabel,
  type TaskDetailTab,
} from "./task-detail/taskDetailViewModel";
import type { MentionOption } from "./MarkdownEditor";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { StatusBadge } from "./StatusBadge";
import { Identity } from "./Identity";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  EyeOff,
  GitBranch,
  Link2,
  ListTree,
  Loader2,
  MessageSquare,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  FileBox,
  FileCode,
  GitPullRequestArrow,
  MonitorPlay,
  FilePlus2,
  Plus,
  Search,
  Trash2,
  X,
  Check,
  XCircle,
  ExternalLink,
  Copy,
  Sparkles,
  ClipboardList,
} from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import type { ActivityEvent } from "@armyofagents/shared";
import type { Agent, IssueAttachment, ArtifactWithVersions, CreateArtifactVersion } from "@armyofagents/shared";

/* ── Helpers (shared with IssueDetail) ── */

type CommentReassignment = {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  "issue.created": "created the task",
  "issue.updated": "updated the task",
  "issue.checked_out": "checked out the task",
  "issue.released": "released the task",
  "issue.comment_added": "added a comment",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.deleted": "deleted the task",
  "issue.read_marked": "marked the task as read",
  "issue.approval_linked": "linked approval to the task",
  "issue.approval_unlinked": "unlinked approval from the task",
  "issue.checkout_lock_adopted": "adopted checkout lock on the task",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function formatAction(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (details.status !== undefined) {
      const from = previous.status;
      parts.push(
        from
          ? `changed the status from ${humanizeValue(from)} to ${humanizeValue(details.status)}`
          : `changed the status to ${humanizeValue(details.status)}`
      );
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      parts.push(
        from
          ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
          : `changed the priority to ${humanizeValue(details.priority)}`
      );
    }
    if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
      parts.push(
        details.assigneeAgentId || details.assigneeUserId
          ? "assigned the task"
          : "unassigned the task",
      );
    }
    if (details.title !== undefined) parts.push("updated the title");
    if (details.description !== undefined) parts.push("updated the description");

    if (parts.length > 0) return parts.join(", ");
  }
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ").replace(/\bissue\b/g, "task");
}

function ActorIdentity({ evt, agentMap }: { evt: ActivityEvent; agentMap: Map<string, Agent> }) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") return <Identity name="Board" size="sm" />;
  return <Identity name={id || "Unknown"} size="sm" />;
}

/* ── Artifact helpers ── */

const SOURCE_BADGE_COLORS: Record<string, string> = {
  agent: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  founder: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  mcp: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  teammate: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  external: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400",
};

function SourceBadge({ source }: { source: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        SOURCE_BADGE_COLORS[source] ?? SOURCE_BADGE_COLORS.external,
      )}
    >
      {source}
    </span>
  );
}

/* ── Scope handoff helpers ── */

function scopeHandoffMetaText(item: IssueContextBundle["items"][number]): string | null {
  const metadata = asRecord(item.metadata);
  if (!metadata) return null;
  const url = typeof metadata.url === "string" ? metadata.url : null;
  const excerpt = typeof metadata.excerpt === "string" ? metadata.excerpt : null;
  const body = typeof metadata.body === "string" ? metadata.body : null;
  const artifactType = typeof metadata.artifactType === "string" ? metadata.artifactType : null;
  const contentType = typeof metadata.contentType === "string" ? metadata.contentType : null;
  return url ?? excerpt ?? body ?? artifactType ?? contentType;
}

function scopeHandoffTypeLabel(type: string) {
  if (type === "discussion_entry") return "Source";
  if (type === "scope_item") return "Scope";
  return type.replace("_", " ");
}

function scopeHandoffItemIncluded(item: IssueContextBundle["items"][number]) {
  return asRecord(item.metadata)?.includeInAgentContext !== false;
}

// Self-contained openability check (restored from pre-merge TaskSlideOver,
// commit 851b6e62c). URL items need a url in metadata; other openable types
// need a sourceId. Used as the default when no parent canOpenItem is provided.
function canOpenScopeHandoffItem(item: IssueContextBundle["items"][number]): boolean {
  if (item.itemType === "url") {
    return typeof asRecord(item.metadata)?.url === "string";
  }
  return (
    ["artifact", "asset", "discussion_entry", "scope_item"].includes(item.itemType) &&
    Boolean(item.sourceId)
  );
}

function ScopeHandoffSection({
  bundles,
  onOpenItem,
  canOpenItem,
  onSetIncluded,
  isUpdatingItemId,
  pushToast,
}: {
  bundles: IssueContextBundle[];
  onOpenItem?: (item: IssueContextBundle["items"][number]) => void;
  canOpenItem?: (item: IssueContextBundle["items"][number]) => boolean;
  onSetIncluded?: (item: IssueContextBundle["items"][number], included: boolean) => void;
  isUpdatingItemId?: string | null;
  pushToast?: ReturnType<typeof useToast>["pushToast"];
}) {
  // Self-contained open fallback (restored from pre-merge TaskSlideOver,
  // commit 851b6e62c): used on every standalone surface (Tasks page, Project /
  // Crew board, Commander viewer) where no parent passes onOpenScopeHandoffItem.
  const isItemOpenable = canOpenItem ?? canOpenScopeHandoffItem;
  const openItem = (item: IssueContextBundle["items"][number]) => {
    if (onOpenItem) {
      onOpenItem(item);
      return;
    }
    if (!isItemOpenable(item)) return;
    const url = asRecord(item.metadata)?.url;
    if (typeof url === "string") {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    pushToast?.({
      title: "Open from discussion",
      body: item.label || item.itemType.replace(/_/g, " "),
      tone: "info",
    });
  };
  const scopeBundles = bundles.filter((bundle) => bundle.sourceKind === "discussion_scope");
  if (scopeBundles.length === 0) return null;
  const itemCount = scopeBundles.reduce((count, bundle) => count + bundle.items.length, 0);

  return (
    <section className="rounded-lg border border-border bg-card/35 p-3" data-testid="task-scope-handoff">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <h3 className="text-sm font-medium text-foreground">Scope handoff</h3>
        </div>
        <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {itemCount} {itemCount === 1 ? "ref" : "refs"}
        </span>
        <p className="basis-full text-[11px] leading-snug text-muted-foreground">
          Included refs are passed to agents.
        </p>
      </div>
      <div className="space-y-3">
        {scopeBundles.map((bundle) => (
          <div key={bundle.id} className="space-y-2">
            {bundle.brief && (
              <p className="text-xs leading-relaxed text-muted-foreground">{bundle.brief}</p>
            )}
            {bundle.items.length > 0 && (
              <div className="space-y-1.5">
                {bundle.items.map((item) => {
                  const meta = scopeHandoffMetaText(item);
                  const included = scopeHandoffItemIncluded(item);
                  const label = item.label || item.itemType.replace("_", " ");
                  // Render the Open button for every openable item regardless of
                  // whether a parent callback exists — the standalone slide-over
                  // falls back to the self-contained open above.
                  const isOpenable = isItemOpenable(item);
                  const className =
                    "flex w-full min-w-0 flex-col gap-2 rounded-md border border-border/70 bg-background px-2.5 py-2 text-left text-xs sm:flex-row sm:items-center";
                  return (
                    <div
                      key={item.id}
                      className={className}
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-2">
                        <span className="mt-0.5 shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                          {scopeHandoffTypeLabel(item.itemType)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">
                            {label}
                          </span>
                          {meta && (
                            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                              {meta}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:ml-auto sm:justify-end">
                        <span
                          className={cn(
                            "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                            included
                              ? "border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-400"
                              : "border-muted-foreground/20 bg-muted/50 text-muted-foreground",
                          )}
                        >
                          {included ? "In context" : "Excluded"}
                        </span>
                        {isOpenable && (
                          <button
                            type="button"
                            className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                            aria-label={`Open handoff item: ${label}`}
                            onClick={() => openItem(item)}
                          >
                            Open
                          </button>
                        )}
                        {onSetIncluded && (
                          <button
                            type="button"
                            className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                            aria-label={`${included ? "Exclude" : "Include"} ${label} ${included ? "from" : "in"} agent context`}
                            disabled={isUpdatingItemId === item.id}
                            onClick={() => onSetIncluded(item, !included)}
                          >
                            {included ? "Exclude" : "Include"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Props ── */

interface TaskDetailProps {
  issueId: string | null;
  active: boolean;
  initialTab?: TaskDetailTab;
  initialMode?: "task" | "workspace";
  workspaceAnchorId?: string;
  onDismiss?: () => void;
  onOpenScopeHandoffItem?: (item: IssueContextBundle["items"][number]) => void;
  panelWide?: boolean;
  onTogglePanelWide?: () => void;
}

/* ── Component ── */

export function TaskDetail({
  issueId,
  active,
  initialTab = getDefaultTaskDetailTab(),
  initialMode = "task",
  workspaceAnchorId,
  onDismiss,
  onOpenScopeHandoffItem,
  panelWide,
  onTogglePanelWide,
}: TaskDetailProps) {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<TaskDetailTab>(initialTab);
  const [secondaryOpen, setSecondaryOpen] = useState({
    approvals: false,
    cost: false,
  });
  const [depPickerOpen, setDepPickerOpen] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [requestChangesOpen, setRequestChangesOpen] = useState(false);
  const [requestChangesFeedback, setRequestChangesFeedback] = useState("");
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryInitialIndex, setGalleryInitialIndex] = useState(0);
  const [showAddVersion, setShowAddVersion] = useState(false);
  const [versionMode, setVersionMode] = useState<"text" | "file">("text");
  const [showAllVersions, setShowAllVersions] = useState(false);
  const [llmMenuOpen, setLlmMenuOpen] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Two-mode sidebar state
  const [sidebarMode, setSidebarMode] = useState<"task" | "workspace">(initialMode);

  /* ── Data fetching ── */

  const { data: issue, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId && active,
    refetchInterval: 5000,
  });

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId && active,
    refetchInterval: 5000,
  });

  const { data: feedbackVotes, refetch: refetchFeedbackVotes } = useQuery({
    queryKey: ["feedback-votes", issueId],
    queryFn: () => feedbackApi.listVotes(issueId!),
    enabled: !!issueId && active,
  });

  const votesByCommentId = useMemo(() => {
    const map = new Map<string, NonNullable<typeof feedbackVotes>[number]>();
    for (const v of feedbackVotes ?? []) {
      if (v.targetType === "issue_comment") map.set(v.targetId, v);
    }
    return map;
  }, [feedbackVotes]);

  const { data: activity } = useQuery({
    queryKey: queryKeys.issues.activity(issueId!),
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!issueId && active,
    refetchInterval: 5000,
  });

  const { data: linkedRuns } = useQuery({
    queryKey: queryKeys.issues.runs(issueId!),
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!issueId && active,
    refetchInterval: 5000,
  });

  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.issues.approvals(issueId!),
    queryFn: () => issuesApi.listApprovals(issueId!),
    enabled: !!issueId && active,
  });

  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId!),
    queryFn: () => issuesApi.listAttachments(issueId!),
    enabled: !!issueId && active,
  });

  const imageAttachments = useMemo(
    () => (attachments ?? []).filter((a) => a.contentType?.startsWith("image/")),
    [attachments],
  );

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId!),
    enabled: !!issueId && active,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId!),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId!),
    enabled: !!issueId && active,
    refetchInterval: 3000,
  });

  const { data: deps } = useQuery({
    queryKey: queryKeys.issues.dependencies(issueId!),
    queryFn: () => dependenciesApi.list(selectedCompanyId!, issueId!),
    enabled: !!issueId && !!selectedCompanyId && active,
  });

  // Artifact linked to this task
  const { data: artifact } = useQuery({
    queryKey: queryKeys.artifacts.byIssue(issueId!),
    queryFn: () => artifactsApi.getByIssueId(issueId!),
    enabled: !!issueId && active,
  });

  // Scope handoff context bundles (discussion-created tasks)
  const { data: contextBundles = [] } = useQuery({
    queryKey: ["issues", "contextBundles", issueId],
    queryFn: () => issuesApi.listContextBundles(issueId!),
    enabled: !!issueId && active,
  });

  // Detected outputs from agent runs.
  const { data: detectedOutputs } = useQuery({
    queryKey: queryKeys.detectedOutputs.byIssue(issueId!),
    queryFn: () => outputDetectionApi.listForIssue(issueId!),
    enabled: !!issueId && active,
  });

  // Execution workspace linked to this task (if any)
  const { data: workspace } = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(issue?.executionWorkspaceId ?? ""),
    queryFn: () => executionWorkspacesApi.get(issue!.executionWorkspaceId!),
    enabled: !!issue?.executionWorkspaceId && active,
  });

  const pendingOutputs = useMemo(
    () => (detectedOutputs ?? []).filter((o) => o.status === "pending"),
    [detectedOutputs],
  );

  const hasLiveRuns = (liveRuns ?? []).length > 0 || !!activeRun;

  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>();
    for (const r of liveRuns ?? []) liveIds.add(r.id);
    if (activeRun) liveIds.add(activeRun.id);
    if (liveIds.size === 0) return linkedRuns ?? [];
    return (linkedRuns ?? []).filter((r) => !liveIds.has(r.runId));
  }, [linkedRuns, liveRuns, activeRun]);

  const { data: allIssues } = useQuery({
    // Distinct cache key from the org-default board list (which shares
    // queryKeys.issues.list) so the 'all' result never poisons the main
    // Tasks board's cache and vice versa.
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "scope-all"],
    // Dependency picker: a task's dependencies can be crew tasks, which the
    // 'org' default would hide — pass 'all' so the graph stays complete.
    queryFn: () => issuesApi.list(selectedCompanyId!, { taskScope: "all" }),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const { permissions } = useTeamAccess(selectedCompanyId);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        name: agent.name,
        kind: "agent",
      });
    }
    for (const project of orderedProjects) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    return options;
  }, [agents, orderedProjects]);

  const { data: childIssuesData } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "children", issue?.id],
    // Children of a task can be crew subtasks; the 'org' default would hide
    // them, so request 'all' to keep the slide-over's child list complete.
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, { parentId: issue!.id, taskScope: "all" }),
    enabled: !!selectedCompanyId && !!issue?.id,
  });

  const childIssues = useMemo(() => {
    if (!childIssuesData) return [];
    return [...childIssuesData].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [childIssuesData]);

  const commentReassignOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; searchText?: string }> = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    if (currentUserId) {
      const label = currentUserId === "local-board" ? "Board" : "Me (Board)";
      options.push({ id: `user:${currentUserId}`, label });
    }
    return permissions.canAssignTasks ? options : [];
  }, [agents, currentUserId, permissions.canAssignTasks]);

  const currentAssigneeValue = useMemo(() => {
    if (issue?.assigneeAgentId) return `agent:${issue.assigneeAgentId}`;
    if (issue?.assigneeUserId) return `user:${issue.assigneeUserId}`;
    return "";
  }, [issue?.assigneeAgentId, issue?.assigneeUserId]);

  const commentsWithRunMeta = useMemo(() => {
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null }>();
    const agentIdByRunId = new Map<string, string>();
    for (const run of linkedRuns ?? []) {
      agentIdByRunId.set(run.runId, run.agentId);
    }
    for (const evt of activity ?? []) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
      });
    }
    return (comments ?? []).map((comment) => {
      const meta = runMetaByCommentId.get(comment.id);
      return meta ? { ...comment, ...meta } : comment;
    });
  }, [activity, comments, linkedRuns]);
  const latestComment =
    commentsWithRunMeta.find(
      (comment) =>
        comment.presentation?.title !== "Run summary" &&
        !comment.body.includes("**Run Summary**"),
    ) ?? commentsWithRunMeta[0];

  const issueCostSummary = useMemo(() => {
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    let hasCost = false;
    let hasTokens = false;

    for (const run of linkedRuns ?? []) {
      const usage = asRecord(run.usageJson);
      const result = asRecord(run.resultJson);
      const runInput = usageNumber(usage, "inputTokens", "input_tokens");
      const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
      const runCached = usageNumber(
        usage,
        "cachedInputTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
      );
      const runCost =
        usageNumber(usage, "costUsd", "cost_usd", "total_cost_usd") ||
        usageNumber(result, "total_cost_usd", "cost_usd", "costUsd");
      if (runCost > 0) hasCost = true;
      if (runInput + runOutput + runCached > 0) hasTokens = true;
      input += runInput;
      output += runOutput;
      cached += runCached;
      cost += runCost;
    }

    return {
      input,
      output,
      cached,
      cost,
      totalTokens: input + output,
      hasCost,
      hasTokens,
    };
  }, [linkedRuns]);

  /* ── Context packaging ── */

  const fetchAndCopyContext = async (openUrl?: string) => {
    if (!selectedCompanyId || !issueId) return;
    setContextLoading(true);
    try {
      const result = await contextPackagingApi.getContextPackage(selectedCompanyId, issueId);
      await navigator.clipboard.writeText(result.markdown);
      const tokenWarning = result.tokenEstimate > 8000
        ? ` (warning: ~${result.tokenEstimate.toLocaleString()} tokens)`
        : "";
      pushToast({
        title: "Context copied to clipboard" + tokenWarning,
        tone: "success",
      });
      if (openUrl) {
        window.open(openUrl, "_blank", "noopener");
      }
    } catch {
      pushToast({ title: "Failed to copy context", tone: "error" });
    } finally {
      setContextLoading(false);
      setLlmMenuOpen(false);
    }
  };

  /* ── Mutations ── */

  const invalidateIssue = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.dependencies(issueId!) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
    }
  };

  const updateIssue = useMutation({
    mutationFn: (data: Record<string, unknown>) => issuesApi.update(issueId!, data),
    onSuccess: (updated) => {
      invalidateIssue();
      const issueRef = updated.identifier ?? `Task ${updated.id.slice(0, 8)}`;
      pushToast({
        dedupeKey: `activity:issue.updated:${updated.id}`,
        title: `${issueRef} updated`,
        body: truncate(updated.title, 96),
        tone: "success",
        action: { label: `View ${issueRef}`, href: `/issues/${updated.identifier ?? updated.id}` },
      });
    },
    onError: (err) => {
      pushToast({
        title: "Task update failed",
        body: err instanceof Error ? err.message : "The task could not be updated.",
        tone: "warn",
      });
    },
  });

  const requestChanges = useMutation({
    mutationFn: (feedback: string) => issuesApi.update(issueId!, {
      status: "in_progress",
      comment: feedback.trim(),
    }),
    onSuccess: (updated) => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
      setRequestChangesOpen(false);
      setRequestChangesFeedback("");
      const issueRef = updated.identifier ?? `Task ${updated.id.slice(0, 8)}`;
      pushToast({
        dedupeKey: `activity:issue.request_changes:${updated.id}`,
        title: `Changes requested on ${issueRef}`,
        body: "The task is back in progress and the assignee has been notified.",
        tone: "success",
        action: { label: `View ${issueRef}`, href: `/issues/${updated.identifier ?? updated.id}` },
      });
    },
    onError: (err) => {
      pushToast({
        title: "Could not request changes",
        body: err instanceof Error ? err.message : "The review feedback could not be sent.",
        tone: "warn",
      });
    },
  });

  const addComment = useMutation({
    mutationFn: ({ body, reopen, interrupt, clientSubmissionId }: { body: string; reopen?: boolean; interrupt?: boolean; clientSubmissionId?: string }) =>
      issuesApi.addComment(issueId!, body, reopen, interrupt, undefined, clientSubmissionId),
    onSuccess: (comment) => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
      const issueRef = issue?.identifier ?? (issueId ? `Task ${issueId.slice(0, 8)}` : "Task");
      pushToast({
        dedupeKey: `activity:issue.comment_added:${issueId}:${comment.id}`,
        title: `Comment posted on ${issueRef}`,
        body: issue?.title ? truncate(issue.title, 96) : undefined,
        tone: "success",
        action: issueId ? { label: `View ${issueRef}`, href: `/issues/${issue?.identifier ?? issueId}` } : undefined,
      });
    },
  });

  const addCommentAndReassign = useMutation({
    mutationFn: ({
      body,
      reopen,
      reassignment,
      clientSubmissionId,
    }: {
      body: string;
      reopen?: boolean;
      reassignment: CommentReassignment;
      clientSubmissionId?: string;
    }) =>
      issuesApi.update(issueId!, {
        comment: body,
        assigneeAgentId: reassignment.assigneeAgentId,
        assigneeUserId: reassignment.assigneeUserId,
        ...(reopen ? { status: "todo" } : {}),
        // Round-10 #2: thread the submission key so a retry of the combined
        // comment+reassign PATCH replays the comment (server dedup) instead of
        // posting a duplicate + re-firing wakeups.
        ...(clientSubmissionId ? { clientSubmissionId } : {}),
      }),
    onSuccess: (updated) => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
      const issueRef = updated.identifier ?? (issueId ? `Task ${issueId.slice(0, 8)}` : "Task");
      pushToast({
        dedupeKey: `activity:issue.reassigned:${updated.id}`,
        title: `${issueRef} reassigned`,
        body: issue?.title ? truncate(issue.title, 96) : undefined,
        tone: "success",
        action: issueId ? { label: `View ${issueRef}`, href: `/issues/${issue?.identifier ?? issueId}` } : undefined,
      });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return issuesApi.uploadAttachment(selectedCompanyId, issueId!, file);
    },
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) => issuesApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const addDependency = useMutation({
    mutationFn: (dependencyIssueId: string) =>
      dependenciesApi.add(selectedCompanyId!, issueId!, dependencyIssueId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.dependencies(issueId!) });
      invalidateIssue();
      setDepPickerOpen(false);
      setDepSearch("");
    },
  });

  const removeDependency = useMutation({
    mutationFn: (dependencyIssueId: string) =>
      dependenciesApi.remove(selectedCompanyId!, issueId!, dependencyIssueId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.dependencies(issueId!) });
      invalidateIssue();
    },
  });

  const addVersion = useMutation({
    mutationFn: (data: { artifactId: string; payload: CreateArtifactVersion }) =>
      artifactsApi.addVersion(data.artifactId, data.payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.byIssue(issueId!) });
      setShowAddVersion(false);
    },
  });

  // Detected output confirm/dismiss mutations.
  const confirmOutput = useMutation({
    mutationFn: (data: {
      runId: string;
      index: number;
      payload: { artifactId?: string; title?: string; type?: string; changelog?: string | null };
    }) => outputDetectionApi.confirm(data.runId, data.index, data.payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.detectedOutputs.byIssue(issueId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.byIssue(issueId!) });
      pushToast({ title: "Output confirmed as artifact" });
    },
  });

  const dismissOutput = useMutation({
    mutationFn: (data: { runId: string; index: number }) =>
      outputDetectionApi.dismiss(data.runId, data.index),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.detectedOutputs.byIssue(issueId!) });
    },
  });

  const setScopeHandoffIncluded = useMutation({
    mutationFn: ({ itemId, included }: { itemId: string; included: boolean }) =>
      issuesApi.updateContextBundleItemIncluded(issueId!, itemId, included),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issues", "contextBundles", issueId] });
    },
    onError: () => {
      // Server rejected the include/exclude change — refetch to revert any
      // optimistic toggle state and surface the failure (context-leak risk).
      queryClient.invalidateQueries({ queryKey: ["issues", "contextBundles", issueId] });
      pushToast({ title: "Failed to update context item", tone: "warn" });
    },
  });


  /* ── Derived data ── */

  const upstreamDeps = deps?.upstream ?? [];
  const downstreamDeps = deps?.downstream ?? [];
  const hasUnmetDeps = upstreamDeps.some((d) => d.status !== "done");

  const depPickerCandidates = useMemo(() => {
    if (!allIssues || !issue) return [];
    const existingDepIds = new Set([
      issue.id,
      ...upstreamDeps.map((d) => d.dependencyIssueId!),
      ...downstreamDeps.map((d) => d.dependentIssueId!),
    ]);
    return allIssues
      .filter((i) => !existingDepIds.has(i.id) && i.status !== "cancelled")
      .filter((i) =>
        depSearch
          ? i.title.toLowerCase().includes(depSearch.toLowerCase()) ||
            (i.identifier ?? "").toLowerCase().includes(depSearch.toLowerCase())
          : true,
      )
      .slice(0, 20);
  }, [allIssues, issue, upstreamDeps, downstreamDeps, depSearch]);

  // Input artifacts from upstream dependency tasks (Decision #71)
  const depArtifactQueries = useQueries({
    queries: upstreamDeps.map((dep) => ({
      queryKey: queryKeys.artifacts.byIssue(dep.dependencyIssueId!),
      queryFn: () => artifactsApi.getByIssueId(dep.dependencyIssueId!),
      enabled: !!dep.dependencyIssueId && detailTab === "work",
    })),
  });

  // Deduplicate input artifacts by artifact ID
  const inputArtifacts = useMemo(() => {
    const seen = new Set<string>();
    const results: Array<{ dep: (typeof upstreamDeps)[number]; artifact: ArtifactWithVersions }> = [];
    depArtifactQueries.forEach((q, i) => {
      const a = q.data;
      if (a && !seen.has(a.id)) {
        seen.add(a.id);
        results.push({ dep: upstreamDeps[i], artifact: a });
      }
    });
    return results;
  }, [depArtifactQueries, upstreamDeps]);


  /* ── Side effects ── */

  // Reset tab and mode when issue changes
  useEffect(() => {
    if (issueId) {
      setDetailTab(initialTab);
      setSecondaryOpen({ approvals: false, cost: false });
      setShowAddVersion(false);
      setShowAllVersions(false);
      setSidebarMode(initialMode);
      setGalleryOpen(false);
      setGalleryInitialIndex(0);
    }
  }, [initialMode, initialTab, issueId]);

  /* ── Handlers ── */

  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    await uploadAttachment.mutateAsync(file);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const isImageAttachment = (attachment: IssueAttachment) => attachment.contentType.startsWith("image/");
  const isCommentsTab = detailTab === "comments";

  /* ── Render ── */

  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden" data-testid="task-detail-panel">
        {/* Mode 2: Workspace Chat */}
        {sidebarMode === "workspace" && issue && (
          <>
            {/* Workspace breadcrumb header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
              <button
                type="button"
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setSidebarMode("task")}
                data-testid="workspace-breadcrumb-back"
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="font-mono">{issue.identifier ?? issue.id.slice(0, 8)}</span>
              </button>
              <span className="text-muted-foreground">/</span>
              <span className="text-sm truncate text-foreground">
                {workspace?.branchName ?? workspace?.name ?? "Workspace"}
              </span>
              <div className="ml-auto flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  data-testid="open-workspace-button"
                  onClick={() => {
                    onDismiss?.();
                    navigate(`/${selectedCompany?.issuePrefix ?? ''}/workspaces/${workspace!.id}`);
                  }}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open Workspace
                </Button>
                <Button variant="ghost" size="icon-xs" onClick={() => onDismiss?.()} aria-label="Close workspace view">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Shared workspace timeline + input */}
            <WorkspaceTimeline
              issueId={issueId!}
              compact
              anchorId={workspaceAnchorId}
              className="flex-1 min-h-0"
            />
          </>
        )}

        {/* Mode 1: Task Properties (default) */}
        {sidebarMode === "task" && (
          <>
        {/* Custom header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {issue && (
              <>
                <StatusIcon
                  status={issue.status}
                  onChange={(status) => updateIssue.mutate({ status })}
                />
                <PriorityIcon
                  priority={issue.priority}
                  onChange={(priority) => updateIssue.mutate({ priority })}
                />
                <span className="text-sm font-mono text-muted-foreground shrink-0">
                  {issue.identifier ?? issue.id.slice(0, 8)}
                </span>
                <span
                  className="hidden text-xs text-muted-foreground/80 sm:inline"
                  data-testid="task-header-updated-at"
                  title={`Last updated ${new Date(issue.updatedAt).toLocaleString()}`}
                >
                  Updated {relativeTime(issue.updatedAt)}
                </span>
                {hasLiveRuns && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 shrink-0">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400" />
                    </span>
                    Live
                  </span>
                )}
                {issue.workMode === "planning" && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400 shrink-0 hover:bg-amber-500/20 transition-colors"
                    onClick={() => updateIssue.mutate({ workMode: "standard" })}
                    title="Switch to Standard mode"
                  >
                    <ClipboardList className="h-2.5 w-2.5" />
                    Planning
                  </button>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {issue && (
              <>
                {onTogglePanelWide && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0"
                    title={panelWide ? "Collapse task panel" : "Expand task panel"}
                    aria-label={panelWide ? "Collapse task panel" : "Expand task panel"}
                    onClick={onTogglePanelWide}
                  >
                    {panelWide ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </Button>
                )}
                <Popover open={llmMenuOpen} onOpenChange={setLlmMenuOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0"
                      title="Open in LLM"
                      aria-label="Open in LLM"
                      disabled={contextLoading}
                    >
                      <Sparkles className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-52 p-1" align="end">
                    <button
                      className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                      onClick={() => fetchAndCopyContext()}
                      disabled={contextLoading}
                    >
                      <Copy className="h-3 w-3" />
                      Copy context to clipboard
                    </button>
                    <button
                      className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                      onClick={() => fetchAndCopyContext("https://claude.ai/new")}
                      disabled={contextLoading}
                    >
                      <ExternalLink className="h-3 w-3" />
                      Open in Claude
                    </button>
                    <button
                      className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                      onClick={() => fetchAndCopyContext("https://chatgpt.com")}
                      disabled={contextLoading}
                    >
                      <ExternalLink className="h-3 w-3" />
                      Open in ChatGPT
                    </button>
                  </PopoverContent>
                </Popover>
                <Popover open={moreOpen} onOpenChange={setMoreOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon-xs" className="shrink-0" aria-label="More task actions">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-44 p-1" align="end">
                    {issue.workMode !== "planning" && (
                      <button
                        className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                        onClick={() => {
                          updateIssue.mutate({ workMode: "planning" });
                          setMoreOpen(false);
                        }}
                      >
                        <ClipboardList className="h-3 w-3" />
                        Switch to Planning mode
                      </button>
                    )}
                    <button
                      className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                      onClick={() => {
                        updateIssue.mutate(
                          { hiddenAt: new Date().toISOString() },
                          { onSuccess: () => onDismiss?.() },
                        );
                        setMoreOpen(false);
                      }}
                    >
                      <EyeOff className="h-3 w-3" />
                      Hide this Task
                    </button>
                  </PopoverContent>
                </Popover>
              </>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => onDismiss?.()}
              className="shrink-0"
              data-testid="close-button"
              aria-label="Close task details"
              title="Close task details"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <ScrollArea
          className={cn(
            "flex-1 overflow-x-hidden [&_[data-slot=scroll-area-scrollbar]]:hidden",
            isCommentsTab
              ? "overflow-hidden [&_[data-slot=scroll-area-viewport]>div]:!h-full"
              : "overflow-y-auto",
          )}
        >
          <div
            className={cn(
              "min-w-0 max-w-full overflow-x-hidden p-4",
              isCommentsTab ? "flex h-full min-h-0 flex-col gap-6" : "space-y-6",
            )}
            data-testid="task-detail-scroll-body"
          >
            {isLoading && (
              <p className="text-sm text-muted-foreground">Loading...</p>
            )}
            {error && (
              <p className="text-sm text-destructive">{(error as Error).message}</p>
            )}
            {!isLoading && !error && !issue && (
              <p className="text-sm text-muted-foreground">Task not found.</p>
            )}

            {issue && (
              <>
                {/* Parent chain */}
                {(issue.ancestors ?? []).length > 0 && (
                  <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
                    {[...(issue.ancestors ?? [])].reverse().map((ancestor, i) => (
                      <span key={ancestor.id} className="flex items-center gap-1">
                        {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
                        <Link
                          to={`/issues/${ancestor.identifier ?? ancestor.id}`}
                          className="hover:text-foreground transition-colors truncate max-w-[200px]"
                          title={ancestor.title}
                        >
                          {ancestor.title}
                        </Link>
                      </span>
                    ))}
                    <ChevronRight className="h-3 w-3 shrink-0" />
                    <span className="text-foreground/60 truncate max-w-[200px]">{issue.title}</span>
                  </nav>
                )}

                {issue.hiddenAt && (
                  <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <EyeOff className="h-4 w-4 shrink-0" />
                    This task is hidden
                  </div>
                )}

                {/* Title + Description */}
                <div className="space-y-3">
                  <InlineEditor
                    value={issue.title}
                    onSave={(title) => updateIssue.mutate({ title })}
                    as="h2"
                    className="text-xl font-bold"
                  />

                  <InlineEditor
                    value={issue.description ?? ""}
                    onSave={(description) => updateIssue.mutate({ description })}
                    as="p"
                    className="text-sm text-muted-foreground"
                    placeholder="Add a description..."
                    multiline
                    multilineAutoSave
                    mentions={mentionOptions}
                    companyId={selectedCompanyId}
                    imageUploadHandler={async (file) => {
                      const attachment = await uploadAttachment.mutateAsync(file);
                      return attachment.contentPath;
                    }}
                  />
                </div>

                {/* Dependency Picker Dialog */}
                <Dialog open={depPickerOpen} onOpenChange={(o) => { setDepPickerOpen(o); if (!o) setDepSearch(""); }}>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>Add Dependency</DialogTitle>
                      <DialogDescription className="text-xs">Select a task that must be completed before this one can start.</DialogDescription>
                    </DialogHeader>
                    <DialogBody>
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search tasks..."
                        value={depSearch}
                        onChange={(e) => setDepSearch(e.target.value)}
                        className="pl-9"
                        autoFocus
                      />
                    </div>
                    <div className="max-h-64 overflow-y-auto -mx-1">
                      {depPickerCandidates.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-4">No matching tasks found.</p>
                      ) : (
                        depPickerCandidates.map((candidate) => (
                          <button
                            key={candidate.id}
                            type="button"
                            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-accent/50 rounded-md transition-colors"
                            onClick={() => addDependency.mutate(candidate.id)}
                            disabled={addDependency.isPending}
                          >
                            <StatusIcon status={candidate.status} />
                            <span className="font-mono text-xs text-muted-foreground shrink-0">
                              {candidate.identifier ?? candidate.id.slice(0, 8)}
                            </span>
                            <span className="truncate">{candidate.title}</span>
                          </button>
                        ))
                      )}
                    </div>
                    </DialogBody>
                  </DialogContent>
                </Dialog>

                <Dialog
                  open={requestChangesOpen}
                  onOpenChange={(open) => {
                    if (requestChanges.isPending) return;
                    setRequestChangesOpen(open);
                    if (!open) setRequestChangesFeedback("");
                  }}
                >
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>Request changes</DialogTitle>
                      <DialogDescription>
                        Tell the assignee what needs to change. The task will return to in progress and resume automatically.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogBody>
                      <div className="space-y-2">
                        <label htmlFor="request-changes-feedback" className="text-sm font-medium">
                          Review feedback
                        </label>
                        <Textarea
                          id="request-changes-feedback"
                          value={requestChangesFeedback}
                          onChange={(event) => setRequestChangesFeedback(event.target.value)}
                          placeholder="Describe the required changes and any acceptance criteria..."
                          rows={5}
                          autoFocus
                        />
                      </div>
                    </DialogBody>
                    <DialogFooter>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setRequestChangesOpen(false);
                          setRequestChangesFeedback("");
                        }}
                        disabled={requestChanges.isPending}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        onClick={() => requestChanges.mutate(requestChangesFeedback)}
                        disabled={!requestChangesFeedback.trim() || requestChanges.isPending}
                      >
                        {requestChanges.isPending ? (
                          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                        ) : null}
                        Send feedback &amp; resume
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Review action bar, visible when task is in_review (Decisions #69, #70). */}
                {issue?.status === "in_review" && (
                  <div className="rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-900/10 p-3 space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                      <GitPullRequestArrow className="h-4 w-4" />
                      Task In Review
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Review the agent&apos;s output. You can approve, request changes, or add a refined version.
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        className="bg-green-600 hover:bg-green-700 text-white"
                        onClick={() => updateIssue.mutate({ status: "done" })}
                        disabled={updateIssue.isPending}
                      >
                        <Check className="h-3.5 w-3.5 mr-1" />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRequestChangesOpen(true)}
                        disabled={updateIssue.isPending || requestChanges.isPending}
                      >
                        Request Changes
                      </Button>
                      {artifact && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setDetailTab("work");
                            setShowAddVersion(true);
                          }}
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" />
                          Add Version
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {/* Tabs: Overview, Work, Comments, Sub-tasks, Activity */}
                <Tabs
                  value={detailTab}
                  onValueChange={(value) => {
                    if ((TASK_DETAIL_TAB_ORDER as readonly string[]).includes(value)) {
                      setDetailTab(value as TaskDetailTab);
                    }
                  }}
                  className={cn(
                    isCommentsTab ? "min-h-0 flex-1 gap-3 overflow-hidden" : "space-y-3",
                  )}
                >
                  <TabsList variant="line" className="w-full justify-start gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
                    <TabsTrigger value="overview" className="gap-1.5">
                      <ClipboardList className="h-3.5 w-3.5" />
                      {getTaskDetailTabLabel("overview")}
                    </TabsTrigger>
                    <TabsTrigger value="work" className="gap-1.5">
                      <Link2 className="h-3.5 w-3.5" />
                      {getTaskDetailTabLabel("work")}
                    </TabsTrigger>
                    <TabsTrigger value="comments" className="gap-1.5">
                      <MessageSquare className="h-3.5 w-3.5" />
                      {getTaskDetailTabLabel("comments")}
                    </TabsTrigger>
                    <TabsTrigger value="subtasks" className="gap-1.5">
                      <ListTree className="h-3.5 w-3.5" />
                      {getTaskDetailTabLabel("subtasks")}
                    </TabsTrigger>
                    <TabsTrigger value="activity" className="gap-1.5">
                      <ActivityIcon className="h-3.5 w-3.5" />
                      {getTaskDetailTabLabel("activity")}
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="overview">
                    <div className="space-y-4" data-testid="task-overview-tab">
                      {hasUnmetDeps && (
                        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                          <Link2 className="h-4 w-4 shrink-0" />
                          Waiting for {upstreamDeps.filter((d) => d.status !== "done").length} dependency task{upstreamDeps.filter((d) => d.status !== "done").length !== 1 ? "s" : ""}
                        </div>
                      )}

                      {issue.executionWorkspaceId && workspace && (
                        <button
                          type="button"
                          data-testid="overview-workspace-row"
                          className="flex w-full items-center gap-3 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-left text-xs transition-colors hover:bg-cyan-500/15"
                          onClick={() => setSidebarMode("workspace")}
                        >
                          <MonitorPlay className="h-3.5 w-3.5 shrink-0 text-cyan-700 dark:text-cyan-300" />
                          <span className="font-medium text-foreground">Workspace</span>
                          <span className="min-w-0 truncate text-muted-foreground">
                            {workspace.branchName ?? workspace.name}
                          </span>
                          <span
                            className={cn(
                              "ml-auto inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                              workspace.status === "active"
                                ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400"
                                : workspace.status === "idle"
                                  ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                                  : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
                            )}
                          >
                            {workspace.status}
                          </span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        </button>
                      )}

                      <div className="rounded-md border border-border/80 p-3" data-testid="task-overview-properties">
                        <IssueProperties
                          issue={issue}
                          onUpdate={(data) => updateIssue.mutate(data)}
                          layout="compact"
                        />
                      </div>

                      {(issue.originKind || issue.sourceDiscussionId || issue.sourceThreadTitle) && (
                        <div className="rounded-md border border-border/80 px-3 py-2 text-xs">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Source</span>
                            {issue.sourceDiscussionId ? (
                              <Link
                                to={`/discussions/${issue.sourceDiscussionId}`}
                                className="truncate text-foreground hover:underline"
                                title={issue.sourceThreadTitle ?? issue.sourceDiscussionId}
                              >
                                {issue.sourceThreadTitle ?? "Discussion thread"}
                              </Link>
                            ) : (
                              <span className="truncate text-foreground">{issue.originKind ?? issue.source}</span>
                            )}
                          </div>
                        </div>
                      )}

                      {latestComment && (
                        <button
                          type="button"
                          className="w-full rounded-md border border-border/80 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
                          onClick={() => setDetailTab("comments")}
                        >
                          <div className="flex items-center justify-between gap-3 text-xs">
                            <span className="font-medium">Latest comment</span>
                            <span className="text-muted-foreground">
                              {relativeTime(latestComment.createdAt)}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {latestComment.body}
                          </p>
                        </button>
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="work">
                    <div className="space-y-5" data-testid="task-work-tab">
                      <IssueDocumentsSection
                        issue={issue}
                        canDeleteDocuments={!!session?.user?.id}
                        mentions={mentionOptions}
                        imageUploadHandler={async (file) => {
                          const attachment = await uploadAttachment.mutateAsync(file);
                          return attachment.contentPath;
                        }}
                      />

                      <div className="space-y-2" data-testid="workspace-section">
                        <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                          <MonitorPlay className="h-3.5 w-3.5" />
                          Workspace
                        </h3>
                        {!issue.executionWorkspaceId ? (
                          <p className="text-xs text-muted-foreground" data-testid="workspace-empty-state">
                            {issue.executionLockedAt && hasLiveRuns && issue.projectId && issue.project?.executionWorkspacePolicy ? (
                              <span className="flex items-center gap-1.5">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Provisioning workspace...
                              </span>
                            ) : hasLiveRuns ? (
                              "Agent is running without a project workspace"
                            ) : !issue.projectId ? (
                              "No project assigned - assign a project with workspace policy to enable"
                            ) : !issue.project?.executionWorkspacePolicy ? (
                              "Project has no workspace policy configured"
                            ) : (
                              "No workspace yet - will be created when agent starts work"
                            )}
                          </p>
                        ) : workspace ? (
                          <div
                            role="button"
                            tabIndex={0}
                            data-testid="workspace-row"
                            className="w-full flex items-center gap-3 rounded-md border border-border px-3 py-2.5 text-sm hover:bg-accent/30 transition-colors text-left"
                            onClick={() => setSidebarMode("workspace")}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setSidebarMode("workspace");
                              }
                            }}
                          >
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0",
                                workspace.status === "active"
                                  ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400"
                                  : workspace.status === "idle"
                                    ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                                    : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
                              )}
                            >
                              {workspace.status}
                            </span>
                            {workspace.branchName && (
                              <span className="flex items-center gap-1 min-w-0">
                                <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                                <span className="font-mono text-xs text-muted-foreground truncate">
                                  {workspace.branchName}
                                </span>
                                <button
                                  type="button"
                                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                                  title="Copy branch name"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void navigator.clipboard.writeText(workspace.branchName!);
                                  }}
                                >
                                  <Copy className="h-3 w-3" />
                                </button>
                              </span>
                            )}
                            {!workspace.branchName && (
                              <span className="text-xs text-muted-foreground truncate min-w-0">
                                {workspace.name}
                              </span>
                            )}
                            <span className="ml-auto text-xs text-muted-foreground shrink-0">
                              {relativeTime(workspace.lastUsedAt)}
                            </span>
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">Loading workspace...</p>
                        )}
                      </div>

                      <IssueWorkspaceCard
                        issueId={issue.id}
                        companyId={selectedCompanyId}
                        projectId={issue.projectId}
                        issueExecutionWorkspacePreference={issue.executionWorkspacePreference}
                        issueExecutionWorkspaceSettings={issue.executionWorkspaceSettings}
                      />

                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                            <Link2 className="h-3.5 w-3.5" />
                            Dependencies
                          </h3>
                          <Button variant="outline" size="sm" onClick={() => setDepPickerOpen(true)}>
                            <Plus className="h-3.5 w-3.5 mr-1.5" />
                            Add
                          </Button>
                        </div>

                        {upstreamDeps.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-1.5">Waiting for</p>
                            <div className="border border-border rounded-md divide-y divide-border">
                              {upstreamDeps.map((dep) => (
                                <div key={dep.id} className="flex items-center justify-between px-3 py-2 text-sm">
                                  <Link
                                    to={`/issues/${dep.identifier ?? dep.dependencyIssueId}`}
                                    className="flex items-center gap-2 min-w-0 hover:text-foreground transition-colors"
                                  >
                                    <StatusIcon status={dep.status} />
                                    <span className="font-mono text-xs text-muted-foreground shrink-0">
                                      {dep.identifier ?? dep.dependencyIssueId?.slice(0, 8)}
                                    </span>
                                    <span className="truncate">{dep.title}</span>
                                  </Link>
                                  <span className="ml-auto flex items-center gap-2 shrink-0">
                                    <StatusBadge status={dep.status} />
                                    <button
                                      type="button"
                                      className="text-muted-foreground hover:text-destructive"
                                      onClick={() => removeDependency.mutate(dep.dependencyIssueId!)}
                                      title="Remove dependency"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </button>
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {downstreamDeps.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-1.5">Blocking</p>
                            <div className="border border-border rounded-md divide-y divide-border">
                              {downstreamDeps.map((dep) => (
                                <Link
                                  key={dep.id}
                                  to={`/issues/${dep.identifier ?? dep.dependentIssueId}`}
                                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/20 transition-colors"
                                >
                                  <StatusIcon status={dep.status} />
                                  <span className="font-mono text-xs text-muted-foreground shrink-0">
                                    {dep.identifier ?? dep.dependentIssueId?.slice(0, 8)}
                                  </span>
                                  <span className="truncate">{dep.title}</span>
                                  <StatusBadge status={dep.status} />
                                </Link>
                              ))}
                            </div>
                          </div>
                        )}

                        {upstreamDeps.length === 0 && downstreamDeps.length === 0 && (
                          <p className="text-xs text-muted-foreground">No dependencies.</p>
                        )}
                      </div>

                      <ScopeHandoffSection
                        bundles={contextBundles}
                        onOpenItem={onOpenScopeHandoffItem}
                        pushToast={pushToast}
                        onSetIncluded={(item, included) =>
                          setScopeHandoffIncluded.mutate({ itemId: item.id, included })}
                        isUpdatingItemId={
                          setScopeHandoffIncluded.isPending
                            ? (setScopeHandoffIncluded.variables as { itemId?: string } | undefined)?.itemId ?? null
                            : null
                        }
                      />

                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-sm font-medium text-muted-foreground">Attachments</h3>
                          <div className="flex items-center gap-2">
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept="image/png,image/jpeg,image/webp,image/gif"
                              className="hidden"
                              onChange={handleFilePicked}
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => fileInputRef.current?.click()}
                              disabled={uploadAttachment.isPending}
                            >
                              <FilePlus2 className="h-3.5 w-3.5 mr-1.5" />
                              {uploadAttachment.isPending ? "Uploading..." : "Upload image"}
                            </Button>
                          </div>
                        </div>

                        {attachmentError && (
                          <p className="text-xs text-destructive">{attachmentError}</p>
                        )}

                        {(!attachments || attachments.length === 0) ? (
                          <p className="text-xs text-muted-foreground">No attachments yet.</p>
                        ) : (
                          <div className="space-y-2">
                            {attachments.map((attachment) => (
                              <div key={attachment.id} className="border border-border rounded-md p-2">
                                <div className="flex items-center justify-between gap-2">
                                  <a
                                    href={attachment.contentPath}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-xs hover:underline truncate"
                                    title={attachment.originalFilename ?? attachment.id}
                                  >
                                    {attachment.originalFilename ?? attachment.id}
                                  </a>
                                  <button
                                    type="button"
                                    className="text-muted-foreground hover:text-destructive"
                                    onClick={() => deleteAttachment.mutate(attachment.id)}
                                    disabled={deleteAttachment.isPending}
                                    title="Delete attachment"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                                <p className="text-[11px] text-muted-foreground">
                                  {attachment.contentType} - {(attachment.byteSize / 1024).toFixed(1)} KB
                                </p>
                                {isImageAttachment(attachment) && (
                                  <button
                                    type="button"
                                    className="mt-2 block w-full cursor-zoom-in text-left"
                                    aria-label={`Open ${attachment.originalFilename ?? "image"} in gallery`}
                                    onClick={() => {
                                      const idx = imageAttachments.findIndex((img) => img.id === attachment.id);
                                      if (idx >= 0) {
                                        setGalleryInitialIndex(idx);
                                        setGalleryOpen(true);
                                      }
                                    }}
                                  >
                                    <img
                                      src={attachment.contentPath}
                                      alt={attachment.originalFilename ?? "attachment"}
                                      className="max-h-56 w-full rounded border border-border object-contain bg-accent/10"
                                      loading="lazy"
                                    />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <ImageGalleryModal
                        images={imageAttachments}
                        initialIndex={galleryInitialIndex}
                        open={galleryOpen}
                        onOpenChange={setGalleryOpen}
                      />
                    </div>
                  </TabsContent>

                  <TabsContent
                    value="comments"
                    className="flex min-h-0 flex-1 flex-col overflow-hidden"
                    data-testid="task-comments-tab-content"
                  >
                    <CommentThread
                      comments={commentsWithRunMeta}
                      linkedRuns={timelineRuns}
                      issueStatus={issue.status}
                      agentMap={agentMap}
                      draftKey={`aoa:composer-draft:${issue.companyId}:${currentUserId ?? "unknown"}:task:${issue.id}:root`}
                      enableReassign={permissions.canAssignTasks}
                      reassignOptions={commentReassignOptions}
                      currentAssigneeValue={currentAssigneeValue}
                      hasActiveRun={hasLiveRuns}
                      mentions={mentionOptions}
                      feedbackIssueId={issue.id}
                      existingVotesByCommentId={votesByCommentId}
                      onVoteChange={() => { void refetchFeedbackVotes(); }}
                      onAdd={async (body, reopen, reassignment, interrupt, clientSubmissionId) => {
                        if (reassignment) {
                          await addCommentAndReassign.mutateAsync({ body, reopen, reassignment, clientSubmissionId });
                          return;
                        }
                        await addComment.mutateAsync({ body, reopen, interrupt, clientSubmissionId });
                      }}
                      onAddWithAttachments={async (body, files, reopen, interrupt, clientSubmissionId) => {
                        await issuesApi.addCommentWithAttachments(issue.id, body, files, reopen, interrupt, clientSubmissionId);
                        invalidateIssue();
                        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issue.id) });
                        queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issue.id) });
                      }}
                      imageUploadHandler={async (file) => {
                        const attachment = await uploadAttachment.mutateAsync(file);
                        return attachment.contentPath;
                      }}
                      onAttachImage={async (file) => {
                        await uploadAttachment.mutateAsync(file);
                      }}
                      liveRunSlot={<LiveRunWidget issueId={issueId!} companyId={issue.companyId} />}
                    />
                  </TabsContent>

                  <TabsContent value="subtasks">
                    {childIssues.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No sub-tasks.</p>
                    ) : (
                      <div className="border border-border rounded-lg divide-y divide-border">
                        {childIssues.map((child) => (
                          <Link
                            key={child.id}
                            to={`/issues/${child.identifier ?? child.id}`}
                            className="flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/20 transition-colors"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <StatusIcon status={child.status} />
                              <PriorityIcon priority={child.priority} />
                              <span className="font-mono text-muted-foreground shrink-0">
                                {child.identifier ?? child.id.slice(0, 8)}
                              </span>
                              <span className="truncate">{child.title}</span>
                            </div>
                            {child.assigneeAgentId && (() => {
                              const name = agentMap.get(child.assigneeAgentId)?.name;
                              return name
                                ? <Identity name={name} size="sm" />
                                : <span className="text-muted-foreground font-mono">{child.assigneeAgentId.slice(0, 8)}</span>;
                            })()}
                          </Link>
                        ))}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="activity">
                    {!activity || activity.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No activity yet.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {activity.slice(0, 20).map((evt) => (
                          <div key={evt.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <ActorIdentity evt={evt} agentMap={agentMap} />
                            <span>{formatAction(evt.action, evt.details)}</span>
                            <span className="ml-auto shrink-0">{relativeTime(evt.createdAt)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="work" className="space-y-4" data-testid="work-artifacts-section">
                    <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                      <FileBox className="h-3.5 w-3.5" />
                      Artifacts & outputs
                    </h3>

                    {/* Detected outputs from agent runs. */}
                    {pendingOutputs.length > 0 && (
                      <div className="mb-4 space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                          <FileCode className="h-3.5 w-3.5" />
                          Detected Outputs
                          <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                            {pendingOutputs.length}
                          </span>
                        </h4>
                        <div className="border border-border rounded-lg divide-y divide-border">
                          {pendingOutputs.map((output) => {
                            return (
                              <div key={`${output.runId}-${output.path}`} className="px-3 py-2 space-y-1.5">
                                <div className="flex items-center gap-2 text-xs">
                                  <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  <span className="font-medium truncate">{output.filename}</span>
                                  <span className="text-muted-foreground shrink-0">
                                    {output.byteSize < 1024
                                      ? `${output.byteSize} B`
                                      : output.byteSize < 1024 * 1024
                                        ? `${(output.byteSize / 1024).toFixed(1)} KB`
                                        : `${(output.byteSize / (1024 * 1024)).toFixed(1)} MB`}
                                  </span>
                                  <span
                                    className={cn(
                                      "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px]",
                                      output.source === "hint" || output.source === "both"
                                        ? "border-blue-200 text-blue-600 dark:border-blue-800 dark:text-blue-400"
                                        : "border-border text-muted-foreground",
                                    )}
                                  >
                                    {output.source}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                  <span className="font-mono">{output.runId.slice(0, 8)}</span>
                                  {output.runFinishedAt && (
                                    <span>{relativeTime(output.runFinishedAt)}</span>
                                  )}
                                  <span className="truncate text-muted-foreground/70">{output.path}</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 text-xs px-2"
                                    disabled={confirmOutput.isPending}
                                    onClick={() => {
                                      confirmOutput.mutate({
                                        runId: output.runId,
                                        index: output.outputIndex,
                                        payload: artifact
                                          ? {
                                              artifactId: artifact.id,
                                              changelog: `Agent output: ${output.filename}`,
                                            }
                                          : {
                                              title: output.filename,
                                              type: output.artifactType ?? "other",
                                              changelog: `Agent output: ${output.filename}`,
                                            },
                                      });
                                    }}
                                  >
                                    <Check className="h-3 w-3 mr-1" />
                                    {artifact ? "Add Version" : "Create Artifact"}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 text-xs px-2 text-muted-foreground"
                                    disabled={dismissOutput.isPending}
                                    onClick={() => {
                                      dismissOutput.mutate({
                                        runId: output.runId,
                                        index: output.outputIndex,
                                      });
                                    }}
                                  >
                                    <XCircle className="h-3 w-3 mr-1" />
                                    Dismiss
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {!artifact && pendingOutputs.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">
                        No artifact linked to this task.
                      </p>
                    ) : artifact ? (
                      <div className="space-y-4">
                        {/* Artifact header */}
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{artifact.title}</span>
                            {artifact.versions.length > 0 && (
                              <span className="text-xs font-mono text-muted-foreground">
                                v{artifact.versions[0].versionNumber}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                              {artifact.type}
                            </span>
                            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                              {artifact.status}
                            </span>
                            {artifact.versions.length > 0 && (
                              <SourceBadge source={artifact.versions[0].source} />
                            )}
                          </div>
                          {artifact.versions[0]?.changelog && (
                            <p className="text-xs text-muted-foreground italic">
                              &ldquo;{artifact.versions[0].changelog}&rdquo;
                            </p>
                          )}
                        </div>

                        {/* Add Version */}
                        {!showAddVersion ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setShowAddVersion(true)}
                          >
                            <Plus className="h-3.5 w-3.5 mr-1.5" />
                            Add Version
                          </Button>
                        ) : (
                          <form
                            className="space-y-3 rounded-lg border border-border p-3"
                            onSubmit={(e) => {
                              e.preventDefault();
                              const form = e.currentTarget;
                              const fd = new FormData(form);
                              addVersion.mutate({
                                artifactId: artifact.id,
                                payload: {
                                  source: "founder",
                                  changelog: (fd.get("changelog") as string) || null,
                                  parentVersionId: artifact.currentVersionId,
                                  content: versionMode === "text" ? (fd.get("content") as string) || null : null,
                                  fileUrl: versionMode === "file" ? (fd.get("fileUrl") as string) || null : null,
                                },
                              });
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <div className="flex rounded-md border border-input text-xs overflow-hidden">
                                <button
                                  type="button"
                                  className={cn(
                                    "px-2 py-1 transition-colors",
                                    versionMode === "text" ? "bg-accent text-accent-foreground" : "bg-background",
                                  )}
                                  onClick={() => setVersionMode("text")}
                                >
                                  Text
                                </button>
                                <button
                                  type="button"
                                  className={cn(
                                    "px-2 py-1 transition-colors",
                                    versionMode === "file" ? "bg-accent text-accent-foreground" : "bg-background",
                                  )}
                                  onClick={() => setVersionMode("file")}
                                >
                                  File
                                </button>
                              </div>
                            </div>
                            {versionMode === "text" ? (
                              <textarea
                                name="content"
                                rows={4}
                                placeholder="Paste content..."
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                              />
                            ) : (
                              <Input name="fileUrl" placeholder="File URL..." />
                            )}
                            <Input name="changelog" placeholder="Changelog (optional)" />
                            <div className="flex items-center gap-2">
                              <Button type="submit" size="sm" disabled={addVersion.isPending}>
                                {addVersion.isPending ? "Saving..." : "Save Version"}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setShowAddVersion(false)}
                              >
                                Cancel
                              </Button>
                              {addVersion.isError && (
                                <span className="text-xs text-destructive">Failed to save version.</span>
                              )}
                            </div>
                          </form>
                        )}

                        {/* Version History */}
                        {artifact.versions.length > 0 && (
                          <div className="space-y-1">
                            <h4 className="text-xs font-medium text-muted-foreground">Version History</h4>
                            <div className="border border-border rounded-lg divide-y divide-border">
                              {(showAllVersions ? artifact.versions : artifact.versions.slice(0, 5)).map((v) => (
                                <div key={v.id} className="flex items-center justify-between px-3 py-2 text-xs">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="font-mono font-medium shrink-0">v{v.versionNumber}</span>
                                    <SourceBadge source={v.source} />
                                    {v.changelog && (
                                      <span className="text-muted-foreground truncate">{v.changelog}</span>
                                    )}
                                  </div>
                                  <span className="text-muted-foreground shrink-0 ml-2">
                                    {relativeTime(v.createdAt)}
                                  </span>
                                </div>
                              ))}
                            </div>
                            {artifact.versions.length > 5 && !showAllVersions && (
                              <button
                                type="button"
                                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                                onClick={() => setShowAllVersions(true)}
                              >
                                Show all {artifact.versions.length} versions
                              </button>
                            )}
                          </div>
                        )}

                        {/* Input Artifacts (Decision #71) */}
                        {inputArtifacts.length > 0 && (
                          <div className="space-y-1">
                            <h4 className="text-xs font-medium text-muted-foreground">Input Artifacts</h4>
                            <div className="border border-border rounded-lg divide-y divide-border">
                              {inputArtifacts.map(({ dep, artifact: depArtifact }) => (
                                <Link
                                  key={depArtifact.id}
                                  to={`/issues/${dep.identifier ?? dep.dependencyIssueId}`}
                                  className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent/20 transition-colors"
                                >
                                  <span className="font-mono text-muted-foreground shrink-0">
                                    {dep.identifier ?? dep.dependencyIssueId?.slice(0, 8)}
                                  </span>
                                  <span className="text-muted-foreground">&rarr;</span>
                                  <span className="truncate font-medium">{depArtifact.title}</span>
                                  {depArtifact.versions.length > 0 && (
                                    <span className="font-mono text-muted-foreground shrink-0">
                                      v{depArtifact.versions[0].versionNumber}
                                    </span>
                                  )}
                                </Link>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </TabsContent>
                </Tabs>

                {/* Linked Approvals (collapsible) */}
                {detailTab === "activity" && linkedApprovals && linkedApprovals.length > 0 && (
                  <Collapsible
                    open={secondaryOpen.approvals}
                    onOpenChange={(o) => setSecondaryOpen((prev) => ({ ...prev, approvals: o }))}
                    className="rounded-lg border border-border"
                  >
                    <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
                      <span className="text-sm font-medium text-muted-foreground">
                        Linked Approvals ({linkedApprovals.length})
                      </span>
                      <ChevronDown
                        className={cn("h-4 w-4 text-muted-foreground transition-transform", secondaryOpen.approvals && "rotate-180")}
                      />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="border-t border-border divide-y divide-border">
                        {linkedApprovals.map((approval) => (
                          <Link
                            key={approval.id}
                            to={`/approvals/${approval.id}`}
                            className="flex items-center justify-between px-3 py-2 text-xs hover:bg-accent/20 transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              <StatusBadge status={approval.status} />
                              <span className="font-medium">
                                {approval.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                              </span>
                              <span className="font-mono text-muted-foreground">{approval.id.slice(0, 8)}</span>
                            </div>
                            <span className="text-muted-foreground">{relativeTime(approval.createdAt)}</span>
                          </Link>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}

                {/* Cost Summary (collapsible) */}
                {detailTab === "activity" && linkedRuns && linkedRuns.length > 0 && (
                  <Collapsible
                    open={secondaryOpen.cost}
                    onOpenChange={(o) => setSecondaryOpen((prev) => ({ ...prev, cost: o }))}
                    className="rounded-lg border border-border"
                  >
                    <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
                      <span className="text-sm font-medium text-muted-foreground">Cost Summary</span>
                      <ChevronDown
                        className={cn("h-4 w-4 text-muted-foreground transition-transform", secondaryOpen.cost && "rotate-180")}
                      />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="border-t border-border px-3 py-2">
                        {!issueCostSummary.hasCost && !issueCostSummary.hasTokens ? (
                          <div className="text-xs text-muted-foreground">No cost data yet.</div>
                        ) : (
                          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                            {issueCostSummary.hasCost && (
                              <span className="font-medium text-foreground">
                                ${issueCostSummary.cost.toFixed(4)}
                              </span>
                            )}
                            {issueCostSummary.hasTokens && (
                              <span>
                                Tokens {formatTokens(issueCostSummary.totalTokens)}
                                {issueCostSummary.cached > 0
                                  ? ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)}, cached ${formatTokens(issueCostSummary.cached)})`
                                  : ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)})`}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </>
            )}
          </div>
        </ScrollArea>
          </>
        )}
    </div>
  );
}
