/**
 * EntryRow — group-chat message bubbles and agent cards.
 * Current user → right-aligned bubble.
 * Other humans → left-aligned bubble.
 * Agents → left-aligned card with role-colored left border.
 * System notices → centered divider.
 *
 * Phase E2 additions:
 *  - Agent attribution badge (name + avatar) when authorAgentId + authorAgentName
 *  - Inline InlineArtifactCard when entry.attachments[] is non-empty
 *  - Reply count toggle when entry.replyCount > 0
 *
 * Phase E3 wiring: special-cased inputTypes route to dedicated cards:
 *  - "scope_proposal" → ScopeProposalCard
 *  - "system" → SystemEntryCard (or SpinOffSuggestionCard when payload present)
 */
import {
  CheckCircle2,
  Database,
  Loader2,
  XCircle,
  MessageSquare,
} from "lucide-react";
import { relativeTime } from "@/lib/utils";
import type { ShowRef } from "@armyofagents/shared";
import type { DiscussionEntry, DiscussionEntryAttachment } from "../../api/discussions";
import { OutputRefChips } from "../commander/viewer/OutputRefChips";
import { InlineArtifactCard } from "./InlineArtifactCard";
import { ScopeProposalCard } from "./ScopeProposalCard";
import { SystemEntryCard } from "./SystemEntryCard";
import {
  SpinOffSuggestionCard,
  type SpinOffSuggestion,
} from "./SpinOffSuggestionCard";
import { HopCapDecisionCard } from "./HopCapDecisionCard";
import { CrewFailureCard, type CrewFailurePayload } from "./CrewFailureCard";
import { AgentAvatar, agentRoleColor } from "./AgentAvatar";
import { MarkdownBody } from "../MarkdownBody";
import type { ScopeProposalPayload } from "@armyofagents/shared";

/* ─── Helpers ─── */

function toInitials(id: string | null | undefined, fallback = "?"): string {
  if (!id) return fallback;
  if (id === "local-board") return "LB";
  if (/^[0-9a-f]{8}-/i.test(id)) return "M";
  return (
    id.replace(/[-_]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || fallback
  );
}

function toDisplayName(id: string | null | undefined): string {
  if (!id) return "Unknown";
  if (id === "local-board") return "Local Board";
  if (/^[0-9a-f]{8}-/i.test(id)) return "Member";
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

/**
 * Phase E3: extract a SpinOffSuggestion payload from a system entry's sourceInfo
 * when present. The Adjutant emits these via sourceInfo.spinOffSuggestion =
 * { topicSummary, rationale }. Returns null when the shape doesn't match.
 */
function extractSpinOffPayload(
  sourceInfo: Record<string, unknown> | null,
): SpinOffSuggestion | null {
  if (!sourceInfo) return null;
  const raw = sourceInfo.spinOffSuggestion;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.topicSummary !== "string" || typeof obj.rationale !== "string") {
    return null;
  }
  return { topicSummary: obj.topicSummary, rationale: obj.rationale };
}

/**
 * P1-T13: extract a hop-cap payload from a system entry's sourceInfo.
 * Returns { hopCount, cap } when sourceInfo.type === "hop_cap_reached".
 */
function extractHopCapPayload(entry: DiscussionEntry): { hopCount: number; cap: number } | null {
  if (entry.inputType !== "system") return null;
  const si = entry.sourceInfo as Record<string, unknown> | null;
  if (!si || si.type !== "hop_cap_reached") return null;
  const hopCount = typeof si.hopCount === "number" ? si.hopCount : 0;
  const cap = typeof si.cap === "number" ? si.cap : 5;
  return { hopCount, cap };
}

/**
 * P2-T2: extract a crew-failure payload from a system entry's sourceInfo.
 * Returns the payload when sourceInfo.type === "crew_failed".
 */
function extractCrewFailurePayload(entry: DiscussionEntry): CrewFailurePayload | null {
  if (entry.inputType !== "system") return null;
  const si = entry.sourceInfo as Record<string, unknown> | null;
  if (!si || si.type !== "crew_failed") return null;
  if (typeof si.issueId !== "string") return null;
  return {
    issueId: si.issueId,
    agentName: typeof si.agentName === "string" ? si.agentName : "An agent",
    taskTitle: typeof si.taskTitle === "string" ? si.taskTitle : "(untitled task)",
    error: typeof si.error === "string" ? si.error : "",
  };
}

function tryParseScopeProposal(content: string): ScopeProposalPayload | null {
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;
    if (typeof obj.summary !== "string") return null;
    if (!Array.isArray(obj.proposedTasks)) return null;
    return obj as unknown as ScopeProposalPayload;
  } catch {
    return null;
  }
}

/* ─── Reply count toggle (Phase E2) ─── */

function ReplyCountToggle({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors mt-1"
      data-testid="entry-reply-count"
    >
      <MessageSquare className="h-3 w-3" />
      {count} {count === 1 ? "reply" : "replies"}
    </button>
  );
}

/* ─── Delivered navigational-ref chips (Viewer Upgrade Phase 7B) ─── */

/**
 * Renders the clickable ShowRef chips a crew run delivered onto this entry
 * (`entry.outputRefs`). Reuses the surface-agnostic OutputRefChips; each chip's
 * click maps ShowRef → Thread viewer tab via the thread's openRef handler.
 * Inert (renders nothing) when there are no refs or no handler was threaded.
 */
function DeliveredRefChips({
  refs,
  onOpenRef,
}: {
  refs?: ShowRef[] | null;
  onOpenRef?: (ref: ShowRef) => void;
}) {
  if (!onOpenRef || !refs || refs.length === 0) return null;
  return <OutputRefChips refs={refs} onOpen={onOpenRef} />;
}

/* ─── Chip row ─── */

function ChipRow({
  taskCount,
  memCount,
  pendingCount,
  extractionStatus,
  extractionError,
}: {
  taskCount: number;
  memCount: number;
  pendingCount: number;
  extractionStatus: string;
  extractionError: string | null;
}) {
  const hasChips =
    taskCount > 0 ||
    memCount > 0 ||
    pendingCount > 0 ||
    extractionStatus === "processing" ||
    extractionStatus === "failed";

  if (!hasChips) return null;

  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {extractionStatus === "processing" && (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full text-muted-foreground"
          style={{ border: "1px solid hsl(0 0% 25%)", background: "hsl(0 0% 12%)" }}
        >
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          Extracting…
        </span>
      )}
      {extractionStatus === "failed" && (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full"
          style={{
            color: "#e87070",
            border: "1px solid rgba(220,80,80,0.3)",
            background: "rgba(220,80,80,0.08)",
          }}
          title={extractionError ?? "Extraction failed"}
        >
          <XCircle className="h-2.5 w-2.5" />
          Extraction failed
        </span>
      )}
      {taskCount > 0 && (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full"
          style={{
            color: "#4FB67E",
            border: "1px solid rgba(79,182,126,0.35)",
            background: "rgba(79,182,126,0.08)",
          }}
        >
          <CheckCircle2 className="h-2.5 w-2.5" />
          {taskCount} Task{taskCount !== 1 ? "s" : ""}
        </span>
      )}
      {memCount > 0 && (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full"
          style={{
            color: "#6470DC",
            border: "1px solid rgba(100,112,220,0.35)",
            background: "rgba(100,112,220,0.08)",
          }}
        >
          <Database className="h-2.5 w-2.5" />
          {memCount} Memory
        </span>
      )}
      {pendingCount > 0 && (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full"
          style={{
            color: "#D9A938",
            border: "1px solid rgba(217,169,56,0.35)",
            background: "rgba(217,169,56,0.08)",
          }}
        >
          {pendingCount} pending
        </span>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   EntryRow — public component
   ════════════════════════════════════════════════════════════════════════ */

export interface EntryRowProps {
  entry: DiscussionEntry;
  /** Viewer's own user ID — determines which side to align the bubble. */
  currentUserId?: string | null;
  onReprocess: () => void;
  isReprocessing?: boolean;
  /** Phase E3: optional handlers for entry card actions. */
  onScopeProposalApprove?: (entry: DiscussionEntry) => void;
  onScopeProposalReject?: (entry: DiscussionEntry) => void;
  /** Phase E3: whether this scope_proposal entry is the active proposal. */
  scopeProposalActive?: boolean;
  onSpinOffAccept?: (entry: DiscussionEntry, suggestion: SpinOffSuggestion) => void;
  onSpinOffDismiss?: (entry: DiscussionEntry, suggestion: SpinOffSuggestion) => void;
  /** Phase E2: clicked when the user opens an inline artifact. */
  onOpenArtifact?: (attachment: DiscussionEntryAttachment) => void;
  /**
   * Viewer Upgrade Phase 7B: clicked when the user opens a delivered navigational
   * ref chip (from `entry.outputRefs`). Optional — other EntryRow callers omit it
   * and the chips simply don't render.
   */
  onOpenRef?: (ref: ShowRef) => void;
  /** Artifact Lifecycle P1: founder-gated archive/unarchive on inline artifacts. */
  canManageArtifacts?: boolean;
  onArchiveArtifact?: (artifactId: string) => void | Promise<void>;
  onUnarchiveArtifact?: (artifactId: string) => void | Promise<void>;
  /** P2-T2: crew-failure card actions (issueId passed through). */
  onCrewFailureRetry?: (issueId: string) => void;
  onCrewFailureReassign?: (issueId: string) => void;
  onCrewFailureSkip?: (issueId: string) => void;
  /**
   * When true, a scope-version draft exists for this thread. Forwarded to
   * ScopeProposalCard as `scoped` to show the "Scoped" done-state and hide
   * the approve/reject/edit actions.
   */
  hasScopeDraft?: boolean;
}

export function EntryRow({
  entry,
  currentUserId,
  onReprocess,
  isReprocessing = false,
  onScopeProposalApprove,
  onScopeProposalReject,
  scopeProposalActive = false,
  onSpinOffAccept,
  onSpinOffDismiss,
  onOpenArtifact,
  onOpenRef,
  canManageArtifacts,
  onArchiveArtifact,
  onUnarchiveArtifact,
  onCrewFailureRetry,
  onCrewFailureReassign,
  onCrewFailureSkip,
  hasScopeDraft = false,
}: EntryRowProps) {
  // ── Phase E3: scope_proposal entries get the dedicated card ──
  if (entry.inputType === "scope_proposal") {
    const proposal = tryParseScopeProposal(entry.rawContent);
    if (proposal) {
      return (
        <div data-testid={`entry-row-${entry.id}`} data-entry-type="scope_proposal">
          <ScopeProposalCard
            proposal={proposal}
            isActive={scopeProposalActive}
            onApprove={() => onScopeProposalApprove?.(entry)}
            onReject={() => onScopeProposalReject?.(entry)}
            autoAdvanceAt={proposal.autoAdvanceAt}
            scoped={hasScopeDraft}
          />
        </div>
      );
    }
    // Fall through to system rendering if payload parse fails — the entry is
    // still useful as a system message.
  }

  // ── P1-T13: hop-cap decision card — system entry with sourceInfo.type === "hop_cap_reached" ──
  const hopCapPayload = extractHopCapPayload(entry);
  if (hopCapPayload) {
    return (
      <div data-testid={`entry-row-${entry.id}`} data-entry-type="hop_cap_decision">
        <HopCapDecisionCard hopCount={hopCapPayload.hopCount} cap={hopCapPayload.cap} />
      </div>
    );
  }

  // ── P2-T2: crew-failure card — system entry with sourceInfo.type === "crew_failed" ──
  const crewFailurePayload = extractCrewFailurePayload(entry);
  if (crewFailurePayload) {
    return (
      <div data-testid={`entry-row-${entry.id}`} data-entry-type="crew_failed">
        <CrewFailureCard
          payload={crewFailurePayload}
          onRetry={() => onCrewFailureRetry?.(crewFailurePayload.issueId)}
          onReassign={() => onCrewFailureReassign?.(crewFailurePayload.issueId)}
          onSkip={() => onCrewFailureSkip?.(crewFailurePayload.issueId)}
        />
      </div>
    );
  }

  // ── Phase E3: system entries — spin-off when payload present, else generic ──
  if (entry.inputType === "system") {
    const spinOff = extractSpinOffPayload(entry.sourceInfo);
    if (spinOff) {
      return (
        <div data-testid={`entry-row-${entry.id}`} data-entry-type="spinoff_suggestion">
          <SpinOffSuggestionCard
            suggestion={spinOff}
            onAccept={() => onSpinOffAccept?.(entry, spinOff)}
            onDismiss={() => onSpinOffDismiss?.(entry, spinOff)}
          />
        </div>
      );
    }
    return (
      <div data-testid={`entry-row-${entry.id}`} data-entry-type="system">
        <SystemEntryCard entry={entry} onRetry={onReprocess} />
      </div>
    );
  }

  // System notice → centered divider (legacy sourceInfo.systemNotice path)
  if ((entry.sourceInfo as Record<string, unknown> | null)?.systemNotice === true) {
    return (
      <div
        className="flex items-center gap-3 my-2 px-1"
        data-testid="entry-system-notice"
        data-entry-id={`entry-row-${entry.id}`}
      >
        <div className="flex-1 h-px bg-border/60" />
        <span
          className="text-[11px] text-muted-foreground/70 break-words text-center max-w-[70%] rounded-full px-3 py-0.5 shrink-0"
          style={{ background: "hsl(0 0% 14% / 0.6)" }}
        >
          {entry.rawContent}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 shrink-0">
          System notice
        </span>
        <div className="flex-1 h-px bg-border/60" />
      </div>
    );
  }

  const isAgent = !!entry.authorAgentId;
  const isMe = !isAgent && !!currentUserId && entry.createdBy === currentUserId;

  const approved = entry.extractedItems.filter((i) => i.status === "approved");
  const taskCount = approved.filter((i) => i.resultTaskId).length;
  const memCount = approved.filter((i) => i.resultMemoryId).length;
  const pendingCount = entry.extractedItems.filter(
    (i) => i.status === "pending" || i.status === "edited",
  ).length;

  // extractionError may be a plain string (legacy path) OR the CLI path's
  // structured { kind, message } object (extraction.ts). Surface the human
  // message from either shape so the failure chip's tooltip shows the actionable
  // CLI guidance (e.g. "run claude login") instead of a generic message (P2,
  // Codex). Extraction is CLI-only (Decision #104, amended 2026-06-27) — it never
  // reads a hosted key, so the failure chip no longer offers a "Settings" link.
  const rawExtractionError = (entry.sourceInfo as Record<string, unknown> | null)?.extractionError;
  const extractionError =
    typeof rawExtractionError === "string"
      ? rawExtractionError
      : rawExtractionError &&
          typeof rawExtractionError === "object" &&
          typeof (rawExtractionError as { message?: unknown }).message === "string"
        ? ((rawExtractionError as { message: string }).message)
        : null;

  if (isAgent) {
    return (
      <AgentCard
        entry={entry}
        taskCount={taskCount}
        memCount={memCount}
        pendingCount={pendingCount}
        extractionError={extractionError}
        onOpenArtifact={onOpenArtifact}
        onOpenRef={onOpenRef}
        canManageArtifacts={canManageArtifacts}
        onArchiveArtifact={onArchiveArtifact}
        onUnarchiveArtifact={onUnarchiveArtifact}
      />
    );
  }

  if (isMe) {
    return (
      <MeBubble
        entry={entry}
        taskCount={taskCount}
        memCount={memCount}
        pendingCount={pendingCount}
        extractionError={extractionError}
        onOpenArtifact={onOpenArtifact}
        onOpenRef={onOpenRef}
        canManageArtifacts={canManageArtifacts}
        onArchiveArtifact={onArchiveArtifact}
        onUnarchiveArtifact={onUnarchiveArtifact}
      />
    );
  }

  return (
    <HumanBubble
      entry={entry}
      taskCount={taskCount}
      memCount={memCount}
      pendingCount={pendingCount}
      extractionError={extractionError}
      onOpenArtifact={onOpenArtifact}
      onOpenRef={onOpenRef}
      canManageArtifacts={canManageArtifacts}
      onArchiveArtifact={onArchiveArtifact}
      onUnarchiveArtifact={onUnarchiveArtifact}
    />
  );
}

/* ── Me bubble (right-aligned) ── */

function MeBubble({
  entry,
  taskCount,
  memCount,
  pendingCount,
  extractionError,
  onOpenArtifact,
  onOpenRef,
  canManageArtifacts,
  onArchiveArtifact,
  onUnarchiveArtifact,
}: {
  entry: DiscussionEntry;
  taskCount: number;
  memCount: number;
  pendingCount: number;
  extractionError?: string | null;
  onOpenArtifact?: (attachment: DiscussionEntryAttachment) => void;
  onOpenRef?: (ref: ShowRef) => void;
  canManageArtifacts?: boolean;
  onArchiveArtifact?: (artifactId: string) => void | Promise<void>;
  onUnarchiveArtifact?: (artifactId: string) => void | Promise<void>;
}) {
  return (
    <div
      className="flex flex-col items-end gap-1"
      data-testid={`entry-row-${entry.id}`}
      data-entry-type="me"
    >
      <div className="flex items-center gap-1.5 pr-1">
        <span className="text-[11px] font-semibold text-muted-foreground">
          {toDisplayName(entry.createdBy)}
        </span>
        <span className="text-[11px] text-muted-foreground/50">
          {relativeTime(entry.createdAt)}
        </span>
      </div>
      <div className="flex items-end justify-end gap-2">
        <div className="flex flex-col items-end gap-1.5 max-w-[78%]">
          <div
            className="px-4 py-3 text-sm leading-relaxed break-words"
            style={{
              // Bubble has a self-contained dark background in BOTH themes, so its
              // text stays light (not text-foreground, which would be dark-on-dark
              // in light mode). DS-1 only flagged the AgentCard plain text below.
              color: "#eeeeee",
              background: "hsl(221 20% 27%)",
              border: "1px solid hsl(221 18% 34%)",
              borderRadius: "16px 16px 4px 16px",
            }}
          >
            {/* prose-invert forced: dark bubble in both themes. */}
            <MarkdownBody className="prose-sm prose-invert">
              {entry.rawContent}
            </MarkdownBody>
          </div>
          {entry.attachments && entry.attachments.length > 0 && (
            <div className="w-full">
              <InlineArtifactCard
                attachments={entry.attachments}
                onOpen={onOpenArtifact}
                canManage={canManageArtifacts}
                onArchiveArtifact={onArchiveArtifact}
                onUnarchiveArtifact={onUnarchiveArtifact}
              />
            </div>
          )}
          <ChipRow
            taskCount={taskCount}
            memCount={memCount}
            pendingCount={pendingCount}
            extractionStatus={entry.extractionStatus}
            extractionError={extractionError ?? null}
          />
          <DeliveredRefChips refs={entry.outputRefs} onOpenRef={onOpenRef} />
          <ReplyCountToggle count={entry.replyCount ?? 0} />
        </div>
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
          style={{ background: "hsl(221 22% 34%)" }}
          title={entry.createdBy ?? "Me"}
        >
          {toInitials(entry.createdBy, "Me")}
        </div>
      </div>
    </div>
  );
}

/* ── Human bubble (left-aligned) ── */

function HumanBubble({
  entry,
  taskCount,
  memCount,
  pendingCount,
  extractionError,
  onOpenArtifact,
  onOpenRef,
  canManageArtifacts,
  onArchiveArtifact,
  onUnarchiveArtifact,
}: {
  entry: DiscussionEntry;
  taskCount: number;
  memCount: number;
  pendingCount: number;
  extractionError: string | null;
  onOpenArtifact?: (attachment: DiscussionEntryAttachment) => void;
  onOpenRef?: (ref: ShowRef) => void;
  canManageArtifacts?: boolean;
  onArchiveArtifact?: (artifactId: string) => void | Promise<void>;
  onUnarchiveArtifact?: (artifactId: string) => void | Promise<void>;
}) {
  return (
    <div
      className="flex items-end gap-2"
      data-testid={`entry-row-${entry.id}`}
      data-entry-type="human"
    >
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
        style={{ background: "hsl(220 14% 28%)" }}
        title={toDisplayName(entry.createdBy)}
      >
        {toInitials(entry.createdBy, "?")}
      </div>
      <div className="flex flex-col gap-1 flex-1 min-w-0 max-w-[80%]">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {toDisplayName(entry.createdBy)}
          </span>
          <span className="text-[11px] text-muted-foreground/50">
            {relativeTime(entry.createdAt)}
          </span>
        </div>
        <div
          className="px-4 py-3 text-sm leading-relaxed break-words"
          style={{
            // Self-contained dark bubble background in both themes → keep light
            // text (text-foreground would be unreadable dark-on-dark in light mode).
            color: "#eeeeee",
            background: "hsl(220 12% 21%)",
            border: "1px solid hsl(220 10% 27%)",
            borderRadius: "16px 16px 16px 4px",
          }}
        >
          {/* prose-invert forced: dark bubble in both themes. */}
          <MarkdownBody className="prose-sm prose-invert">
            {entry.rawContent}
          </MarkdownBody>
        </div>
        {entry.attachments && entry.attachments.length > 0 && (
          <InlineArtifactCard
            attachments={entry.attachments}
            onOpen={onOpenArtifact}
            canManage={canManageArtifacts}
            onArchiveArtifact={onArchiveArtifact}
            onUnarchiveArtifact={onUnarchiveArtifact}
          />
        )}
        <ChipRow
          taskCount={taskCount}
          memCount={memCount}
          pendingCount={pendingCount}
          extractionStatus={entry.extractionStatus}
          extractionError={extractionError}
        />
        <DeliveredRefChips refs={entry.outputRefs} onOpenRef={onOpenRef} />
        <ReplyCountToggle count={entry.replyCount ?? 0} />
      </div>
    </div>
  );
}

/* ── Agent card (left-aligned, role-colored left border) ── */

function AgentCard({
  entry,
  taskCount,
  memCount,
  pendingCount,
  extractionError,
  onOpenArtifact,
  onOpenRef,
  canManageArtifacts,
  onArchiveArtifact,
  onUnarchiveArtifact,
}: {
  entry: DiscussionEntry;
  taskCount: number;
  memCount: number;
  pendingCount: number;
  extractionError: string | null;
  onOpenArtifact?: (attachment: DiscussionEntryAttachment) => void;
  onOpenRef?: (ref: ShowRef) => void;
  canManageArtifacts?: boolean;
  onArchiveArtifact?: (artifactId: string) => void | Promise<void>;
  onUnarchiveArtifact?: (artifactId: string) => void | Promise<void>;
}) {
  const color = agentRoleColor(entry.authorAgentName);
  const agentName = entry.authorAgentName ?? "Agent";
  const roleLabel = agentName.split(/\s+/)[0];

  return (
    <div
      className="flex items-start gap-2 max-w-[90%]"
      data-testid={`entry-row-${entry.id}`}
      data-entry-type="agent"
    >
      {/* Agent avatar (role-colored robot icon, or custom image) */}
      <div className="mt-0.5">
        <AgentAvatar name={agentName} avatarUrl={entry.authorAgentAvatar} />
      </div>

      {/* Card */}
      <div
        className="flex flex-col gap-2.5 px-3.5 py-3 flex-1 min-w-0"
        style={{
          background: "var(--card-2, #1d2128)",
          borderLeft: `3px solid ${color}`,
          borderRadius: "4px 14px 14px 14px",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 flex-wrap agent-attribution"
          data-testid="entry-agent-attribution"
        >
          <span className="text-sm font-semibold text-foreground">
            {agentName}
          </span>
          <span
            className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide shrink-0"
            data-testid="entry-author-badge-agent"
            style={{ color, background: `${color}25` }}
          >
            {roleLabel}
          </span>
          <span className="text-[11px] text-muted-foreground/50 ml-auto">
            {relativeTime(entry.createdAt)}
          </span>
        </div>

        {/* Body — theme-driven (no forced invert; agent card follows global theme) */}
        <MarkdownBody className="prose-sm text-foreground">
          {entry.rawContent}
        </MarkdownBody>

        {/* Phase E2: inline attachments */}
        {entry.attachments && entry.attachments.length > 0 && (
          <InlineArtifactCard
            attachments={entry.attachments}
            onOpen={onOpenArtifact}
            canManage={canManageArtifacts}
            onArchiveArtifact={onArchiveArtifact}
            onUnarchiveArtifact={onUnarchiveArtifact}
          />
        )}

        {/* Chips */}
        <ChipRow
          taskCount={taskCount}
          memCount={memCount}
          pendingCount={pendingCount}
          extractionStatus={entry.extractionStatus}
          extractionError={extractionError}
        />

        {/* Phase 7B: delivered navigational-ref chips (crew run-result entries) */}
        <DeliveredRefChips refs={entry.outputRefs} onOpenRef={onOpenRef} />

        {/* Reply count */}
        <ReplyCountToggle count={entry.replyCount ?? 0} />
      </div>
    </div>
  );
}
