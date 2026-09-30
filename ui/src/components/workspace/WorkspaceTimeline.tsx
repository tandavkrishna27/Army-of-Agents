import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../../api/issues";
import { activityApi, type RunForIssue } from "../../api/activity";
import { heartbeatsApi } from "../../api/heartbeats";
import { agentsApi } from "../../api/agents";
import { projectsApi } from "../../api/projects";
import { useCompany } from "../../context/CompanyContext";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "@/lib/utils";
import { TimelineUserMessage } from "./TimelineUserMessage";
import { TimelineAgentMessage } from "./TimelineAgentMessage";
import { TimelineTaskBrief } from "./TimelineTaskBrief";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useToast } from "../../context/ToastContext";
import { Activity } from "lucide-react";
import {
  COMPOSER_ATTACHMENT_CONTENT_TYPES,
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_ATTACHMENT_BYTES,
  createComposerSubmissionId,
  type IssueAttachment,
  type IssueComment,
  type Agent,
  type WorkQuestionDetail,
} from "@armyofagents/shared";
import { ChatbarStatusRow } from "./ChatbarStatusRow";
import { ChatbarControls } from "./ChatbarControls";
import { ComposerMentionMenu } from "../composer/ComposerMentionMenu";
import { useComposerMention } from "../composer/useComposerMention";
import { useRunTokens } from "./useRunTokens";
import { useLatestTodos } from "./useLatestTodos";
import { getContextLimit } from "./adapter-utils";
import type { ActiveRunForIssue, LiveRunForIssue } from "../../api/heartbeats";
import { useInlineWorkQuestions, WorkQuestionInlineError } from "../work-questions/WorkQuestionInlineList";
import { WorkQuestionPanel } from "../work-questions/WorkQuestionPanel";
import { resolveTaskCommentAction } from "../../lib/task-composer-actions";
import { useComposerDraft } from "../../lib/composerDraft";
import { useTeamAccess } from "../../hooks/useTeamAccess";
import { useLiveUpdates } from "../../context/LiveUpdatesProvider";
import { ComposerFrame } from "../composer/ComposerFrame";
import { ComposerAttachmentCard } from "../composer/ComposerAttachmentCard";
import { ComposerSendFailedBanner } from "../composer/ComposerSendFailedBanner";
import { ComposerOfflineStrip, toComposerConnectionState } from "../composer/ComposerOfflineStrip";
import { ComposerDropOverlay } from "../composer/ComposerDropOverlay";
import { useComposerDragDrop } from "../composer/useComposerDragDrop";

export type TimelineItem =
  | { kind: "run"; ts: string; data: RunForIssue }
  | { kind: "comment"; ts: string; data: IssueComment }
  | { kind: "work_question"; ts: string; data: WorkQuestionDetail };

const TIMELINE_KIND_ORDER: Record<TimelineItem["kind"], number> = {
  comment: 0,
  run: 1,
  work_question: 2,
};

function normalizeTimelineDate(value: string | Date | null): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function liveRunToTimelineRun(run: LiveRunForIssue | ActiveRunForIssue): RunForIssue {
  return {
    runId: run.id,
    status: run.status,
    agentId: run.agentId,
    startedAt: normalizeTimelineDate(run.startedAt),
    finishedAt: normalizeTimelineDate(run.finishedAt),
    createdAt: normalizeTimelineDate(run.createdAt) ?? new Date().toISOString(),
    invocationSource: run.invocationSource ?? "",
    logStore: run.logStore,
    logRef: run.logRef,
    processPid: run.processPid,
    processStartedAt: normalizeTimelineDate(run.processStartedAt ?? null),
    lastOutputAt: normalizeTimelineDate(run.lastOutputAt ?? null),
    usageJson: null,
    resultJson: null,
    detectedOutputs: null,
  };
}

/** One send attempt, snapshotted BEFORE the mutate (mock §5): the banner's
 *  Retry re-sends this exact shape — same clientSubmissionId — so the server
 *  replays instead of double-posting when the first request actually landed. */
interface SendAttempt {
  text: string;
  files: File[];
  revision: number;
  reopen?: boolean;
  interrupt?: boolean;
  clientSubmissionId: string;
}

interface WorkspaceTimelineProps {
  issueId: string;
  /** When true, renders in compact mode for TaskSlideOver */
  compact?: boolean;
  className?: string;
  anchorId?: string;
  /** Pop an attachment into a preview panel. Absent (e.g. TaskDetail) → direct link. */
  onOpenAttachment?: (att: IssueAttachment) => void;
}

export function WorkspaceTimeline({
  issueId,
  compact = false,
  className,
  anchorId,
  onOpenAttachment,
}: WorkspaceTimelineProps) {
  const { selectedCompanyId } = useCompany();
  const { currentUser } = useTeamAccess(selectedCompanyId);
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isPinnedToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRevisionRef = useRef(0);
  const sendInFlightRef = useRef(false);
  const [chatInput, setChatInput] = useState("");
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  // composerError is for VALIDATION errors (attachment type/size/count).
  // Send failures raise the ComposerSendFailedBanner via sendFailed instead.
  const [composerError, setComposerError] = useState<string | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const lastAttemptRef = useRef<SendAttempt | null>(null);
  const { connectionState } = useLiveUpdates();
  const composerConnection = toComposerConnectionState(connectionState);
  const isOffline = composerConnection === "offline";
  const composerDraft = useComposerDraft(
    selectedCompanyId && currentUser?.userId
      ? { companyId: selectedCompanyId, userId: currentUser.userId, surface: "task", entityId: issueId }
      : null,
  );
  const [interruptRequested, setInterruptRequested] = useState(false);
  const [reopenRequested, setReopenRequested] = useState(true);
  const [hasUnseenActivity, setHasUnseenActivity] = useState(false);

  useEffect(() => {
    setChatInput(composerDraft.draft.text);
  }, [composerDraft.storageKey]);

  useEffect(() => {
    composerDraft.setDraft({ text: chatInput });
  }, [chatInput]);
  const [highlightedAnchorId, setHighlightedAnchorId] = useState<string | null>(null);
  const [anchorAnnouncement, setAnchorAnnouncement] = useState("");

  // Stale-snapshot guard (mock §5: failure never eats your work): once the
  // draft diverges from the failed attempt, Retry would post stale content and
  // its success-clear would wipe the newer edits — dismiss the banner. The ref
  // is kept (nothing double-posts); the next send is a normal fresh submission
  // with a NEW clientSubmissionId. Called from EVERY text-changing path
  // (textarea typing AND mention inserts).
  const dismissBannerOnDivergence = (nextText: string) => {
    if (
      sendFailed &&
      !sendMessage.isPending &&
      lastAttemptRef.current &&
      nextText.trim() !== lastAttemptRef.current.text
    ) {
      setSendFailed(false);
    }
  };

  // Any attachment-tray mutation IS divergence: Retry would post the snapshot
  // including a removed (possibly sensitive) file, or without a newly added one.
  const dismissBannerOnTrayChange = () => {
    if (sendFailed && !sendMessage.isPending) setSendFailed(false);
  };

  // Control changes (reopen / interrupt) are part of the snapshot: Retry would
  // post the OLD flags and the success-clear would reset the newer choice —
  // dismiss the banner and mark divergence (same "Retry must never post what
  // the user changed" principle as the tray; CommentThread peer pattern). The
  // revision bump also keeps a mid-flight retry success from clearing the
  // newer state.
  const dismissBannerOnControlChange = () => {
    composerRevisionRef.current += 1;
    if (sendFailed && !sendMessage.isPending) setSendFailed(false);
  };

  // Entity switch (issueId change): the banner + attempt snapshot + tray all
  // belong to the PREVIOUS task — Retry must never post into a different task.
  // The revision bump keeps a still-in-flight send from the previous task from
  // re-arming the banner (onError) or clearing the new task's state
  // (onSuccess). The draft text itself is per-task via composerDraft above.
  useEffect(() => {
    composerRevisionRef.current += 1;
    lastAttemptRef.current = null;
    setSendFailed(false);
    setSelectedFiles([]);
    setComposerError(null);
  }, [issueId]);

  // Shared @mention (mock v2): the @ button opens the picker and a trailing
  // `@token` opens the same list inline. Server-side, task/workspace comment
  // mentions wake the mentioned agents (issues.ts findMentionedAgents).
  const mention = useComposerMention({
    companyId: selectedCompanyId,
    value: chatInput,
    onChange: (next) => {
      composerRevisionRef.current += 1;
      setChatInput(next);
      dismissBannerOnDivergence(next);
    },
    focusAt: (pos) => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    },
  });

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    composerRevisionRef.current += 1;
    setChatInput(e.target.value);
    setComposerError(null);
    dismissBannerOnDivergence(e.target.value);
    mention.refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
    // Auto-grow: reset to 1 row then expand to content, max 4 rows
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 96)}px`; // 96px ≈ 4 rows at text-sm
  };

  // --- Data fetching ---

  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
    enabled: !!issueId,
  });

  const { data: comments, error: commentsError, isLoading: commentsLoading } = useQuery({
    queryKey: queryKeys.issues.comments(issueId),
    queryFn: () => issuesApi.listComments(issueId),
    enabled: !!issueId,
  });

  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId),
    queryFn: () => issuesApi.listAttachments(issueId),
    enabled: !!issueId,
  });

  const { data: contextBundles } = useQuery({
    queryKey: ["issues", "context-bundles", issueId],
    queryFn: () => issuesApi.listContextBundles(issueId),
    enabled: !!issueId,
  });

  const { data: linkedRuns, isLoading: runsLoading } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 5000,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const inlineQuestionsQuery = useInlineWorkQuestions(selectedCompanyId ?? "", { issueId });
  const inlineQuestions = useMemo(
    () => Array.isArray(inlineQuestionsQuery.data) ? inlineQuestionsQuery.data : [],
    [inlineQuestionsQuery.data],
  );

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: project } = useQuery({
    queryKey: queryKeys.projects.detail(issue?.projectId ?? ""),
    queryFn: () => projectsApi.get(issue!.projectId!),
    enabled: !!issue?.projectId,
  });

  const departmentType = project?.functionType ?? "general";

  const { pushToast } = useToast();

  useEffect(() => {
    if (commentsError) {
      pushToast({ tone: "error", title: "Failed to load comments", body: (commentsError as Error).message });
    }
  }, [commentsError, pushToast]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const hasLiveRuns = (liveRuns ?? []).length > 0 || !!activeRun;

  // Filter out live runs from the historical timeline
  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>();
    for (const r of liveRuns ?? []) liveIds.add(r.id);
    if (activeRun) liveIds.add(activeRun.id);
    if (liveIds.size === 0) return linkedRuns ?? [];
    return (linkedRuns ?? []).filter((r) => !liveIds.has(r.runId));
  }, [linkedRuns, liveRuns, activeRun]);

  const liveTimelineRuns = useMemo(() => {
    const live: Array<LiveRunForIssue | ActiveRunForIssue> = [...(liveRuns ?? [])];
    if (activeRun && !live.some((run) => run.id === activeRun.id)) {
      live.push(activeRun);
    }
    return live.map(liveRunToTimelineRun);
  }, [liveRuns, activeRun]);

  // Merge runs + comments chronologically
  const mergedTimeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...liveTimelineRuns.map((r) => ({
        kind: "run" as const,
        ts: r.startedAt ?? r.createdAt,
        data: r,
      })),
      ...(timelineRuns ?? []).map((r) => ({
        kind: "run" as const,
        ts: r.startedAt ?? r.createdAt,
        data: r,
      })),
      ...(comments ?? []).map((c) => ({
        kind: "comment" as const,
        ts: typeof c.createdAt === "string" ? c.createdAt : c.createdAt.toISOString(),
        data: c,
      })),
      ...inlineQuestions.map((detail) => ({
        kind: "work_question" as const,
        ts: typeof detail.question.createdAt === "string"
          ? detail.question.createdAt
          : detail.question.createdAt.toISOString(),
        data: detail,
      })),
    ];
    return items.sort((a, b) => {
      const time = new Date(a.ts).getTime() - new Date(b.ts).getTime();
      if (time !== 0) return time;
      const kind = TIMELINE_KIND_ORDER[a.kind] - TIMELINE_KIND_ORDER[b.kind];
      if (kind !== 0) return kind;
      const leftId = a.kind === "run" ? a.data.runId : a.kind === "comment" ? a.data.id : a.data.question.id;
      const rightId = b.kind === "run" ? b.data.runId : b.kind === "comment" ? b.data.id : b.data.question.id;
      return leftId.localeCompare(rightId);
    });
  }, [liveTimelineRuns, timelineRuns, comments, inlineQuestions]);

  const attachmentsByCommentId = useMemo(() => {
    const grouped = new Map<string, NonNullable<typeof attachments>>();
    for (const attachment of attachments ?? []) {
      if (!attachment.issueCommentId) continue;
      const existing = grouped.get(attachment.issueCommentId) ?? [];
      grouped.set(attachment.issueCommentId, [...existing, attachment]);
    }
    return grouped;
  }, [attachments]);

  const taskAttachments = useMemo(
    () => (attachments ?? []).filter((attachment) => !attachment.issueCommentId),
    [attachments],
  );

  const scrollToTimelineBottom = useCallback(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    isPinnedToBottomRef.current = true;
    setHasUnseenActivity(false);
  }, []);

  const handleTimelineScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distanceFromBottom <= 96;
    isPinnedToBottomRef.current = pinned;
    if (pinned) setHasUnseenActivity(false);
  }, []);

  const handleTimelineActivity = useCallback(() => {
    if (!scrollRef.current) return;
    if (isPinnedToBottomRef.current) {
      scrollToTimelineBottom();
    } else {
      setHasUnseenActivity(true);
    }
  }, [scrollToTimelineBottom]);

  // Auto-follow new content only while the reader is pinned near the bottom.
  useEffect(() => {
    handleTimelineActivity();
  }, [mergedTimeline.length, hasLiveRuns, handleTimelineActivity]);

  useEffect(() => {
    if (!anchorId || anchorId === "question" || anchorId === "work") return;
    const target = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-work-question-id]") ?? [])
      .find((element) => element.dataset.workQuestionId === anchorId);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.focus({ preventScroll: true });
    setHighlightedAnchorId(anchorId);
    setAnchorAnnouncement("Focused the requested work question");
    const timeout = window.setTimeout(() => setHighlightedAnchorId(null), 1800);
    return () => window.clearTimeout(timeout);
  }, [anchorId, inlineQuestions]);

  // Agent resolution — always use the task's assigned agent
  const assignedAgentId = issue?.assigneeAgentId ?? null;
  const assignedAgent = assignedAgentId ? agentMap.get(assignedAgentId) : null;
  const agentAdapterType = assignedAgent?.adapterType ?? "process";
  const agentDefaultModel = (assignedAgent?.adapterConfig as Record<string, unknown>)?.model as string | null ?? null;

  const latestRun = linkedRuns?.[0] ?? null;

  // Token usage across all runs
  const tokenSummary = useRunTokens(linkedRuns);

  // Todo progress from latest run
  const todoData = useLatestTodos(latestRun, activeRun ?? null, agentAdapterType);

  // --- Mutations ---

  const sendMessage = useMutation({
    mutationFn: async ({ text, files, reopen, interrupt, clientSubmissionId }: SendAttempt) => {
      if (files.length > 0) {
        await issuesApi.addCommentWithAttachments(issueId, text, files, reopen, interrupt, clientSubmissionId);
        return;
      }
      await issuesApi.addComment(issueId, text, reopen, interrupt, undefined, clientSubmissionId);
    },
    onSuccess: (_data, submitted) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId) });
      setComposerError(null);
      setSendFailed(false);
      lastAttemptRef.current = null;
      if (composerRevisionRef.current === submitted.revision) {
        setChatInput("");
        setSelectedFiles([]);
        composerDraft.clearDraft();
        setModelOverride(null); // Reset model override after send
        setInterruptRequested(false);
        setReopenRequested(true);
      }
    },
    onError: (_error, submitted) => {
      // The draft, attachments, and lastAttemptRef snapshot are all kept —
      // the shared banner offers Retry (idempotent replay) / Edit / Discard.
      // Mid-flight divergence guard (stale-banner residual): if the draft or
      // tray moved while this send/retry was in flight (the dismiss is
      // suppressed while pending), the snapshot is stale — a re-armed banner's
      // Retry would post it (e.g. a removed attachment). Leave the banner
      // down; the user sends fresh with a NEW clientSubmissionId.
      setSendFailed(composerRevisionRef.current === submitted.revision);
    },
    onSettled: () => {
      sendInFlightRef.current = false;
    },
  });

  const canSend = chatInput.trim().length > 0 || selectedFiles.length > 0;

  const handleAttach = () => {
    fileInputRef.current?.click();
  };

  const addComposerFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;

    const next = [...selectedFiles];
    const errors: string[] = [];
    let reachedLimit = false;
    for (const file of incoming) {
      if (next.length >= COMPOSER_MAX_ATTACHMENTS) {
        reachedLimit = true;
        continue;
      }
      if (!COMPOSER_ATTACHMENT_CONTENT_TYPES.includes(file.type as (typeof COMPOSER_ATTACHMENT_CONTENT_TYPES)[number])) {
        errors.push(`Unsupported attachment type: ${file.type || "unknown"}.`);
        continue;
      }
      if (file.size > COMPOSER_MAX_ATTACHMENT_BYTES) {
        errors.push(`${file.name} exceeds the 10 MB attachment limit.`);
        continue;
      }
      next.push(file);
    }
    if (reachedLimit) errors.unshift(`Attach up to ${COMPOSER_MAX_ATTACHMENTS} files per message.`);

    setComposerError(errors.length > 0 ? errors.join(" ") : null);
    // Only a REAL tray change (a file actually accepted) is divergence — an
    // all-rejected add leaves the snapshot's tray intact, so the banner stays
    // and the revision doesn't move (matches CommentThread's addCommentFiles).
    if (next.length !== selectedFiles.length) {
      composerRevisionRef.current += 1;
      setSelectedFiles(next);
      dismissBannerOnTrayChange();
    }
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(e.target.files ?? []);
    e.target.value = "";
    addComposerFiles(incoming);
  };

  const removeSelectedFile = (index: number) => {
    composerRevisionRef.current += 1;
    setSelectedFiles((files) => files.filter((_, i) => i !== index));
    setComposerError(null);
    // Retry must never post a removed (possibly sensitive) file.
    dismissBannerOnTrayChange();
  };

  // Frame-wide drag-drop (mock §5): ONE hook instance shared by both chatbar
  // branches (only one renders at a time). Validation stays in addComposerFiles.
  const { isDragActive, dragHandlers } = useComposerDragDrop({
    onDropFiles: addComposerFiles,
    disabled: sendMessage.isPending,
  });

  const handleSend = () => {
    if (!canSend || sendInFlightRef.current || sendMessage.isPending || isOffline) return;
    sendInFlightRef.current = true;
    setComposerError(null);
    setSendFailed(false);
    const isClosed = issue?.status === "done" || issue?.status === "cancelled";
    const action = resolveTaskCommentAction({
      isClosed,
      reopenRequested,
      hasActiveRun: hasLiveRuns,
      interruptRequested,
      hasReassignment: false,
    });
    // Minted ONCE per submission and snapshotted BEFORE the mutate so the
    // banner's Retry re-sends the exact same attempt (same clientSubmissionId
    // → the server replays if the first request actually landed).
    const attempt: SendAttempt = {
      text: chatInput.trim(),
      files: [...selectedFiles],
      revision: composerRevisionRef.current,
      reopen: action === "reopen" ? true : undefined,
      interrupt: action === "interrupt" ? true : undefined,
      clientSubmissionId: createComposerSubmissionId(),
    };
    lastAttemptRef.current = attempt;
    sendMessage.mutate(attempt);
  };

  /** Banner Retry: re-send the IDENTICAL stored attempt (same clientSubmissionId). */
  const handleRetryFailedSend = () => {
    const attempt = lastAttemptRef.current;
    if (!attempt || sendInFlightRef.current || sendMessage.isPending || isOffline) return;
    sendInFlightRef.current = true;
    sendMessage.mutate(attempt);
  };

  const handleDismissFailedSend = () => {
    setSendFailed(false);
  };

  const handleDiscardFailedSend = () => {
    lastAttemptRef.current = null;
    setSendFailed(false);
    setComposerError(null);
    composerRevisionRef.current += 1;
    setChatInput("");
    setSelectedFiles([]);
    composerDraft.clearDraft();
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.handleKeyDown(e)) return; // picker owns ↑/↓/Enter/Esc while open
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    handleSend();
  };

  const handleComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    addComposerFiles(files);
  };

  const chatbarRunState =
    hasLiveRuns ? "running"
      : issue?.status === "done" ? "done"
        : issue?.status === "blocked" ? "blocked"
          : "idle";

  // Shared B-state chrome for both chatbar branches (mock §5): offline strip
  // at the top, then the send-failed banner — above the status row/textarea.
  const composerStateBanners = (sendFailed || composerConnection !== "connected") ? (
    <div className="px-2 pt-2">
      <ComposerOfflineStrip state={composerConnection} />
      {sendFailed && (
        <ComposerSendFailedBanner
          onRetry={handleRetryFailedSend}
          onEdit={handleDismissFailedSend}
          onDiscard={handleDiscardFailedSend}
          retrying={sendMessage.isPending}
        />
      )}
    </div>
  ) : null;

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden", className)} data-testid="workspace-timeline">
      {/* Scrollable timeline */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-5"
        data-testid="timeline-scroll"
        onScroll={handleTimelineScroll}
      >
        <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4" data-testid="timeline-thread-lane">
        {inlineQuestionsQuery.isError ? (
          <WorkQuestionInlineError onRetry={() => void inlineQuestionsQuery.refetch()} />
        ) : null}
        {(commentsLoading || runsLoading) && (
          <div className="space-y-3" data-testid="timeline-skeleton">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        {/* Empty state */}
        {mergedTimeline.length === 0 && !hasLiveRuns && (
          <p className="text-xs text-muted-foreground text-center py-8">
            No runs or comments yet. Send a message to start work.
          </p>
        )}

        {/* Timeline items — structured conversation */}
        {issue && (
          <TimelineTaskBrief
            issue={issue}
            attachments={taskAttachments}
            contextBundles={contextBundles ?? []}
            agentName={assignedAgent?.name ?? null}
            onOpenAttachment={onOpenAttachment}
          />
        )}

        {mergedTimeline.map((item, idx) => {
          if (item.kind === "work_question") {
            const detail = item.data;
            return (
              <div
                key={`work-question-${detail.question.id}`}
                data-work-question-id={detail.question.id}
                tabIndex={-1}
                className={cn(
                  "outline-none transition-shadow motion-reduce:transition-none",
                  highlightedAnchorId === detail.question.id && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                )}
              >
                <WorkQuestionPanel
                  companyId={selectedCompanyId!}
                  questionId={detail.question.id}
                  initialDetail={detail}
                />
              </div>
            );
          }
          if (item.kind === "run") {
            const run = item.data;
            const agent = agentMap.get(run.agentId);
            const isLatest = idx === mergedTimeline.length - 1 ||
              mergedTimeline.slice(idx + 1).every((i) => i.kind !== "run");
            const agentAdapterType = agent?.adapterType ?? "process";
            return (
              <TimelineAgentMessage
                key={`run-${run.runId}`}
                run={run}
                agentName={agent?.name ?? run.agentId.slice(0, 8)}
                isLatest={isLatest}
                compact={compact}
                adapterType={agentAdapterType}
                departmentType={departmentType}
                onActivity={handleTimelineActivity}
              />
            );
          }
          // Comment — rendered as chat bubble or system row
          const comment = item.data;
          const isSystemComment = !comment.authorAgentId && !comment.authorUserId;

          if (isSystemComment) {
            // System-generated comment — render as subtle centered metadata row
            const body = comment.body ?? "";
            const isRunSummary = body.includes("**Run Summary**");
            let displayText = "System";

            if (isRunSummary) {
              // Format: "🤖 **Run Summary** — Agent\nDuration: Xs | Tokens: N in / N out | Cost: $X\nOutcome: ✅ Succeeded"
              const lines = body.split("\n").filter(Boolean);
              const statsLine = lines[1] ?? "";
              const outcomeLine = lines[2] ?? "";
              const outcome = outcomeLine.replace(/^Outcome:\s*/, "").replace(/[✅❌⏱️⛔]\s*/g, "").trim();
              displayText = [statsLine, outcome].filter(Boolean).join(" · ") || "System";
            } else {
              // Generic system comment — show first line of body
              displayText = body.replace(/\*\*/g, "").trim().split("\n").filter(Boolean)[0] ?? "System";
            }

            return (
              <div key={`comment-${comment.id}`} className="flex items-center gap-3 px-2 py-1.5 overflow-hidden" data-testid={`timeline-comment-${comment.id}`}>
                <div className="flex-1 h-px bg-border shrink-0 min-w-[20px]" />
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                  <Activity className="h-3 w-3 shrink-0" />
                  <span className="truncate" title={displayText}>{displayText}</span>
                </div>
                <div className="flex-1 h-px bg-border shrink-0 min-w-[20px]" />
              </div>
            );
          }

          // Resolve author name — agent or user
          const authorAgent = comment.authorAgentId
            ? agentMap.get(comment.authorAgentId)
            : null;
          const authorName = comment.authorAgentId
            ? (authorAgent?.name ?? "Agent")
            : (comment.authorUserId ? "You" : "System");
          const isAgentComment = !!comment.authorAgentId;
          return (
            <TimelineUserMessage
              key={`comment-${comment.id}`}
              comment={comment}
              authorName={authorName}
              isAgent={isAgentComment}
              attachments={attachmentsByCommentId.get(comment.id) ?? []}
              onOpenAttachment={onOpenAttachment}
            />
          );
        })}
        </div>
      </div>
      <span className="sr-only" aria-live="polite">{anchorAnnouncement}</span>

      {/* Chatbar — unified 3-row widget fixed at bottom */}
      {hasUnseenActivity && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-10 flex justify-center">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="pointer-events-auto h-7 rounded-full border border-border bg-background/95 px-3 text-xs shadow-sm"
            onClick={scrollToTimelineBottom}
          >
            New activity
          </Button>
        </div>
      )}

      {assignedAgent && (
        <ComposerFrame chrome="card" density={compact ? "compact" : "comfortable"} className="shrink-0 mx-3 mb-3" data-testid="workspace-chatbar" dragHandlers={dragHandlers}>
          <ComposerDropOverlay active={isDragActive} />
          {composerStateBanners}
          {/* Status row */}
          <ChatbarStatusRow
            agentName={assignedAgent.name}
            adapterType={agentAdapterType}
            tokensUsed={tokenSummary.totalTokens > 0 ? tokenSummary.totalTokens : null}
            contextLimit={getContextLimit(agentDefaultModel)}
            todoProgress={todoData.total > 0 ? { completed: todoData.completed, total: todoData.total } : null}
            todoItems={todoData.total > 0 ? todoData.todos : null}
            runState={chatbarRunState}
            runDurationLabel={null}
          />

          {selectedFiles.length > 0 && (
            <div className="border-t border-border/50 px-3 py-1.5">
              <div className="flex flex-wrap gap-1.5">
                {selectedFiles.map((file, index) => (
                  <ComposerAttachmentCard
                    key={`${file.name}-${file.size}-${index}`}
                    name={file.name}
                    byteSize={file.size}
                    state="ready"
                    onRemove={() => removeSelectedFile(index)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Textarea */}
          <div className="relative border-t border-border/50">
            {mention.open && (
              <ComposerMentionMenu
                options={mention.options}
                selectionIndex={mention.index}
                onSelect={mention.select}
                onHover={mention.setIndex}
                loading={mention.loading}
                testIdPrefix="workspace-mention"
              />
            )}
            <textarea
              ref={textareaRef}
              className="w-full bg-transparent px-3 py-2 text-sm resize-none focus:outline-none placeholder:text-muted-foreground/50"
              placeholder={`Message ${assignedAgent.name}...`}
              rows={1}
              value={chatInput}
              onChange={handleTextareaChange}
              onKeyDown={handleComposerKeyDown}
              onSelect={(e) => {
                // Caret moves (click/arrows) re-evaluate the mention token so
                // the menu can't go stale against a moved caret (F9).
                const t = e.currentTarget;
                mention.refresh(t.value, t.selectionStart ?? t.value.length);
              }}
              onPaste={handleComposerPaste}
            />
          </div>

          <input
            ref={fileInputRef}
            data-testid="workspace-chatbar-file-input"
            type="file"
            multiple
            accept={COMPOSER_ATTACHMENT_CONTENT_TYPES.join(",")}
            className="hidden"
            onChange={handleFilesSelected}
          />
          {composerError && (
            <div className="border-t border-border/50 px-3 py-2 text-xs text-destructive" role="alert">
              {composerError}
            </div>
          )}

          {/* Board 1 §3: an active run means a normal send queues behind it —
              state that BEFORE submission instead of implying an instant reply. */}
          {hasLiveRuns && !interruptRequested && (
            <div
              className="border-t border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground"
              data-testid="workspace-chatbar-queued-notice"
            >
              Queued after current run
            </div>
          )}

          {/* Controls row */}
          <div className="border-t border-border/50">
              <ChatbarControls
              adapterType={agentAdapterType}
              defaultModel={agentDefaultModel}
              selectedModel={modelOverride}
              onModelChange={setModelOverride}
              onAttach={handleAttach}
              onMention={mention.openViaButton}
              onSend={handleSend}
              sendDisabled={!canSend || sendMessage.isPending || isOffline}
                sendPending={sendMessage.isPending}
                // The label states the actual effect: waking the agent vs
                // queueing behind the live run (approved mock §4).
                sendLabel={hasLiveRuns ? "Send" : "Send & wake"}
                activeRun={hasLiveRuns}
                closedTask={issue?.status === "done" || issue?.status === "cancelled"}
                reopenRequested={reopenRequested}
                onReopenChange={(value) => {
                  setReopenRequested(value);
                  dismissBannerOnControlChange();
                }}
              />
          </div>
        </ComposerFrame>
      )}

      {/* Interrupt is a deliberate, separate choice BELOW the card (mock §4);
          it remains a flag applied on the next send. */}
      {assignedAgent && hasLiveRuns && issue?.status !== "done" && issue?.status !== "cancelled" && (
        <label className="mx-3 -mt-1 mb-3 flex shrink-0 cursor-pointer select-none items-center gap-2 text-[11px] text-muted-foreground" data-testid="workspace-chatbar-interrupt">
          <input
            type="checkbox"
            checked={interruptRequested}
            onChange={(event) => {
              setInterruptRequested(event.target.checked);
              dismissBannerOnControlChange();
            }}
            className="rounded border-border"
          />
          Interrupt active run — applies to the next send
        </label>
      )}

      {/* Fallback when no agent assigned */}
      {!assignedAgent && (
        <ComposerFrame chrome="card" density={compact ? "compact" : "comfortable"} className="shrink-0 mx-3 mb-3" data-testid="workspace-chatbar-fallback" dragHandlers={dragHandlers}>
          <ComposerDropOverlay active={isDragActive} />
          {composerStateBanners}
          <ChatbarStatusRow
            agentName="No agent assigned"
            adapterType="process"
            tokensUsed={null}
            contextLimit={null}
            todoProgress={todoData.total > 0 ? { completed: todoData.completed, total: todoData.total } : null}
            todoItems={todoData.total > 0 ? todoData.todos : null}
            runState={chatbarRunState}
            runDurationLabel={null}
          />
          {selectedFiles.length > 0 && (
            <div className="border-t border-border/50 px-3 py-1.5">
              <div className="flex flex-wrap gap-1.5">
                {selectedFiles.map((file, index) => (
                  <ComposerAttachmentCard
                    key={`${file.name}-${file.size}-${index}`}
                    name={file.name}
                    byteSize={file.size}
                    state="ready"
                    onRemove={() => removeSelectedFile(index)}
                  />
                ))}
              </div>
            </div>
          )}
          <div className="relative border-t border-border/50">
            {mention.open && (
              <ComposerMentionMenu
                options={mention.options}
                selectionIndex={mention.index}
                onSelect={mention.select}
                onHover={mention.setIndex}
                loading={mention.loading}
                testIdPrefix="workspace-mention"
              />
            )}
            <textarea
              ref={textareaRef}
              className="w-full bg-transparent px-3 py-2 text-sm resize-none focus:outline-none placeholder:text-muted-foreground/50"
              placeholder="Add a comment..."
              rows={1}
              value={chatInput}
              onChange={handleTextareaChange}
              onKeyDown={handleComposerKeyDown}
              onSelect={(e) => {
                // Caret moves (click/arrows) re-evaluate the mention token so
                // the menu can't go stale against a moved caret (F9).
                const t = e.currentTarget;
                mention.refresh(t.value, t.selectionStart ?? t.value.length);
              }}
              onPaste={handleComposerPaste}
            />
          </div>
          <input
            ref={fileInputRef}
            data-testid="workspace-chatbar-file-input"
            type="file"
            multiple
            accept={COMPOSER_ATTACHMENT_CONTENT_TYPES.join(",")}
            className="hidden"
            onChange={handleFilesSelected}
          />
          {composerError && (
            <div className="border-t border-border/50 px-3 py-2 text-xs text-destructive" role="alert">
              {composerError}
            </div>
          )}
          <div className="border-t border-border/50">
            <ChatbarControls
              adapterType="comment"
              defaultModel={null}
              selectedModel={modelOverride}
              onModelChange={setModelOverride}
              onAttach={handleAttach}
              onMention={mention.openViaButton}
              onSend={handleSend}
              showModelLabel={false}
              sendDisabled={!canSend || sendMessage.isPending || isOffline}
              sendPending={sendMessage.isPending}
              activeRun={hasLiveRuns}
              closedTask={issue?.status === "done" || issue?.status === "cancelled"}
              reopenRequested={reopenRequested}
              onReopenChange={(value) => {
                setReopenRequested(value);
                dismissBannerOnControlChange();
              }}
            />
          </div>
        </ComposerFrame>
      )}
    </div>
  );
}
