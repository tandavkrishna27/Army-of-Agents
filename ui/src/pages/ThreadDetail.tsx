import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { useLiveUpdates } from "../context/LiveUpdatesProvider";
import { useTeamAccess } from "../hooks/useTeamAccess";
import { useComposerDraft } from "../lib/composerDraft";
import { threadsApi, type ThreadListItem, type ThreadDetail as ThreadDetailType } from "../api/threads";
import { api } from "../api/client";
import type {
  DiscussionEntryAttachment,
  ExtractedItem,
  ThreadScopeItem,
  ThreadScopeVersionDetail,
  UpdateScopeItemRequest,
} from "../api/discussions";
import {
  RefreshCw, Pencil, ChevronDown, Pause, Play,
  Archive, MoreHorizontal, X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ThreadTab } from "../components/threads/ThreadTab";
import { ThreadCollapsedTabStrip, ThreadViewer } from "../components/threads/ThreadViewer";
import { ScopeTab } from "../components/threads/ScopeTab";
import { BranchesTab } from "../components/threads/BranchesTab";
import { ThreadErrorBanner } from "../components/threads/ThreadErrorBanner";
import { ThreadVisibilityControls } from "../components/threads/ThreadVisibilityControls";
import type { ScopeItem } from "../components/threads/scopeGrouping";
import { autonomyLabel, type AutonomyValue, type ShowRef } from "@armyofagents/shared";
import {
  OPEN_TAB_KEY,
  browserTab,
  closeTab,
  createOpenTab,
  artifactRefTab,
  ensureTab,
  memoryTab,
  scopeItemToTab,
  showRefToThreadTab,
  taskTab,
  threadAttachmentToTab,
  type ThreadViewerScopeItem,
  type ThreadViewerTab,
  type ThreadOpenRequest,
  threadViewerTabToOpenRequest,
} from "../components/threads/threadViewerModel";

/* ─── Phase constants ─── */

const PHASES = ["discuss", "scope", "assign", "done"] as const;
type Phase = (typeof PHASES)[number];

const NEXT_PHASE: Partial<Record<Phase, Phase>> = {
  discuss: "scope",
  scope:   "assign",
  assign:  "done",
};

const PHASE_LABELS: Record<Phase, string> = {
  discuss: "Discuss",
  scope:   "Scope",
  assign:  "Assign",
  done:    "Done",
};

/* ─── Autonomy pill ─── */

// Canonical 0-2 scale (Manual / Assist / Drive) sourced from @armyofagents/shared.
// Colors keyed on AutonomyValue (0 | 1 | 2).
const AUTONOMY_COLORS: Record<AutonomyValue, { color: string; bgColor: string }> = {
  0: { color: "#D9A938", bgColor: "rgba(217,169,56,0.15)" },
  1: { color: "#60a5fa", bgColor: "rgba(96,165,250,0.15)" },
  2: { color: "#4FB67E", bgColor: "rgba(79,182,126,0.15)" },
};

/* ─── Mobile + center tab types ─── */

const MOBILE_TABS = [
  { key: "origin"   as const, label: "Origin" },
  { key: "thread"   as const, label: "Thread" },
  { key: "scope"    as const, label: "Scope" },
  { key: "branches" as const, label: "Branches" },
  { key: "viewer"   as const, label: "Viewer" },
];

type MobileTab = (typeof MOBILE_TABS)[number]["key"];
type CenterTab = "thread" | "scope" | "branches";

const VIEWER_MIN_WIDTH = 280;
const VIEWER_DEFAULT_WIDTH = 340;
const VIEWER_MIN_CENTER_WIDTH = 520;
const VIEWER_ABSOLUTE_MAX_WIDTH = 1040;

function getViewerMaxWidth() {
  if (typeof window === "undefined") return 920;
  const available = window.innerWidth - VIEWER_MIN_CENTER_WIDTH;
  return Math.max(680, Math.min(VIEWER_ABSOLUTE_MAX_WIDTH, available));
}

/* ─── Phase dot color for left rail ─── */

const PHASE_DOT: Record<string, string> = {
  discuss: "bg-blue-500",
  scope:   "bg-amber-500",
  assign:  "bg-violet-500",
  done:    "bg-green-500",
};

/* ─── initials helper ─── */

function toInitials(id: string | null | undefined): string {
  if (!id) return "?";
  if (id === "local-board") return "LB";
  if (/^[0-9a-f]{8}-/i.test(id)) return "M";
  return (
    id.replace(/[-_]/g, " ").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?"
  );
}

const AGENT_ROLE_COLORS: Array<[RegExp, string]> = [
  [/scribe/i, "#6470DC"], [/adjutant/i, "#D9A938"], [/router/i, "#3FA8C7"],
  [/planner/i, "#5AA87E"], [/dispatcher/i, "#7E8AA8"],
];
function agentColor(name: string | null): string {
  for (const [re, c] of AGENT_ROLE_COLORS) if (re.test(name ?? "")) return c;
  return "#7E8AA8";
}

function apiErrorMessage(error: unknown, fallback: string): string {
  const record = error as { response?: { data?: { error?: unknown } }; message?: unknown };
  const serverMessage = record.response?.data?.error;
  if (typeof serverMessage === "string" && serverMessage.trim().length > 0) return serverMessage;
  if (typeof record.message === "string" && record.message.trim().length > 0) return record.message;
  return fallback;
}

function scopeVersionItemToViewerItem(
  item: ThreadScopeItem,
  scopeVersionId?: string | null,
): ThreadViewerScopeItem & { payload?: Record<string, unknown> } {
  return {
    id: item.id,
    type: item.kind.replaceAll("_", " "),
    kind: item.kind,
    scopeVersionId: scopeVersionId ?? null,
    title: item.title,
    description: item.description,
    status: item.status,
    payload: item.payload,
    resultIssueId: item.resultIssueId,
    resultMemoryId: item.resultMemoryId,
    artifactId: item.artifactId,
    artifactVersionId: item.artifactVersionId,
    sourceEntryIds: item.sourceEntryIds,
    suggestedPriority:
      typeof item.payload.priority === "string" ? item.payload.priority : null,
    suggestedAssigneeId:
      typeof item.payload.assigneeAgentId === "string" ? item.payload.assigneeAgentId : null,
    suggestedDepartmentId:
      typeof item.payload.departmentId === "string" ? item.payload.departmentId : null,
    suggestedLayer:
      typeof item.payload.layer === "string" ? item.payload.layer : null,
  };
}

function payloadString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function sourceSignalToAttachment(item: ThreadScopeItem): DiscussionEntryAttachment | null {
  const assetId = payloadString(item.payload.assetId);
  if (!assetId) return null;
  return {
    id: item.id,
    assetId,
    artifactId: null,
    artifactType: null,
    artifactTitle: null,
    assetContentType: payloadString(item.payload.contentType),
    assetOriginalFilename: payloadString(item.payload.filename) ?? item.title,
    assetByteSize: typeof item.payload.byteSize === "number" ? item.payload.byteSize : null,
  };
}

/* ════════════════════════════════════════════════════════════════════════
   ThreadDetail Page
   ════════════════════════════════════════════════════════════════════════ */

interface ThreadDetailProps {
  embedded?: boolean;
  onViewerWideChange?: (wide: boolean) => void;
  /**
   * D2 (Inbox Hub): when hosted inside a hub tab, the thread id is supplied by
   * prop rather than the route. Takes precedence over `useParams`; when absent
   * the component falls back to the route params (full-page + ThreadsWorkspace
   * embedded usage unchanged).
   */
  discussionId?: string;
  /** D2: prop-supplied company id (hub tab). Falls back to CompanyContext. */
  companyId?: string;
  /** Host-owned nested-detail dispatcher. Omit to retain the Discussions viewer. */
  onOpenRequest?: (request: ThreadOpenRequest) => void;
  /** Host-owned close action for embedded focus panes. */
  onClose?: () => void;
  draftText?: string;
  onDraftTextChange?: (text: string) => void;
}

export function ThreadDetail({
  embedded = false,
  onViewerWideChange,
  discussionId: discussionIdProp,
  companyId: companyIdProp,
  onOpenRequest,
  onClose,
  draftText,
  onDraftTextChange,
}: ThreadDetailProps = {}) {
  void onViewerWideChange;
  const { threadId, discussionId: discussionIdParam } = useParams<{ threadId?: string; discussionId?: string }>();
  // Prop wins over route params so the same component can be hosted in a hub tab.
  const resolvedId = discussionIdProp ?? threadId ?? discussionIdParam;
  const { selectedCompanyId: companyIdFromContext } = useCompany();
  // Prefer the prop company id when the thread is hosted outside its route.
  const selectedCompanyId = companyIdProp ?? companyIdFromContext;
  const { currentUser } = useTeamAccess(selectedCompanyId);
  const scopedDraft = useComposerDraft(
    selectedCompanyId && currentUser?.userId && resolvedId
      ? { companyId: selectedCompanyId, userId: currentUser.userId, surface: "discussion", entityId: resolvedId }
      : null,
  );
  const effectiveDraftText = draftText ?? scopedDraft.draft.text;
  const handleDraftTextChange = onDraftTextChange ?? ((text: string) => scopedDraft.setDraft({ text }));
  const { setBreadcrumbs, setSubtitle, setEntityColor } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [mobileTab, setMobileTab] = useState<MobileTab>("thread");
  const [centerTab, setCenterTab] = useState<CenterTab>("thread");
  const [viewerTabs, setViewerTabs] = useState<ThreadViewerTab[]>(() => [createOpenTab()]);
  const [activeViewerKey, setActiveViewerKey] = useState<string | null>(OPEN_TAB_KEY);
  const [viewerCollapsed, setViewerCollapsed] = useState(false);
  const [viewerWidth, setViewerWidth] = useState(VIEWER_DEFAULT_WIDTH);
  const [isViewerResizing, setIsViewerResizing] = useState(false);
  const [selectedScopeVersionId, setSelectedScopeVersionId] = useState<string | null>(null);

  // Header state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [showTitleEdit, setShowTitleEdit] = useState(false);

  const renameInputRef = useRef<HTMLInputElement>(null);
  const centerHeadingRef = useRef<HTMLHeadingElement>(null);
  const viewerDragStart = useRef<{ x: number; width: number } | null>(null);

  // Query
  const { data: thread, isLoading, isError, refetch } = useQuery({
    queryKey: ["threads", selectedCompanyId, resolvedId],
    queryFn: () => threadsApi.detail(selectedCompanyId!, resolvedId!),
    enabled: !!selectedCompanyId && !!resolvedId,
    retry: false,
  });

  const scopeVersionsQuery = useQuery({
    queryKey: ["threads", selectedCompanyId, resolvedId, "scope-versions"],
    queryFn: () => threadsApi.listScopeVersions(selectedCompanyId!, resolvedId!),
    enabled: !!selectedCompanyId && !!resolvedId && centerTab === "scope",
    retry: false,
  });

  const currentScopeVersionId = useMemo(() => {
    if (!thread) return null;
    return thread.derivedStage?.scopeVersionId ?? scopeVersionsQuery.data?.versions[0]?.id ?? null;
  }, [scopeVersionsQuery.data?.versions, thread]);

  const activeScopeVersionId = useMemo(() => {
    if (!thread) return null;
    return selectedScopeVersionId ?? currentScopeVersionId;
  }, [currentScopeVersionId, selectedScopeVersionId, thread]);

  const isViewingCurrentScopeVersion = Boolean(
    activeScopeVersionId && currentScopeVersionId && activeScopeVersionId === currentScopeVersionId,
  );

  const activeScopeVersionQuery = useQuery<ThreadScopeVersionDetail | null>({
    queryKey: ["threads", selectedCompanyId, resolvedId, "scope-versions", activeScopeVersionId],
    queryFn: async () =>
      activeScopeVersionId
        ? (await threadsApi.getScopeVersion(selectedCompanyId!, resolvedId!, activeScopeVersionId)) ?? null
        : null,
    enabled: !!selectedCompanyId && !!resolvedId && !!activeScopeVersionId,
    retry: false,
  });

  useEffect(() => {
    setViewerTabs([createOpenTab()]);
    setActiveViewerKey(OPEN_TAB_KEY);
    setSelectedScopeVersionId(null);
  }, [resolvedId]);

  useEffect(() => {
    if (!selectedScopeVersionId || !scopeVersionsQuery.data?.versions) return;
    if (!scopeVersionsQuery.data.versions.some((version) => version.id === selectedScopeVersionId)) {
      setSelectedScopeVersionId(null);
    }
  }, [scopeVersionsQuery.data?.versions, selectedScopeVersionId]);

  const openViewerTab = useCallback((tab: ThreadViewerTab) => {
    if (onOpenRequest) {
      const request = threadViewerTabToOpenRequest(tab);
      if (request) onOpenRequest(request);
      return;
    }
    setViewerTabs((current) => ensureTab(current, tab));
    setActiveViewerKey(tab.key);
    setViewerCollapsed(false);
    setMobileTab("viewer");
  }, [onOpenRequest]);

  const closeViewerTab = useCallback((key: string) => {
    setViewerTabs((current) => {
      const next = closeTab(current, key);
      if (activeViewerKey === key) {
        setActiveViewerKey(next[0]?.key ?? null);
      }
      return next;
    });
  }, [activeViewerKey]);

  const openScopeItemInViewer = useCallback((item: ExtractedItem) => {
    openViewerTab(scopeItemToTab(item));
  }, [openViewerTab]);

  const openScopeVersionItemInViewer = useCallback((item: ThreadScopeItem) => {
    if (item.resultIssueId) {
      openViewerTab(taskTab(item.resultIssueId, item.title, item.id));
      return;
    }
    if (item.resultMemoryId && selectedCompanyId) {
      openViewerTab(memoryTab(selectedCompanyId, item.resultMemoryId, item.title, item.id));
      return;
    }
    if (item.artifactId) {
      openViewerTab(artifactRefTab(item.artifactId, item.title, item.artifactVersionId, item.id));
      return;
    }
    if (item.kind === "source_signal") {
      const attachment = sourceSignalToAttachment(item);
      if (attachment) {
        const sourceEntryId =
          Array.isArray(item.sourceEntryIds) && typeof item.sourceEntryIds[0] === "string"
            ? item.sourceEntryIds[0]
            : undefined;
        openViewerTab(threadAttachmentToTab(attachment, sourceEntryId));
        return;
      }
      const url = payloadString(item.payload.url);
      if (url) {
        openViewerTab(browserTab(url, item.title));
        return;
      }
    }
    openViewerTab(scopeItemToTab(scopeVersionItemToViewerItem(item, activeScopeVersionId)));
  }, [activeScopeVersionId, openViewerTab, selectedCompanyId]);

  const openAttachmentInViewer = useCallback((
    attachment: DiscussionEntryAttachment,
    entryId?: string,
  ) => {
    openViewerTab(threadAttachmentToTab(attachment, entryId));
  }, [openViewerTab]);

  // Viewer Upgrade Phase 7B: open a delivered navigational ref (from an entry's
  // outputRefs) — map the ShowRef to a Thread viewer tab via the openRef adapter,
  // then route through the same seam attachments use (local tab or hub request).
  const openRefInViewer = useCallback((ref: ShowRef) => {
    openViewerTab(showRefToThreadTab(ref, selectedCompanyId ?? ""));
  }, [openViewerTab, selectedCompanyId]);

  // Live updates. D2: keep these fully live even when embedded (a hub tab IS the
  // live thread — same as the ThreadsWorkspace pane). They key on `resolvedId`
  // (prop-or-param) so a hub-hosted thread subscribes to the right room.
  const { connectionState, subscribeThread, unsubscribeThread, sendPresence, onReconnect } =
    useLiveUpdates();

  useEffect(() => {
    if (!resolvedId) return;
    subscribeThread(resolvedId);
    return () => unsubscribeThread(resolvedId);
  }, [resolvedId, subscribeThread, unsubscribeThread]);

  useEffect(() => {
    if (!resolvedId) return;
    // Per-tab presence interval (8s). Accepted cost: each mounted thread tab
    // heartbeats independently; a hub can host a few thread tabs concurrently.
    sendPresence(resolvedId);
    const id = window.setInterval(() => sendPresence(resolvedId), 8_000);
    return () => window.clearInterval(id);
  }, [resolvedId, sendPresence]);

  useEffect(() => {
    if (!resolvedId || !selectedCompanyId) return;
    return onReconnect(() => {
      queryClient.invalidateQueries({ queryKey: ["threads", selectedCompanyId, resolvedId] });
    });
  }, [resolvedId, selectedCompanyId, onReconnect, queryClient]);

  // Derived scope items
  const scopeItems = useMemo((): ScopeItem[] => {
    if (!thread) return [];
    return thread.entries.flatMap((entry) =>
      entry.extractedItems.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        description: item.description,
        status: item.status,
        conflictsWith: item.conflictsWith,
        suggestedPriority: item.suggestedPriority,
        suggestedAssigneeId: item.suggestedAssigneeId,
        suggestedDepartmentId: item.suggestedDepartmentId,
        suggestedLayer: item.suggestedLayer,
        layer: item.layer,
        dedupAction: item.dedupAction,
        resultTaskId: item.resultTaskId,
        resultMemoryId: item.resultMemoryId,
        createdAt: item.createdAt,
      })),
    );
  }, [thread]);

  const viewerScopeItems = useMemo((): ThreadViewerScopeItem[] => {
    const versionedItems = activeScopeVersionQuery.data?.items;
    if (versionedItems && versionedItems.length > 0) {
      return versionedItems.map((item) => ({
        id: item.id,
        type: item.kind.replaceAll("_", " "),
        kind: item.kind,
        scopeVersionId: activeScopeVersionId,
        title: item.title,
        description: item.description,
        status: item.status,
        resultIssueId: item.resultIssueId,
        resultMemoryId: item.resultMemoryId,
        artifactId: item.artifactId,
        artifactVersionId: item.artifactVersionId,
        sourceEntryIds: item.sourceEntryIds,
        payload: item.payload,
        suggestedPriority:
          typeof item.payload.priority === "string" ? item.payload.priority : null,
        suggestedAssigneeId:
          typeof item.payload.assigneeAgentId === "string" ? item.payload.assigneeAgentId : null,
        suggestedDepartmentId:
          typeof item.payload.departmentId === "string" ? item.payload.departmentId : null,
        suggestedLayer:
          typeof item.payload.layer === "string" ? item.payload.layer : null,
      }));
    }

    return thread
      ? thread.entries.flatMap((entry) =>
          entry.extractedItems.map((item) => ({
            id: item.id,
            type: item.type,
            title: item.title,
            description: item.description,
            status: item.status,
            payload: {},
            suggestedPriority: item.suggestedPriority,
            priority: item.priority,
            suggestedAssigneeId: item.suggestedAssigneeId,
            suggestedDepartmentId: item.suggestedDepartmentId,
            suggestedLayer: item.suggestedLayer,
            layer: item.layer,
          })),
        )
      : [];
  }, [activeScopeVersionQuery.data?.items, thread]);

  const extractedItemById = useMemo(() => {
    const map = new Map<string, ExtractedItem>();
    if (!thread) return map;
    for (const entry of thread.entries) {
      for (const item of entry.extractedItems) {
        map.set(item.id, item);
      }
    }
    return map;
  }, [thread]);

  // Derived participant counts from entries
  const participants = useMemo(() => {
    if (!thread) return { humans: [] as string[], agents: [] as { id: string; name: string | null }[] };
    const humanSet = new Set<string>();
    const agentMap = new Map<string, string | null>();
    for (const e of thread.entries) {
      if (e.authorAgentId) agentMap.set(e.authorAgentId, e.authorAgentName);
      else if (e.createdBy) humanSet.add(e.createdBy);
    }
    return {
      humans: [...humanSet],
      agents: [...agentMap.entries()].map(([id, name]) => ({ id, name })),
    };
  }, [thread]);

  const branchCount = useMemo(() => scopeItems.filter((i) => i.type === "spin_off_thread").length, [scopeItems]);

  // Invalidate helper
  const invalidateThread = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["threads", selectedCompanyId, resolvedId] });
  }, [queryClient, selectedCompanyId, resolvedId]);

  const invalidateScopeVersionsOnly = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["threads", selectedCompanyId, resolvedId, "scope-versions"] });
  }, [queryClient, selectedCompanyId, resolvedId]);

  const invalidateScopeVersions = useCallback(() => {
    invalidateScopeVersionsOnly();
    invalidateThread();
  }, [invalidateScopeVersionsOnly, invalidateThread]);

  // Mutations
  const renameMutation = useMutation({
    mutationFn: (title: string) =>
      api.patch<ThreadDetailType>(
        `/companies/${selectedCompanyId!}/discussions/${resolvedId!}`,
        { title },
      ),
    onSuccess: () => {
      invalidateThread();
      setIsRenaming(false);
      pushToast({ title: "Thread renamed", tone: "success" });
    },
    onError: () => pushToast({ title: "Rename failed", tone: "warn" }),
  });

  const claimMutation = useMutation({
    mutationFn: () => threadsApi.claim(selectedCompanyId!, resolvedId!),
    onSuccess: () => {
      invalidateThread();
      pushToast({ title: "Thread claimed", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to claim thread", tone: "warn" }),
  });

  const advancePhaseMutation = useMutation({
    mutationFn: (phase: string) =>
      threadsApi.advancePhase(selectedCompanyId!, resolvedId!, phase),
    onSuccess: () => invalidateThread(),
    onError: () => pushToast({ title: "Failed to advance phase", tone: "warn" }),
  });

  const pauseCrewMutation = useMutation({
    mutationFn: () => threadsApi.pauseCrew(selectedCompanyId!, resolvedId!),
    onSuccess: () => {
      invalidateThread();
      pushToast({ title: "Crew paused", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to pause crew", tone: "warn" }),
  });

  const resumeCrewMutation = useMutation({
    mutationFn: () => threadsApi.resumeCrew(selectedCompanyId!, resolvedId!),
    onSuccess: () => {
      invalidateThread();
      pushToast({ title: "Crew resumed", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to resume crew", tone: "warn" }),
  });

  const setAutonomyMutation = useMutation({
    mutationFn: (level: number | null) =>
      threadsApi.setAutonomyLevel(selectedCompanyId!, resolvedId!, level),
    onSuccess: () => invalidateThread(),
    onError: () => pushToast({ title: "Failed to update autonomy", tone: "warn" }),
  });

  const createScopeDraftMutation = useMutation({
    mutationFn: () => {
      if (!thread) throw new Error("Thread is not loaded");
      return threadsApi.createScopeDraft(selectedCompanyId!, resolvedId!, { mode: "generate" });
    },
    onSuccess: (result) => {
      invalidateScopeVersions();
      setCenterTab("scope");
      setMobileTab("scope");
      pushToast({
        title:
          result.status === "no_entries"
            ? "No messages to scope yet"
            : result.status === "existing_draft"
              ? "Scope draft already exists"
              : "Scope draft created",
        tone: result.status === "no_entries" ? "warn" : "success",
      });
    },
    onError: () => pushToast({ title: "Failed to create scope draft", tone: "warn" }),
  });

  const acceptScopeMutation = useMutation({
    mutationFn: ({ scopeVersionId, itemIds }: { scopeVersionId: string; itemIds: string[] }) =>
      threadsApi.acceptScopeVersion(selectedCompanyId!, resolvedId!, scopeVersionId, itemIds),
    onSuccess: () => {
      invalidateScopeVersions();
      pushToast({ title: "Scope accepted", tone: "success" });
    },
    onError: (error) => pushToast({ title: apiErrorMessage(error, "Failed to accept scope"), tone: "warn" }),
  });

  const reviewScopeItemsMutation = useMutation({
    mutationFn: ({
      scopeVersionId,
      items,
    }: {
      scopeVersionId: string;
      items: Array<{ itemId: string; status: "draft" | "accepted" | "rejected" }>;
    }) => threadsApi.reviewScopeItems(selectedCompanyId!, resolvedId!, scopeVersionId, { items }),
    onSuccess: () => {
      invalidateScopeVersionsOnly();
      pushToast({ title: "Scope card updated", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to update scope card", tone: "warn" }),
  });

  const updateScopeItemMutation = useMutation({
    mutationFn: ({
      scopeVersionId,
      itemId,
      patch,
    }: {
      scopeVersionId: string;
      itemId: string;
      patch: UpdateScopeItemRequest;
    }) => threadsApi.updateScopeItem(selectedCompanyId!, resolvedId!, scopeVersionId, itemId, patch),
    onSuccess: () => {
      invalidateScopeVersionsOnly();
      pushToast({ title: "Scope card changed", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to change scope card", tone: "warn" }),
  });

  const createScopeOutputItemMutation = useMutation({
    mutationFn: ({
      scopeVersionId,
      itemId,
      memoryStatus,
    }: {
      scopeVersionId: string;
      itemId: string;
      memoryStatus?: "approved" | "pending";
    }) =>
      memoryStatus
        ? threadsApi.createScopeOutputItem(selectedCompanyId!, resolvedId!, scopeVersionId, itemId, { memoryStatus })
        : threadsApi.createScopeOutputItem(selectedCompanyId!, resolvedId!, scopeVersionId, itemId),
    onSuccess: (result) => {
      invalidateScopeVersionsOnly();
      invalidateThread();
      if (result.createdTask?.id) {
        openViewerTab(taskTab(result.createdTask.id, result.item.title, result.item.id));
      } else if (result.createdMemoryId && selectedCompanyId) {
        openViewerTab(memoryTab(selectedCompanyId, result.createdMemoryId, result.item.title, result.item.id));
      }
      pushToast({ title: "Scope output created", tone: "success" });
    },
    onError: (error) => pushToast({ title: apiErrorMessage(error, "Failed to create scope output"), tone: "warn" }),
  });

  const applyScopeMutation = useMutation({
    mutationFn: (scopeVersionId: string) =>
      threadsApi.applyScopeVersion(selectedCompanyId!, resolvedId!, scopeVersionId),
    onSuccess: () => {
      invalidateScopeVersionsOnly();
      invalidateThread();
      pushToast({ title: "Accepted scope cards applied", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to apply scope cards", tone: "warn" }),
  });

  const rejectScopeMutation = useMutation({
    mutationFn: (scopeVersionId: string) =>
      threadsApi.rejectScopeVersion(selectedCompanyId!, resolvedId!, scopeVersionId),
    onSuccess: () => {
      invalidateScopeVersions();
      pushToast({ title: "Scope rejected", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to reject scope", tone: "warn" }),
  });

  const completeScopeMutation = useMutation({
    mutationFn: (scopeVersionId: string) =>
      threadsApi.completeScopeVersion(selectedCompanyId!, resolvedId!, scopeVersionId),
    onSuccess: () => {
      invalidateScopeVersions();
      pushToast({ title: "Scope completed", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to complete scope", tone: "warn" }),
  });

  // Rename modal handlers
  function openRename() {
    setRenameTitle(thread?.title ?? "");
    setIsRenaming(true);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  }

  function handleRename() {
    const t = renameTitle.trim();
    if (!t || t === thread?.title) { setIsRenaming(false); return; }
    renameMutation.mutate(t);
  }

  // Breadcrumbs — page chrome only. When embedded (ThreadsWorkspace pane or a
  // hub tab) the host owns the breadcrumbs/subtitle/entity color, so we skip
  // these setters entirely (mirrors the left-rail `!embedded` gate below).
  useEffect(() => {
    if (embedded) return;
    setBreadcrumbs([
      { label: "Discussions", href: "/discussions" },
      { label: thread?.title ?? "Thread" },
    ]);
    setEntityColor("var(--entity-brief)");
    return () => { setSubtitle(null); setEntityColor(null); };
  }, [embedded, thread?.title, setBreadcrumbs, setSubtitle, setEntityColor]);

  useEffect(() => {
    if (embedded || !thread) return;
    setSubtitle(thread.pendingItemCount > 0 ? `${thread.pendingItemCount} items pending` : null);
  }, [embedded, thread, setSubtitle]);

  useEffect(() => {
    if (thread && centerHeadingRef.current) centerHeadingRef.current.focus();
  }, [thread?.id]);

  // Tab keyboard navigation
  const handleTabKeyDown = useCallback((e: React.KeyboardEvent, currentTab: CenterTab) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const tabs: CenterTab[] = ["thread", "scope", "branches"];
      const i = tabs.indexOf(currentTab);
      const next =
        e.key === "ArrowRight" ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length;
      setCenterTab(tabs[next]);
    }
  }, []);

  const applyViewerResize = useCallback((clientX: number) => {
    if (!viewerDragStart.current) return;
    const delta = viewerDragStart.current.x - clientX;
    const nextWidth = Math.min(
      getViewerMaxWidth(),
      Math.max(VIEWER_MIN_WIDTH, viewerDragStart.current.width + delta),
    );
    setViewerWidth(nextWidth);
  }, []);

  const startViewerResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (viewerCollapsed) return;
    viewerDragStart.current = { x: event.clientX, width: viewerWidth };
    setIsViewerResizing(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [viewerCollapsed, viewerWidth]);

  const resizeViewer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    applyViewerResize(event.clientX);
  }, [applyViewerResize]);

  const stopViewerResize = useCallback(() => {
    viewerDragStart.current = null;
    setIsViewerResizing(false);
  }, []);

  useEffect(() => {
    if (!isViewerResizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      applyViewerResize(event.clientX);
    };
    const handlePointerStop = () => {
      viewerDragStart.current = null;
      setIsViewerResizing(false);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerStop);
    document.addEventListener("pointercancel", handlePointerStop);

    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerStop);
      document.removeEventListener("pointercancel", handlePointerStop);
    };
  }, [applyViewerResize, isViewerResizing]);

  // Loading / error
  if (isLoading) {
    return (
      <div
        className={cn(
          "flex h-full flex-col",
          !embedded && "bg-muted/30 p-2",
        )}
        data-testid="thread-detail-skeleton"
      >
        <div
          className={cn(
            "flex flex-1 flex-col gap-4 p-6",
            !embedded && "rounded-xl border border-border bg-background shadow-sm",
          )}
        >
          <div className="h-6 rounded-md bg-muted animate-pulse w-1/2" />
          <div className="h-4 rounded-md bg-muted animate-pulse w-3/4" />
          <div className="h-32 rounded-md bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  if (isError || !thread) {
    return (
      <div
        className={cn(
          "flex h-full flex-col",
          !embedded && "bg-muted/30 p-2",
        )}
        data-testid="thread-error-state"
      >
        <div
          className={cn(
            "flex flex-1 flex-col items-center gap-4 py-20",
            !embedded && "rounded-xl border border-border bg-background shadow-sm",
          )}
        >
          <p className="text-sm text-muted-foreground">Couldn&apos;t load this thread.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-1.5" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Phase computations
  const phaseIndex = PHASES.indexOf(thread.phase as Phase);
  const nextPhase = NEXT_PHASE[thread.phase as Phase];
  const derivedStage = thread.derivedStage ?? null;
  const derivedStageLabel = derivedStage?.label ?? PHASE_LABELS[thread.phase as Phase] ?? thread.phase;
  const newEntryLabel =
    derivedStage?.hasNewEntries && derivedStage.newEntryCount > 0
      ? `${derivedStage.newEntryCount} new ${derivedStage.newEntryCount === 1 ? "message" : "messages"}`
      : null;
  const scopeDraftActionLabel =
    derivedStage?.scopeVersionId && derivedStage.hasNewEntries ? "Re-scope" : "Create scope draft";
  const canCreateScopeDraft = thread.subtype !== "live";
  const autonomyInfo =
    thread.autonomyLevel != null && thread.autonomyLevel in AUTONOMY_COLORS
      ? { label: autonomyLabel(thread.autonomyLevel), ...AUTONOMY_COLORS[thread.autonomyLevel as AutonomyValue] }
      : null;

  // Participant avatars (first 5)
  const participantHumanIds = new Set(participants.humans);
  if (thread.ownerUserId) participantHumanIds.add(thread.ownerUserId);
  const allParticipants: Array<{ type: "human" | "agent"; id: string; name: string | null; role?: string }> = [
    ...[...participantHumanIds].map((id) => ({
      type: "human" as const,
      id,
      name: null,
      role: id === thread.ownerUserId ? "Owner" : undefined,
    })),
    ...participants.agents.map(({ id, name }) => ({ type: "agent" as const, id, name })),
  ];
  const shownParticipants = allParticipants.slice(0, 5);
  const hiddenCount = Math.max(0, allParticipants.length - 5);

  return (
    <div
      className={cn(
        "flex flex-col h-full overflow-hidden",
        !embedded && "bg-muted/30 p-2",
      )}
      data-testid="thread-detail"
    >
      <ConnectionPill state={connectionState} />

      {/* Rename modal */}
      {isRenaming && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
          style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}
          onClick={() => setIsRenaming(false)}
        >
          <div
            className="w-full max-w-sm mx-4 rounded-xl border border-border p-4 space-y-3"
            style={{ background: "var(--card, #161a20)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-foreground">Rename thread</h2>
            <input
              ref={renameInputRef}
              type="text"
              value={renameTitle}
              onChange={(e) => setRenameTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
                if (e.key === "Escape") setIsRenaming(false);
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder="Thread title"
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setIsRenaming(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleRename} disabled={renameMutation.isPending}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile tab bar */}
      <div className="flex border-b border-border shrink-0 md:hidden" data-testid="thread-mobile-tabs">
        {MOBILE_TABS.filter(({ key }) => !onOpenRequest || key !== "viewer").map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setMobileTab(key);
              if (key === "thread" || key === "scope" || key === "branches")
                setCenterTab(key as CenterTab);
            }}
            className={cn(
              "flex-1 flex items-center justify-center px-1 py-2.5 text-xs font-medium transition-colors",
              mobileTab === key
                ? "text-primary border-b-2 border-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`mobile-tab-${key}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Desktop 3-pane */}
      <div
        className={cn(
          "flex flex-1 min-h-0 overflow-hidden",
          !embedded && "rounded-xl border border-border bg-background shadow-sm",
          // Embedded on the full desktop page: the parent supplies no card, so
          // separate the center + viewer into their own rounded cards (matches
          // the home view and Commander) with a gap between them.
          embedded && "gap-2",
        )}
      >

        {/* Left rail */}
        {!embedded && (
          <div
            className={cn(
              "shrink-0 h-full overflow-auto border-r border-border bg-background w-[220px]",
              mobileTab !== "origin" ? "hidden md:block" : "block",
            )}
            data-testid="thread-left-rail"
          >
            <ThreadLeftRail companyId={selectedCompanyId!} currentThreadId={thread.id} />
          </div>
        )}

        {/* Center panel */}
        <div
          className={cn(
            "flex-1 min-w-0 h-full overflow-hidden flex flex-col",
            embedded && "rounded-xl border border-border bg-background shadow-sm",
            mobileTab === "thread" || mobileTab === "scope" || mobileTab === "branches"
              ? "flex"
              : "hidden md:flex",
          )}
          data-testid="thread-center-panel"
          data-pane="center"
        >
          <h1 ref={centerHeadingRef} tabIndex={-1} className="sr-only">{thread.title}</h1>

          {/* ── Header card ── */}
          <div
            className="shrink-0 border-b border-border"
            style={{ background: "var(--card, #161a20)" }}
            data-testid="thread-center-header"
          >
            {/* Row 1: title + controls */}
            <div className="flex items-start gap-3 px-4 pt-4 pb-2">
              {/* Title with hover-to-edit */}
              <div
                className="flex items-center gap-1.5 flex-1 min-w-0 group cursor-pointer pt-0.5"
                onMouseEnter={() => setShowTitleEdit(true)}
                onMouseLeave={() => setShowTitleEdit(false)}
                onClick={openRename}
              >
                <h2
                  className="text-lg font-bold text-foreground truncate leading-tight"
                  style={{ letterSpacing: "-0.01em" }}
                >
                  {thread.title}
                </h2>
                <Pencil
                  className={cn(
                    "h-3.5 w-3.5 text-muted-foreground/40 shrink-0 transition-opacity",
                    showTitleEdit ? "opacity-100" : "opacity-0",
                  )}
                />
              </div>

              {/* Controls: autonomy + workflow actions + pause */}
              <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Change autonomy level"
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-opacity hover:opacity-80"
                      style={
                        autonomyInfo
                          ? { color: autonomyInfo.color, background: autonomyInfo.bgColor }
                          : { color: "hsl(0 0% 60%)", background: "hsl(0 0% 14%)" }
                      }
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: autonomyInfo?.color ?? "hsl(0 0% 40%)" }}
                      />
                      {autonomyInfo?.label ?? "Auto off"}
                      <ChevronDown className="h-2.5 w-2.5 opacity-60" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[240px]">
                    <DropdownMenuLabel>Autonomy</DropdownMenuLabel>
                    {([null, 0, 1, 2] as Array<AutonomyValue | null>).map((lvl) => {
                      const label = autonomyLabel(lvl);
                      const colors = lvl !== null ? AUTONOMY_COLORS[lvl] : null;
                      const color = colors?.color ?? "hsl(0 0% 50%)";
                      const isActive = (thread.autonomyLevel ?? null) === lvl;
                      const description =
                        lvl === null
                          ? "Use the company default for this thread."
                          : lvl === 0
                            ? "Humans drive. Agents answer only when directly called."
                            : lvl === 1
                              ? "Agents can assist the discussion without driving delivery."
                              : "Agents can help move the thread toward work.";

                      return (
                        <DropdownMenuItem
                          key={String(lvl)}
                          onSelect={() => {
                            if (!isActive) setAutonomyMutation.mutate(lvl);
                          }}
                          className={cn("items-start gap-2", isActive && "bg-white/5")}
                        >
                          <span
                            className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0"
                            style={{ background: color }}
                          />
                          <span className="min-w-0">
                            <span className="flex items-center gap-2 text-xs font-semibold">
                              {label}
                              {isActive && (
                                <span className="text-[10px] text-muted-foreground">Current</span>
                              )}
                            </span>
                            <span className="block text-[11px] leading-snug text-muted-foreground">
                              {description}
                            </span>
                          </span>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Thread actions"
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-opacity hover:opacity-80"
                      style={{
                        color: "#eeeeee",
                        background: "hsl(0 0% 20%)",
                        border: "1px solid hsl(0 0% 28%)",
                      }}
                    >
                      Actions
                      <ChevronDown className="h-2.5 w-2.5 opacity-60" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[220px]">
                    <DropdownMenuLabel>Thread workflow</DropdownMenuLabel>
                    <DropdownMenuItem
                      disabled={!canCreateScopeDraft || createScopeDraftMutation.isPending}
                      onSelect={() => {
                        if (canCreateScopeDraft) createScopeDraftMutation.mutate();
                      }}
                    >
                      {scopeDraftActionLabel}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={thread.phase === "discuss" || thread.phase === "done" || advancePhaseMutation.isPending}
                      onSelect={() => {
                        if (thread.phase === "scope") advancePhaseMutation.mutate("assign");
                      }}
                    >
                      Assign work
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={thread.phase === "done" || advancePhaseMutation.isPending}
                      onSelect={() => advancePhaseMutation.mutate("done")}
                    >
                      Mark done
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <button
                  type="button"
                  aria-label={thread.crewPaused ? "Resume crew" : "Pause crew"}
                  onClick={() =>
                    thread.crewPaused
                      ? resumeCrewMutation.mutate()
                      : pauseCrewMutation.mutate()
                  }
                  disabled={pauseCrewMutation.isPending || resumeCrewMutation.isPending}
                  className="w-7 h-7 rounded-full flex items-center justify-center transition-colors disabled:opacity-40"
                  style={
                    thread.crewPaused
                      ? {
                          background: "rgba(79,182,126,0.15)",
                          color: "#4FB67E",
                          border: "1px solid rgba(79,182,126,0.45)",
                        }
                      : {
                          background: "rgba(217,169,56,0.15)",
                          color: "#D9A938",
                          border: "1px solid rgba(217,169,56,0.45)",
                        }
                  }
                >
                  {thread.crewPaused
                    ? <Play className="h-3 w-3 ml-0.5" />
                    : <Pause className="h-3.5 w-3.5" />
                  }
                </button>
                {embedded && onClose && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={onClose}
                    aria-label="Close discussion focus"
                    title="Close discussion"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            {/* PR-A2: thread-level coordination error (self-clears when the thread recovers) */}
            {thread.lastError && (
              <div className="px-4">
                <ThreadErrorBanner error={thread.lastError} consecutiveFailures={thread.consecutiveCommitFailures} />
              </div>
            )}

            {/* Scope tag */}
            {thread.scopeName && (
              <div className="flex items-center gap-1.5 px-4 pb-2">
                <span className="text-[11px] text-muted-foreground/60">Scoped to:</span>
                <span className="text-[11px] font-medium text-muted-foreground capitalize">
                  {thread.scopeType}
                </span>
                <span className="text-muted-foreground/30 text-[11px]">·</span>
                <span className="text-[11px] font-medium text-muted-foreground">
                  {thread.scopeName}
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
              <span
                className="inline-flex items-center rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground"
                data-testid="thread-derived-stage"
              >
                {derivedStageLabel}
              </span>
              {newEntryLabel && (
                <span className="text-[11px] text-muted-foreground">
                  {newEntryLabel}
                </span>
              )}

              {/* Per-thread visibility selector + public share-link block.
                  Restored from the retired OriginCard (group-chat redesign
                  dropped it). Company-scoped → needs selectedCompanyId. */}
              <ThreadVisibilityControls
                thread={thread}
                companyId={selectedCompanyId!}
              />
            </div>

            {(shownParticipants.length > 0 || thread.ownerUserId === null) && (
              <div className="flex items-center gap-2.5 px-4 pb-2.5 min-h-8">
                <div className="flex items-center -space-x-1.5">
                  {shownParticipants.map((p) =>
                    p.type === "agent" ? (
                      <div
                        key={p.id}
                        className="w-7 h-7 rounded-full border-2 flex items-center justify-center text-white shrink-0"
                        style={{
                          background: agentColor(p.name),
                          borderColor: "var(--card, #161a20)",
                        }}
                        title={p.name ?? "Agent"}
                      >
                        <svg viewBox="0 0 20 20" width="11" height="11" fill="currentColor" aria-hidden>
                          <rect x="3" y="9" width="14" height="9" rx="2" />
                          <rect x="7" y="5.5" width="6" height="4" rx="1" />
                          <circle cx="7.5" cy="13" r="1.3" />
                          <circle cx="12.5" cy="13" r="1.3" />
                        </svg>
                      </div>
                    ) : (
                      <div
                        key={p.id}
                        className="w-7 h-7 rounded-full border-2 flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                        style={{
                          background: "hsl(220 14% 28%)",
                          borderColor: p.role === "Owner" ? "#D9A938" : "var(--card, #161a20)",
                        }}
                        title={p.role === "Owner" ? `Owner: ${p.id}` : p.id}
                      >
                        {toInitials(p.id)}
                      </div>
                    ),
                  )}
                  {hiddenCount > 0 && (
                    <div
                      className="w-7 h-7 rounded-full border-2 flex items-center justify-center text-[10px] font-semibold text-muted-foreground shrink-0"
                      style={{ background: "hsl(0 0% 20%)", borderColor: "var(--card, #161a20)" }}
                    >
                      +{hiddenCount}
                    </div>
                  )}
                </div>
                {thread.ownerUserId === null && (
                  <button
                    type="button"
                    onClick={() => claimMutation.mutate()}
                    disabled={claimMutation.isPending}
                    className="text-[11px] font-semibold text-primary hover:underline disabled:opacity-50"
                  >
                    Take ownership
                  </button>
                )}
              </div>
            )}

            {thread.summaryNext && (
              <div className="px-4 pb-2 text-[12px] text-muted-foreground">
                <span className="font-semibold text-foreground/80">Next:</span>{" "}
                {thread.summaryNext}
              </div>
            )}

            <div
              className="px-4 pb-3.5 pt-1"
              aria-label={`Phase: ${PHASE_LABELS[thread.phase as Phase] ?? thread.phase}`}
            >
              <div className="flex items-center gap-1">
                {PHASES.map((phase, i) => {
                  const isDone = i < phaseIndex;
                  const isActive = i === phaseIndex;
                  return (
                    <div
                      key={phase}
                      className="group relative flex flex-1 items-center"
                      title={PHASE_LABELS[phase]}
                    >
                      <div
                        className="h-1.5 flex-1 rounded-full transition-colors"
                        style={{
                          background: isDone ? "#4FB67E" : isActive ? "#3b82f6" : "hsl(0 0% 22%)",
                        }}
                      />
                      <span className="pointer-events-none absolute left-1/2 top-3 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm group-hover:block">
                        {PHASE_LABELS[phase]}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Tab bar */}
            <div
              role="tablist"
              aria-label="Thread sections"
              className="flex border-t border-border/60"
            >
              {(["thread", "scope", "branches"] as CenterTab[]).map((tab) => {
                let badge: number | null = null;
                if (tab === "scope") badge = thread.pendingItemCount > 0 ? thread.pendingItemCount : null;
                if (tab === "branches") badge = branchCount > 0 ? branchCount : null;

                return (
                  <button
                    key={tab}
                    id={`center-tab-${tab}`}
                    role="tab"
                    type="button"
                    aria-selected={centerTab === tab}
                    aria-controls={`center-tabpanel-${tab}`}
                    tabIndex={centerTab === tab ? 0 : -1}
                    onKeyDown={(e) => handleTabKeyDown(e, tab)}
                    onClick={() => {
                      setCenterTab(tab);
                      if (tab === "thread") setMobileTab("thread");
                      else if (tab === "scope") setMobileTab("scope");
                      else if (tab === "branches") setMobileTab("branches");
                    }}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors capitalize",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(255,255,255,0.22)] focus-visible:ring-inset",
                      centerTab === tab
                        ? "text-foreground border-b-2 border-foreground"
                        : "text-muted-foreground hover:text-foreground border-b-2 border-transparent",
                    )}
                    data-testid={`center-tab-${tab}`}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    {badge != null && (
                      <span
                        className="inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-bold tabular-nums"
                        style={{ background: "rgba(59,130,246,0.2)", color: "#60a5fa" }}
                      >
                        {badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tab panels */}
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {/* Thread panel — scroll handled internally */}
            <div
              id="center-tabpanel-thread"
              role="tabpanel"
              aria-labelledby="center-tab-thread"
              className={cn("absolute inset-0", centerTab !== "thread" && "hidden")}
            >
              <ThreadTab
                threadId={thread.id}
                companyId={selectedCompanyId!}
                entries={thread.entries}
                isLoading={isLoading}
                isError={isError}
                onRetry={refetch}
                onOpenAttachment={openAttachmentInViewer}
                onOpenRef={openRefInViewer}
                hasScopeDraft={!!thread.derivedStage?.scopeVersionId}
                draftText={effectiveDraftText}
                onDraftTextChange={handleDraftTextChange}
              />
            </div>

            {/* Scope panel */}
            <div
              id="center-tabpanel-scope"
              role="tabpanel"
              aria-labelledby="center-tab-scope"
              className={cn("absolute inset-0 overflow-auto p-4", centerTab !== "scope" && "hidden")}
              data-testid="thread-tabpanel-scope"
            >
              <ScopeTab
                summaryText={thread.summaryText}
                summaryNext={thread.summaryNext}
                items={scopeItems}
                planSteps={(((thread as unknown as { planSteps?: Array<{ title: string }> }).planSteps) ?? []).map((s) => s.title)}
                isLoading={isLoading}
                isError={isError}
                onRetry={refetch}
                onItemClick={(item) => {
                  const extracted = extractedItemById.get(item.id);
                  if (extracted) openScopeItemInViewer(extracted);
                }}
                onScopeVersionItemClick={openScopeVersionItemInViewer}
                companyId={selectedCompanyId ?? undefined}
                discussionId={resolvedId ?? undefined}
                activeScopeVersion={activeScopeVersionQuery.data ?? null}
                scopeVersions={scopeVersionsQuery.data?.versions ?? []}
                isScopeVersionLoading={scopeVersionsQuery.isLoading || activeScopeVersionQuery.isLoading}
                onScopeVersionSelect={setSelectedScopeVersionId}
                onCreateScopeDraft={() => createScopeDraftMutation.mutate()}
                createScopeDraftLabel={scopeDraftActionLabel}
                createScopeDraftDisabled={!canCreateScopeDraft || createScopeDraftMutation.isPending}
                showCreateScopeDraftCta={Boolean(
                  isViewingCurrentScopeVersion && derivedStage?.scopeVersionId && derivedStage.hasNewEntries,
                )}
                onAcceptScopeVersion={
                  isViewingCurrentScopeVersion
                    ? (scopeVersionId, itemIds) => acceptScopeMutation.mutate({ scopeVersionId, itemIds })
                    : undefined
                }
                onReviewScopeItems={
                  isViewingCurrentScopeVersion
                    ? (scopeVersionId, items) => reviewScopeItemsMutation.mutate({ scopeVersionId, items })
                    : undefined
                }
                onUpdateScopeItem={
                  isViewingCurrentScopeVersion
                    ? (scopeVersionId, itemId, patch) =>
                        updateScopeItemMutation.mutate({ scopeVersionId, itemId, patch })
                    : undefined
                }
                onCreateScopeOutputItem={
                  isViewingCurrentScopeVersion
                    ? (scopeVersionId, itemId, options) =>
                        createScopeOutputItemMutation.mutate({ scopeVersionId, itemId, ...options })
                    : undefined
                }
                onApplyScopeVersion={
                  isViewingCurrentScopeVersion
                    ? (scopeVersionId) => applyScopeMutation.mutate(scopeVersionId)
                    : undefined
                }
                onRejectScopeVersion={
                  isViewingCurrentScopeVersion
                    ? (scopeVersionId) => rejectScopeMutation.mutate(scopeVersionId)
                    : undefined
                }
                onCompleteScopeVersion={
                  isViewingCurrentScopeVersion
                    ? (scopeVersionId) => completeScopeMutation.mutate(scopeVersionId)
                    : undefined
                }
              />
            </div>

            {/* Branches panel */}
            <div
              id="center-tabpanel-branches"
              role="tabpanel"
              aria-labelledby="center-tab-branches"
              className={cn("absolute inset-0 overflow-auto p-4", centerTab !== "branches" && "hidden")}
              data-testid="thread-tabpanel-branches"
            >
              <BranchesTab
                items={scopeItems}
                companyId={selectedCompanyId ?? undefined}
                discussionId={resolvedId ?? undefined}
              />
            </div>
          </div>
        </div>

        {!onOpenRequest && !viewerCollapsed && (
          <div
            role="separator"
            aria-label="Resize viewer"
            aria-orientation="vertical"
            onPointerDown={startViewerResize}
            onPointerMove={resizeViewer}
            onPointerUp={stopViewerResize}
            onPointerCancel={stopViewerResize}
            className={cn(
              "relative z-20 h-full w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-border/70",
              mobileTab !== "viewer" ? "hidden md:block" : "block",
            )}
          />
        )}

        {/* Right viewer panel */}
        {!onOpenRequest && <div
          className={cn(
            "relative shrink-0 h-full overflow-hidden bg-muted/20 transition-[width] duration-200",
            !embedded && "border-l border-border",
            embedded && "rounded-xl border border-border shadow-sm",
            mobileTab !== "viewer" ? "hidden md:block" : "block",
          )}
          style={{ width: viewerCollapsed ? 46 : viewerWidth }}
          data-testid="thread-right-viewer"
          data-pane="viewer"
          data-collapsed={viewerCollapsed ? "true" : "false"}
          data-width={viewerCollapsed ? "46" : String(viewerWidth)}
        >
          {viewerCollapsed ? (
            <ThreadCollapsedTabStrip
              tabs={viewerTabs}
              activeKey={activeViewerKey}
              onActivate={setActiveViewerKey}
              onExpand={() => setViewerCollapsed(false)}
            />
          ) : (
            <ThreadViewer
              thread={thread}
              tabs={viewerTabs}
              activeKey={activeViewerKey}
              companyId={selectedCompanyId ?? undefined}
              scopeItems={viewerScopeItems}
              onActivate={setActiveViewerKey}
              onClose={closeViewerTab}
              onOpenTab={openViewerTab}
              onOpenScopePanel={() => { setCenterTab("scope"); setMobileTab("scope"); }}
              onUpdateScopeItem={(scopeVersionId, itemId, patch) =>
                updateScopeItemMutation.mutateAsync({ scopeVersionId, itemId, patch }).then(() => undefined).catch(() => undefined)
              }
              onCreateScopeOutputItem={(scopeVersionId, itemId, options) =>
                createScopeOutputItemMutation.mutateAsync({ scopeVersionId, itemId, ...options }).then(() => undefined).catch(() => undefined)
              }
              onReviewScopeItem={(scopeVersionId, itemId, status) =>
                reviewScopeItemsMutation.mutateAsync({
                  scopeVersionId,
                  items: [{ itemId, status }],
                }).then(() => undefined).catch(() => undefined)
              }
              onToggleCollapse={() => setViewerCollapsed(true)}
            />
          )}
        </div>}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   ConnectionPill
   ════════════════════════════════════════════════════════════════════════ */

function ConnectionPill({ state }: { state: "connecting" | "open" | "reconnecting" | "offline" }) {
  const announceRef = useRef(false);
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    if (state === "reconnecting" || state === "offline") {
      if (!announceRef.current) {
        announceRef.current = true;
        setAnnounce(state === "offline" ? "You're offline" : "Connection lost. Reconnecting.");
      }
    } else {
      announceRef.current = false;
      setAnnounce("");
    }
  }, [state]);

  if (state === "open" || state === "connecting") {
    return <div aria-live="polite" className="sr-only">{announce}</div>;
  }

  return (
    <div data-testid="thread-connection-pill" className="shrink-0 flex items-center justify-center">
      <span className={cn(
        "my-1 inline-flex items-center gap-1.5 rounded-full px-3 py-0.5 text-[11px] font-medium",
        state === "offline"
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
      )}>
        <span className={cn("h-1.5 w-1.5 rounded-full", state === "offline" ? "bg-destructive" : "bg-amber-500 animate-pulse")} aria-hidden />
        {state === "offline" ? "You're offline" : "Reconnecting…"}
      </span>
      <div aria-live="polite" className="sr-only">{announce}</div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Thread Left Rail
   ════════════════════════════════════════════════════════════════════════ */

function ThreadLeftRail({ companyId, currentThreadId }: { companyId: string; currentThreadId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [archiveConfirm, setArchiveConfirm] = useState<{ id: string; title: string } | null>(null);

  const { data } = useQuery({
    queryKey: ["threads", companyId, "list"],
    queryFn: () => threadsApi.list(companyId),
    enabled: !!companyId,
    retry: false,
  });
  const threads = (data?.discussions ?? []) as ThreadListItem[];
  // Only show active threads in the rail (archived threads are in the board's Archived column)
  const activeThreads = threads.filter((t) => t.status !== "archived");

  const archiveMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      threadsApi.setStatus(companyId, id, "archived"),
    onSuccess: () => {
      setArchiveConfirm(null);
      queryClient.invalidateQueries({ queryKey: ["threads", companyId] });
      pushToast({ title: "Thread archived", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to archive thread", tone: "warn" }),
  });

  return (
    <div className="p-2">
      <div className="flex items-center justify-between px-2 mb-2">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          Discussions
        </p>
        <span className="text-[10px] text-muted-foreground tabular-nums">{activeThreads.length}</span>
      </div>
      <nav className="space-y-0.5" aria-label="Thread index">
        {activeThreads.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">No threads yet</p>
        ) : (
          activeThreads.map((t) => {
            const isActive = t.id === currentThreadId;
            return (
              <div
                key={t.id}
                className="group relative"
              >
                <Link
                  to={`/discussions/${t.id}`}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors pr-7",
                    isActive ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", PHASE_DOT[t.phase] ?? "bg-muted-foreground")} aria-hidden />
                  <span className="flex-1 truncate">{t.title}</span>
                  {t.pendingItemCount > 0 && (
                    <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 text-[9px] font-semibold text-blue-600 dark:text-blue-400 tabular-nums">
                      {t.pendingItemCount}
                    </span>
                  )}
                </Link>
                {/* Hover-revealed kebab menu */}
                <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        data-testid={`thread-rail-kebab-${t.id}`}
                        onClick={(e) => e.preventDefault()}
                        className="flex items-center justify-center h-5 w-5 rounded hover:bg-muted transition-colors"
                        aria-label={`Thread options for ${t.title}`}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start">
                      <DropdownMenuItem
                        onSelect={() => {
                          setArchiveConfirm({ id: t.id, title: t.title });
                        }}
                        data-testid={`thread-rail-archive-${t.id}`}
                      >
                        <Archive className="h-4 w-4" />
                        Archive
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })
        )}
      </nav>
      {archiveConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Archive thread"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4"
          onClick={() => setArchiveConfirm(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-foreground">Archive thread</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Archive "{archiveConfirm.title}"? It will move out of the live rail and can be restored from Archived.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setArchiveConfirm(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => archiveMutation.mutate({ id: archiveConfirm.id })}
                disabled={archiveMutation.isPending}
              >
                Archive
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
