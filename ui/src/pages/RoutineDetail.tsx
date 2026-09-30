import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  Braces,
  Clock3,
  Copy,
  History,
  MoreHorizontal,
  Play,
  Plus,
  Repeat,
  Save,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";
import { routinesApi, type RoutineTriggerResponse, type RotateRoutineTriggerResponse } from "../api/routines";
import { heartbeatsApi } from "../api/heartbeats";
import { LiveRunWidget } from "../components/LiveRunWidget";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  autoResizeTextarea,
  catchUpPolicies,
  concurrencyPolicies,
  runStatusBadgeClass,
} from "../lib/routine-constants";
import { buildRoutineTriggerPatch } from "../lib/routine-trigger-patch";
import { timeAgo } from "../lib/timeAgo";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef } from "../components/MarkdownEditor";
import { describeSchedule } from "../components/ScheduleEditor";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Routine, RoutineTrigger } from "@armyofagents/shared";
import { ROUTINE_VARIABLE_NAME_PATTERN } from "@armyofagents/shared";
import { RoutineVariablesEditor } from "@/components/routines/RoutineVariablesEditor";
import { RoutineRunDialog } from "@/components/routines/RoutineRunDialog";
import { RoutineTitleWithVariables } from "@/components/routines/RoutineTitleWithVariables";
import { AddTriggerDialog, type NewTriggerConfig } from "@/components/routines/AddTriggerDialog";
import { RoutineRevisionHistory } from "@/components/routines/RoutineRevisionHistory";

const triggerKinds = ["schedule", "webhook"];
const signingModes = ["bearer", "hmac_sha256"];
const HAS_VALID_VARIABLE_TOKEN_RE = new RegExp(`\\{\\{\\s*${ROUTINE_VARIABLE_NAME_PATTERN}\\s*\\}\\}`);
const routineTabs = ["triggers", "runs", "variables", "activity", "history"] as const;

type RoutineTab = (typeof routineTabs)[number];

type SecretMessage = {
  title: string;
  webhookUrl: string;
  webhookSecret: string;
};

function isRoutineTab(value: string | null): value is RoutineTab {
  return value !== null && routineTabs.includes(value as RoutineTab);
}

function getRoutineTabFromSearch(search: string): RoutineTab {
  const tab = new URLSearchParams(search).get("tab");
  return isRoutineTab(tab) ? tab : "triggers";
}

function formatActivityDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map((item) => formatActivityDetailValue(item)).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function formatActivityAction(action: string): string {
  const parts = action.split(".");
  const verb = parts[parts.length - 1];
  const subject = parts.length > 1 ? parts[0] : null;
  const verbFormatted = verb.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
  if (subject === "routine" || !subject) return verbFormatted;
  const subjectFormatted = subject.replace("routine_", "").replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
  return `${subjectFormatted} ${verb.replaceAll("_", " ")}`.replace(/^\w/, (c) => c.toUpperCase());
}

function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function formatNextRun(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const todayStr = now.toDateString();
  const tomorrowStr = new Date(now.getTime() + 86400000).toDateString();
  const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === todayStr) return `Today, ${timeStr}`;
  if (d.toDateString() === tomorrowStr) return `Tomorrow, ${timeStr}`;
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + `, ${timeStr}`;
}

function TriggerCard({
  trigger,
  onSave,
  onRotate,
  onDelete,
}: {
  trigger: RoutineTrigger;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const editInitialConfig = useMemo<NewTriggerConfig>(() => ({
    kind: trigger.kind as "schedule" | "webhook",
    cronExpression: trigger.cronExpression ?? undefined,
    signingMode: (trigger.signingMode as "bearer" | "hmac_sha256") ?? undefined,
    replayWindowSec: trigger.replayWindowSec ?? undefined,
    label: trigger.label ?? undefined,
  }), [trigger.kind, trigger.cronExpression, trigger.signingMode, trigger.replayWindowSec, trigger.label]);

  const isSchedule = trigger.kind === "schedule";
  const isWebhook  = trigger.kind === "webhook";
  const accentClass    = isSchedule ? "bg-blue-500"   : isWebhook ? "bg-purple-500"   : "bg-muted-foreground";
  const kindColorClass = isSchedule ? "text-blue-400" : isWebhook ? "text-purple-400" : "text-muted-foreground";

  const mainDescription = isSchedule && trigger.cronExpression
    ? describeSchedule(trigger.cronExpression)
    : isWebhook
      ? `${trigger.signingMode ?? "bearer"} · ${trigger.replayWindowSec ?? 300}s replay`
      : trigger.label ?? trigger.kind;

  const customLabel = trigger.label && trigger.label !== trigger.kind ? trigger.label : null;

  const lastResultColor = trigger.lastResult === "success"
    ? "text-emerald-400"
    : trigger.lastResult
      ? "text-red-400"
      : "text-muted-foreground/40";

  return (
    <>
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="flex items-stretch">
          {/* Accent stripe */}
          <div className={`w-[3px] shrink-0 ${accentClass}`} />

          {/* Kind badge + description */}
          <div className="flex flex-1 min-w-0 items-center px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className={`mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest ${kindColorClass}`}>
                {isSchedule ? <Clock3 className="h-3 w-3" /> : isWebhook ? <Webhook className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
                {trigger.kind}
                {customLabel && <span className="text-muted-foreground/50 normal-case font-normal tracking-normal">· {customLabel}</span>}
              </div>
              <p className="text-sm font-semibold text-foreground leading-tight">{mainDescription}</p>
            </div>
          </div>

          {/* Divider */}
          <div className="w-px bg-border shrink-0 my-2" />

          {/* Stats */}
          <div className="flex shrink-0 flex-col justify-center gap-1.5 px-4 py-3 w-[148px]">
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-0.5">Next run</p>
              <p className="text-xs font-medium text-foreground/80 leading-tight">
                {trigger.nextRunAt ? formatNextRun(trigger.nextRunAt) : "—"}
              </p>
            </div>
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-0.5">Last result</p>
              <p className={`text-xs font-medium capitalize leading-tight ${lastResultColor}`}>
                {trigger.lastResult ?? "—"}
              </p>
            </div>
          </div>

          {/* Divider */}
          <div className="w-px bg-border shrink-0 my-2" />

          {/* Kebab */}
          <div className="flex shrink-0 items-center px-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem onClick={() => setEditOpen(true)}>
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* ── Edit modal ── */}
      <AddTriggerDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        onSave={(config) => {
          onSave(trigger.id, buildRoutineTriggerPatch(trigger, {
            label: config.label ?? "",
            cronExpression: config.cronExpression ?? "",
            signingMode: config.signingMode ?? "bearer",
            replayWindowSec: String(config.replayWindowSec ?? 300),
          }, getLocalTimezone()));
          setEditOpen(false);
        }}
        isPending={false}
        editMode
        initialConfig={editInitialConfig}
      />

      {/* ── Delete confirmation ── */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete trigger?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">{mainDescription}</span>
              {" "}will be permanently removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onDelete(trigger.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function RoutineDetail() {
  const { routineId } = useParams<{ routineId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToast();
  const hydratedRoutineIdRef = useRef<string | null>(null);
  const latestRevisionIdRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const [secretMessage, setSecretMessage] = useState<SecretMessage | null>(null);
  const [addTriggerOpen, setAddTriggerOpen] = useState(false);
  const [addTriggerDefaultKind, setAddTriggerDefaultKind] = useState<"schedule" | "webhook">("schedule");
  const [editDraft, setEditDraft] = useState({
    title: "",
    description: "",
    projectId: "",
    assigneeAgentId: "",
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
  });
  const activeTab = useMemo(() => getRoutineTabFromSearch(location.search), [location.search]);

  const { data: routine, isLoading, error } = useQuery({
    queryKey: queryKeys.routines.detail(routineId!),
    queryFn: () => routinesApi.get(routineId!),
    enabled: !!routineId,
  });
  const activeIssueId = routine?.activeIssue?.id;
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(activeIssueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(activeIssueId!),
    enabled: !!activeIssueId,
    refetchInterval: 3000,
  });
  const hasLiveRun = (liveRuns ?? []).length > 0;
  const { data: routineRuns } = useQuery({
    queryKey: queryKeys.routines.runs(routineId!),
    queryFn: () => routinesApi.listRuns(routineId!),
    enabled: !!routineId,
    refetchInterval: hasLiveRun ? 3000 : false,
  });
  const relatedActivityIds = useMemo(
    () => ({
      triggerIds: routine?.triggers.map((trigger) => trigger.id) ?? [],
      runIds: routineRuns?.map((run) => run.id) ?? [],
    }),
    [routine?.triggers, routineRuns],
  );
  const { data: activity } = useQuery({
    queryKey: [
      ...queryKeys.routines.activity(selectedCompanyId!, routineId!),
      relatedActivityIds.triggerIds.join(","),
      relatedActivityIds.runIds.join(","),
    ],
    queryFn: () => routinesApi.activity(selectedCompanyId!, routineId!, relatedActivityIds),
    enabled: !!selectedCompanyId && !!routineId && !!routine,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const routineDefaults = useMemo(
    () =>
      routine
        ? {
            title: routine.title,
            description: routine.description ?? "",
            projectId: routine.projectId ?? "",
            assigneeAgentId: routine.assigneeAgentId ?? "",
            priority: routine.priority,
            concurrencyPolicy: routine.concurrencyPolicy as string,
            catchUpPolicy: routine.catchUpPolicy as string,
          }
        : null,
    [routine],
  );
  const isEditDirty = useMemo(() => {
    if (!routineDefaults) return false;
    return (
      editDraft.title !== routineDefaults.title ||
      editDraft.description !== routineDefaults.description ||
      editDraft.projectId !== routineDefaults.projectId ||
      editDraft.assigneeAgentId !== routineDefaults.assigneeAgentId ||
      editDraft.priority !== routineDefaults.priority ||
      editDraft.concurrencyPolicy !== routineDefaults.concurrencyPolicy ||
      editDraft.catchUpPolicy !== routineDefaults.catchUpPolicy
    );
  }, [editDraft, routineDefaults]);

  useEffect(() => {
    if (!routine) return;
    setBreadcrumbs([{ label: "Routines", href: "/routines" }, { label: routine.title }]);
    if (!routineDefaults) return;

    const changedRoutine = hydratedRoutineIdRef.current !== routine.id;
    if (changedRoutine || !isEditDirty) {
      setEditDraft(routineDefaults);
      hydratedRoutineIdRef.current = routine.id;
      latestRevisionIdRef.current = routine.latestRevisionId ?? null;
    }
  }, [routine, routineDefaults, isEditDirty, setBreadcrumbs]);

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [editDraft.title, routine?.id]);

  const copySecretValue = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast({ title: `${label} copied`, tone: "success" });
    } catch (error) {
      pushToast({
        title: `Failed to copy ${label.toLowerCase()}`,
        body: error instanceof Error ? error.message : "Clipboard access was denied.",
        tone: "error",
      });
    }
  };

  const setActiveTab = (value: string) => {
    if (!routineId || !isRoutineTab(value)) return;
    const params = new URLSearchParams(location.search);
    if (value === "triggers") {
      params.delete("tab");
    } else {
      params.set("tab", value);
    }
    const search = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
      },
      { replace: true },
    );
  };

  const refreshRoutineRevisionQueries = async (updated: Routine) => {
    latestRevisionIdRef.current = updated.latestRevisionId ?? null;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.revisions(routineId!) }),
    ]);
  };

  const saveRoutine = useMutation({
    mutationFn: () => {
      return routinesApi.update(routineId!, {
        ...editDraft,
        description: editDraft.description.trim() || null,
        baseRevisionId: latestRevisionIdRef.current,
      });
    },
    onSuccess: async (updated) => {
      await refreshRoutineRevisionQueries(updated);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to save routine",
        body: error instanceof Error ? error.message : "AoA could not save the routine.",
        tone: "error",
      });
    },
  });

  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const handleRunComplete = async () => {
    setActiveTab("runs");
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.runs(routineId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
    ]);
  };

  const updateRoutineStatus = useMutation({
    mutationFn: (status: string) => routinesApi.update(routineId!, {
      status,
      baseRevisionId: latestRevisionIdRef.current,
    }),
    onSuccess: async (updated, status) => {
      pushToast({
        title: "Routine saved",
        body: status === "paused" ? "Automation paused." : "Automation enabled.",
        tone: "success",
      });
      await refreshRoutineRevisionQueries(updated);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update routine",
        body: error instanceof Error ? error.message : "AoA could not update the routine.",
        tone: "error",
      });
    },
  });

  const createTrigger = useMutation({
    mutationFn: async (config: NewTriggerConfig): Promise<RoutineTriggerResponse> => {
      const existingOfKind = (routine?.triggers ?? []).filter((t) => t.kind === config.kind).length;
      const autoLabel = config.label ?? (existingOfKind > 0 ? `${config.kind}-${existingOfKind + 1}` : config.kind);
      return routinesApi.createTrigger(routineId!, {
        kind: config.kind,
        label: autoLabel,
        ...(config.kind === "schedule"
          ? { cronExpression: (config.cronExpression ?? "").trim(), timezone: getLocalTimezone() }
          : {}),
        ...(config.kind === "webhook"
          ? {
            signingMode: config.signingMode ?? "bearer",
            replayWindowSec: config.replayWindowSec ?? 300,
          }
          : {}),
      });
    },
    onSuccess: async (result) => {
      if (result.secretMaterial) {
        setSecretMessage({
          title: "Webhook trigger created",
          webhookUrl: result.secretMaterial.webhookUrl,
          webhookSecret: result.secretMaterial.webhookSecret,
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to add trigger",
        body: error instanceof Error ? error.message : "AoA could not create the trigger.",
        tone: "error",
      });
    },
  });

  const handleAddTriggers = async (configs: NewTriggerConfig[]) => {
    for (const config of configs) {
      await createTrigger.mutateAsync(config);
    }
    setAddTriggerOpen(false);
  };

  const updateTrigger = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => routinesApi.updateTrigger(id, patch),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update trigger",
        body: error instanceof Error ? error.message : "AoA could not update the trigger.",
        tone: "error",
      });
    },
  });

  const deleteTrigger = useMutation({
    mutationFn: (id: string) => routinesApi.deleteTrigger(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to delete trigger",
        body: error instanceof Error ? error.message : "AoA could not delete the trigger.",
        tone: "error",
      });
    },
  });

  const rotateTrigger = useMutation({
    mutationFn: (id: string): Promise<RotateRoutineTriggerResponse> => routinesApi.rotateTriggerSecret(id),
    onSuccess: async (result) => {
      setSecretMessage({
        title: "Webhook secret rotated",
        webhookUrl: result.secretMaterial.webhookUrl,
        webhookSecret: result.secretMaterial.webhookSecret,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to rotate webhook secret",
        body: error instanceof Error ? error.message : "AoA could not rotate the webhook secret.",
        tone: "error",
      });
    },
  });

  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [routine?.id]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      (projects ?? []).map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [projects],
  );
  const currentAssignee = editDraft.assigneeAgentId ? agentById.get(editDraft.assigneeAgentId) ?? null : null;
  const currentProject = editDraft.projectId ? projectById.get(editDraft.projectId) ?? null : null;

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message="Select a company to view routines." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  if (error || !routine) {
    return (
      <p className="pt-6 text-sm text-destructive">
        {error instanceof Error ? error.message : "Routine not found"}
      </p>
    );
  }

  const automationEnabled = routine.status === "active";
  const automationToggleDisabled = updateRoutineStatus.isPending || routine.status === "archived";
  const automationLabel = routine.status === "archived" ? "Archived" : automationEnabled ? "Active" : "Paused";
  const automationLabelClassName = routine.status === "archived"
    ? "text-muted-foreground"
    : automationEnabled
      ? "text-emerald-400"
      : "text-muted-foreground";

  return (
    <div className="p-5 space-y-4">
      {/* ─── Definition card ─── */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        {/* Header row: icon + title + actions */}
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent">
            <Repeat className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <textarea
              ref={titleInputRef}
              className="w-full resize-none overflow-hidden bg-transparent text-xl font-bold outline-none placeholder:text-muted-foreground/50"
              placeholder="Routine title"
              rows={1}
              value={editDraft.title}
              onChange={(event) => {
                setEditDraft((current) => ({ ...current, title: event.target.value }));
                autoResizeTextarea(event.target);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  descriptionEditorRef.current?.focus();
                }
                if (event.key === "Tab" && !event.shiftKey) {
                  event.preventDefault();
                  assigneeSelectorRef.current?.focus();
                }
              }}
            />
            {HAS_VALID_VARIABLE_TOKEN_RE.test(editDraft.title) && (
              <div className="mt-0.5 text-sm text-muted-foreground">
                <RoutineTitleWithVariables template={editDraft.title} />
              </div>
            )}
            {/* Status + metadata badges */}
            <div className="mt-2 flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  automationEnabled
                    ? "bg-emerald-500/15 text-emerald-400"
                    : routine.status === "archived"
                      ? "bg-muted/50 text-muted-foreground"
                      : "bg-amber-500/15 text-amber-400"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    automationEnabled ? "bg-emerald-500" : routine.status === "archived" ? "bg-muted-foreground/40" : "bg-amber-500"
                  }`}
                />
                {automationLabel}
              </span>
              {routine.triggers.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                  <Clock3 className="h-3 w-3" />
                  {routine.triggers.length} trigger{routine.triggers.length !== 1 ? "s" : ""}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground/60">Created {timeAgo(routine.createdAt)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => setRunDialogOpen(true)} disabled={routine.status === "archived"}>
              <Play className="mr-1.5 h-3.5 w-3.5" /> Run now
            </Button>
            <button
              type="button"
              role="switch"
              data-slot="toggle"
              aria-checked={automationEnabled}
              aria-label={automationEnabled ? "Pause automatic triggers" : "Enable automatic triggers"}
              disabled={automationToggleDisabled}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                automationEnabled ? "bg-emerald-500" : "bg-muted-foreground/30"
              } ${automationToggleDisabled ? "cursor-not-allowed opacity-50" : ""}`}
              onClick={() => updateRoutineStatus.mutate(automationEnabled ? "paused" : "active")}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
                  automationEnabled ? "translate-x-4.5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </div>

        {/* Secret message banner */}
        {secretMessage && (
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 space-y-3 text-sm">
            <div>
              <p className="font-medium">{secretMessage.title}</p>
              <p className="text-xs text-muted-foreground">Save this now. AoA will not show the secret value again.</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Input value={secretMessage.webhookUrl} readOnly className="flex-1" />
                <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook URL", secretMessage.webhookUrl)}>
                  <Copy className="h-3.5 w-3.5 mr-1" />URL
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Input value={secretMessage.webhookSecret} readOnly className="flex-1" />
                <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook secret", secretMessage.webhookSecret)}>
                  <Copy className="h-3.5 w-3.5 mr-1" />Secret
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Instructions */}
        <MarkdownEditor
          ref={descriptionEditorRef}
          value={editDraft.description}
          onChange={(description) => setEditDraft((current) => ({ ...current, description }))}
          placeholder="Add instructions..."
          bordered={false}
          contentClassName="min-h-[100px] text-[15px] leading-7"
          onSubmit={() => {
            if (!saveRoutine.isPending && editDraft.title.trim()) {
              saveRoutine.mutate();
            }
          }}
        />

        {/* Properties grid */}
        <div className="grid grid-cols-3 gap-x-6 gap-y-4 border-t border-border pt-4">
          {/* Agent */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Agent</p>
            <InlineEntitySelector
              ref={assigneeSelectorRef}
              value={editDraft.assigneeAgentId}
              options={assigneeOptions}
              placeholder="Assignee"
              noneLabel="No assignee"
              searchPlaceholder="Search assignees..."
              emptyMessage="No assignees found."
              onChange={(assigneeAgentId) => {
                if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
                setEditDraft((current) => ({ ...current, assigneeAgentId }));
              }}
              onConfirm={() => projectSelectorRef.current?.focus()}
              renderTriggerValue={(option) =>
                option ? (
                  currentAssignee ? (
                    <>
                      <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="truncate">{option.label}</span>
                  )
                ) : (
                  <span className="text-muted-foreground/60">No assignee</span>
                )
              }
              renderOption={(option) => {
                if (!option.id) return <span className="truncate">{option.label}</span>;
                const assignee = agentById.get(option.id);
                return (
                  <>
                    {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                    <span className="truncate">{option.label}</span>
                  </>
                );
              }}
            />
          </div>

          {/* Project */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Project</p>
            <InlineEntitySelector
              ref={projectSelectorRef}
              value={editDraft.projectId}
              options={projectOptions}
              placeholder="Project"
              noneLabel="No project"
              searchPlaceholder="Search projects..."
              emptyMessage="No projects found."
              onChange={(projectId) => setEditDraft((current) => ({ ...current, projectId }))}
              onConfirm={() => descriptionEditorRef.current?.focus()}
              renderTriggerValue={(option) =>
                option && currentProject ? (
                  <>
                    <span
                      className="h-3.5 w-3.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: currentProject.color ?? "#64748b" }}
                    />
                    <span className="truncate">{option.label}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground/60">No project</span>
                )
              }
              renderOption={(option) => {
                if (!option.id) return <span className="truncate">{option.label}</span>;
                const project = projectById.get(option.id);
                return (
                  <>
                    <span
                      className="h-3.5 w-3.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: project?.color ?? "#64748b" }}
                    />
                    <span className="truncate">{option.label}</span>
                  </>
                );
              }}
            />
          </div>

          {/* Priority */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Priority</p>
            <Select
              value={editDraft.priority}
              onValueChange={(priority) => setEditDraft((current) => ({ ...current, priority }))}
            >
              <SelectTrigger className="h-8 w-full text-xs capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["critical", "high", "medium", "low"].map((p) => (
                  <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Concurrency */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Concurrency</p>
            <Select
              value={editDraft.concurrencyPolicy}
              onValueChange={(concurrencyPolicy) => setEditDraft((current) => ({ ...current, concurrencyPolicy }))}
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {concurrencyPolicies.map((value) => (
                  <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Catch-up */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Catch-up</p>
            <Select
              value={editDraft.catchUpPolicy}
              onValueChange={(catchUpPolicy) => setEditDraft((current) => ({ ...current, catchUpPolicy }))}
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {catchUpPolicies.map((value) => (
                  <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Modified */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Modified</p>
            <p className="text-sm text-muted-foreground">{timeAgo(routine.updatedAt)}</p>
          </div>
        </div>
      </div>

      {/* Sticky save bar — only renders when dirty */}
      {isEditDirty && (
        <div className="sticky bottom-0 z-10 border border-amber-500/30 bg-amber-950/60 backdrop-blur-sm px-5 py-3 rounded-lg flex items-center justify-between">
          <span className="text-sm text-amber-200">⚠ Unsaved changes</span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (routineDefaults) {
                  setEditDraft({
                    ...routineDefaults,
                    projectId: routineDefaults.projectId ?? "",
                    assigneeAgentId: routineDefaults.assigneeAgentId ?? "",
                  });
                }
              }}
              disabled={saveRoutine.isPending}
            >
              Discard
            </Button>
            <Button
              size="sm"
              onClick={() => saveRoutine.mutate()}
              disabled={saveRoutine.isPending || !editDraft.title.trim()}
            >
              {saveRoutine.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* ─── Tabs ─── */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="triggers" className="gap-1.5">
            <Clock3 className="h-3.5 w-3.5" />
            Triggers
            {routine.triggers.length > 0 && (
              <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {routine.triggers.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="runs" className="gap-1.5">
            <Play className="h-3.5 w-3.5" />
            Runs
            {(routineRuns ?? []).length > 0 && (
              <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {(routineRuns ?? []).length}
              </span>
            )}
            {hasLiveRun && <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />}
          </TabsTrigger>
          <TabsTrigger value="variables" className="gap-1.5">
            <Braces className="h-3.5 w-3.5" />
            Variables
            {routine.variables.length > 0 && (
              <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {routine.variables.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Activity
            {(activity ?? []).length > 0 && (
              <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {(activity ?? []).length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <History className="h-3.5 w-3.5" />
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="triggers" className="space-y-5">
          {[
            { kind: "schedule" as const, label: "Schedule", icon: Clock3, colorClass: "text-blue-400" },
            { kind: "webhook" as const, label: "Webhook", icon: Webhook, colorClass: "text-purple-400" },
          ].map(({ kind, label, icon: Icon, colorClass }) => {
            const kindTriggers = routine.triggers.filter((t) => t.kind === kind);
            const isWebhook = kind === "webhook";
            return (
              <div key={kind}>
                <div className="mb-2 flex items-center justify-between">
                  <div className={`flex items-center gap-1.5 text-xs font-medium ${colorClass}`}>
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                    {kindTriggers.length > 0 && (
                      <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {kindTriggers.length}
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={isWebhook}
                    title={isWebhook ? "Webhook triggers coming soon" : undefined}
                    onClick={() => {
                      setAddTriggerDefaultKind(kind);
                      setAddTriggerOpen(true);
                    }}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    Add
                  </Button>
                </div>
                {kindTriggers.length === 0 ? (
                  <p className="py-2 pl-2 text-xs italic text-muted-foreground/60">No {label.toLowerCase()} triggers</p>
                ) : (
                  <div className="space-y-2">
                    {kindTriggers.map((trigger) => (
                      <TriggerCard
                        key={trigger.id}
                        trigger={trigger}
                        onSave={(id, patch) => updateTrigger.mutate({ id, patch })}
                        onRotate={(id) => rotateTrigger.mutate(id)}
                        onDelete={(id) => deleteTrigger.mutate(id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

        </TabsContent>

        <TabsContent value="runs" className="space-y-4">
          {hasLiveRun && activeIssueId && routine && (
            <LiveRunWidget issueId={activeIssueId} companyId={routine.companyId} />
          )}
          {(routineRuns ?? []).length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">No runs yet.</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Use Run now or add a trigger to start.</p>
            </div>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {(routineRuns ?? []).map((run) => (
                <div key={run.id} className="flex flex-col gap-0.5 px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="secondary" className="shrink-0">{run.source}</Badge>
                      <Badge variant="secondary" className={`shrink-0 ${runStatusBadgeClass(run.status)}`}>
                        {run.status.replaceAll("_", " ")}
                      </Badge>
                      {run.trigger && (
                        <span className="text-muted-foreground truncate">{run.trigger.label ?? run.trigger.kind}</span>
                      )}
                      {run.linkedIssue && (
                        <Link to={`/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`} className="text-muted-foreground hover:underline truncate">
                          {run.linkedIssue.identifier ?? run.linkedIssue.id.slice(0, 8)}
                        </Link>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{timeAgo(run.triggeredAt)}</span>
                  </div>
                  {run.failureReason && (
                    <p className="text-xs text-destructive/80 pl-0.5">{run.failureReason}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="variables">
          <RoutineVariablesEditor
            routineId={routine.id}
            title={routine.title}
            description={routine.description}
            initialVariables={routine.variables}
            getBaseRevisionId={() => latestRevisionIdRef.current}
            onRoutineUpdated={(updated) => {
              void refreshRoutineRevisionQueries(updated);
            }}
          />
        </TabsContent>

        <TabsContent value="activity">
          {(activity ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {(activity ?? []).map((event) => (
                <div key={event.id} className="flex items-start justify-between px-4 py-3 text-xs gap-4">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-foreground/90 shrink-0">{formatActivityAction(event.action)}</span>
                    {event.details && Object.keys(event.details).length > 0 && (
                      <span className="text-muted-foreground truncate">
                        {Object.entries(event.details).slice(0, 3).map(([key, value], i) => (
                          <span key={key}>
                            {i > 0 && <span className="mx-1 text-border">·</span>}
                            <span className="text-muted-foreground/70">{key.replaceAll("_", " ")}:</span>{" "}
                            {formatActivityDetailValue(value)}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground/60 shrink-0">{timeAgo(event.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history">
          <RoutineRevisionHistory
            routineId={routineId!}
            getBaseRevisionId={() => latestRevisionIdRef.current}
            onRestored={(updated) => {
              void refreshRoutineRevisionQueries(updated);
            }}
          />
        </TabsContent>
      </Tabs>

      {routine ? (
        <RoutineRunDialog
          open={runDialogOpen}
          onOpenChange={setRunDialogOpen}
          routineId={routine.id}
          routineTitle={routine.title}
          variables={routine.variables}
          onRunComplete={handleRunComplete}
        />
      ) : null}

      <AddTriggerDialog
        open={addTriggerOpen}
        onOpenChange={setAddTriggerOpen}
        defaultKind={addTriggerDefaultKind}
        onAdd={handleAddTriggers}
        isPending={createTrigger.isPending}
      />
    </div>
  );
}
