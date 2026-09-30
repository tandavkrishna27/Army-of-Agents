/**
 * crew-task-service.ts — Tasks 2.2+2.3 (Crew Work-as-Tasks)
 *
 * The single autonomy-gated chokepoint for creating crew work (Decision D11).
 *
 * Every piece of crew work flows through `proposeWork`. The unified model means
 * L2/Drive doesn't get a separate code path — it writes the same inline scope
 * card and then auto-approves it through the EXISTING approveProposal handler
 * (which is already idempotent, stamps provenance, writes plan steps, and gives
 * the audit trail).
 *
 * Key invariants (Codex #14, #16, #19):
 *   - Codex #14: companyId validation lives inside writeScopeProposal — we rely on
 *     it throwing COMPANY_MISMATCH if the thread doesn't belong to this company.
 *   - Codex #16: Budget gates DISPATCH (heartbeat wakeup + approval), never the
 *     card write. The human-approvable card is ALWAYS written first regardless of
 *     budget state so the founder can manually approve if needed.
 *   - Codex #19: activity_log entries written for proposal creation and for
 *     auto-approval so there is a full audit trail.
 *
 * Auto-approval uses the real `threadDeliverablesService.approveProposal` path,
 * which is:
 *   1. Atomic claim-first (pending → approved UPDATE ... RETURNING)
 *   2. createDeliverableTasks (stamps originKind='crew_thread')
 *   3. Returns taskIds + createdTasks with assigneeAgentId per task
 *
 * Dispatch: routed once per created task through the kind-aware chokepoint
 * (enqueueIssueAssigneeWakeup) so crew (AoA) assignees reach the AoA dispatcher
 * and org assignees reach heartbeat. Null/planning-mode assignees are skipped.
 */

import { and, eq, ne, gt, isNull, desc } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { discussionEntries } from "@armyofagents/db";
import { writeScopeProposal } from "./scope-proposal-writer.js";
import { preflightCrewDispatch } from "./crew-budget.js";
import { threadDeliverablesService } from "./thread-deliverables.js";
import { logActivity } from "./activity-log.js";
import { enqueueIssueAssigneeWakeup } from "./issue-assignee-wakeup.js";
import { shouldDispatchIssueWakeup } from "../routes/issues-planning-mode-dispatch.js";

// ─── Pure gate ────────────────────────────────────────────────────────────────

/**
 * Resolve the creation gate based on the caller's autonomy level.
 *
 * - autonomy >= 2 → "auto_approve" (L2/Drive: write card AND immediately approve)
 * - anything else (0, 1, null, undefined) → "await_human" (fail closed)
 *
 * This is a pure function — no I/O, trivially testable.
 */
export function resolveCreationGate(
  autonomy: number | null | undefined,
): "auto_approve" | "await_human" {
  return typeof autonomy === "number" && autonomy >= 2 ? "auto_approve" : "await_human";
}

/**
 * 3-way autonomy gate for controller scope-draft auto-accept (W1b).
 * - >= 2 (Drive)  → "accept_apply_dispatch": create+assign tasks AND dispatch
 * - == 1 (Assist) → "accept_apply": create+assign tasks (board populates), NO dispatch
 * - else (Manual/null) → "draft_only": leave the draft for the founder
 * Pure — no I/O. Separate from resolveCreationGate so Path A's binary contract is untouched.
 */
export function resolveScopeAutoAcceptGate(
  autonomy: number | null | undefined,
): "draft_only" | "accept_apply" | "accept_apply_dispatch" {
  if (typeof autonomy !== "number") return "draft_only";
  if (autonomy >= 2) return "accept_apply_dispatch";
  if (autonomy === 1) return "accept_apply";
  return "draft_only";
}

// ─── Dispatch helper ────────────────────────────────────────────────────────────

/**
 * Dispatch wakeups for crew tasks created by an auto-approved proposal.
 *
 * Routes EACH task through the kind-aware chokepoint (`enqueueIssueAssigneeWakeup`)
 * so crew (AoA) assignees are dispatched via the AoA dispatcher and org assignees
 * via heartbeat — instead of the old per-distinct-assignee raw `heartbeat.wakeup`
 * which silently dropped crew assignees.
 *
 * One wakeup is enqueued PER task (each carries its own issueId). Tasks with a
 * null assignee or in planning mode are skipped.
 */
export async function dispatchCreatedCrewTasks(
  db: Db,
  companyId: string,
  createdTasks: Array<{ id: string; assigneeAgentId: string | null; workMode: string | null }>,
): Promise<void> {
  for (const t of createdTasks) {
    if (!t.assigneeAgentId) continue;
    if (!shouldDispatchIssueWakeup({ workMode: t.workMode })) continue;
    await enqueueIssueAssigneeWakeup(db, {
      companyId, agentId: t.assigneeAgentId, issueId: t.id,
      source: "automation", reason: "crew_task_auto_approved",
    });
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApproveAndDispatchArgs {
  threadId: string;
  companyId: string;
  proposalEntryId: string;
  /** Synthetic approver id — use a real userId when available, else a system sentinel. */
  approverUserId: string;
  /** For activity_log: actor type. */
  actorType: "agent" | "user" | "system";
  /** For activity_log: actor id (userId or agentId). */
  actorId: string;
  /** For activity_log: optional agentId when actor is an agent. */
  agentId?: string | null;
  /** Autonomy level (used only in activity_log details). */
  autonomy?: number | null;
}

export interface ApproveAndDispatchResult {
  /** true when the proposal was freshly approved and tasks were dispatched. */
  approved: boolean;
  /** Ids of the issues created by the approval. Empty when approved=false. */
  createdIssueIds: string[];
  /**
   * reasonCode from preflightCrewDispatch when budget blocked dispatch.
   * The card stays pending for human approval.
   */
  blockedReason?: string;
}

export interface ProposeWorkArgs {
  threadId: string;
  companyId: string;
  /** Caller's autonomy level. 0/1/null/undefined → await_human; ≥2 → auto_approve. */
  autonomy: number | null;
  summary: string;
  proposedTasks: Array<{ title: string; assigneeRole?: string; [k: string]: unknown }>;
  /** Who is making the proposal — at least one of userId/agentId should be set. */
  createdBy: { userId?: string | null; agentId?: string | null };
}

export interface ProposeWorkResult {
  /** The discussion_entries row id of the scope_proposal card. */
  proposalId: string;
  /** true when gate was auto_approve and the proposal was approved + tasks created. */
  autoApproved: boolean;
  /** true when a pending proposal already existed (idempotency path — no new work). */
  existing: boolean;
  /** Task ids created from the proposal, only present when autoApproved=true. */
  createdIssueIds?: string[];
  /**
   * reasonCode from preflightCrewDispatch when budget blocked dispatch.
   * The card was written but the proposal stays pending for human approval.
   */
  blockedReason?: string;
}

// ─── Service factory ──────────────────────────────────────────────────────────

export function crewTaskService(db: Db) {
  const deliverables = threadDeliverablesService(db);

  return {
    /**
     * Shared approve-and-dispatch helper (D11 / Task 2.6 extraction).
     *
     * Called by:
     *   - proposeWork (step 4b-4c, auto_approve path at L2)
     *   - advancePhase in threads.ts (phase-advance auto-approve at L2)
     *
     * Steps:
     *   1. preflightCrewDispatch (budget gate — if not allowed, card stays pending).
     *   2. deliverables.approveProposal (claim-first atomic, createDeliverableTasks).
     *   3. activity_log for auto-approval.
     *   4. dispatchCreatedCrewTasks — once per task, kind-aware chokepoint.
     *
     * Returns:
     *   - approved=true + createdIssueIds when tasks were created and dispatched.
     *   - approved=false + blockedReason when budget blocked dispatch.
     *   - approved=false (no blockedReason) when the approval handler returned
     *     a non-ok or alreadyApproved result (idempotent race).
     */
    async approveAndDispatch(args: ApproveAndDispatchArgs): Promise<ApproveAndDispatchResult> {
      const { threadId, companyId, proposalEntryId, approverUserId, actorType, actorId, agentId, autonomy } = args;

      // Step 1: Budget pre-flight (gates dispatch, not card)
      const preflight = await preflightCrewDispatch(db, {
        companyId,
        agentId: actorId,
        threadId,
      });

      if (!preflight.allowed) {
        // Card stays pending for human approval. Surface the reason.
        return {
          approved: false,
          createdIssueIds: [],
          blockedReason: preflight.reasonCode,
        };
      }

      // Step 2: Approve via the existing approval handler.
      // approveProposal does: claim pending→approved (atomic), then
      // createDeliverableTasks (stamps originKind='crew_thread').
      const approvalResult = await deliverables.approveProposal({
        threadId,
        companyId,
        proposalEntryId,
        approver: { userId: approverUserId },
      });

      if (!approvalResult.ok) {
        // Unexpected failure (stale, rejected, etc.) — do NOT dispatch.
        return { approved: false, createdIssueIds: [] };
      }

      if (approvalResult.alreadyApproved) {
        // Race: someone else already approved this proposal.
        return { approved: false, createdIssueIds: [] };
      }

      const taskIds = approvalResult.taskIds;
      const createdTasks = approvalResult.createdTasks;

      // Step 3: Codex #19: activity log for auto-approval
      await logActivity(db, {
        companyId,
        actorType,
        actorId,
        action: "crew.proposal.auto_approved",
        entityType: "discussion_entry",
        entityId: proposalEntryId,
        agentId,
        details: {
          threadId,
          taskIds,
          autonomy,
        },
      });

      // Step 4: Dispatch — once per task, through the kind-aware chokepoint.
      // Null/planning-mode assignees are skipped inside the helper.
      await dispatchCreatedCrewTasks(db, companyId, createdTasks);

      return {
        approved: true,
        createdIssueIds: taskIds,
      };
    },

    /**
     * The unified proposal chokepoint (D11).
     *
     * Steps:
     *   1. ALWAYS write the scope card via writeScopeProposal (idempotent).
     *      Write activity_log for the proposal creation.
     *      If existing:true → return immediately (no duplicate work).
     *   2. Compute gate = resolveCreationGate(autonomy).
     *   3. await_human → return (human approves the card later).
     *   4. auto_approve: delegate to approveAndDispatch.
     */
    async proposeWork(args: ProposeWorkArgs): Promise<ProposeWorkResult> {
      const { threadId, companyId, autonomy, summary, proposedTasks, createdBy } = args;

      const agentId = createdBy.agentId ?? null;
      const actorId = agentId ?? createdBy.userId ?? "system";
      const actorType: "agent" | "user" | "system" = agentId
        ? "agent"
        : createdBy.userId
          ? "user"
          : "system";

      // ── Pre-check: stale duplicate guard (defense-in-depth, post-approval) ───
      // If the most-recent scope_proposal for this thread is ALREADY APPROVED
      // and NO new human entry has been posted since it, this call is a stale
      // re-fire from a duplicate Adjutant/Planner run. Returning early avoids
      // writing a second pending proposal that would immediately auto-approve
      // again and duplicate tasks.
      //
      // "Human entry" discriminator: mirrors sweep-adjutant.ts isHumanEntry
      //   - authorAgentId IS NULL           (not agent-posted)
      //   - inputType NOT IN ('agent', 'system', 'scope_proposal')
      //
      // Ordering: seq is a per-thread monotonic counter (Plan 7). We use
      // seq > latestProposal.seq as the "newer than" check to stay consistent
      // with the sweep's approach (avoids clock-skew risk with createdAt).
      const [latestProposal] = await db
        .select({
          entryId: discussionEntries.id,
          seq: discussionEntries.seq,
          proposalStatus: discussionEntries.proposalStatus,
        })
        .from(discussionEntries)
        .where(
          and(
            eq(discussionEntries.discussionId, threadId),
            eq(discussionEntries.inputType, "scope_proposal"),
          ),
        )
        .orderBy(desc(discussionEntries.seq))
        .limit(1);

      if (latestProposal && latestProposal.proposalStatus === "approved") {
        // Check for any human entry newer than the approved proposal
        const [newerHumanEntry] = await db
          .select({ id: discussionEntries.id })
          .from(discussionEntries)
          .where(
            and(
              eq(discussionEntries.discussionId, threadId),
              isNull(discussionEntries.authorAgentId),
              ne(discussionEntries.inputType, "agent"),
              ne(discussionEntries.inputType, "system"),
              ne(discussionEntries.inputType, "scope_proposal"),
              gt(discussionEntries.seq, latestProposal.seq),
            ),
          )
          .limit(1);

        if (!newerHumanEntry) {
          // Stale duplicate: no new human input since the approved proposal.
          // Return the existing approved proposal id as the anchor, no work done.
          console.info(
            `[crew-task-service] proposeWork: stale duplicate suppressed ` +
              `(threadId=${threadId}, latestApprovedEntry=${latestProposal.entryId}, seq=${latestProposal.seq})`,
          );
          return {
            proposalId: latestProposal.entryId,
            autoApproved: false,
            existing: true,
          };
        }
      }

      // ── Step 1: ALWAYS write the scope card ─────────────────────────────────
      // Codex #16: budget never blocks the card write. The human must always be
      // able to see and manually approve a pending proposal even when budget is
      // exhausted or autonomy is low.
      const writeResult = await writeScopeProposal(db, {
        threadId,
        companyId,
        proposal: { summary, proposedTasks },
        agentId,
      });

      const proposalId = writeResult.entryId;

      // Codex #19: activity log for proposal creation
      await logActivity(db, {
        companyId,
        actorType,
        actorId,
        action: "crew.proposal.created",
        entityType: "discussion_entry",
        entityId: proposalId,
        agentId,
        details: {
          threadId,
          summary,
          taskCount: proposedTasks.length,
          existing: writeResult.existing,
        },
      });

      // ── Idempotency: a pending proposal already existed ──────────────────────
      if (writeResult.existing) {
        return { proposalId, autoApproved: false, existing: true };
      }

      // ── Step 2: Resolve gate ─────────────────────────────────────────────────
      const gate = resolveCreationGate(autonomy);

      if (gate === "await_human") {
        // Human will approve the inline card later. Nothing else to do.
        return { proposalId, autoApproved: false, existing: false };
      }

      // ── Step 4: auto_approve path ── delegate to shared helper ───────────────
      // We provide a synthetic approver userId; using the actorId from createdBy
      // when it's a user, or a system-sentinel when agent-only.
      const approverUserId = createdBy.userId ?? `system:agent:${actorId}`;

      const dispatchResult = await this.approveAndDispatch({
        threadId,
        companyId,
        proposalEntryId: proposalId,
        approverUserId,
        actorType,
        actorId,
        agentId,
        autonomy,
      });

      if (dispatchResult.blockedReason) {
        return {
          proposalId,
          autoApproved: false,
          existing: false,
          blockedReason: dispatchResult.blockedReason,
        };
      }

      if (!dispatchResult.approved) {
        // alreadyApproved race or unexpected validation failure — card remains pending.
        return { proposalId, autoApproved: false, existing: false };
      }

      return {
        proposalId,
        autoApproved: true,
        existing: false,
        createdIssueIds: dispatchResult.createdIssueIds,
      };
    },
  };
}
