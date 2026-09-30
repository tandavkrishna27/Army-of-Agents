import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AtSign,
  Bot,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  MessageSquarePlus,
  Mic,
  Paperclip,
  PanelLeft,
  Send,
  Square,
  X,
  Zap,
} from "lucide-react";
import { useAgentPanel } from "../context/AgentPanelContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCommanderContextScope } from "../context/CommanderContextScopeContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useLocation, useNavigate } from "../lib/router";
import { useBreakpoint } from "../lib/useBreakpoint";
import {
  internalAgentApi,
  streamAgentChat,
  conversationMessagesApi,
  commanderConversationsApi,
  confirmAction,
  type AgentMessage,
  type ConfirmActionDecision,
  type AgentGreeting,
  type SSEEvent,
} from "../api/internal-agent";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { COMMANDER_PANEL_CARD } from "./commander/commanderChrome";
import {
  commanderPaneCoordinatorReducer,
  initialCommanderPaneCoordinatorState,
  type CommanderFocusTarget,
} from "./commander/commanderPaneCoordinator";
import { CommanderTaskFocusPane } from "./commander/CommanderTaskFocusPane";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "./MarkdownBody";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { ChatPaneCaption } from "./commander/ChatPaneCaption";
import { CommanderEmptyState } from "./commander/CommanderEmptyState";
import { CommanderReasoningBlock } from "./commander/CommanderReasoningBlock";
import { InputAddMenu } from "./commander/InputAddMenu";
import { MemoryContextStrip } from "./commander/MemoryContextStrip";
import { SkillPicker } from "./commander/SkillPicker";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useCommanderViewerCollapsed } from "./commander/useCommanderViewerCollapsed";
import { useCommanderCockpitCollapsed } from "./commander/useCommanderCockpitCollapsed";
import { CommanderCockpitPanel } from "./commander/cockpit/CommanderCockpitPanel";
import { ThreadDetail } from "../pages/ThreadDetail";
import type { ThreadOpenRequest } from "./threads/threadViewerModel";
import {
  CommanderViewerPanel,
  CommanderViewerDetail,
  buildViewerTabModels,
  OutputRefChips,
  collectConversationRefs,
  mergeRefs,
  pickAutoOpenRef,
  useCommanderViewer,
} from "./commander/viewer";
import {
  CommanderInput,
  type CommanderInputHandle,
  type SlashState,
} from "./commander/CommanderInput";
import type { CommanderInputRef, CompanySkillListItem, ViewerControlLevel } from "@armyofagents/shared";
import {
  COMPOSER_ATTACHMENT_CONTENT_TYPES,
  MAX_COMMANDER_INPUT_REFS,
  appendCommanderInputRef,
  appendCommanderInputRefsToMessage,
  commanderInputRefKey,
  commanderInputRefKindLabel,
  createComposerSubmissionId,
} from "@armyofagents/shared";
import { assetsApi } from "../api/assets";
import { agentsApi } from "../api/agents";
import { useTeamAccess } from "../hooks/useTeamAccess";
import { useViewerControl } from "../hooks/useViewerControl";
import { useComposerDraft } from "../lib/composerDraft";
import {
  assetResponseToCommanderInputRef,
  validateCommanderAttachmentFiles,
} from "./commander/commanderAttachments";
import { ComposerFrame } from "./composer/ComposerFrame";
import { ComposerIconButton } from "./composer/ComposerIconButton";
import { ComposerSendFailedBanner } from "./composer/ComposerSendFailedBanner";
import { ComposerOfflineStrip, toComposerConnectionState } from "./composer/ComposerOfflineStrip";
import { ComposerDropOverlay } from "./composer/ComposerDropOverlay";
import { useComposerDragDrop } from "./composer/useComposerDragDrop";
import { useLiveUpdates } from "../context/LiveUpdatesProvider";
import type { CommanderContextScope } from "@armyofagents/shared";
import type { ShowRef } from "@armyofagents/shared";
import { useInlineWorkQuestions, WorkQuestionInlineError } from "./work-questions/WorkQuestionInlineList";
import { WorkQuestionPanel } from "./work-questions/WorkQuestionPanel";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/* ------------------------------------------------------------------ */
/*  Auto-scroll proximity helper (exported for unit-testing)          */
/* ------------------------------------------------------------------ */

/** Returns true if the scroll container is close enough to the bottom to auto-scroll. */
export function shouldAutoScroll(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  thresholdPx = 120,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}

/* ------------------------------------------------------------------ */
/*  Abort cleanup helper (exported for unit-testing)                  */
/* ------------------------------------------------------------------ */

/**
 * Returns a cleanup function that calls `abort()` on whatever AbortController
 * is stored in `abortRef` at the time the cleanup runs.  This is the exact
 * logic used inside `AgentPanelContent`'s unmount useEffect (B1).
 *
 * Exported so the behaviour can be unit-tested against the real production
 * code rather than a test-local replica.
 */
export function createAbortCleanup(
  abortRef: React.MutableRefObject<AbortController | null>,
): () => void {
  return () => {
    abortRef.current?.abort();
  };
}

export interface CommanderInputRefState {
  refs: CommanderInputRef[];
  duplicateKey: string | null;
}

export function buildCommanderInputRefState(
  refs: readonly CommanderInputRef[],
  ref: CommanderInputRef,
): CommanderInputRefState {
  const result = appendCommanderInputRef(refs, ref);
  return {
    refs: result.refs,
    duplicateKey: result.added ? null : result.existingKey ?? commanderInputRefKey(ref),
  };
}

export function settleCommanderInputRefsAfterSend(
  current: readonly CommanderInputRef[],
  sent: readonly CommanderInputRef[],
  accepted: boolean,
): CommanderInputRef[] {
  if (!accepted) return [...current];
  const sentKeys = new Set(sent.map(commanderInputRefKey));
  return current.filter((ref) => !sentKeys.has(commanderInputRefKey(ref)));
}

export interface CommanderInputRefOpenDeps {
  openPreview: (source: "center" | "right-panel") => void;
  openTask: (issueId: string, title: string) => void;
  openDiscussion: (discussionId: string, title: string) => void;
  openArtifact: (id: string, title: string) => void;
  openInputRef: (ref: CommanderInputRef) => void;
  navigate: (href: string) => void;
}

export function openCommanderInputRef(
  ref: CommanderInputRef,
  deps: CommanderInputRefOpenDeps,
): void {
  if (ref.kind === "task") {
    deps.openTask(ref.id, ref.label);
    return;
  }
  if (ref.kind === "discussion") {
    deps.openDiscussion(ref.id, ref.label);
    return;
  }
  if (ref.kind === "artifact" || ref.kind === "approval" || ref.kind === "inbox" || ref.kind === "note") {
    deps.openPreview("right-panel");
    deps.openInputRef(ref);
    return;
  }
  if (ref.route) {
    deps.navigate(ref.route);
  }
}

export function discussionDraftStorageKey(companyId: string, discussionId: string) {
  return `aoa:commander:discussion-draft:${companyId}:${discussionId}`;
}

function CommanderDiscussionPane({
  companyId,
  discussion,
  onClose,
  onOpenRequest,
  mobile = false,
}: {
  companyId: string;
  discussion: CommanderFocusTarget;
  onClose: () => void;
  onOpenRequest: (request: ThreadOpenRequest) => void;
  mobile?: boolean;
}) {
  const draftKey = discussionDraftStorageKey(companyId, discussion.entityId);
  const [draftText, setDraftText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    try {
      setDraftText(sessionStorage.getItem(draftKey) ?? "");
    } catch {
      setDraftText("");
    }
  }, [draftKey]);

  const updateDraftText = useCallback((text: string) => {
    setDraftText(text);
    try {
      if (text) sessionStorage.setItem(draftKey, text);
      else sessionStorage.removeItem(draftKey);
    } catch {
      // Keep the in-memory draft when storage is unavailable.
    }
  }, [draftKey]);

  const content = (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="commander-discussion-pane">
      <ThreadDetail
        discussionId={discussion.entityId}
        companyId={companyId}
        embedded
        onClose={onClose}
        onOpenRequest={onOpenRequest}
        draftText={draftText}
        onDraftTextChange={updateDraftText}
      />
    </div>
  );

  if (!mobile) return content;

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" showCloseButton={false} className="w-full max-w-full p-2 sm:max-w-full">
        <SheetTitle className="sr-only">{discussion.title ?? "Discussion"}</SheetTitle>
        {content}
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/*  Tool call display names                                            */
/* ------------------------------------------------------------------ */

const TOOL_LABELS: Record<string, string> = {
  list_tasks: "Checking your tasks...",
  get_task: "Looking up task details...",
  create_task: "Creating a task...",
  update_task: "Updating a task...",
  list_goals: "Reviewing goals...",
  list_agents: "Checking agents...",
  list_departments: "Looking at departments...",
  create_department: "Creating a department...",
  search_memory: "Searching memory...",
  create_discussion: "Starting a discussion...",
  list_discussions: "Checking discussions...",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidOrNull(value: string | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null;
}

function surfaceFromPath(parts: string[]): NonNullable<CommanderContextScope["surface"]> {
  if (parts.includes("issues") || parts.includes("tasks")) return "task";
  if (parts.includes("goals") || parts.includes("objectives")) return "goal";
  const section = parts[1] ?? parts[0] ?? "commander";
  if (section === "projects") return "project";
  if (section === "goals" || section === "objectives") return "goal";
  if (section === "issues" || section === "tasks") return "task";
  if (section === "memory") return "memory";
  if (section === "discussions" || section === "threads") return "discussion";
  if (section === "budget" || section === "costs") return "budget";
  if (section === "team" || section === "agents") return "team";
  if (section === "settings") return "settings";
  if (section === "home") return "home";
  if (section === "commander") return "commander";
  return "commander";
}

export function buildCommanderContextScopeFromPath(pathname: string): CommanderContextScope {
  const parts = pathname.split("/").filter(Boolean);
  const projectIndex = parts.indexOf("projects");
  const goalIndex = parts.indexOf("goals");
  const issueIndex = parts.indexOf("issues");
  const memoryIndex = parts.indexOf("memory");
  const projectId = projectIndex >= 0 ? uuidOrNull(parts[projectIndex + 1]) : null;
  const goalId = goalIndex >= 0 ? uuidOrNull(parts[goalIndex + 1]) : null;
  const taskId = issueIndex >= 0 ? uuidOrNull(parts[issueIndex + 1]) : null;

  return {
    surface: surfaceFromPath(parts),
    route: pathname.slice(0, 500),
    ...(projectId ? { projectId } : {}),
    ...(goalId ? { goalId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(memoryIndex >= 0 ? { memoryFolderPath: "Company" } : {}),
  };
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `Running ${name.replaceAll("_", " ")}...`;
}

export function completedToolLabel(name: string): string {
  const label = TOOL_LABELS[name] ?? name.replace(/_+/g, " ");
  return `Used ${label.replace(/\.\.\.$/, "").replace(/^Running\s+/i, "")}`;
}

/* ------------------------------------------------------------------ */
/*  Confirmation card entity-line derivation                           */
/* ------------------------------------------------------------------ */

/** Verbs we treat as action verbs; anything else falls back to "run <action>". */
const KNOWN_VERBS = new Set([
  "update", "create", "delete", "set", "add", "remove", "reset",
  "enable", "disable", "send", "archive", "restore", "approve",
  "reject", "assign", "unassign", "move", "copy", "list", "get",
  "fetch", "run", "start", "stop", "pause", "resume",
]);

/**
 * Derives a human-readable entity line from an action identifier.
 *
 * Examples:
 *   "update_company_identity" → "This will update company identity"
 *   "create_task"             → "This will create task"
 *   "foo_bar_baz"             → "This will run foo bar baz"
 *
 * The result is truncated to 80 characters (including "This will ").
 */
export function deriveConfirmEntityLine(action: string): string {
  const parts = action.split("_");
  const verb = parts[0] ?? "";
  const entityParts = parts.slice(1);
  let line: string;
  if (KNOWN_VERBS.has(verb.toLowerCase())) {
    const entity = entityParts.join(" ");
    line = `This will ${verb} ${entity}`.trim();
  } else {
    const humanized = parts.join(" ");
    line = `This will run ${humanized}`;
  }
  if (line.length > 80) {
    return line.slice(0, 79) + "…";
  }
  return line;
}

/* ------------------------------------------------------------------ */
/*  Message types for local rendering                                  */
/* ------------------------------------------------------------------ */

export interface ToolCallEntry {
  id: number;
  name: string;
  status: "running" | "done";
  success?: boolean;
  summary?: string;
  open?: boolean;
}

export interface LocalMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  streamingDone: boolean;
  toolCalls?: ToolCallEntry[];
  reasoning?: string;
  actionConfirm?: {
    confirmId: string;
    action: string;
    description: string;
    status: "pending" | "approving" | "approved" | "rejected" | "failed";
    errorMessage?: string;
  };
  optionsPrompt?: {
    promptId: string;
    question: string;
    options: string[];
    dismissed: boolean;
  };
  outputRefs?: ShowRef[];
  createdAt: string;
  durationMs?: number;
}

function serverToLocal(m: AgentMessage): LocalMessage {
  const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
  const toolCalls: ToolCallEntry[] | undefined =
    calls.length > 0
      ? calls.map((c, i) => ({
          id: i,
          name: c.name,
          status: "done" as const,
          ...(c.success !== undefined ? { success: c.success } : {}),
          ...(c.summary !== undefined ? { summary: c.summary } : {}),
        }))
      : undefined;
  return {
    id: m.id,
    role: m.role === "tool" ? "system" : m.role,
    content: m.content ?? "",
    streamingDone: true,
    outputRefs: m.outputRefs ?? undefined,
    ...(toolCalls ? { toolCalls } : {}),
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    createdAt: m.createdAt,
  };
}

export function mergeServerMessagesWithTransientLocal(
  serverMessages: AgentMessage[],
  localMessages: LocalMessage[],
): LocalMessage[] {
  const localById = new Map(localMessages.map((m) => [m.id, m]));
  const serverIds = new Set(serverMessages.map((m) => m.id));
  // Carry the live-only "Worked for Xs" durationMs from the streamed local
  // message onto its persisted server counterpart. The streamed message has a
  // client temp id (≠ the server id), so match by content. This keeps the
  // caption visible after the post-turn server sync; it is still absent after a
  // hard reload (no local message to carry from) — duration is not persisted,
  // by design (it lives on internal_agent_runs, not internal_agent_messages).
  const localDurationByContent = new Map<string, number>();
  for (const lm of localMessages) {
    if (lm.role === "assistant" && typeof lm.durationMs === "number" && lm.content.trim().length > 0) {
      localDurationByContent.set(lm.content, lm.durationMs);
    }
  }
  const merged = serverMessages.map((m) => {
    const base = serverToLocal(m);
    const carriedDuration =
      base.role === "assistant" ? localDurationByContent.get(base.content) : undefined;
    return {
      ...base,
      ...(carriedDuration !== undefined ? { durationMs: carriedDuration } : {}),
      actionConfirm: localById.get(m.id)?.actionConfirm,
      optionsPrompt: localById.get(m.id)?.optionsPrompt,
    };
  });

  const transientMessages = localMessages.filter(
    (m) =>
      !serverIds.has(m.id) &&
      (
        m.actionConfirm !== undefined ||
        m.optionsPrompt !== undefined ||
        (
          m.role === "assistant" &&
          m.content.trim().length > 0 &&
          !serverMessages.some(
            (serverMessage) =>
              serverMessage.role === "assistant" &&
              (serverMessage.content ?? "") === m.content,
          )
        )
      ),
  );

  return [...merged, ...transientMessages];
}

export function settleRunningToolCalls(messages: LocalMessage[], messageId: string): LocalMessage[] {
  return messages.map((m) => {
    if (m.id !== messageId || !m.toolCalls?.some((tc) => tc.status === "running")) {
      return m;
    }
    return {
      ...m,
      toolCalls: m.toolCalls.map((tc) => (
        tc.status === "running" ? { ...tc, status: "done" as const } : tc
      )),
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Panel content (shared between desktop inline & mobile sheet)       */
/* ------------------------------------------------------------------ */

interface AgentPanelContentProps {
  /** Universe changes chrome only; one canonical composer remains mounted. */
  universeView?: "compact" | "expanded" | "maximized" | "tucked";
  conversationId?: string | null;
  onSelectConversation?: (id: string) => void;
  /**
   * Task 11: on mobile/tablet the sessions list lives in a left Sheet drawer.
   * When provided, the caption's "Sessions" button opens it. Undefined on
   * desktop/wide (the inline sidebar is shown instead).
   */
  onOpenSessions?: () => void;
  /**
   * Commander Viewer P1: when true, the right-hand viewer panel (artifact
   * tabs + home) is mounted next to the chat column. Only the full-page
   * Commander route passes this — the docked w-80 panel stays viewer-free.
   */
  enableViewerPanel?: boolean;
  /**
   * When true, wraps the chat column in the Commander rounded-card chrome.
   * Only the full-page Commander route passes this — the docked InternalAgentPanel
   * and mobile sheet stay card-free.
   */
  cardChrome?: boolean;
  /**
   * Phase 6 [A1]: Controlled sessions collapse state lifted from Commander.tsx.
   * Required for the openPreview choreography to collapse the sessions sidebar
   * (which lives as a sibling component outside this panel). Only provided by
   * the full-page Commander route; undefined in docked/mobile usage.
   */
  sessionsCollapsed?: boolean;
  onSetSessionsCollapsed?: (value: boolean) => void;
  /** Captured at Send time and retained on Retry; only the dedicated Universe route supplies it. */
  getUniverseContext?: () => import("@armyofagents/shared").UniverseContext | null;
}

/**
 * Snapshot of one Commander submission (B-states, mock §5). Minted ONCE per
 * submission BEFORE the send so the failed-send banner's Retry replays the
 * EXACT attempt — same expanded message, same attachment ids, and the same
 * clientSubmissionId (the server-side agent-loop replay dedupes if the first
 * request actually landed). `revision` is the composer revision at snapshot
 * time: a retry-success only clears the input when nothing diverged since.
 */
interface CommanderSendAttempt {
  /** Trimmed raw input text — divergence comparisons only. */
  rawText: string;
  /** Fully expanded outgoing message (refs appended). */
  message: string;
  attachmentAssetIds: string[];
  refsForTurn: CommanderInputRef[];
  revision: number;
  clientSubmissionId: string;
  universeContext?: import("@armyofagents/shared").UniverseContext;
}

export function AgentPanelContent({ conversationId, onSelectConversation, onOpenSessions, enableViewerPanel, cardChrome = false, sessionsCollapsed, onSetSessionsCollapsed, universeView, getUniverseContext }: AgentPanelContentProps = {}) {
  const { selectedCompanyId } = useCompany();
  const { currentUser } = useTeamAccess(selectedCompanyId);
  const { breadcrumbs } = useBreadcrumbs();
  const providedContextScope = useCommanderContextScope();
  const location = useLocation();
  const navigate = useNavigate();
  const { closePanel, setIsStreaming, setCurrentConversationId } = useAgentPanel();
  const queryClient = useQueryClient();

  const [messages, setMessages] = useState<LocalMessage[]>([]);
  // The rich input is uncontrolled (the contenteditable DOM owns the live
  // text). We only track empty-ness here to drive the Send button + placeholder.
  const [inputEmpty, setInputEmpty] = useState(true);
  const [inputRefs, setInputRefs] = useState<CommanderInputRef[]>([]);
  const inputRefsRef = useRef<CommanderInputRef[]>([]);
  const [duplicateInputRefKey, setDuplicateInputRefKey] = useState<string | null>(null);
  const commanderFileInputRef = useRef<HTMLInputElement>(null);
  const activeConversationIdRef = useRef(conversationId);
  activeConversationIdRef.current = conversationId;
  const uploadSequenceRef = useRef(0);
  const [uploadingFiles, setUploadingFiles] = useState<Array<{ id: number; name: string }>>([]);
  const [failedUploads, setFailedUploads] = useState<Array<{ id: number; file: File }>>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [streaming, setStreamingLocal] = useState(false);
  // ─── Composer B-states (mock §5) ────────────────────────────────────────
  const [sendFailed, setSendFailed] = useState(false);
  const lastAttemptRef = useRef<CommanderSendAttempt | null>(null);
  // Bumped on every draft-changing edit (typing, ref add/remove, Discard) so a
  // retry that succeeds AFTER the draft diverged skips the clears instead of
  // wiping the newer edits (peer pattern: CommentThread / WorkspaceTimeline).
  const composerRevisionRef = useRef(0);
  // Mirror of `streaming` readable from stable callbacks (divergence guards).
  const streamingRef = useRef(false);
  const { connectionState } = useLiveUpdates();
  const composerConnection = toComposerConnectionState(connectionState);
  const isOffline = composerConnection === "offline";
  // Task 9: skill picker. `skillPickerOpen` = opened via the `+` menu (shows
  // all skills). `slashActive`/`slashQuery` = opened via a `/token` typed in
  // the textarea. The picker is open when either source is active.
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [slashActive, setSlashActive] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [pickerIndex, setPickerIndex] = useState(0);
  // The picker computes + reports its filtered list here so handleKeyDown can
  // clamp the active index and resolve the selected skill without re-filtering.
  const filteredSkillsRef = useRef<CompanySkillListItem[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<CommanderInputHandle>(null);
  const hydratedCommanderDraftKeyRef = useRef<string | null>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight SSE stream when the component unmounts (B1).
  // Uses the exported createAbortCleanup helper (testable against production code).
  useEffect(() => createAbortCleanup(abortRef), []);

  const localIdRef = useRef(0);
  const toolCallIdRef = useRef(0);
  // Track which message id had its Copy button recently clicked (for checkmark feedback)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const companyId = selectedCompanyId ?? "";
  const commanderDraft = useComposerDraft(
    companyId && currentUser?.userId
      ? { companyId, userId: currentUser.userId, surface: "commander", entityId: conversationId ?? "new" }
      : null,
  );
  useEffect(() => {
    if (!commanderDraft.storageKey || hydratedCommanderDraftKeyRef.current === commanderDraft.storageKey) return;
    hydratedCommanderDraftKeyRef.current = commanderDraft.storageKey;
    if (commanderDraft.draft.text && !inputRef.current?.getText()) {
      inputRef.current?.insertText(commanderDraft.draft.text);
    }
  }, [commanderDraft.storageKey, commanderDraft.draft.text]);
  const inlineQuestionsQuery = useInlineWorkQuestions(companyId, {
    sourceCommanderConversationId: conversationId ?? undefined,
  });

  // Load conversation history
  const { data: conversation } = useQuery({
    queryKey: queryKeys.agentConversation(companyId),
    queryFn: () => internalAgentApi.getConversation(companyId),
    enabled: !!companyId,
  });

  // Fetch greeting (summary of background activity since last visit)
  const { data: greeting } = useQuery({
    queryKey: queryKeys.agentGreeting(companyId),
    queryFn: () => internalAgentApi.getGreeting(companyId),
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  const { data: runtimeSettings } = useQuery({
    queryKey: ["internal-agent-runtime-settings", companyId],
    queryFn: () => internalAgentApi.getRuntimeSettings(companyId),
    enabled: !!companyId,
    staleTime: 60 * 1000,
  });
  const allowAlwaysEnabled = runtimeSettings?.runtimeAllowAlwaysEnabled ?? true;
  const { data: mentionAgents = [] } = useQuery({
    queryKey: ["commander-mention-agents", companyId],
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
    staleTime: 60_000,
  });

  // Load history when switching to a specific conversation
  const { data: historyData } = useQuery({
    queryKey: ["conversation-messages", companyId, conversationId],
    queryFn: () =>
      companyId && conversationId
        ? conversationMessagesApi.list(companyId, conversationId)
        : Promise.resolve(null),
    enabled: !!companyId && !!conversationId,
  });

  // Commander Viewer P1: per-conversation tab state + mobile flag. The viewer
  // hook is always called (hooks rules) but the panel only mounts when
  // `enableViewerPanel` is set (full-page Commander route).
  const { useDrawerSessions, isTablet, isWide } = useBreakpoint();
  const viewer = useCommanderViewer(conversationId ?? null);

  // Task 4: gate viewer auto-open on the effective viewerControl level.
  // The SSE tool_result loop runs inside a memoized (stale) closure, so it MUST
  // read the level from a ref at event time — reading `effectiveLevel` directly
  // there would capture a render-old value. Fail-closed: default "manual" (no
  // auto-open) while the preference is still loading or errored.
  const { effectiveLevel } = useViewerControl(companyId || null);
  const effectiveLevelRef = useRef<ViewerControlLevel>("manual");
  useEffect(() => {
    effectiveLevelRef.current = effectiveLevel ?? "manual";
  }, [effectiveLevel]);
  // One tab may auto-open per user turn (kills the live-ref "tab storm"). Reset
  // to false when a new user turn is sent (see sendText).
  const autoOpenedTurnRef = useRef(false);
  const [paneState, dispatchPane] = useReducer(
    commanderPaneCoordinatorReducer,
    typeof window === "undefined" ? 1600 : window.innerWidth,
    initialCommanderPaneCoordinatorState,
  );
  const focusPane = paneState.focus;
  const discussionPane = focusPane?.kind === "discussion" ? focusPane : null;
  const taskFocusPane = focusPane?.kind === "workspace" ? focusPane : null;

  // Phase 1: resizable panel geometry + collapse persistence.
  const [viewerCollapsed, setViewerCollapsed] = useCommanderViewerCollapsed();
  const [cockpitCollapsed, setCockpitCollapsed] = useCommanderCockpitCollapsed();
  const [tabletCockpitOpen, setTabletCockpitOpen] = useState(false);
  const focusDetailOpen = focusPane !== null && paneState.viewerOpen;
  const showChatPanel = paneState.chat === "expanded" && !focusDetailOpen;
  // Phase 1 (panel-redesign): cockpit is now a width-div sibling — NOT in the Group.
  // panelIds only covers the center Group panels: chat + optionally viewer.
  // Key uses "-v2" suffix to avoid restoring stale 3-panel geometry from old sessions.
  const panelIds = useMemo(
    () => [
      ...(showChatPanel ? ["commander-chat"] : []),
      ...(focusPane ? ["commander-focus"] : []),
      ...(viewerCollapsed ? [] : ["commander-detail"]),
    ],
    [focusPane, showChatPanel, viewerCollapsed],
  );
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `aoa:commander:panel-sizes-v3:${panelIds.join(":") || "empty"}`,
    storage: localStorage,
    panelIds,
  });

  useEffect(() => {
    const updateWidth = () => dispatchPane({ type: "set_width", width: window.innerWidth });
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  // Phase 6: open/close preview choreography (applyPreviewFocus parity).
  //
  // Pre-open snapshot: we capture sessions + cockpit collapsed state just before
  // opening so closePreview() can restore them (not force-expand if the user had
  // them already closed). Stored in a ref so it doesn't trigger re-renders.
  const preOpenSnapshotRef = useRef<{ sessions: boolean; cockpit: boolean } | null>(null);
  const focusRestoreRef = useRef<{
    sessionsCollapsed: boolean;
    cockpitCollapsed: boolean;
    viewerCollapsed: boolean;
  } | null>(null);

  // openPreview(source):
  //   "center"       — chat-header toggle: collapse BOTH sessions + cockpit
  //   "right-panel"  — chip/cockpit/reply/browser/liveRef: collapse sessions only;
  //                    also collapse cockpit when NOT ultrawide (B6: tablet tier)
  const openPreview = useCallback((source: "center" | "right-panel") => {
    // Snapshot current state before collapsing
    const currentSessionsCollapsed = sessionsCollapsed ?? true;
    preOpenSnapshotRef.current = {
      sessions: currentSessionsCollapsed,
      cockpit: cockpitCollapsed,
    };

    // Expand the viewer
    setViewerCollapsed(false);
    viewer.expand();
    dispatchPane({ type: "open_viewer", originFocusKey: focusPane ? `${focusPane.kind}:${focusPane.entityId}` : "commander" });

    // Always collapse sessions
    onSetSessionsCollapsed?.(true);

    // Collapse cockpit: always for "center"; also for "right-panel" when not ultrawide
    if (source === "center" || !isWide) {
      setCockpitCollapsed(true);
      setTabletCockpitOpen(false);
    }
  }, [sessionsCollapsed, cockpitCollapsed, setViewerCollapsed, viewer, focusPane, onSetSessionsCollapsed, setCockpitCollapsed, isWide]);

  // closePreview(): collapse viewer, restore sessions + cockpit to pre-open state.
  const closePreview = useCallback(() => {
    setViewerCollapsed(true);
    viewer.collapse();
    dispatchPane({ type: "close_viewer" });

    if (preOpenSnapshotRef.current !== null) {
      const { sessions, cockpit } = preOpenSnapshotRef.current;
      onSetSessionsCollapsed?.(sessions);
      setCockpitCollapsed(cockpit);
      preOpenSnapshotRef.current = null;
    }
  }, [setViewerCollapsed, viewer, onSetSessionsCollapsed, setCockpitCollapsed]);

  const openFocusPane = useCallback((target: CommanderFocusTarget, originFocusKey: string) => {
    if (!focusPane) {
      focusRestoreRef.current = {
        sessionsCollapsed: sessionsCollapsed ?? true,
        cockpitCollapsed,
        viewerCollapsed,
      };
    }
    dispatchPane({ type: "open_focus", target, originFocusKey });
    onSetSessionsCollapsed?.(true);
    setCockpitCollapsed(true);
    setTabletCockpitOpen(false);
    setViewerCollapsed(true);
    viewer.collapse();
  }, [cockpitCollapsed, focusPane, onSetSessionsCollapsed, sessionsCollapsed, setCockpitCollapsed, setViewerCollapsed, viewer, viewerCollapsed]);

  const openTaskFocusPane = useCallback((issueId: string, title = "Task", anchorId?: string) => {
    openFocusPane(
      { kind: "workspace", entityId: issueId, title, anchorId },
      `task:${issueId}`,
    );
  }, [openFocusPane]);

  const openDiscussionPane = useCallback((discussionId: string, title: string) => {
    openFocusPane(
      { kind: "discussion", entityId: discussionId, title },
      `discussion:${discussionId}`,
    );
  }, [openFocusPane]);

  const closeFocusPane = useCallback(() => {
    const snapshot = focusRestoreRef.current;
    dispatchPane({ type: "close_focus" });
    preOpenSnapshotRef.current = null;
    if (snapshot) {
      onSetSessionsCollapsed?.(snapshot.sessionsCollapsed);
      setCockpitCollapsed(snapshot.cockpitCollapsed);
      setViewerCollapsed(snapshot.viewerCollapsed);
      if (!snapshot.viewerCollapsed) viewer.expand();
    }
    focusRestoreRef.current = null;
  }, [onSetSessionsCollapsed, setCockpitCollapsed, setViewerCollapsed, viewer]);

  const closeTopSurface = useCallback(() => {
    if (!viewerCollapsed) {
      closePreview();
      return;
    }
    if (focusPane) {
      closeFocusPane();
      return;
    }
    closePanel();
  }, [closeFocusPane, closePanel, closePreview, focusPane, viewerCollapsed]);

  const openDiscussionRequest = useCallback((request: ThreadOpenRequest) => {
    switch (request.kind) {
      case "task":
      case "task_output":
        openPreview("right-panel");
        viewer.openTask(request.issueId, request.title);
        return;
      case "artifact":
        openPreview("right-panel");
        viewer.openRef({
          v: 1,
          kind: "artifact",
          id: request.artifactId,
          versionId: request.versionId ?? null,
          title: request.title,
          action: "referenced",
        });
        return;
      case "browser":
        openPreview("right-panel");
        viewer.openBrowser(request.url);
        return;
      case "memory":
      case "scope_item":
      case "asset":
      case "map":
        if (discussionPane) navigate(`/discussions/${discussionPane.entityId}`);
        return;
    }
  }, [discussionPane, navigate, openPreview, viewer]);

  // Lightweight helpers still used for cockpit expand/collapse buttons (unchanged UX).
  const expandCockpit = useCallback(() => {
    // Keep the persisted desktop state and the tablet sheet state in sync. The
    // breakpoint can change while the app is mounted (and Playwright can resize
    // between navigations); updating only the branch selected by the current
    // render can leave the rail visible after an expand click.
    setCockpitCollapsed(false);
    if (isTablet) {
      setTabletCockpitOpen(true);
    }
    if (!isWide) setViewerCollapsed(true);
  }, [isTablet, setCockpitCollapsed, setViewerCollapsed, isWide]);
  const collapseCockpit = useCallback(() => {
    setCockpitCollapsed(true);
    if (isTablet) {
      setTabletCockpitOpen(false);
      return;
    }
  }, [isTablet, setCockpitCollapsed]);

  // Stable ref to openPreview for use inside stale SSE closures (onLiveRef).
  // The sendText / handleSSEEvent callbacks are memoized and capture viewer + other
  // values from the render they were created in, so we must NOT capture openPreview
  // by value in those closures — use this ref instead.
  const openPreviewRef = useRef(openPreview);
  openPreviewRef.current = openPreview;

  // Conversations list — same cache key as SessionsSidebar (no extra fetch)
  const { data: conversationsData } = useQuery({
    queryKey: ["commander-conversations", companyId],
    queryFn: () => commanderConversationsApi.list(companyId),
    enabled: !!companyId,
  });

  const allConversations = conversationsData?.conversations ?? [];

  // Active conversation row (for caption title/meta)
  const activeConv = useMemo(
    () => (conversationId ? allConversations.find((c) => c.id === conversationId) : undefined),
    [allConversations, conversationId],
  );

  // Top 2 most-recent conversations (by updatedAt) for empty-state recent chats,
  // excluding the currently-active one so the list isn't redundant.
  const recentChats = useMemo(
    () =>
      [...allConversations]
        .filter((c) => c.id !== conversationId)
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
        .slice(0, 2),
    [allConversations, conversationId],
  );

  // Reset messages when switching conversations
  useEffect(() => {
    if (!conversationId) return;
    setMessages([]);
    setStreamingLocal(false);
    inputRefsRef.current = [];
    setInputRefs([]);
    setUploadingFiles([]);
    setFailedUploads([]);
    setAttachmentError(null);
    // Entity switch: the send-failed banner + attempt snapshot belong to the
    // PREVIOUS conversation — Retry must never post into a different one. The
    // revision bump keeps a still-in-flight send from the previous
    // conversation from re-arming the banner or clearing the new draft.
    composerRevisionRef.current += 1;
    lastAttemptRef.current = null;
    setSendFailed(false);
  }, [conversationId]);

  // Populate messages from history when historyData arrives.
  // conversationId is included so the effect re-fires when switching between
  // cached conversations (TanStack Query returns the same object reference on a
  // cache hit, so [historyData] alone would not trigger a re-run).
  useEffect(() => {
    if (!historyData?.messages?.length) return;
    const loaded: LocalMessage[] = historyData.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map(serverToLocal);
    setMessages(loaded);
  }, [historyData, conversationId]);

  // Sync server messages into local state (only when not streaming AND no specific conversation is selected)
  useEffect(() => {
    if (conversationId) return;
    if (streaming) return;
    if (!conversation) return;
    if (conversation.messages) {
      setMessages((prev) => {
        return mergeServerMessagesWithTransientLocal(
          conversation.messages ?? [],
          prev,
        );
      });
    }
    if (conversation.conversation?.id) {
      setCurrentConversationId(conversation.conversation.id);
    }
  }, [conversation, streaming, setCurrentConversationId, conversationId]);

  // Auto-scroll on new messages or streaming content/action card updates
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (shouldAutoScroll(el.scrollHeight, el.scrollTop, el.clientHeight)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, messages[messages.length - 1]?.content, messages[messages.length - 1]?.actionConfirm]);

  // Focus input when panel opens
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, []);

  // Escape key closes panel on desktop — UNLESS the skill picker is open, in
  // which case the picker's own Escape handler closes it instead. The native
  // document listener can't see React's stopPropagation, so we guard via a ref.
  //
  // Task 11 (Eng E2): the mobile/tablet sessions Sheet is a Radix Dialog. Its
  // own Escape handler closes the drawer, but the native document listener below
  // would otherwise ALSO fire closePanel() on the same keystroke (double-fire).
  // Guard by early-returning whenever any Radix dialog/sheet is open in the DOM
  // (data-state="open"), so the drawer's Escape only closes the drawer.
  const pickerOpenRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pickerOpenRef.current) return;
        // Defer to any open Radix dialog/sheet (e.g. the sessions drawer or the
        // rename/delete dialogs) — let it own the Escape and skip closePanel().
        if (document.querySelector('[data-slot="sheet-content"],[role="dialog"][data-state="open"]')) {
          return;
        }
        closeTopSurface();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeTopSurface]);

  const pageContext = breadcrumbs.length > 0 ? breadcrumbs.map((b) => b.label).join(" > ") : null;
  const contextScope = useMemo(
    () => universeView ? { surface: "universe" as const, route: location.pathname } : providedContextScope ?? buildCommanderContextScopeFromPath(location.pathname),
    [providedContextScope, location.pathname, universeView],
  );

  const sendText = useCallback(
    async (text: string, attachmentAssetIds?: string[], clientSubmissionId?: string, universeContext?: import("@armyofagents/shared").UniverseContext): Promise<boolean> => {
      if (!text || !companyId || streaming) return false;

      // New user turn: allow exactly one auto-opened viewer tab for the refs
      // this turn produces (Task 4 one-tab-per-turn arbitration).
      autoOpenedTurnRef.current = false;

      setStreamingLocal(true);
      streamingRef.current = true;
      setIsStreaming(true);

      // Add user message
      const userMsg: LocalMessage = {
        id: `local-user-${Date.now()}-${++localIdRef.current}`,
        role: "user",
        content: text,
        streamingDone: true,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Prepare assistant message placeholder
      const assistantId = `local-assistant-${Date.now()}-${++localIdRef.current}`;
      const assistantMsg: LocalMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        streamingDone: false,
        toolCalls: [],
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      const controller = new AbortController();
      abortRef.current = controller;
      let accepted = false;
      // A server-emitted SSE `error` event (CLI failure mid-stream, or the
      // "already being processed" idempotency response) ends the generator
      // NORMALLY rather than throwing. Without tracking it, the loop would fall
      // through to `accepted = true` and suppress the failed-send banner even
      // though no reply was produced — breaking the idempotent Retry flow
      // (PR #291 round-3 review).
      let sawError = false;

      try {
        const stream = streamAgentChat(companyId, text, pageContext, controller.signal, conversationId, contextScope, attachmentAssetIds, clientSubmissionId, universeContext);

        for await (const event of stream) {
          if (event.event === "error") sawError = true;
          handleSSEEvent(event, assistantId);
        }
        accepted = !sawError;
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // Stop generation happens after the server accepted the user turn.
          accepted = true;
        } else {
          setMessages((prev) =>
            settleRunningToolCalls(prev, assistantId).map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content || "Sorry, something went wrong. Please try again.", streamingDone: true }
                : m,
            ),
          );
        }
      } finally {
        // Mark streaming done on the assistant message (fix #1: switch to markdown)
        setMessages((prev) =>
          settleRunningToolCalls(prev, assistantId).map((m) =>
            m.id === assistantId ? { ...m, streamingDone: true } : m,
          ),
        );
        setStreamingLocal(false);
        streamingRef.current = false;
        setIsStreaming(false);
        abortRef.current = null;
        // Refresh conversation from server
        queryClient.invalidateQueries({ queryKey: queryKeys.agentConversation(companyId) });
        queryClient.invalidateQueries({ queryKey: ["commander-conversations"] });
      }
      return accepted;
    },
    [companyId, streaming, pageContext, setIsStreaming, queryClient, conversationId, contextScope],
  );

  /** Shared send path: submitCommanderInput mints a fresh attempt, the failed-send
   *  banner's Retry replays the stored one (same clientSubmissionId). */
  const settleAcceptedCommanderSend = useCallback((attempt: CommanderSendAttempt) => {
        setSendFailed(false);
        lastAttemptRef.current = null;
        // Retry-success safety: only clear when the draft still matches the
        // snapshot — mid-flight edits/ref changes must survive the clear.
        if (composerRevisionRef.current === attempt.revision) {
          inputRef.current?.clear();
          const remaining = settleCommanderInputRefsAfterSend(
            inputRefsRef.current,
            attempt.refsForTurn,
            true,
          );
          inputRefsRef.current = remaining;
          setInputRefs(remaining);
          setAttachmentError(null);
        }
  }, []);

  const performCommanderSend = useCallback(
    async (attempt: CommanderSendAttempt) => {
      const accepted = await sendText(attempt.message, attempt.attachmentAssetIds, attempt.clientSubmissionId, attempt.universeContext);
      if (accepted) {
        settleAcceptedCommanderSend(attempt);
      } else {
        // Failure never eats your work (mock §5): the draft + attached refs are
        // all kept — the shared banner offers Retry / Edit / Discard.
        // Mid-flight divergence guard (stale-banner residual): if the draft or
        // refs tray moved while this send/retry was in flight (the dismiss is
        // suppressed while streaming), the snapshot is stale — a re-armed
        // banner's Retry would post it (e.g. a removed reference). Leave the
        // banner down; the user sends fresh with a NEW clientSubmissionId.
        setSendFailed(composerRevisionRef.current === attempt.revision);
      }
    },
    [sendText, settleAcceptedCommanderSend],
  );

  const submitCommanderInput = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const refsForTurn = inputRefsRef.current;
      if ((!trimmed && refsForTurn.length === 0) || uploadingFiles.length > 0 || isOffline) return;
      setSendFailed(false);
      const baseText = trimmed || "Use the referenced context.";
      const universeContext = getUniverseContext?.() ?? null;
      // Minted ONCE per submission and snapshotted BEFORE the await so the
      // banner's Retry re-sends the exact same attempt (same clientSubmissionId
      // → the server replays if the first request actually landed).
      const attempt: CommanderSendAttempt = {
        rawText: trimmed,
        message: appendCommanderInputRefsToMessage(baseText, refsForTurn),
        attachmentAssetIds: refsForTurn.filter((r) => r.kind === "asset").map((r) => r.id),
        refsForTurn,
        revision: composerRevisionRef.current,
        clientSubmissionId: createComposerSubmissionId(),
        ...(universeContext ? { universeContext } : {}),
      };
      lastAttemptRef.current = attempt;
      await performCommanderSend(attempt);
    },
    [performCommanderSend, uploadingFiles.length, isOffline, getUniverseContext],
  );

  /** Banner Retry first observes the canonical receipt. It re-sends the exact
   * attempt only when the server proves the submission was never accepted. */
  const handleRetryFailedSend = useCallback(async () => {
    const attempt = lastAttemptRef.current;
    if (!attempt || streamingRef.current || isOffline) return;
    if (!companyId || !conversationId) {
      await performCommanderSend(attempt);
      return;
    }
    try {
      const outcome = await commanderConversationsApi.getSubmissionOutcome(
        companyId,
        conversationId,
        attempt.clientSubmissionId,
      );
      if (outcome.state === "accepted" || outcome.state === "completed") {
        settleAcceptedCommanderSend(attempt);
        await queryClient.invalidateQueries({ queryKey: queryKeys.agentConversation(companyId) });
        return;
      }
      if (outcome.state === "not_found") await performCommanderSend(attempt);
      // A canonical failed receipt or an observation failure is deliberately
      // not resubmitted. The preserved draft remains available to edit/discard.
    } catch {
      setSendFailed(true);
    }
  }, [companyId, conversationId, isOffline, performCommanderSend, queryClient, settleAcceptedCommanderSend]);

  const handleEditFailedSend = useCallback(() => {
    setSendFailed(false);
  }, []);

  const handleDiscardFailedSend = useCallback(() => {
    lastAttemptRef.current = null;
    setSendFailed(false);
    composerRevisionRef.current += 1;
    inputRef.current?.clear();
    inputRefsRef.current = [];
    setInputRefs([]);
    setAttachmentError(null);
  }, []);

  // Stale-snapshot guard (mock §5: failure never eats your work): once the
  // draft diverges from the failed attempt, Retry would post stale content and
  // its success-clear would wipe the newer edits — dismiss the banner. The next
  // send is a normal fresh submission with a NEW clientSubmissionId.
  const handleComposerTextChange = useCallback((text: string) => {
    composerRevisionRef.current += 1;
    const attempt = lastAttemptRef.current;
    if (attempt && !streamingRef.current && text.trim() !== attempt.rawText) {
      setSendFailed(false);
    }
  }, []);

  const addInputRef = useCallback((ref: CommanderInputRef, suggestedPrompt?: string) => {
    const next = buildCommanderInputRefState(inputRefsRef.current, ref);
    const refs = next.refs.slice(-MAX_COMMANDER_INPUT_REFS);
    inputRefsRef.current = refs;
    setInputRefs(refs);
    setDuplicateInputRefKey(next.duplicateKey);
    // Only a REAL tray change (a ref actually added) is divergence — Retry
    // must never post attachments the failed attempt didn't include, so the
    // banner goes down and the next send mints a fresh submission.
    if (next.duplicateKey === null) {
      composerRevisionRef.current += 1;
      if (!streamingRef.current) setSendFailed(false);
    }
    if (suggestedPrompt && next.duplicateKey === null) {
      inputRef.current?.insertText(suggestedPrompt);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const uploadCommanderFiles = useCallback(async (files: File[], replacingFailedId?: number) => {
    if (!companyId || files.length === 0 || streaming) return;
    const attachedCount = inputRefsRef.current.filter((ref) => ref.kind === "asset").length;
    const retainedFailureCount = failedUploads.filter((item) => item.id !== replacingFailedId).length;
    const selection = validateCommanderAttachmentFiles(
      files,
      attachedCount + retainedFailureCount,
      uploadingFiles.length,
    );
    if (replacingFailedId !== undefined) {
      setFailedUploads((current) => current.filter((item) => item.id !== replacingFailedId));
    }
    setAttachmentError(selection.errors.length > 0 ? selection.errors.join(" ") : null);

    for (const file of selection.accepted) {
      const uploadConversationId = conversationId;
      const uploadId = ++uploadSequenceRef.current;
      setUploadingFiles((current) => [...current, { id: uploadId, name: file.name }]);
      try {
        const asset = await assetsApi.uploadFile(
          companyId,
          file,
          `commander/${conversationId ?? "new"}`,
        );
        if (activeConversationIdRef.current === uploadConversationId) {
          addInputRef(assetResponseToCommanderInputRef(asset, file.name));
        }
      } catch {
        // Round-10 #3: guard the failure path with the SAME active-conversation
        // check the success path uses. If the user switched chats mid-upload,
        // drop the stale failure silently — otherwise B's tray shows a failed
        // card for A's file, and retrying it would attach A's file to B.
        if (activeConversationIdRef.current === uploadConversationId) {
          setFailedUploads((current) => [...current, { id: uploadId, file }]);
          setAttachmentError(`Could not upload ${file.name}. Retry or remove it below.`);
        }
      } finally {
        setUploadingFiles((current) => current.filter((item) => item.id !== uploadId));
      }
    }
  }, [addInputRef, companyId, conversationId, failedUploads, streaming, uploadingFiles.length]);

  const handleCommanderFileInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void uploadCommanderFiles(files);
  }, [uploadCommanderFiles]);

  // Frame-wide drag-drop (mock §5): validation stays in uploadCommanderFiles
  // (validateCommanderAttachmentFiles) — the hook only detects + hands over.
  const { isDragActive, dragHandlers } = useComposerDragDrop({
    onDropFiles: (files: File[]) => void uploadCommanderFiles(files),
    disabled: streaming,
  });

  useEffect(() => {
    if (!duplicateInputRefKey) return;
    const timer = window.setTimeout(() => setDuplicateInputRefKey(null), 1200);
    return () => window.clearTimeout(timer);
  }, [duplicateInputRefKey]);

  const removeInputRef = useCallback((ref: CommanderInputRef) => {
    const key = commanderInputRefKey(ref);
    const refs = inputRefsRef.current.filter((item) => commanderInputRefKey(item) !== key);
    inputRefsRef.current = refs;
    setInputRefs(refs);
    setDuplicateInputRefKey((current) => (current === key ? null : current));
    // Retry must never post a removed (possibly sensitive) attachment.
    composerRevisionRef.current += 1;
    if (!streamingRef.current) setSendFailed(false);
  }, []);

  const handleOpenInputRef = useCallback(
    (ref: CommanderInputRef) => {
      openCommanderInputRef(ref, {
        openPreview,
        openTask: openTaskFocusPane,
        openDiscussion: openDiscussionPane,
        openArtifact: (id, title) => {
          viewer.openRef({ v: 1, kind: "artifact", id, title, action: "referenced" });
        },
        openInputRef: viewer.openInputRef,
        navigate,
      });
    },
    [navigate, openDiscussionPane, openPreview, openTaskFocusPane, viewer],
  );

  const handleSend = useCallback(async () => {
    // Read the expanded directive text (skill tokens → full use_skill lines)
    // straight from the rich input; it clears itself on submit.
    const text = inputRef.current?.getText() ?? "";
    if ((!text && inputRefsRef.current.length === 0) || uploadingFiles.length > 0) return;
    await submitCommanderInput(text);
  }, [submitCommanderInput, uploadingFiles.length]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setStreamingLocal(false);
    setIsStreaming(false);
  }, [setIsStreaming]);

  // Not wrapped in useCallback intentionally — only called from handleSend's async loop,
  // and only uses setMessages (functional updater) + toolCallIdRef (ref). No stale closure risk.
  function handleSSEEvent(event: SSEEvent, assistantId: string) {
    switch (event.event) {
      case "content":
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: m.content + ((event.data as { text?: string }).text ?? "") }
              : m,
          ),
        );
        break;

      case "thinking":
        // Show thinking indicator — content stays empty until real content arrives
        break;

      case "reasoning": {
        const text = (event.data as { text?: string }).text ?? "";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, reasoning: (m.reasoning ?? "") + text } : m,
          ),
        );
        break;
      }

      case "error": {
        const message =
          (event.data as { message?: string }).message ??
          "Commander hit an error. Please try again.";
        setMessages((prev) =>
          settleRunningToolCalls(prev, assistantId).map((m) =>
            m.id === assistantId && !m.content
              ? { ...m, content: message, streamingDone: true }
              : m,
          ),
        );
        break;
      }

      case "tool_call": {
        const name = (event.data as { name?: string }).name ?? "unknown";
        const callId = ++toolCallIdRef.current;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, toolCalls: [...(m.toolCalls ?? []), { id: callId, name, status: "running" }] }
              : m,
          ),
        );
        break;
      }

      case "tool_result": {
        // Fix #3: Mark only the FIRST running tool call with this name as done (by id order)
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            const data = event.data as { name?: string; success?: boolean; summary?: string };
            const toolName = data.name;
            let found = false;
            const updated = (m.toolCalls ?? []).map((tc) => {
              if (!found && tc.name === toolName && tc.status === "running") {
                found = true;
                return { ...tc, status: "done" as const, success: data.success ?? true, summary: data.summary };
              }
              return tc;
            });
            return { ...m, toolCalls: updated };
          }),
        );
        // Commander Viewer P1: accumulate output refs on the streaming assistant
        // message + auto-open created refs (desktop) / badge the pill (mobile).
        // NOTE: this closure can be stale (sendText is memoized and captures the
        // handleSSEEvent from the render it was created in) — that is safe ONLY
        // because useCommanderViewer's API reads its live state from a ref at
        // call time, and setMessages uses a functional updater.
        const liveRefs = (event.data as { refs?: ShowRef[] }).refs;
        if (liveRefs && liveRefs.length > 0) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, outputRefs: mergeRefs(m.outputRefs ?? [], liveRefs) }
                : m,
            ),
          );
          // Task 4: cap tab creation at ONE auto-open per user turn, gated by the
          // effective viewerControl level read from a ref (this closure is stale;
          // reading the state var here would be render-old). Chips already show
          // ALL refs via the mergeRefs above — only tab creation is arbitrated.
          if (enableViewerPanel && !useDrawerSessions && !autoOpenedTurnRef.current) {
            const pick = pickAutoOpenRef(
              liveRefs,
              effectiveLevelRef.current,
              useDrawerSessions,
            );
            if (pick) {
              // Phase 6 [A2]: run the choreography first (right-panel: collapses
              // sessions only, keeps cockpit on ultrawide — do NOT yank both
              // panels mid-stream). openPreviewRef is a stable ref so it's safe
              // inside this stale closure.
              openPreviewRef.current("right-panel");
              viewer.onLiveRef(pick, useDrawerSessions, effectiveLevelRef.current);
              autoOpenedTurnRef.current = true;
            }
          } else if (
            enableViewerPanel &&
            useDrawerSessions &&
            effectiveLevelRef.current !== "manual"
          ) {
            // Mobile: no visible tab opens (the drawer stays closed), but pre-load
            // the created refs and surface the "N new" pill badge — governed by
            // viewerControl (manual = no nudge). pickAutoOpenRef excludes mobile,
            // so this per-ref path (not the one-tab arbitration) restores the badge
            // + pre-load. No per-turn cap here: mobile opens no focused tab, so we
            // pre-load ALL refs for an accurate badge count (prior parity).
            for (const r of liveRefs) {
              viewer.onLiveRef(r, useDrawerSessions, effectiveLevelRef.current);
            }
          }
        }
        break;
      }

      case "action_confirm": {
        const { confirmId, action, description } = event.data as {
          confirmId: string;
          action: string;
          description: string;
        };
        setMessages((prev) =>
          settleRunningToolCalls(prev, assistantId).map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  actionConfirm: { confirmId, action, description, status: "pending" },
                }
              : m,
          ),
        );
        break;
      }

      case "options_prompt": {
        const { promptId, question, options } = event.data as {
          promptId: string;
          question: string;
          options: string[];
        };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, optionsPrompt: { promptId, question, options, dismissed: false } }
              : m,
          ),
        );
        break;
      }

      case "done": {
        const durationMs = (event.data as { durationMs?: number }).durationMs;
        setMessages((prev) =>
          settleRunningToolCalls(prev, assistantId).map((m) =>
            m.id === assistantId && typeof durationMs === "number" ? { ...m, durationMs } : m,
          ),
        );
        break;
      }
    }
  }

  const sendConfirmMessage = useCallback(
    async (
      messageId: string,
      confirmId: string,
      decision: ConfirmActionDecision,
    ) => {
      const isDeny = decision === "deny";
      // 1. Optimistic UI: move status to "approving" / "rejected"
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId && m.actionConfirm
            ? {
                ...m,
                actionConfirm: {
                  ...m.actionConfirm,
                  status: isDeny ? "rejected" : "approving",
                },
              }
            : m,
        ),
      );

      try {
        const result = await confirmAction(companyId, { confirmId, decision });

        // 2. Settle UI based on server result
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId && m.actionConfirm
              ? {
                  ...m,
                  actionConfirm: {
                    ...m.actionConfirm,
                    status:
                      result.result === "executed"
                        ? "approved"
                        : result.result === "rejected" || result.result === "denied"
                          ? "rejected"
                          : "failed",
                    errorMessage: result.error ?? undefined,
                  },
                }
              : m,
          ),
        );

        // 3. Refresh conversation so any new tool-result messages appear in chat
        queryClient.invalidateQueries({ queryKey: queryKeys.agentConversation(companyId) });
        queryClient.invalidateQueries({ queryKey: ["commander-conversations"] });
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId && m.actionConfirm
              ? {
                  ...m,
                  actionConfirm: {
                    ...m.actionConfirm,
                    status: "failed",
                    errorMessage: err instanceof Error ? err.message : "Network error",
                  },
                }
              : m,
          ),
        );
      }
    },
    [companyId, queryClient],
  );

  const handleReset = useCallback(async () => {
    if (!companyId || streaming) return;
    // Abort any in-flight stream
    abortRef.current?.abort();
    try {
      await internalAgentApi.resetConversation(companyId);
      setMessages([]);
      queryClient.invalidateQueries({ queryKey: queryKeys.agentConversation(companyId) });
    } catch {
      // ignore
    }
  }, [companyId, streaming, queryClient]);

  // Newest pending confirmation id — only the most-recent pending card pulses.
  const newestPendingConfirmId = useMemo(() => {
    let result: string | null = null;
    for (const m of messages) {
      if (m.actionConfirm?.status === "pending") {
        result = m.actionConfirm.confirmId;
      }
    }
    return result;
  }, [messages]);

  // Copy message content to clipboard with a transient checkmark.
  const handleCopyMessage = useCallback((msgId: string, content: string) => {
    void navigator.clipboard.writeText(content);
    setCopiedMessageId(msgId);
    setTimeout(() => setCopiedMessageId((prev) => (prev === msgId ? null : prev)), 1500);
  }, []);

  // The picker is open if triggered by a slash token OR the `+` menu.
  const pickerOpen = slashActive || skillPickerOpen;
  const pickerQuery = slashActive ? slashQuery : "";

  // Mirror picker-open into a ref so the native document Escape listener can
  // defer to the picker without re-subscribing on every toggle.
  useEffect(() => {
    pickerOpenRef.current = pickerOpen;
  }, [pickerOpen]);

  const closePicker = useCallback(() => {
    setSlashActive(false);
    setSlashQuery("");
    setSkillPickerOpen(false);
    setPickerIndex(0);
  }, []);

  // CommanderInput reports its empty/non-empty state so we can disable Send.
  const handleEmptyChange = useCallback((empty: boolean) => {
    setInputEmpty(empty);
  }, []);

  // CommanderInput reports the slash-command context at the caret. A `/` token
  // drives the slash-triggered picker; a `+`-menu-triggered picker is left
  // untouched (it isn't slash-driven).
  const handleSlashChange = useCallback((slash: SlashState) => {
    if (slash.active) {
      setSlashActive(true);
      setSlashQuery(slash.query);
    } else {
      setSlashActive(false);
      setSlashQuery("");
    }
    setPickerIndex(0);
  }, []);

  // Stable callback so SkillPicker's effect dep array doesn't re-fire every
  // parent render (an inline arrow would recreate on every render).
  const handleFilteredSkillsChange = useCallback(
    (skills: CompanySkillListItem[]) => {
      filteredSkillsRef.current = skills;
    },
    [],
  );

  const handleSelectSkill = useCallback(
    (skill: CompanySkillListItem) => {
      // The rich input inserts a colored atomic token (just the skill name);
      // it expands to the full use_skill directive on send. `slashActive`
      // tells it whether to replace a typed `/query` or insert inline.
      inputRef.current?.insertSkill(skill, slashActive);
      closePicker();
    },
    [slashActive, closePicker],
  );

  // Parent gets first crack at keydown (CommanderInput calls this before its
  // own Enter/Backspace handling). When the picker is open, picker nav wins and
  // we preventDefault so CommanderInput skips submit. When the picker is closed,
  // we do nothing here and let CommanderInput own Enter-to-send.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!pickerOpen) return;
    const list = filteredSkillsRef.current;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (list.length > 0) setPickerIndex((i) => Math.min(i + 1, list.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (list.length > 0) setPickerIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const skill = list[pickerIndex];
      if (skill) handleSelectSkill(skill);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePicker();
    }
  };

  // Commander Viewer P1: deduped refs across the loaded conversation (feeds the
  // viewer's home tab). Cheap O(messages) — no memo needed.
  const conversationRefs = collectConversationRefs(messages);
  const commanderInlineQuestions = useMemo(
    () => Array.isArray(inlineQuestionsQuery.data) ? inlineQuestionsQuery.data : [],
    [inlineQuestionsQuery.data],
  );
  const commanderQuestionBuckets = useMemo(() => {
    const byMessageId = new Map<string, typeof commanderInlineQuestions>();
    const trailing: typeof commanderInlineQuestions = [];
    const orderedQuestions = [...commanderInlineQuestions].sort((left, right) => (
      new Date(left.question.createdAt).getTime() - new Date(right.question.createdAt).getTime()
      || left.question.id.localeCompare(right.question.id)
    ));
    for (const detail of orderedQuestions) {
      const questionTime = new Date(detail.question.createdAt).getTime();
      const nextMessage = messages.find((message) => new Date(message.createdAt).getTime() >= questionTime);
      if (!nextMessage) {
        trailing.push(detail);
        continue;
      }
      const bucket = byMessageId.get(nextMessage.id) ?? [];
      bucket.push(detail);
      byMessageId.set(nextMessage.id, bucket);
    }
    return { byMessageId, trailing };
  }, [commanderInlineQuestions, messages]);

  // The chat column is extracted into a const (instead of re-indenting the
  // ~400-line tree inside a new row wrapper) so the viewer-panel row below
  // stays a small, reviewable diff. Classes: original `flex flex-col h-full`
  // + `min-w-0 flex-1` so the column shrinks correctly next to the viewer.
  const chatColumn = (
    <div
      className={cn(
        "flex h-full min-w-0 flex-1 flex-col",
        cardChrome && `${COMMANDER_PANEL_CARD} overflow-hidden`,
      )}
    >
      {/* Chat pane caption strip. In full-page Commander (enableViewerPanel) it always
          renders so the "Open preview" toggle is reachable even before a session is
          selected (the default conversation shows messages with conversationId still
          null). In docked mode it shows only with an active conversation and never the
          toggle (no viewer there). */}
      {!universeView && (conversationId || enableViewerPanel) && (
        <ChatPaneCaption
          title={activeConv?.title ?? "New chat"}
          messageCount={activeConv?.messageCount ?? messages.length}
          updatedAt={activeConv?.updatedAt}
          onOpenSessions={onOpenSessions}
          viewerOpen={!viewerCollapsed}
          onToggleViewer={
            enableViewerPanel
              ? (viewerCollapsed ? () => openPreview("center") : closePreview)
              : undefined
          }
        />
      )}

      {/* Mobile/tablet Sessions trigger — shown only when there is NO active
          conversation (the caption's Sessions button covers the active case).
          `lg:hidden` keeps the desktop layout completely unchanged. */}
      {!universeView && !conversationId && !enableViewerPanel && onOpenSessions && (
        <div className="lg:hidden shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background">
          <button
            type="button"
            data-commander-touch
            onClick={() => onOpenSessions()}
            aria-label="Open sessions"
            title="Sessions"
            className="p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-muted-foreground select-none">Chats</span>
        </div>
      )}

      {!universeView && <MemoryContextStrip
        strictness="balanced"
        layers={["identity", "domain", "active_context", "working"]}
        surface={contextScope.surface ?? "commander"}
        hasWorkingContext={Boolean(contextScope.taskId || contextScope.goalId || contextScope.projectId || conversationId)}
      />}

      {/* Mobile close button (absolute overlay, not in flow) */}
      {!universeView && <Button
        variant="ghost"
        size="icon-sm"
        onClick={closePanel}
        aria-label="Close Commander"
        className="md:hidden absolute top-2 right-2 z-10"
      >
        <X className="h-4 w-4" />
      </Button>}

      {/* Messages (fix #11: aria-live for streaming accessibility) */}
      <div
        data-commander-history
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto px-3 py-3 min-h-0"
        aria-live="polite"
        aria-relevant="additions"
      >
        {/* Task 11: on wide (>= 1536px / Tailwind 2xl) cap the message column at
            880px centered. Below 2xl this wrapper is a no-op width-wise, so
            desktop width is unchanged. `h-full` preserves the empty-state's
            full-height vertical centering (it used to reference the scroll
            container directly). */}
        <div className="h-full space-y-3 2xl:max-w-[880px] 2xl:mx-auto">
        {messages.length === 0 && (
          <CommanderEmptyState
            greetingText={
              greeting
                ? (greeting.findingCount > 0 ? "Here's what happened" : greeting.greeting)
                : undefined
            }
            onPromptClick={sendText}
            recentChats={recentChats}
            onSelectChat={(id) => onSelectConversation?.(id)}
          />
        )}

        {messages.map((msg) => (
          <Fragment key={msg.id}>
          {(commanderQuestionBuckets.byMessageId.get(msg.id) ?? []).map((detail) => (
            <div key={`work-question-${detail.question.id}`} data-work-question-id={detail.question.id}>
              <WorkQuestionPanel
                companyId={companyId}
                questionId={detail.question.id}
                initialDetail={detail}
              />
            </div>
          ))}
          <div className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "group relative max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                msg.role === "user"
                  ? "bg-card text-card-foreground shadow-sm"
                  : "bg-muted",
              )}
            >
              {/* Hover Copy button — revealed on group-hover, top-right corner */}
              {msg.content && (
                <button
                  type="button"
                  data-commander-touch
                  aria-label="Copy message"
                  title="Copy"
                  onClick={() => handleCopyMessage(msg.id, msg.content)}
                  className={cn(
                    "absolute top-1 right-1 flex items-center justify-center rounded p-0.5",
                    "opacity-0 group-hover:opacity-100 transition-opacity",
                    "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {copiedMessageId === msg.id
                    ? <Check className="h-3.5 w-3.5" />
                    : <Copy className="h-3.5 w-3.5" />}
                </button>
              )}

              {/* Hover "open reply in viewer" pop-out — assistant bubbles only,
                  sits just left of the Copy button with identical hover reveal */}
              {msg.role === "assistant" && msg.content && (
                <button
                  type="button"
                  data-commander-touch
                  aria-label="Open reply in viewer"
                  title="Open reply in viewer"
                  onClick={() => { openPreview("right-panel"); viewer.openReply(msg.id, msg.content); }}
                  className={cn(
                    "absolute top-1 right-6 flex items-center justify-center rounded p-0.5",
                    "opacity-0 group-hover:opacity-100 transition-opacity",
                    "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
              )}

              <span
                className={cn(
                  "pointer-events-none absolute bottom-1 right-2 text-[10px] text-muted-foreground",
                  "opacity-0 group-hover:opacity-100 transition-opacity",
                )}
              >
                {relativeTime(msg.createdAt)}
              </span>

              {/* Inline reasoning (collapsible Thinking block) */}
              {msg.role === "assistant" && msg.reasoning && (
                <CommanderReasoningBlock
                  text={msg.reasoning}
                  streaming={streaming && !msg.streamingDone}
                  defaultCollapsed={msg.streamingDone}
                />
              )}

              {/* Tool activity — inline, expandable, with status glyph */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="space-y-1 mb-2">
                  {msg.toolCalls.map((tc) => (
                    <div key={tc.id} className="text-xs">
                      <button
                        type="button"
                        data-testid={`commander-tool-activity-${tc.id}`}
                        disabled={!tc.summary}
                        aria-expanded={!!tc.open}
                        aria-controls={`tool-summary-${msg.id}-${tc.id}`}
                        onClick={() =>
                          setMessages((prev) =>
                            prev.map((m) =>
                              m.id === msg.id
                                ? { ...m, toolCalls: (m.toolCalls ?? []).map((t) => (t.id === tc.id ? { ...t, open: !t.open } : t)) }
                                : m,
                            ),
                          )
                        }
                        className="flex w-full items-center gap-1.5 text-left text-muted-foreground hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
                      >
                        {tc.status === "running" ? (
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                        ) : tc.success === false ? (
                          <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
                        ) : (
                          <Check className="h-3 w-3 shrink-0 text-emerald-500" />
                        )}
                        <span className="truncate">
                          {tc.status === "running" ? toolLabel(tc.name) : completedToolLabel(tc.name)}
                        </span>
                        {tc.summary && (
                          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", tc.open && "rotate-90")} />
                        )}
                      </button>
                      {tc.open && tc.summary && (
                        <pre
                          id={`tool-summary-${msg.id}-${tc.id}`}
                          data-testid="commander-tool-summary"
                          className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px] text-muted-foreground"
                        >
                          {tc.summary}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Message content (fix #1: plain text while streaming, markdown when done) */}
              {msg.content ? (
                msg.role === "user" ? (
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                ) : msg.streamingDone ? (
                  <MarkdownBody
                    className="prose-xs [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_pre]:my-1 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs"
                    onLinkOpen={enableViewerPanel ? (url: string) => { openPreview("right-panel"); viewer.openBrowser(url); } : undefined}
                  >
                    {msg.content}
                  </MarkdownBody>
                ) : (
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                )
              ) : msg.role === "assistant" && streaming && !msg.reasoning ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Thinking...
                </span>
              ) : null}

              {/* Commander Viewer P1: artifact handles under the reply text */}
              {msg.role === "assistant" && msg.outputRefs && msg.outputRefs.length > 0 && (
                <OutputRefChips
                  refs={msg.outputRefs}
                  onOpen={(ref) => { openPreview("right-panel"); viewer.openRef(ref); }}
                />
              )}

              {/* Live-only: durationMs comes from the done SSE event, not persisted
                  (it's on internal_agent_runs). Absent after reload by design. */}
              {msg.role === "assistant" && msg.streamingDone && typeof msg.durationMs === "number" && msg.durationMs > 0 && (
                <p data-testid="commander-worked-for" className="mt-1 text-[10px] text-muted-foreground">
                  Worked for {(msg.durationMs / 1000).toFixed(1)}s
                </p>
              )}

              {/* Action confirmation */}
              {msg.actionConfirm && (
                <div
                  className={cn(
                    "mt-2 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-3 space-y-2",
                    msg.actionConfirm.status === "pending" &&
                      msg.actionConfirm.confirmId === newestPendingConfirmId &&
                      "commander-pulse-border",
                  )}
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-100">
                    <Zap className="h-3.5 w-3.5 shrink-0" />
                    <span>Action requires approval: <code className="font-mono">{msg.actionConfirm.action}</code></span>
                  </div>
                  {/* Entity line — derived from action, truncated to 80 chars */}
                  <p className="text-xs text-amber-800/70 dark:text-amber-200/70">
                    {(() => {
                      const line = deriveConfirmEntityLine(msg.actionConfirm.action);
                      const [prefix, ...rest] = line.split(" ");
                      const second = rest[0];
                      const third = rest[1];
                      const entity = rest.slice(2).join(" ");
                      return (
                        <>
                          {prefix} {second} {third}{entity ? " " : ""}
                          {entity && <strong className="font-medium">{entity}</strong>}
                        </>
                      );
                    })()}
                  </p>
                  {msg.actionConfirm.description !== msg.actionConfirm.action && (
                    <p className="text-xs text-muted-foreground">{msg.actionConfirm.description}</p>
                  )}
                  {msg.actionConfirm.status === "pending" ? (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 text-xs"
                        onClick={() => sendConfirmMessage(msg.id, msg.actionConfirm!.confirmId, "allow_once")}
                      >
                        <Check className="h-3 w-3 mr-1" />
                        Allow once
                      </Button>
                      {allowAlwaysEnabled && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => sendConfirmMessage(msg.id, msg.actionConfirm!.confirmId, "allow_always")}
                        >
                          <Check className="h-3 w-3 mr-1" />
                          Always allow
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => sendConfirmMessage(msg.id, msg.actionConfirm!.confirmId, "deny")}
                      >
                        <X className="h-3 w-3 mr-1" />
                        Deny
                      </Button>
                    </div>
                  ) : msg.actionConfirm.status === "approving" ? (
                    <span className="inline-flex items-center gap-1 text-xs text-amber-800 dark:text-amber-200">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Executing…
                    </span>
                  ) : msg.actionConfirm.status === "failed" ? (
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-red-600 dark:text-red-400">Failed</span>
                      {msg.actionConfirm.errorMessage && (
                        <p className="text-xs text-muted-foreground">{msg.actionConfirm.errorMessage}</p>
                      )}
                    </div>
                  ) : (
                    <span
                      className={cn(
                        "text-xs font-medium",
                        msg.actionConfirm.status === "approved"
                          ? "text-green-600 dark:text-green-400"
                          : "text-red-600 dark:text-red-400",
                      )}
                    >
                      {msg.actionConfirm.status === "approved" ? "Confirmed" : "Rejected"}
                    </span>
                  )}
                </div>
              )}

              {/* Options prompt */}
              {msg.optionsPrompt && !msg.optionsPrompt.dismissed && (
                <div className="mt-2 rounded-lg border border-border bg-background p-3 space-y-2 shadow-sm">
                  <p className="text-xs text-muted-foreground">
                    Commander is asking — pick one or type your answer below:
                  </p>
                  <p className="text-xs font-medium text-foreground">{msg.optionsPrompt.question}</p>
                  <div className="flex flex-wrap gap-2">
                    {msg.optionsPrompt.options.map((opt, i) => (
                      <button
                        key={`${msg.id}-opt-${i}-${opt}`}
                        type="button"
                        onClick={() => {
                          // Dismiss the panel
                          setMessages((prev) =>
                            prev.map((m) =>
                              m.id === msg.id && m.optionsPrompt
                                ? { ...m, optionsPrompt: { ...m.optionsPrompt, dismissed: true } }
                                : m,
                            ),
                          );
                          // Send the selected option as a user message
                          void sendText(opt);
                        }}
                        className={cn(
                          "px-3 py-1.5 rounded-full border text-xs transition-colors",
                          i === 0
                            ? "border-primary bg-primary/5 text-primary hover:bg-primary/10 font-medium"
                            : "border-border hover:bg-muted",
                        )}
                      >
                        {opt}
                        {i === 0 && <span className="ml-1 opacity-60">(recommended)</span>}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Clicking a chip sends it as your reply and dismisses this panel.
                  </p>
                </div>
              )}
            </div>
          </div>
          </Fragment>
        ))}

        {commanderQuestionBuckets.trailing.map((detail) => (
          <div key={`work-question-${detail.question.id}`} data-work-question-id={detail.question.id}>
            <WorkQuestionPanel
              companyId={companyId}
              questionId={detail.question.id}
              initialDetail={detail}
            />
          </div>
        ))}
        {inlineQuestionsQuery.isError ? (
          <WorkQuestionInlineError onRetry={() => void inlineQuestionsQuery.refetch()} />
        ) : null}

        <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input bar */}
      <div data-commander-composer ref={inputBarRef} className="shrink-0 border-t border-border p-3 relative">
        {/* Task 9: skill picker — anchored above the input card */}
        <SkillPicker
          open={pickerOpen}
          query={pickerQuery}
          activeIndex={pickerIndex}
          onActiveIndexChange={setPickerIndex}
          onSelect={handleSelectSkill}
          onFilteredChange={handleFilteredSkillsChange}
          onClose={closePicker}
        />
        {/* Honest delta vs the previous bespoke div: +shadow-sm, +flex-col/min-w-0
            base, +data-composer-frame attribute. NO overflow — the mention popover
            renders absolute bottom-full INSIDE this frame. */}
        <ComposerFrame chrome="card" data-testid="commander-composer-frame" dragHandlers={dragHandlers}>
          <ComposerDropOverlay active={isDragActive} />
          {/* B-states (mock §5): offline strip + failed-send banner, above the
              attachments strip. Wrapper renders only when either is visible so
              the connected/no-failure frame keeps its exact spacing. */}
          {(composerConnection !== "connected" || sendFailed) && (
            <div className="px-2 pt-2">
              <ComposerOfflineStrip state={composerConnection} />
              {sendFailed && (
                <ComposerSendFailedBanner
                  onRetry={handleRetryFailedSend}
                  onEdit={handleEditFailedSend}
                  onDiscard={handleDiscardFailedSend}
                  retrying={streaming}
                />
              )}
            </div>
          )}
          <input
            ref={commanderFileInputRef}
            type="file"
            multiple
            accept={COMPOSER_ATTACHMENT_CONTENT_TYPES.join(",")}
            className="sr-only"
            aria-label="Attach files"
            onChange={handleCommanderFileInput}
          />
          {(uploadingFiles.length > 0 || failedUploads.length > 0 || attachmentError) && (
            <div className="border-b border-border/70 px-2 py-2 text-xs" role="status" aria-live="polite">
              {uploadingFiles.map((file) => (
                <div key={file.id} className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                  <span className="truncate">Uploading {file.name}…</span>
                </div>
              ))}
              {failedUploads.map((item) => (
                <div key={item.id} className="flex items-center gap-2 text-destructive">
                  <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{item.file.name} failed</span>
                  <button
                    type="button"
                    className="rounded px-1 font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus-ring"
                    onClick={() => void uploadCommanderFiles([item.file], item.id)}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove failed ${item.file.name} attachment`}
                    className="rounded p-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus-ring"
                    onClick={() => setFailedUploads((current) => current.filter((failed) => failed.id !== item.id))}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </div>
              ))}
              {attachmentError && <p className="mt-1 text-destructive">{attachmentError}</p>}
            </div>
          )}
          {inputRefs.length > 0 && (
            <div
              className="flex flex-wrap gap-1.5 border-b border-border/70 px-2 py-2"
              data-testid="commander-input-refs"
            >
              {inputRefs.map((ref) => (
                <span
                  key={commanderInputRefKey(ref)}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/60 px-2 py-1 text-[11px] text-foreground transition-colors",
                    duplicateInputRefKey === commanderInputRefKey(ref)
                      ? "border-brand bg-brand/10"
                      : "border-border",
                  )}
                >
                  {ref.kind === "asset" && ref.route ? (
                    <a
                      href={ref.route}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${ref.label} attachment`}
                      title="Open attachment"
                      className="inline-flex min-w-0 max-w-[220px] items-center gap-1 rounded text-left hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus-ring"
                    >
                      <span className="shrink-0 font-medium text-muted-foreground">File</span>
                      <span className="min-w-0 truncate">{ref.label}</span>
                    </a>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Open ${ref.label} reference`}
                      title="Open reference"
                      className="inline-flex min-w-0 max-w-[220px] items-center gap-1 rounded text-left hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus-ring"
                      onClick={() => handleOpenInputRef(ref)}
                    >
                      <span className="shrink-0 font-medium text-muted-foreground">
                        {commanderInputRefKindLabel(ref.kind)}
                      </span>
                      <span className="min-w-0 truncate">{ref.label}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${ref.label} reference`}
                    title="Remove reference"
                    className="ml-0.5 rounded text-muted-foreground hover:text-foreground"
                    onClick={() => removeInputRef(ref)}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* Rich input — renders skill selections as colored atomic tokens */}
          <CommanderInput
            ref={inputRef}
            placeholder={universeView ? "Ask Commander…" : "Ask the agent..."}
            disabled={streaming}
            onSubmit={(text) => void submitCommanderInput(text)}
            onReferenceDrop={({ ref, prompt }) => addInputRef(ref, prompt)}
            onFilesSelected={(files) => void uploadCommanderFiles(files)}
            onTextChange={(text) => {
              commanderDraft.setDraft({ text });
              handleComposerTextChange(text);
            }}
            mentionOptions={mentionAgents.filter((agent) => agent.status !== "terminated").map((agent) => ({ id: agent.id, name: agent.name }))}
            onEmptyChange={handleEmptyChange}
            onSlashChange={handleSlashChange}
            onKeyDown={handleKeyDown}
            onBlur={(e) => {
              // Only close when focus leaves the whole input bar. Radix restores
              // focus to the `+` trigger after "Use a skill"; that target is inside
              // inputBarRef, so we must NOT close in that case. Skill-row clicks use
              // onMouseDown+preventDefault and never blur the input.
              const next = e.relatedTarget as Node | null;
              if (pickerOpen && !inputBarRef.current?.contains(next)) {
                closePicker();
              }
            }}
          />
          {/* Controls row — approved mock §1/§2 order: attach + mention first,
              surface extras (+ skills, voice) after them. */}
          <div data-commander-controls className="flex items-center gap-1.5 px-2 pb-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ComposerIconButton
                    disabled={streaming}
                    aria-label="Attach file"
                    onClick={() => commanderFileInputRef.current?.click()}
                  >
                    <Paperclip className="size-4" aria-hidden="true" />
                  </ComposerIconButton>
                </TooltipTrigger>
                <TooltipContent side="top">Attach file</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* Structured @mention picker */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ComposerIconButton
                    disabled={streaming}
                    aria-label="Mention a teammate"
                    onClick={() => {
                      inputRef.current?.focus();
                      inputRef.current?.insertText("@");
                    }}
                  >
                    <AtSign className="size-4" aria-hidden="true" />
                  </ComposerIconButton>
                </TooltipTrigger>
                <TooltipContent side="top">Mention a teammate</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* Voice (disabled, coming soon) */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* No native `title` — the Radix TooltipContent below is the
                      single tooltip (a native title would double up on hover). */}
                  <ComposerIconButton aria-label="Voice input" comingSoon>
                    <Mic className="size-4" aria-hidden="true" />
                  </ComposerIconButton>
                </TooltipTrigger>
                <TooltipContent side="top">Coming soon</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* Extras slot: + add menu (attach via menu + Use a skill) */}
            <InputAddMenu
              onUseSkill={() => {
                setPickerIndex(0);
                setSkillPickerOpen(true);
                // Focus the textarea so ↑/↓/Enter drive the picker. Defer past
                // the dropdown's own focus-restore on close.
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              disabled={streaming}
            />

            {/* Spacer */}
            <div className="flex-1" />

            {/* Send / Stop */}
            {streaming ? (
              <button
                type="button"
                onClick={handleStop}
                aria-label="Stop generation"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-brand px-3 text-xs font-semibold text-white hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring"
              >
                <Square className="size-3 fill-current" aria-hidden="true" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={(inputEmpty && inputRefs.length === 0) || uploadingFiles.length > 0 || isOffline}
                aria-label="Send message"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-brand px-3.5 text-xs font-semibold text-white hover:bg-brand-hover transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring disabled:opacity-40 disabled:pointer-events-none"
              >
                Send
                <Send className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </ComposerFrame>
      </div>
    </div>
  );

  const renderCockpitPanel = (collapsed: boolean) => (
    <CommanderCockpitPanel
      companyId={companyId!}
      conversationId={conversationId}
      collapsed={collapsed}
      onExpand={expandCockpit}
      onCollapse={collapseCockpit}
      onOpenTask={(issueId, title, anchorId) => openTaskFocusPane(issueId, title, anchorId)}
      onAsk={(text) => void sendText(text)}
      onReference={addInputRef}
      onOpenInputRef={handleOpenInputRef}
      onOpenFullPage={(href) => navigate(href)}
      onOpenArtifact={(id, title) => {
        openPreview("right-panel");
        viewer.openRef({ v: 1, kind: "artifact", id, title, action: "referenced" });
      }}
      conversationRefs={conversationRefs}
      onOpenRef={(ref) => { openPreview("right-panel"); viewer.openRef(ref); }}
    />
  );

  // No viewer panel (docked usage) — unchanged single column.
  if (!enableViewerPanel || !companyId) {
    return <div className={cn("flex h-full min-h-0 flex-row", !universeView && "overflow-hidden")}>{chatColumn}</div>;
  }

  // Mobile — unchanged: chat + floating pill/Sheet (no Group).
  if (useDrawerSessions) {
    return (
      <div className="flex h-full min-h-0 flex-row overflow-hidden">
        {chatColumn}
        <CommanderViewerPanel
          companyId={companyId}
          viewer={viewer}
          conversationRefs={conversationRefs}
          isMobile
          onOpenTask={openTaskFocusPane}
        />
        {discussionPane && (
          <CommanderDiscussionPane
            companyId={companyId}
            discussion={discussionPane}
            onClose={closeFocusPane}
            onOpenRequest={openDiscussionRequest}
            mobile
          />
        )}
        {taskFocusPane && (
          <Sheet open onOpenChange={(open) => { if (!open) closeFocusPane(); }}>
            <SheetContent side="right" showCloseButton={false} className="w-full max-w-full p-2 sm:max-w-full">
              <SheetTitle className="sr-only">{taskFocusPane.title ?? "Task"}</SheetTitle>
              <CommanderTaskFocusPane
                issueId={taskFocusPane.entityId}
                anchorId={taskFocusPane.anchorId}
                onClose={closeFocusPane}
              />
            </SheetContent>
          </Sheet>
        )}
        {isTablet && !tabletCockpitOpen && (
          <div
            className={cn("h-full w-[48px] shrink-0 overflow-hidden", COMMANDER_PANEL_CARD)}
            data-testid="commander-cockpit-container"
            data-collapsed="true"
          >
            {renderCockpitPanel(true)}
          </div>
        )}
        {isTablet && tabletCockpitOpen && (
          <Sheet open onOpenChange={(open) => { if (!open) collapseCockpit(); }}>
            <SheetContent
              side="right"
              showCloseButton={false}
              className="w-[min(360px,100vw)] p-0 sm:max-w-[360px]"
            >
              <SheetTitle className="sr-only">Cockpit</SheetTitle>
              <div className="h-full min-h-0 overflow-hidden">
                {renderCockpitPanel(false)}
              </div>
            </SheetContent>
          </Sheet>
        )}
      </div>
    );
  }

  // Desktop — Phase 1 (panel-redesign): Group holds Chat+Viewer only.
  // Cockpit is a width-toggled <div> sibling to the right of the Group,
  // mirroring WorkspaceLayout.tsx:525-559. Expanded=300px, collapsed=48px rail.
  const tabModels = buildViewerTabModels(viewer.state);
  const activeTab = viewer.state.tabs.find((t) => t.id === viewer.state.activeId);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden gap-2">
      {/* Center group: Chat + optional Viewer only (cockpit is now a width-div sibling).
          The Group has no border/overflow-hidden — each inner panel provides its
          own COMMANDER_PANEL_CARD chrome. The Separator (w-2 transparent) acts as
          the 8px gap between the chat card and the viewer card. */}
      <Group
        key={panelIds.join(":") || "commander-empty"}
        orientation="horizontal"
        className="flex h-full min-w-0 flex-1"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        data-testid="commander-center-group"
      >
        {showChatPanel && (
          <Panel id="commander-chat" minSize="30%" className="flex h-full min-w-0 flex-col">
            {chatColumn}
          </Panel>
        )}
        {focusPane && (
          <>
            {showChatPanel && (
              <Separator
                id="commander-focus-sep"
                className="w-2 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-brand/50 active:bg-brand/60"
              />
            )}
            <Panel
              id="commander-focus"
              defaultSize={viewerCollapsed ? "60%" : "50%"}
              minSize="30%"
              className="flex h-full min-w-0"
            >
              {discussionPane ? (
                <CommanderDiscussionPane
                  companyId={companyId}
                  discussion={discussionPane}
                  onClose={closeFocusPane}
                  onOpenRequest={openDiscussionRequest}
                />
              ) : taskFocusPane ? (
                <CommanderTaskFocusPane
                  issueId={taskFocusPane.entityId}
                  anchorId={taskFocusPane.anchorId}
                  onClose={closeFocusPane}
                />
              ) : null}
            </Panel>
          </>
        )}
        {!viewerCollapsed && (
          <>
            {/* Separator renders its own `data-separator` + role="separator"
                attributes (a passed data-testid is ignored); tests target
                `[data-separator]`. */}
            {(showChatPanel || focusPane) && (
              <Separator
                id="commander-sep"
                className="w-2 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-brand/50 active:bg-brand/60"
              />
            )}
            <Panel
              id="commander-detail"
              defaultSize="40%"
              minSize="24%"
              maxSize="60%"
              className="flex h-full min-w-0"
            >
              <CommanderViewerDetail
                viewer={viewer}
                companyId={companyId}
                conversationRefs={conversationRefs}
                activeTab={activeTab}
                tabModels={tabModels}
                onCollapse={closePreview}
                onOpenTask={openTaskFocusPane}
              />
            </Panel>
          </>
        )}
      </Group>
      {/* Right cockpit — width-toggled div mirroring WorkspaceLayout right panel.
          Expanded: w-[300px] showing the full CommanderCockpitPanel.
          Collapsed: w-[48px] showing the CommanderCockpitRail.
          COMMANDER_PANEL_CARD here (rounded-xl + border + shadow-sm + overflow-hidden)
          mirrors WorkspaceLayout's right panel card pattern exactly. The inner
          CommanderCockpitPanel/Rail provide their own structural chrome (header, etc.)
          but the card border/radius lives here on the container. */}
      <div
        className={cn(
          "shrink-0 h-full overflow-hidden transition-[width] duration-200",
          COMMANDER_PANEL_CARD,
          cockpitCollapsed ? "w-[48px]" : "w-[300px]",
        )}
        data-testid="commander-cockpit-container"
        data-collapsed={cockpitCollapsed ? "true" : "false"}
      >
        {renderCockpitPanel(cockpitCollapsed)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Exported panel — desktop inline + mobile sheet (DA-23)             */
/* ------------------------------------------------------------------ */

export function InternalAgentPanel() {
  const { isOpen, closePanel } = useAgentPanel();
  const { isMobile } = useSidebar();

  // Mobile: full-screen sheet overlay (DA-23 mutual exclusion)
  if (isMobile) {
    return (
      <Sheet open={isOpen} onOpenChange={(open) => !open && closePanel()}>
        <SheetContent side="right" showCloseButton={false} className="w-full sm:max-w-full p-0">
          <SheetTitle className="sr-only">Commander</SheetTitle>
          <AgentPanelContent />
        </SheetContent>
      </Sheet>
    );
  }

  // Desktop: inline right panel
  if (!isOpen) return null;

  return (
    <div className="shrink-0 w-80 border-l border-border h-full overflow-hidden bg-background">
      <AgentPanelContent />
    </div>
  );
}
