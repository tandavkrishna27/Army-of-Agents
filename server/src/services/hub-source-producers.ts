import type { Db } from "@armyofagents/db";
import { hubItemsService, type EmitArgs } from "./hub-items.js";

type ApprovalLike = {
  id: string;
  companyId: string;
  type: string;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  payload: Record<string, unknown>;
  updatedAt: SourceUpdatedAt;
};

type SourceUpdatedAt = Date | string;

type JoinRequestLike = {
  id: string;
  companyId: string;
  requestType: string;
  agentName: string | null;
  requestEmailSnapshot: string | null;
  adapterType: string | null;
  updatedAt: SourceUpdatedAt;
};

type DiscussionLike = {
  id: string;
  companyId: string;
  title: string | null;
  ownerUserId: string | null;
  scopeType: string | null;
  scopeId: string | null;
  lastPendingActorType?: "user" | "agent" | null;
  lastPendingActorId?: string | null;
  pendingItemCount: number;
  updatedAt: SourceUpdatedAt;
};

type MemoryReviewLike = {
  companyId: string;
  count: number;
  ownerUserId: string | null;
};

type SuggestionLike = {
  id: string;
  companyId: string;
  title: string;
  evidence: string | null;
  updatedAt: SourceUpdatedAt;
};

type IssueLike = {
  id: string;
  companyId: string;
  title: string;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  updatedAt: SourceUpdatedAt;
};

type FailedRunLike = {
  id: string;
  companyId: string;
  agentId: string;
  agentName?: string | null;
  status: string;
  error?: string | null;
  updatedAt: SourceUpdatedAt;
};

type BudgetAlertLike = {
  companyId: string;
  monthSpendCents: number;
  monthBudgetCents: number;
  monthUtilizationPercent: number;
  updatedAt: SourceUpdatedAt;
};

// CLI extraction failure kinds classified by extraction-cli.ts. Mirror of the
// UI's CliExtractionErrorKind (DiscussionDetail.tsx) — kept here so the hub
// summary carries the SAME actionable guidance the founder sees in-thread.
type ExtractionFailureKind =
  | "not_installed"
  | "not_authed"
  | "timeout"
  | "nonzero_exit"
  | "unparseable";

type ExtractionFailedLike = {
  entryId: string;
  discussionId: string;
  companyId: string;
  discussionTitle: string | null;
  ownerUserId: string | null;
  failureKind: ExtractionFailureKind | string | null;
  failureMessage: string | null;
  updatedAt: SourceUpdatedAt;
};

type RoutineFailedLike = {
  runId: string;
  routineId: string;
  companyId: string;
  routineName: string;
  failureReason: string | null;
  createdByUserId: string | null;
  updatedAt: SourceUpdatedAt;
};

function spaced(value: string) {
  return value.replace(/_/g, " ");
}

function scopeKeyFor(source: { scopeType: string | null; scopeId: string | null }) {
  return source.scopeType && source.scopeId ? source.scopeId : null;
}

function sourceRevision(value: SourceUpdatedAt) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function approvalSummary(approval: ApprovalLike) {
  const agentName =
    typeof approval.payload.name === "string"
      ? approval.payload.name
      : typeof approval.payload.agentName === "string"
        ? approval.payload.agentName
        : null;
  return agentName ? `Agent: ${agentName}` : `Approval type: ${spaced(approval.type)}`;
}

export function buildApprovalHubEmit(approval: ApprovalLike): EmitArgs {
  const actor =
    approval.requestedByAgentId != null
      ? ({ sourceActorType: "agent", sourceActorId: approval.requestedByAgentId } as const)
      : approval.requestedByUserId != null
        ? ({ sourceActorType: "user", sourceActorId: approval.requestedByUserId } as const)
        : {};

  return {
    companyId: approval.companyId,
    semanticType: "approval_request",
    sourceType: "approval",
    sourceId: approval.id,
    title: `Review ${spaced(approval.type)} approval`,
    summary: approvalSummary(approval),
    ownerPool: "board",
    ...actor,
    sourcePermissionRevision: sourceRevision(approval.updatedAt),
  };
}

export function buildJoinRequestHubEmit(request: JoinRequestLike): EmitArgs {
  const subject =
    request.requestType === "agent"
      ? request.agentName ?? `${request.adapterType ?? "Agent"} request`
      : request.requestEmailSnapshot ?? "Human join request";

  return {
    companyId: request.companyId,
    semanticType: "join_request",
    sourceType: "join_request",
    sourceId: request.id,
    title: `Review ${subject}`,
    summary: `${spaced(request.requestType)} join request`,
    ownerPool: "board",
    sourcePermissionRevision: sourceRevision(request.updatedAt),
  };
}

export function buildDiscussionPendingHubEmit(discussion: DiscussionLike): EmitArgs {
  const count = discussion.pendingItemCount;
  const title = discussion.title?.trim() || "Discussion";
  const actor =
    discussion.lastPendingActorType && discussion.lastPendingActorId
      ? {
          sourceActorType: discussion.lastPendingActorType,
          sourceActorId: discussion.lastPendingActorId,
        }
      : {};

  return {
    companyId: discussion.companyId,
    semanticType: "discussion_pending",
    sourceType: "discussion",
    sourceId: discussion.id,
    title: `Review ${count} pending ${count === 1 ? "item" : "items"} in ${title}`,
    summary: `${count} extracted ${count === 1 ? "item needs" : "items need"} review.`,
    ownerUserId: discussion.ownerUserId,
    scopeKey: scopeKeyFor(discussion),
    ...actor,
    sourcePermissionRevision: sourceRevision(discussion.updatedAt),
  };
}

// memory_review (Mem T4): ONE hub row per COMPANY — sourceType "memory",
// sourceId = the companyId, count = total founder-gated pending memory across
// ALL scopes. The Inbox shows a single "Review N memory items" signpost; the
// per-scope breakdown lives in Memory → Pending Review. `hub_items_source_unique_idx`
// (companyId+sourceType+sourceId+semanticType+scopeKey) dedupes to one row, so
// every write path re-emits the SAME key and only refreshes the count. The count
// MUST be computed with the same founder-gated-pending predicate the reconciler
// uses (see reconcileMemoryReview in hub-items.ts) so emit and reconcile agree.
export function buildMemoryReviewHubEmit(m: MemoryReviewLike): EmitArgs {
  const count = m.count;
  return {
    companyId: m.companyId,
    semanticType: "memory_review",
    sourceType: "memory",
    sourceId: m.companyId,
    title: `Review ${count} memory ${count === 1 ? "item" : "items"}`,
    summary: `${count} memory ${count === 1 ? "item is" : "items are"} ready for your approval.`,
    ownerUserId: m.ownerUserId,
    // Fix 2 (storm-guard correctness): the aggregate signpost has NO single
    // source row, so it carries a null revision — matching reconcileMemoryReview
    // (permissionRevision: null). A fresh `new Date()` would make the storm
    // guard's `sourcePermissionRevision IS DISTINCT FROM` check always-true
    // (every re-emit rewrites the row) AND disagree with the reconciler.
    sourcePermissionRevision: null,
    // Fix 1: the memory_review row is ONE row per company that the founder clears
    // to `archived` when they approve the last pending item. The next agent write
    // must be able to REOPEN that archived row so the signpost reappears — the
    // clear→refill cycle is normal for memory. This opt-in flag is set ONLY here;
    // all mirror/source types keep the non-reopen (never-resurrect) behavior.
    reopenWhenArchived: true,
  };
}

export function buildSuggestionHubEmit(suggestion: SuggestionLike): EmitArgs {
  return {
    companyId: suggestion.companyId,
    semanticType: "suggestion",
    sourceType: "suggestion",
    sourceId: suggestion.id,
    title: suggestion.title,
    summary: suggestion.evidence,
    sourcePermissionRevision: sourceRevision(suggestion.updatedAt),
  };
}

export function buildStaleIssueHubEmit(issue: IssueLike): EmitArgs {
  return {
    companyId: issue.companyId,
    semanticType: "stale_work",
    sourceType: "issue",
    sourceId: issue.id,
    title: `Stale task: ${issue.title}`,
    summary: "No recent human or crew progress.",
    ownerUserId: issue.assigneeUserId,
    ownerPool: issue.assigneeUserId ? undefined : "board",
    sourceActorType: issue.assigneeAgentId ? "agent" : undefined,
    sourceActorId: issue.assigneeAgentId ?? undefined,
    sourcePermissionRevision: sourceRevision(issue.updatedAt),
  };
}

export function buildFailedRunHubEmit(run: FailedRunLike): EmitArgs {
  const agentName = run.agentName?.trim() || "Agent";
  return {
    companyId: run.companyId,
    semanticType: "run_failed",
    sourceType: "heartbeat_run",
    sourceId: run.id,
    title: `${agentName} run ${run.status.replace(/_/g, " ")}`,
    summary: run.error ?? `Latest run status: ${run.status}`,
    sourceActorType: "agent",
    sourceActorId: run.agentId,
    // The run viewer tab is keyed on runTab(runId=sourceId, agentId). Persist the
    // owning agentId as the related entity so hubTabForItem can build that tab;
    // relatedEntity is NOT part of sourceUniqueKey, so this never re-keys the row.
    relatedEntityType: "agent",
    relatedEntityId: run.agentId,
    priority: "high",
    sourcePermissionRevision: sourceRevision(run.updatedAt),
  };
}

export function buildCompletedRunHubEmit(run: FailedRunLike): EmitArgs {
  const agentName = run.agentName?.trim() || "Agent";
  return {
    companyId: run.companyId,
    semanticType: "run_complete",
    sourceType: "heartbeat_run",
    sourceId: run.id,
    title: `${agentName} run complete`,
    summary: "Run finished successfully",
    sourceActorType: "agent",
    sourceActorId: run.agentId,
    // See buildFailedRunHubEmit: the run tab needs the agentId via relatedEntity.
    relatedEntityType: "agent",
    relatedEntityId: run.agentId,
    priority: "normal",
    sourcePermissionRevision: sourceRevision(run.updatedAt),
  };
}

const TERMINAL_FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "timed_out"]);

// Maps a terminal heartbeat run to its attention-worthy hub emit. Successful
// process exits stay in run history; any resulting question, review, or task
// transition has its own durable surface. Cancelled/queued/running also emit
// nothing. MUST route failures
// through buildFailedRunHubEmit so the event emit and the legacy sidebar-badges
// scan produce byte-identical rows for the same run (change-aware emit no-ops).
export function buildTerminalRunHubEmit(run: FailedRunLike): EmitArgs | null {
  if (TERMINAL_FAILED_STATUSES.has(run.status)) return buildFailedRunHubEmit(run);
  return null;
}

// Shared budget-alert summary formatter (H3). BOTH the producer above and the
// company_budget reconciler (hub-items.ts) format the summary through this ONE
// function so the change-aware upsert and the reconcile heal path produce
// byte-identical strings for the same spend/budget — that byte-identity is what
// keeps them from ping-ponging (a self-inflicted feedback storm) as each side
// re-emits. Recomputes the percentage from cents so callers never have to pass a
// pre-rounded utilization: `pct.toFixed(2)` matches the producer's historical
// `Number(((spend/budget)*100).toFixed(2)).toFixed(2)` (double-rounding a value
// already at 2dp is idempotent). Zero/negative budget → 0.00% (never divide by 0).
export function formatBudgetAlertSummary(spendCents: number, budgetCents: number): string {
  const pct = budgetCents > 0 ? (spendCents / budgetCents) * 100 : 0;
  return `${pct.toFixed(2)}% used (${spendCents}/${budgetCents} cents)`;
}

export function buildBudgetAlertHubEmit(alert: BudgetAlertLike): EmitArgs {
  return {
    companyId: alert.companyId,
    semanticType: "budget_alert",
    sourceType: "company_budget",
    sourceId: alert.companyId,
    title: "Budget approaching limit",
    summary: formatBudgetAlertSummary(alert.monthSpendCents, alert.monthBudgetCents),
    ownerPool: "board",
    priority: alert.monthUtilizationPercent >= 100 ? "urgent" : "high",
    sourcePermissionRevision: sourceRevision(alert.updatedAt),
  };
}

// Classified extraction-failure guidance for the hub summary. Mirrors the
// in-thread copy in ui/src/pages/DiscussionDetail.tsx `extractionFailureMessage`
// so the inbox signal and the DiscussionDetail affordance say the same thing.
// Extraction is CLI-only (Decision #104, amended 2026-06-27): the guidance NEVER
// points at a hosted key / Settings — the CLI kinds carry the actionable copy.
export function formatExtractionFailureGuidance(
  kind: ExtractionFailureKind | string | null,
  message: string | null,
): string {
  switch (kind) {
    case "not_installed":
      // Prefer the server's CLI-specific message (e.g. "codex CLI not found")
      // so codex-configured companies aren't told to fix Claude.
      return message ?? "Extraction CLI not detected. Install your configured CLI and sign in.";
    case "not_authed":
      return message ?? "Extraction CLI is not logged in. Run its login flow.";
    case "timeout":
      return "Extraction timed out. Try Reprocess.";
    case "nonzero_exit":
    case "unparseable":
      return `Extraction failed — try Reprocess.${message ? ` ${message}` : ""}`;
    default:
      // Legacy/unknown kind — surface the raw message with no Settings escape.
      return message ?? "Extraction failed.";
  }
}

// extraction_failed (Task 10, D3): sourceType "discussion_entry" (NOT
// "discussion") so this never collides with the discussion_pending reconciler,
// and sourceId = the raw entry id. relatedEntity = the discussion so
// hubTabForItem resolves the thread tab (DiscussionDetail carries the reprocess
// affordance). Owner = the discussion owner; priority high (a silently stalled
// funnel is a first-week trust killer).
export function buildExtractionFailedHubEmit(entry: ExtractionFailedLike): EmitArgs {
  const title = entry.discussionTitle?.trim() || "Discussion";
  return {
    companyId: entry.companyId,
    semanticType: "extraction_failed",
    sourceType: "discussion_entry",
    sourceId: entry.entryId,
    title: `Extraction failed in ${title}`,
    summary: formatExtractionFailureGuidance(entry.failureKind, entry.failureMessage),
    ownerUserId: entry.ownerUserId,
    relatedEntityType: "discussion",
    relatedEntityId: entry.discussionId,
    priority: "high",
    sourcePermissionRevision: sourceRevision(entry.updatedAt),
  };
}

// routine_outcome (Task 10, D3): FAILURE-ONLY. Routine SUCCESS is already
// visible (execution issue → agent run → run_complete + the Routines page), so a
// success emit would be pure spam. The uncovered signal is SILENT automation
// failure (tick crashed before an issue, or the execution issue got
// blocked/cancelled). sourceType "routine_run"; relatedEntity = the routine so
// the /routines fullLink resolves; owner = the routine creator else the board
// pool; priority high.
export function buildRoutineFailedHubEmit(run: RoutineFailedLike): EmitArgs {
  const name = run.routineName?.trim() || "Routine";
  return {
    companyId: run.companyId,
    semanticType: "routine_outcome",
    sourceType: "routine_run",
    sourceId: run.runId,
    title: `Routine failed: ${name}`,
    summary: run.failureReason ?? "Routine run failed.",
    ownerUserId: run.createdByUserId ?? undefined,
    ownerPool: run.createdByUserId ? undefined : "board",
    relatedEntityType: "routine",
    relatedEntityId: run.routineId,
    priority: "high",
    sourcePermissionRevision: sourceRevision(run.updatedAt),
  };
}

export async function emitHubItem(db: Db, args: EmitArgs) {
  return hubItemsService(db).emit(args);
}
