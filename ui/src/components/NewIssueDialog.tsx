import { useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { assetsApi } from "../api/assets";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { useEnvironments } from "../api/environments";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { useTeamAccess } from "../hooks/useTeamAccess";
import { useWorkspacePermissions } from "../hooks/useWorkspacePermissions";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import {
  formatTaskAssigneeValue,
  parseTaskAssigneeValue,
  taskAssigneePayload,
} from "../lib/task-assignee";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Maximize2,
  Minimize2,
  ChevronRight,
  ChevronDown,
  CircleDot,
  Minus,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  Paperclip,
  Hammer,
  ClipboardList,
  Layers,
  FolderGit2,
  GitBranch,
  User,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "../lib/utils";
import { pruneStaleId } from "../lib/issueDraft";
import { extractProviderIdWithFallback } from "../lib/model-utils";
import { issueStatusText, issueStatusTextDefault, priorityColor, priorityColorDefault } from "../lib/status-colors";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { AgentIcon } from "./AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";

const DRAFT_KEY = "aoa:issue-draft";
const DEBOUNCE_MS = 800;
const NO_RESPONSIBLE_HUMAN_VALUE = "__no_responsible_human__";
type TaskWorkspaceMode = "inherit" | "shared_workspace" | "isolated_workspace" | "reuse_existing";

/** Return black or white hex based on background luminance (WCAG perceptual weights). */
function getContrastTextColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000000" : "#ffffff";
}

interface IssueDraft {
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeId: string;
  responsibleUserId: string;
  projectId: string;
  assigneeModelOverride: string;
  assigneeThinkingEffort: string;
  assigneeChrome: boolean;
  assigneeUseProjectWorkspace: boolean;
}

const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "opencode_local"]);

const ISSUE_THINKING_EFFORT_OPTIONS = {
  claude_local: [
    { value: "", label: "Default" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  codex_local: [
    { value: "", label: "Default" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  opencode_local: [
    { value: "", label: "Default" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "max", label: "Max" },
  ],
} as const;

function buildAssigneeAdapterOverrides(input: {
  adapterType: string | null | undefined;
  modelOverride: string;
  thinkingEffortOverride: string;
  chrome: boolean;
  useProjectWorkspace: boolean;
}): Record<string, unknown> | null {
  const adapterType = input.adapterType ?? null;
  if (!adapterType || !ISSUE_OVERRIDE_ADAPTER_TYPES.has(adapterType)) {
    return null;
  }

  const adapterConfig: Record<string, unknown> = {};
  if (input.modelOverride) adapterConfig.model = input.modelOverride;
  if (input.thinkingEffortOverride) {
    if (adapterType === "codex_local") {
      adapterConfig.modelReasoningEffort = input.thinkingEffortOverride;
    } else if (adapterType === "opencode_local") {
      adapterConfig.variant = input.thinkingEffortOverride;
    } else if (adapterType === "claude_local") {
      adapterConfig.effort = input.thinkingEffortOverride;
    } else if (adapterType === "opencode_local") {
      adapterConfig.variant = input.thinkingEffortOverride;
    }
  }
  if (adapterType === "claude_local" && input.chrome) {
    adapterConfig.chrome = true;
  }

  const overrides: Record<string, unknown> = {};
  if (Object.keys(adapterConfig).length > 0) {
    overrides.adapterConfig = adapterConfig;
  }
  if (!input.useProjectWorkspace) {
    overrides.useProjectWorkspace = false;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}

function loadDraft(): IssueDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as IssueDraft;
  } catch {
    return null;
  }
}

function saveDraft(draft: IssueDraft) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

function normalizeDraftAssigneeValue(value?: string | null): string {
  if (!value) return "";
  const parsed = parseTaskAssigneeValue(value);
  if (parsed.kind !== "none") return value;
  return formatTaskAssigneeValue("agent", value);
}

const statuses = [
  { value: "backlog", label: "Backlog", color: issueStatusText.backlog ?? issueStatusTextDefault },
  { value: "todo", label: "Todo", color: issueStatusText.todo ?? issueStatusTextDefault },
  { value: "in_progress", label: "In Progress", color: issueStatusText.in_progress ?? issueStatusTextDefault },
  { value: "in_review", label: "In Review", color: issueStatusText.in_review ?? issueStatusTextDefault },
  { value: "done", label: "Done", color: issueStatusText.done ?? issueStatusTextDefault },
];

const priorities = [
  { value: "critical", label: "Critical", icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault },
  { value: "high", label: "High", icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault },
  { value: "medium", label: "Medium", icon: Minus, color: priorityColor.medium ?? priorityColorDefault },
  { value: "low", label: "Low", icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault },
];

export function NewIssueDialog() {
  const { newIssueOpen, newIssueDefaults, closeNewIssue } = useDialog();
  const { companies, selectedCompanyId, selectedCompany } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("");
  const [assigneeValue, setAssigneeValue] = useState("");
  const [responsibleUserId, setResponsibleUserId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [assigneeOptionsOpen, setAssigneeOptionsOpen] = useState(false);
  const [assigneeModelOverride, setAssigneeModelOverride] = useState("");
  const [assigneeThinkingEffort, setAssigneeThinkingEffort] = useState("");
  const [assigneeChrome, setAssigneeChrome] = useState(false);
  const [assigneeUseProjectWorkspace, setAssigneeUseProjectWorkspace] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [dialogCompanyId, setDialogCompanyId] = useState<string | null>(null);
  // Per-field server-side validation errors (populated from 422 responses with
  // a `fieldError` payload). Keyed by the server's field name (e.g.
  // "assigneeAgentId") so it lines up with the API contract.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearFieldError(field: "assigneeAgentId" | "projectId") {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  const effectiveCompanyId = dialogCompanyId ?? selectedCompanyId;
  const dialogCompany = companies.find((c) => c.id === effectiveCompanyId) ?? selectedCompany;

  // Popover states
  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [workModeOpen, setWorkModeOpen] = useState(false);
  const [workMode, setWorkMode] = useState<"standard" | "planning">("standard");
  const [envPickerOpen, setEnvPickerOpen] = useState(false);
  const [executionEnvironmentId, setExecutionEnvironmentId] = useState<string | null>(null);
  const [taskWorkspaceMode, setTaskWorkspaceMode] = useState<TaskWorkspaceMode>("inherit");
  const [reuseWorkspaceId, setReuseWorkspaceId] = useState("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const responsibleSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(effectiveCompanyId!),
    queryFn: () => agentsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(effectiveCompanyId!),
    queryFn: () => projectsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: effectiveCompanyId,
    userId: currentUserId,
  });
  const { permissions, summary: teamSummary } = useTeamAccess(effectiveCompanyId);
  const canAssignTasks = Boolean(permissions.canAssignTasks);

  const { data: environments } = useEnvironments(effectiveCompanyId ?? "");
  const selectedProject = orderedProjects.find((project) => project.id === projectId);
  const selectedProjectPolicy = selectedProject?.executionWorkspacePolicy;
  const selectedProjectHasWorkspacePolicy = Boolean(selectedProjectPolicy?.enabled);
  const allowTaskWorkspaceOverride = selectedProjectPolicy?.allowIssueOverride !== false;
  const workspacePermissions = useWorkspacePermissions(effectiveCompanyId, projectId || null);
  const canChooseTaskWorkspace =
    selectedProjectHasWorkspacePolicy
    && allowTaskWorkspaceOverride
    && workspacePermissions.canOverrideTaskWorkspace;

  const { data: reuseWorkspaceCandidates = [] } = useQuery({
    queryKey: [
      ...queryKeys.executionWorkspaces.list(effectiveCompanyId ?? ""),
      "reuseCandidates",
      projectId,
    ] as const,
    queryFn: () =>
      executionWorkspacesApi.listSummaries(effectiveCompanyId ?? "", {
        projectId: projectId || undefined,
        reuseEligible: true,
      }),
    enabled: Boolean(newIssueOpen && effectiveCompanyId && projectId && selectedProjectHasWorkspacePolicy),
  });

  const parsedAssignee = parseTaskAssigneeValue(assigneeValue);
  const selectedAssigneeAgentId = parsedAssignee.kind === "agent" ? parsedAssignee.id : null;
  const assigneeAdapterType = selectedAssigneeAgentId
    ? (agents ?? []).find((agent) => agent.id === selectedAssigneeAgentId)?.adapterType ?? null
    : null;
  const supportsAssigneeOverrides = Boolean(
    assigneeAdapterType && ISSUE_OVERRIDE_ADAPTER_TYPES.has(assigneeAdapterType),
  );
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

  const { data: assigneeAdapterModels } = useQuery({
    queryKey:
      effectiveCompanyId && assigneeAdapterType
        ? queryKeys.agents.adapterModels(effectiveCompanyId, assigneeAdapterType)
        : ["agents", "none", "adapter-models", assigneeAdapterType ?? "none"],
    queryFn: () => agentsApi.adapterModels(effectiveCompanyId!, assigneeAdapterType!),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen && supportsAssigneeOverrides,
  });

  const createIssue = useMutation({
    mutationFn: ({ companyId, ...data }: { companyId: string } & Record<string, unknown>) =>
      issuesApi.create(companyId, data),
    onSuccess: (issue) => {
      newIssueDefaults.onCreated?.(issue);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(effectiveCompanyId!) });
      if (draftTimer.current) clearTimeout(draftTimer.current);
      clearDraft();
      reset();
      closeNewIssue();
      pushToast({
        dedupeKey: `activity:issue.created:${issue.id}`,
        title: `${issue.identifier ?? "Task"} created`,
        body: issue.title,
        tone: "success",
        action: { label: `View ${issue.identifier ?? "task"}`, href: `/issues/${issue.identifier ?? issue.id}` },
      });
    },
    onError: (error: unknown) => {
      // FK reference errors land here as a 422 with { details: { field, id } }.
      // Surface them under the offending picker instead of a toast — the toast
      // is too easy to miss when the bad value is sitting right there in the
      // form. Other errors (validation, auth, network) keep the toast path.
      if (error instanceof ApiError) {
        const fe = error.fieldError;
        if (fe && (fe.field === "assigneeAgentId" || fe.field === "projectId")) {
          setFieldErrors((prev) => ({ ...prev, [fe.field]: fe.message }));
          return;
        }
      }
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Something went wrong. Please try again.";
      pushToast({
        title: "Couldn't create task",
        body: message,
        tone: "error",
      });
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!effectiveCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(effectiveCompanyId, file, "issues/drafts");
    },
  });

  // Debounced draft saving
  const scheduleSave = useCallback(
    (draft: IssueDraft) => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        if (draft.title.trim()) saveDraft(draft);
      }, DEBOUNCE_MS);
    },
    [],
  );

  // Save draft on meaningful changes
  useEffect(() => {
    if (!newIssueOpen) return;
    scheduleSave({
      title,
      description,
      status,
      priority,
      assigneeId: assigneeValue,
      responsibleUserId,
      projectId,
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
      assigneeUseProjectWorkspace,
    });
  }, [
    title,
    description,
    status,
    priority,
    assigneeValue,
    responsibleUserId,
    projectId,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
    assigneeUseProjectWorkspace,
    newIssueOpen,
    scheduleSave,
  ]);

  // Restore draft or apply defaults when dialog opens
  useEffect(() => {
    if (!newIssueOpen) return;
    setDialogCompanyId(selectedCompanyId);

    const hasPrefilledContent = Boolean(
      newIssueDefaults.title?.trim() || newIssueDefaults.description?.trim(),
    );
    const draft = loadDraft();
    if (draft && draft.title.trim() && !hasPrefilledContent) {
      setTitle(draft.title);
      setDescription(draft.description);
      setStatus(draft.status || "todo");
      setPriority(draft.priority);
      setAssigneeValue(
        newIssueDefaults.assigneeAgentId
          ? formatTaskAssigneeValue("agent", newIssueDefaults.assigneeAgentId)
          : normalizeDraftAssigneeValue(draft.assigneeId),
      );
      setResponsibleUserId(draft.responsibleUserId ?? "");
      setProjectId(newIssueDefaults.projectId ?? draft.projectId);
      setAssigneeModelOverride(draft.assigneeModelOverride ?? "");
      setAssigneeThinkingEffort(draft.assigneeThinkingEffort ?? "");
      setAssigneeChrome(draft.assigneeChrome ?? false);
      setAssigneeUseProjectWorkspace(draft.assigneeUseProjectWorkspace ?? true);
    } else {
      setTitle(newIssueDefaults.title ?? "");
      setDescription(newIssueDefaults.description ?? "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(newIssueDefaults.projectId ?? "");
      setAssigneeValue(
        newIssueDefaults.assigneeAgentId
          ? formatTaskAssigneeValue("agent", newIssueDefaults.assigneeAgentId)
          : "",
      );
      setResponsibleUserId("");
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setAssigneeUseProjectWorkspace(true);
    }
  }, [newIssueOpen, newIssueDefaults]);

  // Drop rehydrated assignee / project ids once we know the live agent, human,
  // and project lists, in case the persisted draft was pointing at an entity
  // that has since been deleted (DB nuke, manual delete, etc).
  useEffect(() => {
    if (!newIssueOpen || !agents || !projects || !teamSummary) return;
    const validAssigneeValues = new Set([
      ...agents.map((agent) => formatTaskAssigneeValue("agent", agent.id)),
      ...teamSummary.members.map((member) => formatTaskAssigneeValue("user", member.userId)),
    ]);
    const projectIds = new Set(projects.map((p) => p.id));
    setAssigneeValue((prev) => pruneStaleId(prev, validAssigneeValues));
    setProjectId((prev) => pruneStaleId(prev, projectIds));
  }, [newIssueOpen, agents, projects, teamSummary]);

  useEffect(() => {
    if (!newIssueOpen || !teamSummary) return;
    const responsibleUserIds = new Set([
      NO_RESPONSIBLE_HUMAN_VALUE,
      ...teamSummary.members.map((member) => member.userId),
    ]);
    setResponsibleUserId((prev) => pruneStaleId(prev, responsibleUserIds));
  }, [newIssueOpen, teamSummary]);

  useEffect(() => {
    setTaskWorkspaceMode("inherit");
    setReuseWorkspaceId("");
    setWorkspacePickerOpen(false);
  }, [projectId]);

  useEffect(() => {
    if (!supportsAssigneeOverrides) {
      setAssigneeOptionsOpen(false);
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setAssigneeUseProjectWorkspace(true);
      return;
    }

    const validThinkingValues =
      assigneeAdapterType === "codex_local"
        ? ISSUE_THINKING_EFFORT_OPTIONS.codex_local
        : assigneeAdapterType === "opencode_local"
          ? ISSUE_THINKING_EFFORT_OPTIONS.opencode_local
          : ISSUE_THINKING_EFFORT_OPTIONS.claude_local;
    if (!validThinkingValues.some((option) => option.value === assigneeThinkingEffort)) {
      setAssigneeThinkingEffort("");
    }
  }, [supportsAssigneeOverrides, assigneeAdapterType, assigneeThinkingEffort]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("todo");
    setPriority("");
    setAssigneeValue("");
    setResponsibleUserId("");
    setProjectId("");
    setAssigneeOptionsOpen(false);
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setAssigneeUseProjectWorkspace(true);
    setExpanded(false);
    setDialogCompanyId(null);
    setCompanyOpen(false);
    setFieldErrors({});
    setWorkMode("standard");
    setExecutionEnvironmentId(null);
    setEnvPickerOpen(false);
    setTaskWorkspaceMode("inherit");
    setReuseWorkspaceId("");
    setWorkspacePickerOpen(false);
    setAdvancedOpen(false);
  }

  function handleCompanyChange(companyId: string) {
    if (companyId === effectiveCompanyId) return;
    setDialogCompanyId(companyId);
    setAssigneeValue("");
    setResponsibleUserId("");
    setProjectId("");
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setAssigneeUseProjectWorkspace(true);
    setTaskWorkspaceMode("inherit");
    setReuseWorkspaceId("");
    setWorkspacePickerOpen(false);
    setFieldErrors({});
  }

  function discardDraft() {
    clearDraft();
    reset();
    closeNewIssue();
  }

  function handleSubmit() {
    if (!effectiveCompanyId || !title.trim()) return;
    setFieldErrors({});
    const assigneeAdapterOverrides = buildAssigneeAdapterOverrides({
      adapterType: assigneeAdapterType,
      modelOverride: assigneeModelOverride,
      thinkingEffortOverride: assigneeThinkingEffort,
      chrome: assigneeChrome,
      useProjectWorkspace: assigneeUseProjectWorkspace,
    });
    const executionWorkspaceSettings =
      taskWorkspaceMode === "inherit"
        ? undefined
        : taskWorkspaceMode === "reuse_existing" && reuseWorkspaceId
          ? { mode: "reuse_existing", reuseWorkspaceId }
          : taskWorkspaceMode === "reuse_existing"
            ? undefined
            : { mode: taskWorkspaceMode };
    const assigneePatch =
      canAssignTasks && parsedAssignee.kind !== "none"
        ? taskAssigneePayload(assigneeValue)
        : {};
    const responsiblePatch =
      !canAssignTasks
        ? {}
        : responsibleUserId === NO_RESPONSIBLE_HUMAN_VALUE
          ? { responsibleUserId: null }
          : responsibleUserId
            ? { responsibleUserId }
            : {};
    createIssue.mutate({
      companyId: effectiveCompanyId,
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      priority: priority || "medium",
      workMode,
      ...assigneePatch,
      ...responsiblePatch,
      ...(projectId ? { projectId } : {}),
      ...(assigneeAdapterOverrides ? { assigneeAdapterOverrides } : {}),
      ...(executionEnvironmentId ? { executionEnvironmentId } : {}),
      ...(taskWorkspaceMode !== "inherit" && executionWorkspaceSettings
        ? {
          executionWorkspacePreference: taskWorkspaceMode,
          executionWorkspaceSettings,
        }
        : {}),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  async function handleAttachImage(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    try {
      const asset = await uploadDescriptionImage.mutateAsync(file);
      const name = file.name || "image";
      setDescription((prev) => {
        const suffix = `![${name}](${asset.contentPath})`;
        return prev ? `${prev}\n\n${suffix}` : suffix;
      });
    } finally {
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  const hasDraft = title.trim().length > 0 || description.trim().length > 0;
  const currentStatus = statuses.find((s) => s.value === status) ?? statuses[1]!;
  const currentPriority = priorities.find((p) => p.value === priority);
  const currentAssignee = selectedAssigneeAgentId
    ? (agents ?? []).find((a) => a.id === selectedAssigneeAgentId)
    : null;
  const currentHumanAssignee = parsedAssignee.kind === "user"
    ? (teamSummary?.members ?? []).find((member) => member.userId === parsedAssignee.id)
    : null;
  const currentResponsibleHuman = (teamSummary?.members ?? []).find((member) => member.userId === responsibleUserId);
  const currentProject = selectedProject;
  const workspaceModeLabel =
    taskWorkspaceMode === "shared_workspace"
      ? "Shared workspace"
      : taskWorkspaceMode === "isolated_workspace"
        ? "Isolated workspace"
        : taskWorkspaceMode === "reuse_existing"
          ? "Reuse workspace"
          : "Department default";
  const defaultWorkspaceLabel =
    selectedProjectPolicy?.defaultMode === "shared_workspace"
      ? "Shared"
      : selectedProjectPolicy?.defaultMode === "operator_branch"
        ? "Operator branch"
      : selectedProjectPolicy?.defaultMode === "adapter_default"
          ? "Agent default"
          : "Isolated";
  const assigneeOptionsTitle =
    assigneeAdapterType === "claude_local"
      ? "Claude options"
      : assigneeAdapterType === "codex_local"
        ? "Codex options"
        : assigneeAdapterType === "opencode_local"
          ? "OpenCode options"
        : "Agent options";
  const thinkingEffortOptions =
    assigneeAdapterType === "codex_local"
      ? ISSUE_THINKING_EFFORT_OPTIONS.codex_local
      : assigneeAdapterType === "opencode_local"
        ? ISSUE_THINKING_EFFORT_OPTIONS.opencode_local
      : ISSUE_THINKING_EFFORT_OPTIONS.claude_local;
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [newIssueOpen]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () => {
      const agentOptions = sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: formatTaskAssigneeValue("agent", agent.id),
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""} agent`,
      }));
      const humanOptions = (teamSummary?.members ?? []).map((member) => ({
        id: formatTaskAssigneeValue("user", member.userId),
        label: member.displayName ?? member.email ?? member.userId.slice(0, 8),
        searchText: `${member.displayName ?? ""} ${member.email ?? ""} ${member.title ?? ""} ${member.role} human`,
      }));
      return [...agentOptions, ...humanOptions];
    },
    [agents, recentAssigneeIds, teamSummary?.members],
  );
  const responsibleHumanOptions = useMemo<InlineEntityOption[]>(
    () =>
      [
        { id: NO_RESPONSIBLE_HUMAN_VALUE, label: "No responsible human", searchText: "none no responsible human" },
        ...(teamSummary?.members ?? []).map((member) => ({
          id: member.userId,
          label: member.displayName ?? member.email ?? member.userId.slice(0, 8),
          searchText: `${member.displayName ?? ""} ${member.email ?? ""} ${member.title ?? ""} ${member.role}`,
        })),
      ],
    [teamSummary?.members],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      orderedProjects.map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [orderedProjects],
  );
  const modelOverrideOptions = useMemo<InlineEntityOption[]>(
    () => {
      return [...(assigneeAdapterModels ?? [])]
        .sort((a, b) => {
          const providerA = extractProviderIdWithFallback(a.id);
          const providerB = extractProviderIdWithFallback(b.id);
          const byProvider = providerA.localeCompare(providerB);
          if (byProvider !== 0) return byProvider;
          return a.id.localeCompare(b.id);
        })
        .map((model) => ({
          id: model.id,
          label: model.label,
          searchText: `${model.id} ${extractProviderIdWithFallback(model.id)}`,
        }));
    },
    [assigneeAdapterModels],
  );

  return (
    <Dialog
      open={newIssueOpen}
      onOpenChange={(open) => {
        if (!open) closeNewIssue();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(
          "p-0 gap-0 flex flex-col max-h-[calc(100dvh-2rem)]",
          expanded
            ? "sm:max-w-2xl h-[calc(100dvh-2rem)]"
            : "sm:max-w-lg"
        )}
        onKeyDown={handleKeyDown}
        onPointerDownOutside={(event) => {
          // Radix Dialog's modal DismissableLayer calls preventDefault() on
          // pointerdown events that originate outside the Dialog DOM tree.
          // Popover portals render at the body level (outside the Dialog), so
          // touch events on popover content get their default prevented — which
          // kills scroll gesture recognition on mobile.  Telling Radix "this
          // event is handled" skips that preventDefault, restoring touch scroll.
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest("[data-radix-popper-content-wrapper]")) {
            event.preventDefault();
          }
        }}
      >
        <DialogTitle className="sr-only">New task</DialogTitle>
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Popover open={companyOpen} onOpenChange={setCompanyOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    "px-1.5 py-0.5 rounded text-xs font-semibold cursor-pointer hover:opacity-80 transition-opacity",
                    !dialogCompany?.brandColor && "bg-muted",
                  )}
                  style={
                    dialogCompany?.brandColor
                      ? {
                          backgroundColor: dialogCompany.brandColor,
                          color: getContrastTextColor(dialogCompany.brandColor),
                        }
                      : undefined
                  }
                >
                  {(dialogCompany?.name ?? "").slice(0, 3).toUpperCase()}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-1" align="start">
                {companies.filter((c) => c.status !== "archived").map((c) => (
                  <button
                    key={c.id}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      c.id === effectiveCompanyId && "bg-accent",
                    )}
                    onClick={() => {
                      handleCompanyChange(c.id);
                      setCompanyOpen(false);
                    }}
                  >
                    <span
                      className={cn(
                        "px-1 py-0.5 rounded text-[10px] font-semibold leading-none",
                        !c.brandColor && "bg-muted",
                      )}
                      style={
                        c.brandColor
                          ? {
                              backgroundColor: c.brandColor,
                              color: getContrastTextColor(c.brandColor),
                            }
                          : undefined
                      }
                    >
                      {c.name.slice(0, 3).toUpperCase()}
                    </span>
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>New task</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? "Collapse dialog" : "Expand dialog"}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => closeNewIssue()}
              aria-label="Close new task dialog"
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {/* Title */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <textarea
            className="w-full text-lg font-semibold bg-transparent outline-none resize-none overflow-hidden placeholder:text-muted-foreground/50"
            placeholder="Task title"
            rows={1}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                assigneeSelectorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        <div className="px-4 pb-2 shrink-0">
          <div className="overflow-x-auto overscroll-x-contain">
            <div className="inline-flex items-center gap-2 text-sm text-muted-foreground flex-wrap sm:flex-nowrap sm:min-w-max">
              <span>For</span>
              {canAssignTasks ? (
                <InlineEntitySelector
                  ref={assigneeSelectorRef}
                  value={assigneeValue}
                  options={assigneeOptions}
                  placeholder="Assignee"
                  disablePortal
                  noneLabel="No assignee"
                  searchPlaceholder="Search assignees..."
                  emptyMessage="No assignees found."
                  onChange={(id) => {
                    const parsed = parseTaskAssigneeValue(id);
                    if (parsed.kind === "agent") trackRecentAssignee(parsed.id);
                    setAssigneeValue(id);
                    clearFieldError("assigneeAgentId");
                  }}
                  onConfirm={() => {
                    responsibleSelectorRef.current?.focus();
                  }}
                  renderTriggerValue={(option) =>
                    option && (currentAssignee || currentHumanAssignee) ? (
                      <>
                        {currentAssignee ? (
                          <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Assignee</span>
                    )
                  }
                  renderOption={(option) => {
                    if (!option.id) return <span className="truncate">{option.label}</span>;
                    const parsed = parseTaskAssigneeValue(option.id);
                    const assignee = parsed.kind === "agent"
                      ? (agents ?? []).find((agent) => agent.id === parsed.id)
                      : null;
                    return (
                      <>
                        {parsed.kind === "agent" ? (
                          <AgentIcon icon={assignee?.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{option.label}</span>
                      </>
                    );
                  }}
                />
              ) : (
                <span className="rounded-md border border-border bg-muted/40 px-2 py-1 text-muted-foreground">
                  No assignment access
                </span>
              )}
              {canAssignTasks && (
                <>
                  <span>responsible</span>
                  <InlineEntitySelector
                    ref={responsibleSelectorRef}
                    value={responsibleUserId}
                    options={responsibleHumanOptions}
                    placeholder="Responsible human"
                    disablePortal
                    noneLabel="No responsible human"
                    searchPlaceholder="Search humans..."
                    emptyMessage="No humans found."
                    onChange={setResponsibleUserId}
                    onConfirm={() => {
                      projectSelectorRef.current?.focus();
                    }}
                    renderTriggerValue={(option) =>
                      option && (currentResponsibleHuman || responsibleUserId === NO_RESPONSIBLE_HUMAN_VALUE) ? (
                        <>
                          {responsibleUserId !== NO_RESPONSIBLE_HUMAN_VALUE && (
                            <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{option.label}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">Responsible human</span>
                      )
                    }
                    renderOption={(option) => {
                      if (!option.id || option.id === NO_RESPONSIBLE_HUMAN_VALUE) {
                        return <span className="truncate">{option.label}</span>;
                      }
                      return (
                        <>
                          <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{option.label}</span>
                        </>
                      );
                    }}
                  />
                </>
              )}
              <span>in</span>
              <InlineEntitySelector
                ref={projectSelectorRef}
                value={projectId}
                options={projectOptions}
                placeholder="Project"
                disablePortal
                noneLabel="No project"
                searchPlaceholder="Search projects..."
                emptyMessage="No projects found."
                onChange={(id) => {
                  setProjectId(id);
                  clearFieldError("projectId");
                }}
                onConfirm={() => {
                  descriptionEditorRef.current?.focus();
                }}
                renderTriggerValue={(option) =>
                  option && currentProject ? (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: currentProject.color ?? "#6366f1" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Project</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const project = orderedProjects.find((item) => item.id === option.id);
                  return (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: project?.color ?? "#6366f1" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </div>
          </div>
          {(fieldErrors.assigneeAgentId || fieldErrors.projectId) && (
            <div className="mt-1 space-y-0.5 text-xs text-destructive">
              {fieldErrors.assigneeAgentId && (
                <div data-testid="field-error-assigneeAgentId">
                  <span className="font-medium">Assignee:</span> {fieldErrors.assigneeAgentId}
                </div>
              )}
              {fieldErrors.projectId && (
                <div data-testid="field-error-projectId">
                  <span className="font-medium">Project:</span> {fieldErrors.projectId}
                </div>
              )}
            </div>
          )}
        </div>

        {advancedOpen && supportsAssigneeOverrides && (
          <div className="px-4 pb-2 shrink-0">
            <button
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setAssigneeOptionsOpen((open) => !open)}
            >
              {assigneeOptionsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {assigneeOptionsTitle}
            </button>
            {assigneeOptionsOpen && (
              <div className="mt-2 rounded-md border border-border p-3 bg-muted/20 space-y-3">
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">Model</div>
                  <InlineEntitySelector
                    value={assigneeModelOverride}
                    options={modelOverrideOptions}
                    placeholder="Default model"
                    disablePortal
                    noneLabel="Default model"
                    searchPlaceholder="Search models..."
                    emptyMessage="No models found."
                    onChange={setAssigneeModelOverride}
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">Thinking effort</div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {thinkingEffortOptions.map((option) => (
                      <button
                        key={option.value || "default"}
                        className={cn(
                          "px-2 py-1 rounded-md text-xs border border-border hover:bg-accent/50 transition-colors",
                          assigneeThinkingEffort === option.value && "bg-accent"
                        )}
                        onClick={() => setAssigneeThinkingEffort(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                {assigneeAdapterType === "claude_local" && (
                  <div className="flex items-center justify-between rounded-md border border-border px-2 py-1.5">
                    <div className="text-xs text-muted-foreground">Enable Chrome (--chrome)</div>
                    <button
                      className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                        assigneeChrome ? "bg-green-600" : "bg-muted"
                      )}
                      onClick={() => setAssigneeChrome((value) => !value)}
                    >
                      <span
                        className={cn(
                          "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                          assigneeChrome ? "translate-x-4.5" : "translate-x-0.5"
                        )}
                      />
                    </button>
                  </div>
                )}
                <div className="flex items-center justify-between rounded-md border border-border px-2 py-1.5">
                  <div className="text-xs text-muted-foreground">Use project workspace</div>
                  <button
                    className={cn(
                      "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                      assigneeUseProjectWorkspace ? "bg-green-600" : "bg-muted"
                    )}
                    onClick={() => setAssigneeUseProjectWorkspace((value) => !value)}
                  >
                    <span
                      className={cn(
                        "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                        assigneeUseProjectWorkspace ? "translate-x-4.5" : "translate-x-0.5"
                      )}
                    />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Description */}
        <div className={cn("px-4 pb-2 overflow-y-auto min-h-0 border-t border-border/60 pt-3", expanded ? "flex-1" : "")}>
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            mentions={mentionOptions}
            contentClassName={cn("text-sm text-muted-foreground", expanded ? "min-h-[220px]" : "min-h-[120px]")}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>

        {/* Property chips bar */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap shrink-0">
          {/* Status chip */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <CircleDot className={cn("h-3 w-3", currentStatus.color)} />
                {currentStatus.label}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {statuses.map((s) => (
                <button
                  key={s.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    s.value === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  <CircleDot className={cn("h-3 w-3", s.color)} />
                  {s.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Priority chip */}
          <Popover open={priorityOpen} onOpenChange={setPriorityOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                {currentPriority ? (
                  <>
                    <currentPriority.icon className={cn("h-3 w-3", currentPriority.color)} />
                    {currentPriority.label}
                  </>
                ) : (
                  <>
                    <Minus className="h-3 w-3 text-muted-foreground" />
                    Priority
                  </>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {priorities.map((p) => (
                <button
                  key={p.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    p.value === priority && "bg-accent"
                  )}
                  onClick={() => { setPriority(p.value); setPriorityOpen(false); }}
                >
                  <p.icon className={cn("h-3 w-3", p.color)} />
                  {p.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Work mode — D8 planning gate */}
          <Popover open={workModeOpen} onOpenChange={setWorkModeOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
                  workMode === "planning" &&
                    "border-amber-500/50 text-amber-600 dark:text-amber-400 bg-amber-500/10"
                )}
              >
                {workMode === "planning" ? (
                  <ClipboardList className="h-3 w-3" />
                ) : (
                  <Hammer className="h-3 w-3 text-muted-foreground" />
                )}
                {workMode === "planning" ? "Planning" : "Standard"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              <button
                type="button"
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                  workMode === "standard" && "bg-accent"
                )}
                onClick={() => { setWorkMode("standard"); setWorkModeOpen(false); }}
              >
                <Hammer className="h-3 w-3 text-muted-foreground" />
                Standard
              </button>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                  workMode === "planning" && "bg-accent"
                )}
                onClick={() => { setWorkMode("planning"); setWorkModeOpen(false); }}
              >
                <ClipboardList className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                Planning
              </button>
            </PopoverContent>
          </Popover>

          {/* Attach image chip */}
          <input
            ref={attachInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={handleAttachImage}
          />
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground"
            onClick={() => attachInputRef.current?.click()}
            disabled={uploadDescriptionImage.isPending}
          >
            <Paperclip className="h-3 w-3" />
            {uploadDescriptionImage.isPending ? "Uploading..." : "Image"}
          </button>

          {/* Advanced disclosure — reveals Environment, Task workspace mode, and (when the
              assignee supports it) the model/thinking-effort/Chrome overrides card. */}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
          >
            {advancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <SlidersHorizontal className="h-3 w-3" />
            Advanced
          </button>
        </div>

        {advancedOpen && (
          <div className="flex items-center gap-1.5 px-4 pb-2 border-t border-border/60 pt-2 flex-wrap shrink-0">
            {/* Environment chip */}
            <Popover open={envPickerOpen} onOpenChange={setEnvPickerOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
                    executionEnvironmentId ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  <Layers className="h-3 w-3" />
                  {executionEnvironmentId
                    ? ((environments ?? []).find((e) => e.id === executionEnvironmentId)?.name ?? "Environment")
                    : "Environment"}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-1" align="start">
                <button
                  type="button"
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    executionEnvironmentId === null && "bg-accent"
                  )}
                  onClick={() => { setExecutionEnvironmentId(null); setEnvPickerOpen(false); }}
                >
                  <Layers className="h-3 w-3 text-muted-foreground" />
                  None
                </button>
                {(environments ?? []).map((env) => (
                  <button
                    key={env.id}
                    type="button"
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      executionEnvironmentId === env.id && "bg-accent"
                    )}
                    onClick={() => { setExecutionEnvironmentId(env.id); setEnvPickerOpen(false); }}
                  >
                    <Layers className="h-3 w-3 text-muted-foreground" />
                    <span className="truncate">{env.name}</span>
                  </button>
                ))}
                {(environments ?? []).length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No environments configured.
                  </div>
                )}
              </PopoverContent>
            </Popover>

            {selectedProjectHasWorkspacePolicy && (
              <Popover open={workspacePickerOpen} onOpenChange={setWorkspacePickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
                      canChooseTaskWorkspace ? "text-foreground" : "text-muted-foreground"
                    )}
                    disabled={!canChooseTaskWorkspace}
                    title={
                      canChooseTaskWorkspace
                        ? undefined
                        : !allowTaskWorkspaceOverride
                          ? "Task-level workspace overrides are disabled in department Settings."
                          : "Your role cannot change task workspace settings."
                    }
                  >
                    <FolderGit2 className="h-3 w-3" />
                    {workspaceModeLabel}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-1" align="start">
                  <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                    Department default: {defaultWorkspaceLabel}
                  </div>
                  {[
                    ["inherit", "Use department default"],
                    ["shared_workspace", "Shared workspace"],
                    ["isolated_workspace", "Isolated workspace"],
                  ].map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className={cn(
                        "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                        taskWorkspaceMode === mode && "bg-accent"
                      )}
                      onClick={() => {
                        setTaskWorkspaceMode(mode as TaskWorkspaceMode);
                        setReuseWorkspaceId("");
                        setWorkspacePickerOpen(false);
                      }}
                    >
                      <FolderGit2 className="h-3 w-3 text-muted-foreground" />
                      {label}
                    </button>
                  ))}
                  {reuseWorkspaceCandidates.length > 0 && (
                    <div className="mt-1 border-t border-border pt-1">
                      {reuseWorkspaceCandidates.slice(0, 6).map((workspace) => (
                        <button
                          key={workspace.id}
                          type="button"
                          className={cn(
                            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                            taskWorkspaceMode === "reuse_existing"
                              && reuseWorkspaceId === workspace.id
                              && "bg-accent"
                          )}
                          onClick={() => {
                            setTaskWorkspaceMode("reuse_existing");
                            setReuseWorkspaceId(workspace.id);
                            setWorkspacePickerOpen(false);
                          }}
                        >
                          <GitBranch className="h-3 w-3 text-muted-foreground" />
                          <span className="truncate">{workspace.name}</span>
                          {workspace.branchName && (
                            <span className="ml-auto max-w-24 truncate text-muted-foreground">
                              {workspace.branchName}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={discardDraft}
            disabled={!hasDraft && !loadDraft()}
          >
            Discard Draft
          </Button>
          <Button
            size="sm"
            disabled={!title.trim() || createIssue.isPending}
            onClick={handleSubmit}
          >
            {createIssue.isPending ? "Creating..." : "Create Task"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
