/**
 * ThreadTab — group-chat message stream.
 * Uses EntryRow for each entry (bubble/card style).
 * Composer at the bottom is the new Phase E1 EntryComposer with
 * @-autocomplete, attachments, and reply support.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ShowRef } from "@armyofagents/shared";
import { discussionsApi, type DiscussionEntry, type DiscussionEntryAttachment } from "../../api/discussions";
import { archiveArtifact, unarchiveArtifact } from "../../api/artifacts";
import { authApi } from "../../api/auth";
import { agentsApi } from "../../api/agents";
import { assetsApi } from "../../api/assets";
import { teamApi } from "../../api/team";
import { issuesApi } from "../../api/issues";
import { useTeamAccess } from "../../hooks/useTeamAccess";
import { useToast } from "../../context/ToastContext";
import { useLiveUpdates } from "../../context/LiveUpdatesProvider";
import { queryKeys } from "../../lib/queryKeys";
import { EntryRow } from "./EntryRow";
import { EntryComposer, type AgentRef, type AssetRef, type UserRef } from "./EntryComposer";
import { ComposerSendFailedBanner } from "../composer/ComposerSendFailedBanner";
import { ComposerOfflineStrip, toComposerConnectionState } from "../composer/ComposerOfflineStrip";
import { createComposerSubmissionId } from "@armyofagents/shared";
import { PresenceStrip } from "./PresenceStrip";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { useInlineWorkQuestions, WorkQuestionInlineError } from "../work-questions/WorkQuestionInlineList";
import { WorkQuestionPanel } from "../work-questions/WorkQuestionPanel";

/**
 * How long an optimistic "Summoning {names}…" chip lingers before auto-clearing
 * if the real `thread.presence` pill never arrives (e.g. the agent declined to
 * answer, or the run failed before flipping presence). The pill normally
 * replaces it within a couple of seconds. (Task 5.4)
 */
const SUMMONING_TIMEOUT_MS = 20_000;
const SEND_RECEIPT_TIMEOUT_MS = 4_000;

// Mock §5: "failed" is no longer a receipt — send failure raises the
// ComposerSendFailedBanner (Retry/Edit/Discard) instead of inline copy.
type SendReceipt = "sending" | "sent" | null;

/** The exact mutation body of a failed send, retained for an idempotent Retry. */
type AddEntryPayload = {
  rawContent: string;
  attachments: AssetRef[];
  parentEntryId: string | null;
  /**
   * Client-minted idempotency key (server replay at POST …/entries).
   * Minted ONCE per submission — Retry re-sends the identical body so an
   * ambiguous failure (request landed, response lost) replays instead of
   * double-posting. A NEW submission mints a NEW id.
   */
  clientSubmissionId: string;
};

/* ════════════════════════════════════════════════════════════════════════
   ThreadTab
   ════════════════════════════════════════════════════════════════════════ */

export interface ThreadTabProps {
  threadId: string;
  companyId: string;
  entries: DiscussionEntry[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onOpenAttachment?: (attachment: DiscussionEntryAttachment, entryId: string) => void;
  /**
   * Viewer Upgrade Phase 7B: open a delivered navigational ref chip (from an
   * entry's outputRefs). Forwarded to each EntryRow; optional.
   */
  onOpenRef?: (ref: ShowRef) => void;
  /**
   * When true, a scope-version draft exists for this thread. Forwarded to
   * each EntryRow so ScopeProposalCard can show the "Scoped" done-state.
   */
  hasScopeDraft?: boolean;
  draftText?: string;
  onDraftTextChange?: (text: string) => void;
}

export function ThreadTab({
  threadId,
  companyId,
  entries,
  isLoading,
  isError,
  onRetry,
  onOpenAttachment,
  onOpenRef,
  hasScopeDraft = false,
  draftText,
  onDraftTextChange,
}: ThreadTabProps) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { connectionState, workingAgentsByThread, presenceByThread } = useLiveUpdates();
  // Artifact Lifecycle P1: archive/unarchive is founder-only.
  const { role: teamRole } = useTeamAccess(companyId);
  const canManageArtifacts = teamRole === "founder";
  const isOffline = connectionState === "offline";
  const isReconnecting = connectionState === "reconnecting";
  const isDisconnected = isOffline || isReconnecting;
  const inlineQuestionsQuery = useInlineWorkQuestions(companyId, { sourceDiscussionId: threadId });
  const inlineQuestions = Array.isArray(inlineQuestionsQuery.data) ? inlineQuestionsQuery.data : [];

  // ── Task 5.3: live thread presence (humanized typing/working pill) ──
  // Defensive ?? {} so a partial useLiveUpdates() (e.g. a test mock, or a
  // consumer rendering before the provider populates) never throws.
  const workingAgents = (workingAgentsByThread ?? {})[threadId] ?? [];
  const presence = (presenceByThread ?? {})[threadId] ?? [];
  const typingMembers = presence.filter((m) => m.typing);

  // ── Task 5.4: optimistic "Summoning {names}…" chip on @mention send ──
  // Client-only state: a transient chip per summoned crew agent, shown the
  // instant the founder sends an @mention. Cleared when the real presence pill
  // arrives for that agent (it's now "working") or after a timeout.
  const [summoning, setSummoning] = useState<Array<{ id: string; name: string }>>([]);
  const summoningTimersRef = useRef<Map<string, number>>(new Map());

  // ── Task 5.4: optimistic own-entry — render the just-sent message instantly,
  // before the server round-trip lands (today the mutation only invalidates). ──
  const [optimisticEntries, setOptimisticEntries] = useState<DiscussionEntry[]>([]);
  const [sendReceipt, setSendReceipt] = useState<SendReceipt>(null);

  // Mock §5 send-failed banner state. The last-attempted payload lives in a ref
  // (stored BEFORE awaiting the mutation) so BOTH failure sites — the submit
  // catch here and EntryComposer's onSubmitError — can offer an identical Retry.
  const [sendFailed, setSendFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [composerClearSignal, setComposerClearSignal] = useState(0);
  const lastAttemptedPayloadRef = useRef<AddEntryPayload | null>(null);
  // Latest composer text as reported by EntryComposer (both draft modes) —
  // lets the retry-success path skip the clearSignal bump when the draft
  // diverged WHILE the retry was in flight (edits must never be wiped).
  const latestDraftTextRef = useRef<string | null>(null);
  // Attachment-tray changes since the snapshot was minted (stale-banner
  // residual): the dismiss-on-tray-change guard is locked while retrying, so
  // this flag is how the failure paths know the snapshot went stale mid-flight.
  // Reset whenever a fresh attempt is snapshotted.
  const attachmentsChangedSinceAttemptRef = useRef(false);

  /**
   * Stale-banner residual (cross-surface): true when the composer diverged
   * from the snapshotted attempt — the draft text differs from the attempt's
   * rawContent OR the attachment tray changed since the snapshot. A failure
   * path must never (re-)arm the banner then: its Retry would post the stale
   * snapshot (e.g. a removed attachment). The user has diverged; they'll send
   * fresh with a NEW clientSubmissionId.
   */
  function draftDivergedFromAttempt(): boolean {
    const payload = lastAttemptedPayloadRef.current;
    if (!payload) return false;
    if (attachmentsChangedSinceAttemptRef.current) return true;
    const latest = latestDraftTextRef.current;
    return latest !== null && latest.trim() !== payload.rawContent.trim();
  }

  // Entity switch (threadId change): the send-failed banner + attempt snapshot
  // belong to the PREVIOUS thread — Retry must never post into a different
  // thread. ONLY the banner/snapshot state resets here: the composer draft is
  // per-thread already, so no clearSignal bump (that would wipe the new
  // thread's draft).
  useEffect(() => {
    lastAttemptedPayloadRef.current = null;
    attachmentsChangedSinceAttemptRef.current = false;
    setSendFailed(false);
  }, [threadId]);

  useEffect(() => {
    if (sendReceipt !== "sent") return;
    const timeout = window.setTimeout(() => setSendReceipt(null), SEND_RECEIPT_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [sendReceipt]);

  // Current user identity — for right-aligning own messages
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId =
    (session as Record<string, unknown> | undefined)?.userId as string | null ??
    (session as { user?: { id?: string } } | undefined)?.user?.id ??
    null;

  // Suggestions for the @-autocomplete: AoA crew agents + team members.
  // Both queries are cheap and cached by react-query; we tolerate failure
  // silently because autocomplete is non-critical.
  const { data: agentsData } = useQuery({
    queryKey: ["agents", companyId, "aoa"],
    queryFn: () => agentsApi.listAoa(companyId),
    enabled: !!companyId,
    staleTime: 60_000,
  });
  const { data: teamData } = useQuery({
    queryKey: ["team", companyId],
    queryFn: () => teamApi.get(companyId),
    enabled: !!companyId,
    staleTime: 60_000,
  });

  const composerAgents: AgentRef[] = useMemo(
    () =>
      (agentsData ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        icon: a.icon,
        role: a.role,
      })),
    [agentsData],
  );

  const composerUsers: UserRef[] = useMemo(() => {
    const team = teamData as { members?: Array<{ userId: string; displayName?: string | null; email?: string | null }> } | undefined;
    return (team?.members ?? []).map((m) => ({
      id: m.userId,
      name: m.displayName ?? m.email ?? m.userId,
      email: m.email ?? null,
    }));
  }, [teamData]);

  // P1-T7: The most-recent scope_proposal entry in the thread is the "active"
  // one. Older proposals render read-only. Hoisted above all early returns so
  // the hook order stays stable (rules-of-hooks) — Task 5.4 made the empty-state
  // branch optimistic-aware, which would otherwise toggle this hook in/out.
  const activeProposalEntryId = useMemo(() => {
    const proposals = entries.filter((e) => e.inputType === "scope_proposal");
    return proposals.length > 0 ? proposals[proposals.length - 1].id : null;
  }, [entries]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when new messages arrive (server or optimistic).
  useEffect(() => {
    if (entries.length > 0 || optimisticEntries.length > 0) {
      messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
    }
  }, [entries.length, optimisticEntries.length]);

  // Task 5.4: clear a summoning chip the moment the real working-agent presence
  // pill arrives for that agent (it's now "<Name> is researching…"). The
  // PresenceStrip then carries the live state; the chip was only a stopgap.
  useEffect(() => {
    if (summoning.length === 0) return;
    const workingIds = new Set(workingAgents.map((a) => a.agentId));
    const stillPending = summoning.filter((s) => !workingIds.has(s.id));
    if (stillPending.length !== summoning.length) {
      for (const s of summoning) {
        if (workingIds.has(s.id)) {
          const t = summoningTimersRef.current.get(s.id);
          if (t != null) {
            window.clearTimeout(t);
            summoningTimersRef.current.delete(s.id);
          }
        }
      }
      setSummoning(stillPending);
    }
  }, [workingAgents, summoning]);

  // Task 5.4: drop an optimistic own-entry once the server's refetched entries
  // include it (same author + content). Best-effort dedupe keyed on content.
  useEffect(() => {
    if (optimisticEntries.length === 0) return;
    const serverKeys = new Set(
      entries
        .filter((e) => e.createdBy && e.createdBy === currentUserId)
        .map((e) => e.rawContent),
    );
    const remaining = optimisticEntries.filter((o) => !serverKeys.has(o.rawContent));
    if (remaining.length !== optimisticEntries.length) {
      setOptimisticEntries(remaining);
    }
  }, [entries, optimisticEntries, currentUserId]);

  // Clear any pending summoning timers on unmount.
  useEffect(() => {
    const timers = summoningTimersRef.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, []);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["threads", companyId, threadId] });
    queryClient.invalidateQueries({ queryKey: queryKeys.discussions.detail(companyId, threadId) });
  };

  const addEntryMutation = useMutation({
    mutationFn: (payload: AddEntryPayload) =>
      discussionsApi.addEntry(companyId, threadId, {
        rawContent: payload.rawContent,
        inputType: "write",
        parentEntryId: payload.parentEntryId,
        // First UI consumer of the server-side idempotent replay (validator
        // packages/shared/src/validators/discussion.ts; replay in
        // server/src/routes/discussions.ts POST …/entries).
        clientSubmissionId: payload.clientSubmissionId,
        // Phase E1: pass attachment ids so the server links them in the same txn.
        // Artifact Lifecycle P1: founder file-artifact uploads carry an
        // `artifactId` — route those to { artifactId } so the server links the
        // tracked artifact instead of a bare asset.
        attachments: payload.attachments.length
          ? payload.attachments.map((a) => (a.artifactId ? { artifactId: a.artifactId } : { assetId: a.id }))
          : undefined,
      } as Parameters<typeof discussionsApi.addEntry>[2]),
    onSuccess: () => {
      invalidate();
    },
    onError: () => {
      pushToast({ title: "Failed to send message", tone: "warn" });
    },
  });

  // Artifact Lifecycle P1: archive/unarchive an inline artifact, then invalidate
  // the same thread query the entry mutation uses so the card re-renders with
  // the new artifactStatus (server returns it on the attachment join).
  // Use mutateAsync at the call site so the card's ArtifactActions can await the
  // result, drive its busy-disable, and surface a failure inline (single error
  // surface at the artifact — no global toast double-report).
  const archiveArtifactMutation = useMutation({
    mutationFn: (artifactId: string) => archiveArtifact(artifactId),
    onSuccess: () => invalidate(),
  });
  const unarchiveArtifactMutation = useMutation({
    mutationFn: (artifactId: string) => unarchiveArtifact(artifactId),
    onSuccess: () => invalidate(),
  });
  // Return Promise<void> so the card's ArtifactActions can await it (busy-disable +
  // inline error). The mutation result is irrelevant to the card; a rejection
  // propagates through `.then` to the card's catch.
  const handleArchiveArtifact = (id: string): Promise<void> => archiveArtifactMutation.mutateAsync(id).then(() => undefined);
  const handleUnarchiveArtifact = (id: string): Promise<void> => unarchiveArtifactMutation.mutateAsync(id).then(() => undefined);

  const reprocessMutation = useMutation({
    mutationFn: (entryId: string) =>
      discussionsApi.reprocessEntry(companyId, threadId, entryId),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Reprocessing entry…", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to reprocess entry", tone: "warn" });
    },
  });

  // P1-T7: Approve a scope proposal — calls the secure server handler which
  // independently authorizes, validates staleness, and creates deliverable tasks.
  const approveProposalMutation = useMutation({
    mutationFn: (proposalEntryId: string) =>
      discussionsApi.approveProposal(companyId, threadId, proposalEntryId),
    onSuccess: (data) => {
      invalidate();
      if (data.alreadyApproved) {
        pushToast({ title: "Proposal already approved", tone: "success" });
      } else {
        pushToast({
          title: `${data.tasksCreated.length} task${data.tasksCreated.length === 1 ? "" : "s"} created`,
          tone: "success",
        });
      }
    },
    onError: (err: unknown) => {
      const message =
        (err as { body?: { error?: string } })?.body?.error ??
        (err as { message?: string })?.message ??
        "Failed to approve proposal";
      pushToast({ title: message, tone: "warn" });
    },
  });

  // P2-T2: crew-failure card actions.
  const retryTaskMutation = useMutation({
    mutationFn: (issueId: string) => issuesApi.update(issueId, { status: "todo" }),
    onSuccess: () => {
      pushToast({ title: "Task re-queued", tone: "success" });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
    onError: () => pushToast({ title: "Failed to retry task", tone: "warn" }),
  });
  const skipTaskMutation = useMutation({
    mutationFn: (issueId: string) => issuesApi.update(issueId, { status: "cancelled" }),
    onSuccess: () => {
      pushToast({ title: "Task skipped", tone: "success" });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
    onError: () => pushToast({ title: "Failed to skip task", tone: "warn" }),
  });

  // Crew-agent lookup for the optimistic summoning chip — the composer's
  // `mentions` are ids; only ids present in the AoA crew list summon a crew run.
  const crewAgentById = useMemo(() => {
    const m = new Map<string, AgentRef>();
    for (const a of composerAgents) m.set(a.id, a);
    return m;
  }, [composerAgents]);

  async function handleComposerSubmit(payload: {
    text: string;
    mentions: string[];
    parentEntryId: string | null;
    attachments: AssetRef[];
  }) {
    if (isDisconnected) {
      pushToast({
        title: isOffline ? "You're offline — message not sent" : "Reconnecting — message not sent",
        tone: "warn",
      });
      return;
    }

    setSendReceipt("sending");
    // A fresh submission supersedes any previous failure (and mints a NEW id).
    setSendFailed(false);

    // Task 5.4: optimistically surface a "Summoning {names}…" chip for any
    // @mentioned crew agent, immediately — replaced by the real presence pill
    // (or auto-cleared after a timeout if it never lights).
    const summonedCrew = payload.mentions
      .map((id) => crewAgentById.get(id))
      .filter((a): a is AgentRef => !!a)
      .map((a) => ({ id: a.id, name: a.name }));
    if (summonedCrew.length > 0) {
      setSummoning((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...summonedCrew.filter((s) => !seen.has(s.id))];
      });
      for (const s of summonedCrew) {
        const existing = summoningTimersRef.current.get(s.id);
        if (existing != null) window.clearTimeout(existing);
        const timer = window.setTimeout(() => {
          summoningTimersRef.current.delete(s.id);
          setSummoning((prev) => prev.filter((p) => p.id !== s.id));
        }, SUMMONING_TIMEOUT_MS);
        summoningTimersRef.current.set(s.id, timer);
      }
    }

    // Task 5.4: optimistically insert the user's own entry so the bubble appears
    // instantly (pruned once the server's refetched entries include it).
    if (!payload.parentEntryId) {
      const now = new Date().toISOString();
      const optimistic: DiscussionEntry = {
        id: `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        inputType: "write",
        rawContent: payload.text,
        title: null,
        sourceInfo: null,
        departmentId: null,
        projectId: null,
        goalId: null,
        parentEntryId: null,
        authorAgentId: null,
        authorAgentName: null,
        authorAgentAvatar: null,
        extractionStatus: "pending",
        createdBy: currentUserId ?? "me",
        createdAt: now,
        extractedItems: [],
        annotations: [],
      };
      setOptimisticEntries((prev) => [...prev, optimistic]);
    }

    // Minted ONCE per submission; stored BEFORE the await so the banner's Retry
    // (from either failure site) re-sends the exact same body — the server's
    // clientSubmissionId replay makes an ambiguous failure safe to retry.
    const mutationPayload: AddEntryPayload = {
      rawContent: payload.text,
      attachments: payload.attachments,
      parentEntryId: payload.parentEntryId,
      clientSubmissionId: createComposerSubmissionId(),
    };
    lastAttemptedPayloadRef.current = mutationPayload;
    attachmentsChangedSinceAttemptRef.current = false;

    try {
      await addEntryMutation.mutateAsync(mutationPayload);
      lastAttemptedPayloadRef.current = null;
      setSendReceipt("sent");
    } catch (error) {
      // On failure, drop the optimistic echo (mutation's onError already toasts).
      setOptimisticEntries((prev) => prev.filter((o) => o.rawContent !== payload.text));
      setSendReceipt(null);
      // Never arm a stale banner: if the composer diverged while the send was
      // in flight, Retry would post the stale snapshot — leave it dismissed.
      setSendFailed(!draftDivergedFromAttempt());
      // Let EntryComposer retain the immutable submission snapshot. Swallowing
      // this error causes it to clear the user's draft and uploaded attachments.
      throw error;
    }
  }

  /** Banner Retry: re-send the IDENTICAL stored payload (same clientSubmissionId).
   *  Gated offline like the submit path (and the other three surfaces). */
  async function handleRetryFailedSend() {
    const payload = lastAttemptedPayloadRef.current;
    if (!payload || retrying || isDisconnected) return;
    setRetrying(true);
    try {
      await addEntryMutation.mutateAsync(payload);
      lastAttemptedPayloadRef.current = null;
      setSendFailed(false);
      setSendReceipt("sent");
      // The original submit's success path clears the composer inside
      // EntryComposer; a banner Retry bypasses that path, so clear via signal.
      // EXCEPT when the draft diverged WHILE the retry was in flight (the
      // divergence dismiss is locked during retry) — clearing then would wipe
      // the newer edits. The message posted; the edits stay as a fresh draft.
      const latest = latestDraftTextRef.current;
      if (
        (latest === null || latest.trim() === payload.rawContent.trim()) &&
        !attachmentsChangedSinceAttemptRef.current
      ) {
        setComposerClearSignal((n) => n + 1);
      }
    } catch {
      // Still failing — the banner stays up (mutation onError already toasts)
      // UNLESS the composer diverged mid-retry (the divergence dismiss is
      // locked while retrying): a stale banner's Retry would post the old
      // snapshot (e.g. a removed attachment), so drop it now instead.
      if (draftDivergedFromAttempt()) setSendFailed(false);
    } finally {
      setRetrying(false);
    }
  }

  function handleDiscardFailedSend() {
    lastAttemptedPayloadRef.current = null;
    setSendFailed(false);
    setComposerClearSignal((n) => n + 1);
  }

  /**
   * Stale-snapshot guard (mock §5: failure never eats your work): if the user
   * keeps editing while the banner is up, Retry would post the PRE-EDIT
   * snapshot and its success-clear would wipe the newer edits. The moment the
   * draft diverges from the snapshot, auto-dismiss the banner — the ref is
   * kept (nothing double-posts); the user just sends normally with a fresh id.
   * EntryComposer reports every text change here, in both controlled and
   * uncontrolled draft modes.
   */
  function handleComposerDraftChange(text: string) {
    latestDraftTextRef.current = text;
    if (
      sendFailed &&
      !retrying &&
      lastAttemptedPayloadRef.current &&
      text !== lastAttemptedPayloadRef.current.rawContent
    ) {
      setSendFailed(false);
    }
    onDraftTextChange?.(text);
  }

  /**
   * Any attachment-tray mutation (add/remove/failed-card change) IS divergence
   * from the failed snapshot: Retry would post the snapshot including a
   * removed (possibly sensitive) file, or without a newly added one — dismiss
   * the banner (locked while retrying, same as the text-divergence guard).
   */
  function handleComposerAttachmentsChanged() {
    // Recorded even while retrying (when the dismiss below is locked) so the
    // failure paths know the snapshot went stale and never re-arm the banner.
    attachmentsChangedSinceAttemptRef.current = true;
    if (sendFailed && !retrying) setSendFailed(false);
  }

  async function handleUpload(file: File): Promise<AssetRef> {
    const res = await assetsApi.uploadFile(companyId, file, "discussion-entries");
    return {
      id: res.assetId,
      name: res.originalFilename ?? file.name,
      mimeType: res.contentType,
      previewUrl: res.contentPath,
      byteSize: res.byteSize,
    };
  }

  // ── Loading skeleton ──
  if (isLoading) {
    return (
      <div className="space-y-4 py-4" data-testid="thread-tab-skeleton">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="w-8 h-8 rounded-full bg-muted animate-pulse shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 rounded bg-muted animate-pulse w-24" />
              <div
                className="h-12 rounded-xl bg-muted animate-pulse"
                style={{ borderRadius: "4px 14px 14px 14px" }}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ── Error state ──
  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-8" data-testid="thread-tab-error">
        <p className="text-sm text-muted-foreground">Couldn&apos;t load messages.</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4 mr-1.5" />
          Retry
        </Button>
      </div>
    );
  }

  // Derive user initials for composer avatar
  const myInitials = currentUserId
    ? currentUserId === "local-board"
      ? "LB"
      : currentUserId.replace(/[-_]/g, " ").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "Me"
    : "Me";

  // Task 5.3 + 5.4: live presence/typing pill + transient summoning chips, shown
  // just above the composer so "<Name> is researching…" appears live while an
  // agent runs and "Summoning {names}…" bridges the gap right after an @mention.
  const presenceFooter = (
    <div className="px-4 pb-1.5 empty:hidden" data-testid="thread-presence-footer">
      {summoning.length > 0 && (
        <span
          className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
          data-testid="thread-summoning-chip"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" aria-hidden="true" />
          Summoning {summoning.map((s) => s.name).join(", ")}…
        </span>
      )}
      <PresenceStrip
        presence={presence}
        typingMembers={typingMembers}
        workingAgents={workingAgents.map((a) => ({ id: a.agentId, name: a.name, activity: a.activity }))}
      />
    </div>
  );

  const composer = (
    <div data-testid="thread-composer">
      <EntryComposer
        threadId={threadId}
        agents={composerAgents}
        users={composerUsers}
        onUpload={handleUpload}
        onSubmit={handleComposerSubmit}
        onSubmitError={() => {
          // Covers EntryComposer-internal throw paths too — the payload was
          // already snapshotted into lastAttemptedPayloadRef before the await.
          // Same stale-banner guard as the submit catch: never arm the banner
          // over a snapshot the composer has already diverged from.
          setSendReceipt(null);
          setSendFailed(!draftDivergedFromAttempt());
        }}
        disabled={isDisconnected || addEntryMutation.isPending}
        myInitials={myInitials}
        draftText={draftText}
        onDraftTextChange={handleComposerDraftChange}
        onAttachmentsChanged={handleComposerAttachmentsChanged}
        clearSignal={composerClearSignal}
        failureBanner={
          sendFailed ? (
            <ComposerSendFailedBanner
              onRetry={() => void handleRetryFailedSend()}
              onEdit={() => setSendFailed(false)}
              onDiscard={handleDiscardFailedSend}
              retrying={retrying}
            />
          ) : undefined
        }
        hint={
          isDisconnected
            ? (
                <span data-testid="thread-composer-offline-hint">
                  <ComposerOfflineStrip state={toComposerConnectionState(connectionState)} />
                </span>
              )
            : sendReceipt
              ? (
                  <span aria-live="polite" data-testid="thread-send-receipt">
                    {sendReceipt === "sending" ? "Sending..." : "Sent"}
                  </span>
                )
              : undefined
        }
      />
    </div>
  );

  // ── Empty state ── (only when there's nothing to show, incl. optimistic echoes)
  if (entries.length === 0 && optimisticEntries.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {inlineQuestionsQuery.isError ? (
            <WorkQuestionInlineError onRetry={() => void inlineQuestionsQuery.refetch()} />
          ) : null}
          <div className="mx-auto grid w-full max-w-3xl gap-3">
            {[...inlineQuestions]
              .sort((left, right) => (
                new Date(left.question.createdAt).getTime() - new Date(right.question.createdAt).getTime()
                || left.question.id.localeCompare(right.question.id)
              ))
              .map((detail) => (
              <WorkQuestionPanel
                key={detail.question.id}
                companyId={companyId}
                questionId={detail.question.id}
                initialDetail={detail}
              />
              ))}
          </div>
          <div className="flex flex-col items-center justify-center py-12 text-center px-6">
            <p className="text-sm text-muted-foreground mb-1">No messages yet.</p>
            <p className="text-xs text-muted-foreground/60">Start the discussion below.</p>
          </div>
        </div>
        {presenceFooter}
        {composer}
      </div>
    );
  }

  // Group: top-level first, replies underneath; orphan replies treated as top-level
  const topLevel = entries.filter((e) => !e.parentEntryId);
  const topLevelIds = new Set(topLevel.map((e) => e.id));
  const repliesByParent = new Map<string, DiscussionEntry[]>();
  for (const e of entries) {
    if (e.parentEntryId && topLevelIds.has(e.parentEntryId)) {
      const list = repliesByParent.get(e.parentEntryId) ?? [];
      list.push(e);
      repliesByParent.set(e.parentEntryId, list);
    }
  }
  const orphans = entries.filter((e) => e.parentEntryId && !topLevelIds.has(e.parentEntryId));
  // Task 5.4: append optimistic own-entries (skip any already echoed by the
  // server to avoid a flash of duplicates between refetch and prune).
  const serverOwnContent = new Set(
    entries.filter((e) => e.createdBy && e.createdBy === currentUserId).map((e) => e.rawContent),
  );
  const pendingOptimistic = optimisticEntries.filter((o) => !serverOwnContent.has(o.rawContent));
  const roots = [...topLevel, ...orphans, ...pendingOptimistic];
  const timelineRows = [
    ...roots.map((entry) => ({
      kind: "entry" as const,
      id: entry.id,
      createdAt: new Date(entry.createdAt).getTime(),
      entry,
    })),
    ...inlineQuestions.map((detail) => ({
      kind: "work_question" as const,
      id: detail.question.id,
      createdAt: new Date(detail.question.createdAt).getTime(),
      detail,
    })),
  ].sort((left, right) => (
    left.createdAt - right.createdAt
    || (left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind === "entry" ? -1 : 1)
  ));

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div
        className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3"
        data-testid="thread-tab-entries"
      >
        {inlineQuestionsQuery.isError ? (
          <WorkQuestionInlineError onRetry={() => void inlineQuestionsQuery.refetch()} />
        ) : null}
        {timelineRows.map((row) => {
          if (row.kind === "work_question") {
            return (
              <div key={`work-question-${row.id}`} data-work-question-id={row.id} tabIndex={-1} className="outline-none">
                <WorkQuestionPanel
                  companyId={companyId}
                  questionId={row.id}
                  initialDetail={row.detail}
                />
              </div>
            );
          }
          const entry = row.entry;
          const replies = repliesByParent.get(entry.id) ?? [];
          // Phase E2: client-side reply count when server doesn't supply one.
          const enrichedEntry: DiscussionEntry = {
            ...entry,
            replyCount: entry.replyCount ?? replies.length,
          };
          return (
            <div key={entry.id} data-testid={`entry-group-${entry.id}`} className="space-y-2">
              <EntryRow
                entry={enrichedEntry}
                currentUserId={currentUserId}
                onReprocess={() => reprocessMutation.mutate(entry.id)}
                isReprocessing={
                  reprocessMutation.isPending && reprocessMutation.variables === entry.id
                }
                scopeProposalActive={entry.id === activeProposalEntryId}
                onScopeProposalApprove={(e) => approveProposalMutation.mutate(e.id)}
                onCrewFailureRetry={(issueId) => retryTaskMutation.mutate(issueId)}
                onCrewFailureReassign={(issueId) => navigate(`/issues/${issueId}`)}
                onCrewFailureSkip={(issueId) => skipTaskMutation.mutate(issueId)}
                onOpenArtifact={(attachment) => onOpenAttachment?.(attachment, entry.id)}
                onOpenRef={onOpenRef}
                canManageArtifacts={canManageArtifacts}
                onArchiveArtifact={handleArchiveArtifact}
                onUnarchiveArtifact={handleUnarchiveArtifact}
                hasScopeDraft={hasScopeDraft}
              />
              {replies.map((reply) => (
                <div key={reply.id} className="pl-10">
                  <EntryRow
                    entry={reply}
                    currentUserId={currentUserId}
                    onReprocess={() => reprocessMutation.mutate(reply.id)}
                    isReprocessing={
                      reprocessMutation.isPending && reprocessMutation.variables === reply.id
                    }
                    onCrewFailureRetry={(issueId) => retryTaskMutation.mutate(issueId)}
                    onCrewFailureReassign={(issueId) => navigate(`/issues/${issueId}`)}
                    onCrewFailureSkip={(issueId) => skipTaskMutation.mutate(issueId)}
                    onOpenArtifact={(attachment) => onOpenAttachment?.(attachment, reply.id)}
                    onOpenRef={onOpenRef}
                    canManageArtifacts={canManageArtifacts}
                    onArchiveArtifact={handleArchiveArtifact}
                    onUnarchiveArtifact={handleUnarchiveArtifact}
                    hasScopeDraft={hasScopeDraft}
                  />
                </div>
              ))}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {presenceFooter}
      {composer}
    </div>
  );
}
