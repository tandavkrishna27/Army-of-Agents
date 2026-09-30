import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MEMORY_ITEM_CATEGORIES,
  MEMORY_ITEM_LAYERS,
  type MemoryItemCategory,
  type MemoryItemLayer,
  type Suggestion,
} from "@armyofagents/shared";
import { useDialog } from "../../../context/DialogContext";
import { useToast } from "../../../context/ToastContext";
import { suggestionsApi } from "../../../api/suggestions";
import { memoryApi } from "../../../api/memory";
import { goalsApi } from "../../../api/goals";
import { issuesApi } from "../../../api/issues";
import { queryKeys } from "../../../lib/queryKeys";
import { Identity } from "../../Identity";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ArrowRightLeft,
  Brain,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  GitPullRequest,
  Lightbulb,
  RotateCcw,
  ShieldAlert,
  Target,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { WidgetShell } from "./WidgetShell";
import { rowsForSize } from "./widgetSizing";
import type { WidgetProps } from "./types";

interface SuggestedMemoryDraft {
  suggestionId: string;
  title: string;
  content: string;
  category: MemoryItemCategory;
  layer: MemoryItemLayer;
  departmentId: string;
  goalId: string;
  taskId: string;
  tags: string;
}

const SUGGESTION_CATEGORY_ICONS: Record<Suggestion["category"], LucideIcon> = {
  goal_gap: Target,
  pipeline_bottleneck: Workflow,
  memory_gap: Brain,
  pattern_detected: RotateCcw,
  budget_optimization: CircleDollarSign,
  recurring_work: CalendarClock,
  risk_flag: ShieldAlert,
  workload_balance: ArrowRightLeft,
  agent_proposal: GitPullRequest,
};

const MEMORY_LAYER_LABELS: Record<MemoryItemLayer, string> = {
  identity: "Identity",
  domain: "Domain",
  active_context: "Active Context",
  working: "Working",
};

function readString(payload: Record<string, unknown> | null | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function readStringArray(payload: Record<string, unknown> | null | undefined, key: string) {
  const value = payload?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readMemoryCategory(payload: Record<string, unknown> | null | undefined): MemoryItemCategory {
  const category = readString(payload, "category", "memoryCategory");
  return MEMORY_ITEM_CATEGORIES.includes(category as MemoryItemCategory) ? category as MemoryItemCategory : "reference";
}

function readMemoryLayer(payload: Record<string, unknown> | null | undefined): MemoryItemLayer {
  const layer = readString(payload, "layer", "memoryLayer");
  return MEMORY_ITEM_LAYERS.includes(layer as MemoryItemLayer) ? layer as MemoryItemLayer : "domain";
}

function getSuggestionTaskDefaults(suggestion: Suggestion) {
  const payload = suggestion.actionPayload;
  return {
    title: readString(payload, "taskTitle", "title") || suggestion.title,
    description: readString(payload, "description", "taskDescription", "content") || suggestion.evidence || "",
    status: readString(payload, "status") || "todo",
    priority: readString(payload, "priority") || "medium",
    projectId: readString(payload, "projectId"),
    assigneeAgentId: readString(payload, "assigneeAgentId", "agentId"),
  };
}

function getSuggestedMemoryDraft(suggestion: Suggestion): SuggestedMemoryDraft {
  const payload = suggestion.actionPayload;
  return {
    suggestionId: suggestion.id,
    title: readString(payload, "memoryTitle", "title") || suggestion.title,
    content: readString(payload, "content", "description", "memoryContent") || suggestion.evidence || "",
    category: readMemoryCategory(payload),
    layer: readMemoryLayer(payload),
    departmentId: readString(payload, "departmentId"),
    goalId: readString(payload, "goalId"),
    taskId: readString(payload, "taskId"),
    tags: readStringArray(payload, "tags").join(", "),
  };
}

function getSuggestionAgentMeta(suggestion: Suggestion) {
  const payload = suggestion.actionPayload;
  const name = readString(payload, "agentName", "proposedByAgentName", "actorName");
  const avatarUrl = readString(payload, "agentAvatarUrl", "proposedByAgentAvatarUrl", "avatarUrl");
  return name ? { name, avatarUrl: avatarUrl || null } : null;
}

function getArchiveTargetTitle(suggestion: Suggestion) {
  return readString(suggestion.actionPayload, "memoryTitle", "targetTitle", "title") || suggestion.title;
}

function SuggestionCard({
  suggestion,
  exiting,
  busy,
  canAct,
  onAccept,
  onDismiss,
}: {
  suggestion: Suggestion;
  exiting: boolean;
  busy: boolean;
  /** Accept/dismiss are founder-gated server-side — hide the actions when false. */
  canAct: boolean;
  onAccept: (suggestion: Suggestion) => void;
  onDismiss: (suggestion: Suggestion) => void;
}) {
  const Icon = SUGGESTION_CATEGORY_ICONS[suggestion.category] ?? Lightbulb;
  const agentMeta = suggestion.category === "agent_proposal" ? getSuggestionAgentMeta(suggestion) : null;

  return (
    <div
      className={`rounded-md border border-border bg-card p-4 transition-all duration-200 ${
        exiting ? "opacity-0 translate-x-2 scale-[0.98]" : "opacity-100 translate-x-0"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium leading-5">{suggestion.title}</h3>
              {suggestion.evidence && <p className="mt-1 text-sm text-muted-foreground">{suggestion.evidence}</p>}
            </div>
            {agentMeta && (
              <div className="rounded-full border border-border bg-muted/40 px-2 py-1 text-xs">
                <Identity name={agentMeta.name} avatarUrl={agentMeta.avatarUrl} size="xs" />
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground capitalize">{suggestion.category.replace(/_/g, " ")}</span>
            {canAct && (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => onDismiss(suggestion)} disabled={busy}>
                  Dismiss
                </Button>
                <Button size="sm" onClick={() => onAccept(suggestion)} disabled={busy}>
                  Accept
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SuggestedMemoryDialog({
  companyId,
  draft,
  open,
  onOpenChange,
  onCreated,
}: {
  companyId: string;
  draft: SuggestedMemoryDraft | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<MemoryItemCategory>("reference");
  const [layer, setLayer] = useState<MemoryItemLayer>("domain");
  const [departmentId, setDepartmentId] = useState("");
  const [goalId, setGoalId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [tags, setTags] = useState("");

  useEffect(() => {
    if (!draft || !open) return;
    setTitle(draft.title);
    setContent(draft.content);
    setCategory(draft.category);
    setLayer(draft.layer);
    setDepartmentId(draft.departmentId);
    setGoalId(draft.goalId);
    setTaskId(draft.taskId);
    setTags(draft.tags);
  }, [draft, open]);

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: open && layer === "active_context",
  });

  const { data: tasks } = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
    enabled: open && layer === "working",
  });

  const createMemory = useMutation({
    mutationFn: async () => {
      await memoryApi.create(companyId, {
        title: title.trim(),
        content: content.trim(),
        category,
        source: "founder",
        status: "approved",
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        departmentId: departmentId || null,
        createdBy: "founder",
        layer,
        priority: 0,
        visibility: departmentId ? "scoped" : "shared",
        goalId: layer === "active_context" && goalId ? goalId : null,
        taskId: layer === "working" && taskId ? taskId : null,
      });
      await onCreated();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
      onOpenChange(false);
      pushToast({ title: "Suggestion accepted", body: "Memory item created", tone: "success" });
    },
    onError: (error: Error) => {
      pushToast({ title: "Unable to create memory item", body: error.message, tone: "error" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Suggested Memory</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="dashboard-memory-title">Title</Label>
            <Input id="dashboard-memory-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={(value) => setCategory(value as MemoryItemCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_ITEM_CATEGORIES.map((item) => (
                    <SelectItem key={item} value={item} className="capitalize">
                      {item.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Layer</Label>
              <Select value={layer} onValueChange={(value) => setLayer(value as MemoryItemLayer)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_ITEM_LAYERS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {MEMORY_LAYER_LABELS[item]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {layer === "active_context" && (
            <div className="space-y-1.5">
              <Label>Goal</Label>
              <Select value={goalId || "none"} onValueChange={(value) => setGoalId(value === "none" ? "" : value)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a goal" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {(goals ?? []).map((goal) => (
                    <SelectItem key={goal.id} value={goal.id}>
                      {goal.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {layer === "working" && (
            <div className="space-y-1.5">
              <Label>Task</Label>
              <Select value={taskId || "none"} onValueChange={(value) => setTaskId(value === "none" ? "" : value)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a task" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {(tasks ?? []).map((task) => (
                    <SelectItem key={task.id} value={task.id}>
                      {task.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="dashboard-memory-tags">Tags</Label>
            <Input id="dashboard-memory-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dashboard-memory-content">Content</Label>
            <Textarea
              id="dashboard-memory-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={createMemory.isPending}>
            Cancel
          </Button>
          <Button onClick={() => createMemory.mutate()} disabled={!title.trim() || !content.trim() || createMemory.isPending}>
            {createMemory.isPending ? "Saving..." : "Create Memory"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SuggestionsWidget({ companyId, role, editing, size }: WidgetProps) {
  const canAct = role === "founder";
  const maxVisible = rowsForSize(size);
  const { openNewIssue } = useDialog();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);
  const [exitingSuggestionIds, setExitingSuggestionIds] = useState<string[]>([]);
  const [busySuggestionIds, setBusySuggestionIds] = useState<string[]>([]);
  const [archiveConfirm, setArchiveConfirm] = useState<Suggestion | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<SuggestedMemoryDraft | null>(null);

  const { data: suggestions = [], isLoading: suggestionsLoading } = useQuery({
    queryKey: queryKeys.suggestions.pending(companyId),
    queryFn: () => suggestionsApi.pending(companyId),
    enabled: !!companyId,
  });

  const detectSuggestions = useMutation({
    mutationFn: (companyId: string) => suggestionsApi.detect(companyId),
    onSuccess: async (_, companyId) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.suggestions.pending(companyId) });
    },
  });

  // N2: POST /suggestions/detect is founder-gated server-side — firing it for
  // every user guaranteed a 403 on each Home load for non-founders. Gate the
  // trigger on the founder role (instance admins report role "founder" via the
  // team summary, so local_trusted keeps working).
  useEffect(() => {
    if (!companyId || !canAct) return;
    detectSuggestions.mutate(companyId);
    // Trigger detection when the page loads for the active company (once the
    // founder role is confirmed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, canAct]);

  const acceptSuggestion = useMutation({
    mutationFn: ({ companyId, suggestionId }: { companyId: string; suggestionId: string }) =>
      suggestionsApi.accept(companyId, suggestionId),
  });

  const dismissSuggestion = useMutation({
    mutationFn: ({ companyId, suggestionId }: { companyId: string; suggestionId: string }) =>
      suggestionsApi.dismiss(companyId, suggestionId),
  });

  const visibleSuggestions = useMemo(
    () => (showAllSuggestions ? suggestions : suggestions.slice(0, maxVisible)),
    [showAllSuggestions, suggestions, maxVisible],
  );

  function markSuggestionBusy(suggestionId: string, busy: boolean) {
    setBusySuggestionIds((current) =>
      busy ? [...new Set([...current, suggestionId])] : current.filter((id) => id !== suggestionId),
    );
  }

  function removeSuggestionCard(suggestionId: string) {
    setExitingSuggestionIds((current) => [...new Set([...current, suggestionId])]);
    window.setTimeout(() => {
      queryClient.setQueryData<Suggestion[]>(
        queryKeys.suggestions.pending(companyId),
        (current) => (current ?? []).filter((suggestion) => suggestion.id !== suggestionId),
      );
      setExitingSuggestionIds((current) => current.filter((id) => id !== suggestionId));
    }, 180);
  }

  async function acceptAndRemove(suggestion: Suggestion) {
    if (!companyId) return;
    markSuggestionBusy(suggestion.id, true);
    try {
      await acceptSuggestion.mutateAsync({ companyId, suggestionId: suggestion.id });
      removeSuggestionCard(suggestion.id);
    } finally {
      markSuggestionBusy(suggestion.id, false);
    }
  }

  async function handleAccept(suggestion: Suggestion) {
    if (!companyId) return;

    try {
      switch (suggestion.actionType) {
        case "create_task":
          openNewIssue({
            ...getSuggestionTaskDefaults(suggestion),
            onCreated: async () => {
              try {
                await acceptAndRemove(suggestion);
                pushToast({ title: "Suggestion accepted", body: "Task created", tone: "success" });
              } catch (error) {
                const message = error instanceof Error ? error.message : "Unable to accept suggestion";
                pushToast({ title: "Task created, but suggestion was not cleared", body: message, tone: "error" });
              }
            },
          });
          return;
        case "suggest_memory":
          setMemoryDraft(getSuggestedMemoryDraft(suggestion));
          return;
        case "archive_memory":
          setArchiveConfirm(suggestion);
          return;
        case "flag_risk":
          await acceptAndRemove(suggestion);
          pushToast({ title: "Suggestion accepted", body: "Risk flagged", tone: "success" });
          return;
        default:
          await acceptAndRemove(suggestion);
          pushToast({ title: "Suggestion accepted", tone: "success" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to accept suggestion";
      pushToast({ title: "Unable to accept suggestion", body: message, tone: "error" });
    }
  }

  async function handleArchiveConfirm() {
    if (!archiveConfirm || !companyId) return;
    const suggestion = archiveConfirm;
    setArchiveConfirm(null);
    try {
      await acceptAndRemove(suggestion);
      pushToast({ title: "Suggestion accepted", body: "Memory item archived", tone: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to accept suggestion";
      pushToast({ title: "Unable to accept suggestion", body: message, tone: "error" });
    }
  }

  async function handleDismiss(suggestion: Suggestion) {
    if (!companyId) return;
    markSuggestionBusy(suggestion.id, true);
    try {
      await dismissSuggestion.mutateAsync({ companyId, suggestionId: suggestion.id });
      removeSuggestionCard(suggestion.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to dismiss suggestion";
      pushToast({ title: "Unable to dismiss suggestion", body: message, tone: "error" });
    } finally {
      markSuggestionBusy(suggestion.id, false);
    }
  }

  return (
    <>
      <WidgetShell title="Suggestions" icon={Lightbulb} to="/inbox" editing={editing}>
        <div className="space-y-3">
          {suggestions.length > maxVisible && (
            <div className="flex items-center justify-end">
              <Button variant="link" size="sm" onClick={() => setShowAllSuggestions((current) => !current)}>
                {showAllSuggestions ? "Show less" : "View all"}
              </Button>
            </div>
          )}

          {suggestionsLoading ? (
            <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">
              Refreshing suggestions...
            </div>
          ) : suggestions.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center">
              <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">All caught up</p>
              <p className="mt-1 text-sm text-muted-foreground">No pending suggestions right now.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {visibleSuggestions.map((suggestion) => (
                <SuggestionCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  exiting={exitingSuggestionIds.includes(suggestion.id)}
                  busy={busySuggestionIds.includes(suggestion.id)}
                  canAct={canAct}
                  onAccept={handleAccept}
                  onDismiss={handleDismiss}
                />
              ))}
            </div>
          )}
        </div>
      </WidgetShell>

      <ConfirmDialog
        open={archiveConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveConfirm(null);
        }}
        title={archiveConfirm ? `Archive '${getArchiveTargetTitle(archiveConfirm)}'?` : ""}
        description="This memory item will be archived."
        confirmLabel="Archive"
        onConfirm={handleArchiveConfirm}
      />

      <SuggestedMemoryDialog
        companyId={companyId}
        draft={memoryDraft}
        open={memoryDraft !== null}
        onOpenChange={(open) => {
          if (!open) setMemoryDraft(null);
        }}
        onCreated={async () => {
          if (!memoryDraft) return;
          const suggestion = suggestions.find((item) => item.id === memoryDraft.suggestionId);
          if (!suggestion) {
            setMemoryDraft(null);
            return;
          }
          try {
            await acceptAndRemove(suggestion);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to accept suggestion";
            pushToast({ title: "Memory created, but suggestion was not cleared", body: message, tone: "error" });
          } finally {
            setMemoryDraft(null);
          }
        }}
      />
    </>
  );
}
