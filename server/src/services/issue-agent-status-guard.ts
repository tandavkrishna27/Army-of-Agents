import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { issueApprovals as issueApprovalsTable, approvals as approvalsTable } from "@armyofagents/db";
import { unprocessable } from "../errors.js";

// Approval statuses that count as an active review path.
// Extend this set if AoA adds revision_requested or other in-flight states.
const ACTIVE_REVIEW_APPROVAL_STATUSES = new Set(["pending"]);

/**
 * Guard: reject agent-initiated transitions to `in_review` unless a human
 * review path exists.  Ports the severable middleware slice from Paperclip
 * commit 68f69975.  AoA-adapted: dropped executionState/monitor predicates
 * (those columns don't exist in AoA).
 *
 * Allowed paths to in_review (any one is sufficient):
 *   1. assigneeUserId is set in the update (human hand-off)
 *   2. A linked approval with status in ACTIVE_REVIEW_APPROVAL_STATUSES exists
 *
 * The guard is only triggered when ALL of these hold:
 *   - actorType === 'agent'
 *   - existing.status !== 'in_review'  (already there → no re-check)
 *   - next status resolves to 'in_review'
 *
 * Exported so it can be tested in isolation.
 */
export async function assertAgentInReviewReviewPath(
  input: {
    existing: { id: string; status: string };
    updateFields: { status?: string; assigneeUserId?: string | null; [key: string]: unknown };
    actorType: "agent" | "board" | "user" | "system";
  },
  db: Db,
): Promise<void> {
  // Only applies to agent actors
  if (input.actorType !== "agent") return;

  // Guard doesn't fire if the issue is already in_review
  if (input.existing.status === "in_review") return;

  // Determine the status this update would result in
  const nextStatus =
    typeof input.updateFields.status === "string"
      ? input.updateFields.status
      : input.existing.status;

  // Guard only fires on transitions TO in_review
  if (nextStatus !== "in_review") return;

  // Allow: update sets a non-null human assignee
  if (input.updateFields.assigneeUserId) return;

  // Allow: there is at least one linked approval in an active review state.
  // NOTE: issue_approvals has NO status column — join to approvals to read status.
  const linkedApprovals = await db
    .select({ status: approvalsTable.status })
    .from(issueApprovalsTable)
    .innerJoin(
      approvalsTable,
      eq(issueApprovalsTable.approvalId, approvalsTable.id),
    )
    .where(eq(issueApprovalsTable.issueId, input.existing.id));

  if (linkedApprovals.some((a) => ACTIVE_REVIEW_APPROVAL_STATUSES.has(String(a.status)))) return;

  // No review path found — reject with 422
  throw unprocessable("Agent cannot move task to in_review without a review path", {
    code: "invalid_issue_disposition",
    validReviewPaths: ["linked_pending_approval", "human_assignee_user_id"],
  });
}

/**
 * Service-level guard: ensures crew agents calling `issueService.update`
 * directly (via agent tools) cannot bypass the route-only review-path guard,
 * and enforces the autonomy dial on completion-ish transitions.
 *
 * Dial semantics:
 *   - in_review requires effectiveDial >= 1 (Assist)
 *   - done      requires effectiveDial >= 2 (Drive)
 *
 * Non-agent actors (board/user/system — the latter is also the default the
 * service injects for Commander's update_task path) are unaffected by the
 * early return below; no dead `isCommander` branch is needed.
 *
 * The dial is resolved by the CALLER (e.g. the set_task_status tool) from
 * `ctx.effectiveAutonomy` and forwarded here as `actor.effectiveDial`. This
 * guard never reads internalAgentConfig.
 */
export async function assertAgentStatusTransition(
  input: {
    existing: {
      id: string;
      status: string;
      assigneeAgentId: string | null;
      agentCompletionPolicy: string;
      acceptanceCriteria: string[];
    };
    updateFields: { status?: string; assigneeUserId?: string | null; [k: string]: unknown };
    actor: { actorType: "agent" | "board" | "user" | "system"; agentId?: string | null; effectiveDial?: number };
  },
  _db: Db,
): Promise<void> {
  if (input.actor.actorType !== "agent") return;            // humans/system/Commander(system-default) unaffected
  const next = typeof input.updateFields.status === "string" ? input.updateFields.status : input.existing.status;
  if (next === input.existing.status) return;                // no status transition → nothing to gate
  const me = input.actor.agentId ?? null;
  // Ownership applies to EVERY agent-initiated status transition, not just
  // completion (review #2 — HIGH). The old `in_review`/`done`-only gate let a
  // crew agent move ANOTHER agent's task to cancelled/backlog/in_progress —
  // clearing its execution lock or discarding its in-flight work. An agent may
  // only change the status of its OWN assigned task.
  if (!me || input.existing.assigneeAgentId !== me) {
    throw unprocessable("Agent may only transition its own assigned task", { code: "invalid_issue_disposition" });
  }
  // The autonomy dial additionally gates completion-ish transitions.
  const dial = input.actor.effectiveDial ?? 0;
  if (next === "in_review" && dial < 1) throw unprocessable("Dial is Manual — agent cannot move task to review yet", { code: "invalid_issue_disposition" });
  if (next === "done") {
    if (input.existing.agentCompletionPolicy !== "agent_can_complete") {
      throw unprocessable("This task requires human review before completion", {
        code: "review_required",
        requiredStatus: "in_review",
      });
    }
    if (dial < 2) {
      throw unprocessable("Only at Drive may an agent complete its own task", {
        code: "invalid_issue_disposition",
      });
    }
    const criteria = input.existing.acceptanceCriteria;
    if (!criteria.some((criterion) => typeof criterion === "string" && criterion.trim().length > 0)) {
      throw unprocessable("Agent completion requires at least one acceptance criterion", {
        code: "acceptance_criteria_required",
      });
    }
  }
  // Live-QA fix (Scenario B): a crew agent moving its OWN task to `in_review` is gated
  // by ownership + dial (>=1) ONLY. We deliberately do NOT call assertAgentInReviewReviewPath
  // here. For a crew task the `in_review` status IS the founder's review queue (founder
  // then approves in_review -> done). Requiring a SEPARATE review path (a human
  // assigneeUserId or a linked pending approval) made the Assist tier impossible for a
  // crew-only task: the live QA proved a crew task could never reach in_review and got
  // released back to `todo` by the runner's silent-stuck guard. The route-level guard
  // (routes/issues.ts) still enforces the review-path for ORG agents on the HTTP PATCH
  // path; this service path is crew-only (actorType='agent', reached via the crew tools).
}
