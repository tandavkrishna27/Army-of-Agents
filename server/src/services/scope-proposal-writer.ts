// server/src/services/scope-proposal-writer.ts
//
// Task 2.1 (Crew Work-as-Tasks) — shared, companyId-validated scope-proposal writer.
//
// Extracts the D9 transactional body from `thread-post-scope-proposal.ts` into a
// standalone primitive so that the crew-task-service (Task 2.2) and the
// phase-advance path can reuse it without re-implementing the invariants.
//
// Security: Codex #14 — companyId is validated BEFORE entering the transaction.
// Multi-tenant hole in the original tool (threadId-only update with no company
// check) is closed here by a pre-flight SELECT that verifies the thread belongs
// to the calling company.
//
// Idempotency: a partial-unique index
//   discussion_entries_one_pending_scope_proposal_idx
//   UNIQUE ON (discussion_id) WHERE input_type='scope_proposal' AND proposal_status='pending'
// ensures at most one pending scope proposal per thread at any time.
// A unique violation on that specific index is caught and converted to
//   { existing: true, entryId: <id of the existing pending entry> }
// rather than propagated. All other errors propagate normally so no real
// failure is silently swallowed.
//
// D9 invariant: entry + plan-steps commit together in a single transaction.
// If either side fails, both roll back — readers never see a partial state
// where an entry is visible but its plan-steps are missing (or vice versa).

import { and, eq, sql } from "drizzle-orm";
import { discussionEntries, discussions, threadPlanSteps } from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import { publishLiveEvent } from "./live-events.js";
import { isUniqueViolation } from "./db-errors.js";

// The exact Drizzle-generated index name that backs the one-pending-per-thread guard.
const PENDING_PROPOSAL_UQ = "discussion_entries_one_pending_scope_proposal_idx";

export interface WriteScopeProposalArgs {
  threadId: string;
  /** Must match the thread's companyId — mismatches are rejected (Codex #14). */
  companyId: string;
  proposal: {
    summary: string;
    proposedTasks: Array<{ title: string; [k: string]: unknown }>;
    autoAdvanceAt?: string;
  };
  /** Calling agent's id; null when invoked by Commander / board. */
  agentId: string | null;
}

export interface WriteScopeProposalResult {
  entryId: string;
  proposalCursorSeq: number;
  /** true when a pending proposal already existed (idempotency path). */
  existing: boolean;
}

/**
 * Write a scope_proposal entry + associated plan-steps atomically (D9).
 *
 * @throws {Error} with message containing "COMPANY_MISMATCH" when the thread
 *   is not found or belongs to a different company (Codex #14).
 * @throws {Error} for any other DB error inside the transaction.
 */
export async function writeScopeProposal(
  db: Db,
  args: WriteScopeProposalArgs,
): Promise<WriteScopeProposalResult> {
  const { threadId, companyId, proposal, agentId } = args;

  // ── Step 1: companyId validation (Codex #14) ────────────────────────────────
  // SELECT before the transaction so a mismatch is caught cheaply, before we
  // acquire any row locks. If the row is absent or the company doesn't match,
  // throw immediately — the transaction is never entered.
  const threadRows = await (db as any)
    .select({ companyId: discussions.companyId, entrySeq: discussions.entrySeq })
    .from(discussions)
    .where(eq(discussions.id, threadId));

  const thread = threadRows[0];
  if (!thread || thread.companyId !== companyId) {
    throw new Error(
      `COMPANY_MISMATCH: thread ${threadId} not found or belongs to a different company`,
    );
  }

  // ── Step 2: D9 transaction ───────────────────────────────────────────────────
  // NOTE: proposalCursorSeq and rawContent are built INSIDE the transaction,
  // AFTER the UPDATE ... RETURNING gives us the bumped entrySeq. This ensures
  // the stamped proposalCursorSeq equals the proposal entry's OWN seq (N+1),
  // not the pre-bump value (N). Without this, the stale check in approveProposal
  // (currentSeq > stampedSeq) would always fire for a fresh proposal because
  // the transaction bumps entrySeq to N+1 but the stamp was N.
  let proposalCursorSeq: number = 0;

  try {
    const result = await (db as any).transaction(async (tx: any) => {
      // Bump entrySeq + entryCount atomically (same pattern as addEntry / requestParticipation).
      const [{ entrySeq, companyId: threadCompanyId }] = await tx
        .update(discussions)
        .set({
          entrySeq: sql`${discussions.entrySeq} + 1`,
          entryCount: sql`${discussions.entryCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(discussions.id, threadId))
        .returning({
          entrySeq: discussions.entrySeq,
          companyId: discussions.companyId,
        });

      // Stamp the proposal's OWN post-bump seq so the stale check fires only
      // for genuinely newer entries, not for the proposal entry itself.
      proposalCursorSeq = entrySeq;
      const rawContent = JSON.stringify({ ...proposal, proposalCursorSeq });

      const inserted = await tx
        .insert(discussionEntries)
        .values({
          discussionId: threadId,
          inputType: "scope_proposal",
          rawContent,
          authorAgentId: agentId ?? null,
          createdBy: agentId ?? "aoa-agent",
          // P1-T7: mark extractionStatus "skipped" so neither the autonomous
          // Scribe drain (dispatcher.ts pending sweep) nor reprocessAllEntries
          // ever claims this entry and corrupts the approval state.
          extractionStatus: "skipped",
          // P1-T7: purpose-built approval-lifecycle field. The Approve handler
          // claims pending → approved atomically.
          proposalStatus: "pending",
          seq: entrySeq, // assign the monotonic seq from the bump above
        })
        .returning();

      const entry = Array.isArray(inserted) ? inserted[0] : inserted;
      if (!entry || !entry.id) {
        throw new Error("scope_proposal entry insert returned no row");
      }

      const stepRows = (proposal.proposedTasks ?? []).map((t, i) => {
        if (!t || typeof t.title !== "string" || t.title.length === 0) {
          throw new Error(
            `proposedTasks[${i}] requires a non-empty title (got ${JSON.stringify(t)})`,
          );
        }
        return {
          threadId,
          stepOrder: i,
          title: t.title,
          linkedItemId: null,
        };
      });

      if (stepRows.length > 0) {
        await tx.insert(threadPlanSteps).values(stepRows);
      }

      return { entry, companyId: threadCompanyId };
    });

    // ── Step 3: live events (happy path only) ──────────────────────────────────
    const { entry, companyId: cid } = result;
    publishLiveEvent({
      companyId: cid,
      type: "discussion.entry.created",
      payload: {
        discussionId: threadId,
        entryId: entry.id,
        inputType: "scope_proposal",
      },
    });
    publishLiveEvent({
      companyId: cid,
      type: "thread.entry.created",
      payload: {
        threadId,
        entryId: entry.id,
        seq: entry.seq ?? 0,
      },
    });

    return { entryId: entry.id, proposalCursorSeq, existing: false };
  } catch (err: unknown) {
    // ── Step 4: idempotency — catch the one-pending-per-thread guard ───────────
    // ONLY convert the exact partial-unique constraint for the pending-proposal
    // guard. All other errors (including 23505 from other indexes) propagate so
    // no real failure is swallowed.
    if (isUniqueViolation(err, PENDING_PROPOSAL_UQ)) {
      // A pending scope proposal already exists for this thread. Find its id
      // and return the idempotent result.
      const existingRows = await (db as any)
        .select({ id: discussionEntries.id })
        .from(discussionEntries)
        .where(and(
          eq(discussionEntries.discussionId, threadId),
          eq(discussionEntries.inputType, "scope_proposal"),
          eq(discussionEntries.proposalStatus, "pending"),
        ));
      const existingId: string = existingRows[0]?.id ?? "";
      return { entryId: existingId, proposalCursorSeq, existing: true };
    }
    throw err;
  }
}
