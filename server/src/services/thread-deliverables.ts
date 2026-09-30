/**
 * Thread deliverables service (P1-T1 skeleton + P1-T7 secure Approve handler)
 *
 * Creates one "deliverable task" per scope-proposal acceptance for a discussion
 * thread. Each created issue is linked back to its source thread via
 * `issues.sourceDiscussionId = threadId`.
 *
 * Pattern: follows `server/src/services/goals.ts` — pure functions + a factory
 * that closes over `db` and returns methods.
 *
 * P1-T7: `approveProposal` adds:
 *  1. Authorization is the CALLER's responsibility (route layer uses
 *     assertCompanyAccess + assertRole). The service validates companyId
 *     ownership + that the entry really is a scope_proposal (defense-in-depth).
 *  2. Proposal validation — must exist, belong to threadId, be a scope_proposal,
 *     and have proposalStatus = "pending".
 *  3. Stale check — compares proposalCursorSeq (stamped at post time) against
 *     the thread's current entrySeq. If the thread has newer entries, reject.
 *  4. Claim-first atomic idempotency — transitions proposalStatus pending ->
 *     approved with a single conditional UPDATE ... RETURNING. Loser of a
 *     concurrent race returns alreadyApproved WITHOUT creating duplicate tasks.
 *  5. Task creation via createDeliverableTasks happens only after the claim win.
 *  6. Audit log entry via the caller-provided logActivity (route layer).
 *
 * Approval state is tracked on the dedicated `discussion_entries.proposalStatus`
 * column, NOT `extractionStatus`. The latter is the LLM-extraction lifecycle and
 * is mutated by the autonomous Scribe drain + reprocess sweeps (both select by
 * extractionStatus with no inputType filter); overloading it would corrupt
 * approval state. Proposals are inserted extractionStatus="skipped" so no sweep
 * ever touches them.
 */

import { eq, and, ne } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, discussionEntries, discussions } from "@armyofagents/db";
import { issueService } from "./issues.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A minimal description of one task to create from a scope proposal.
 * Callers can pass any additional fields that `issues.$inferInsert` accepts;
 * `sourceDiscussionId` is always overwritten to `threadId`.
 */
export interface DeliverableProposal {
  title: string;
  description?: string | null;
  priority?: string | null;
  status?: string;
  projectId?: string | null;
  goalId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  [key: string]: unknown;
}

export interface CreateDeliverableTasksInput {
  threadId: string;
  companyId: string;
  proposals: DeliverableProposal[];
  createdBy: { userId?: string; agentId?: string };
}

/**
 * Input to `approveProposal`.
 * Authorization (assertRole) must be performed by the caller BEFORE calling this.
 */
export interface ApproveProposalInput {
  /** The thread (discussion) the proposal belongs to. */
  threadId: string;
  /** The company — used to verify the thread belongs here. */
  companyId: string;
  /** The discussion_entries row id of the scope_proposal entry. */
  proposalEntryId: string;
  /** The authenticated user who is approving (for audit + task createdBy). */
  approver: { userId: string };
}

/**
 * Outcome of `approveProposal`.
 *
 * - `ok: true, alreadyApproved: false` — fresh approval; tasks created.
 * - `ok: true, alreadyApproved: true` — idempotent no-op; tasks already exist.
 * - `ok: false, reason: ...` — validation failure; tasks NOT created.
 */
export type ApproveProposalResult =
  | { ok: true; alreadyApproved: false; taskIds: string[]; createdTasks: Array<{ id: string; assigneeAgentId: string | null; workMode: string | null }> }
  | { ok: true; alreadyApproved: true }
  | { ok: false; reason: "not_found" | "wrong_thread" | "rejected" | "stale"; message: string };

// ─── Pure helper ─────────────────────────────────────────────────────────────

/**
 * Build the Drizzle insert payload for a single deliverable task.
 * Pure function — no I/O, easy to unit-test.
 */
export function buildDeliverableInsert(
  companyId: string,
  threadId: string,
  proposal: DeliverableProposal,
  createdBy: { userId?: string; agentId?: string },
): Record<string, unknown> {
  // `priority` is NOT NULL with a DB default ("medium"). The proposal mapping
  // coerces an unspecified priority to `null`, and an explicit null OVERRIDES
  // the default → 23502 not-null violation. Strip it here so the column is
  // omitted and the DB default applies (matching normal task creation). Only a
  // proposal that actually specified a priority forwards a value.
  const { priority, ...rest } = proposal;
  return {
    ...rest,
    companyId,
    sourceDiscussionId: threadId,
    status: proposal.status ?? "todo",
    createdByUserId: createdBy.userId ?? null,
    createdByAgentId: createdBy.agentId ?? null,
    originKind: "crew_thread",
    ...(priority != null ? { priority } : {}),
  };
}

/**
 * Parse the `rawContent` of a scope_proposal entry.
 * Returns null if the content is not valid JSON or missing required fields.
 */
export function parseScopeProposalContent(rawContent: string): {
  summary: string;
  proposedTasks: Array<{ title: string; [key: string]: unknown }>;
  autoAdvanceAt?: string;
  proposalCursorSeq: number;
  scopeVersionId?: string;
} | null {
  try {
    const parsed = JSON.parse(rawContent);
    if (
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.proposedTasks)
    ) {
      return null;
    }
    return {
      summary: parsed.summary,
      proposedTasks: parsed.proposedTasks,
      autoAdvanceAt: parsed.autoAdvanceAt,
      scopeVersionId: typeof parsed.scopeVersionId === "string" ? parsed.scopeVersionId : undefined,
      // Legacy proposals (pre-T7) have no stamp — treat as 0 (stale check passes
      // for any thread, which is safe: worst case we create tasks for an old proposal,
      // which the human consciously clicked Approve on).
      proposalCursorSeq: typeof parsed.proposalCursorSeq === "number" ? parsed.proposalCursorSeq : 0,
    };
  } catch {
    return null;
  }
}

// ─── Builder helpers ──────────────────────────────────────────────────────────

/**
 * Look up the Engineer crew agent for this company.
 * Returns the agent id, or null if no Engineer has been seeded yet.
 */
export async function findDefaultBuilder(db: Db, companyId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.kind, "aoa"),
        eq(agents.name, "Engineer"),
        ne(agents.status, "terminated"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Append a "needs a worker" notice to a description.
 * Pure function — no I/O.
 */
export function flagNeedsWorker(description: string | null | undefined): string {
  const base = description?.trim() ?? "";
  const notice = "⚠️ Needs a worker: assign an agent to this task before it can be built.";
  return base ? `${base}\n\n${notice}` : notice;
}

// ─── Service factory ──────────────────────────────────────────────────────────

export function threadDeliverablesService(db: Db) {
  const issues = issueService(db);

  return {
    /**
     * Create one issue per proposal, all linked to `threadId` via
     * `sourceDiscussionId`. Returns the created issues in the same order as
     * `proposals`.
     *
     * @param txDb - optional transaction handle; when provided, all DB writes
     *   (findDefaultBuilder + issue inserts) run on that transaction so callers
     *   can atomically roll back task creation together with the claim UPDATE.
     */
    createDeliverableTasks: async (
      {
        threadId,
        companyId,
        proposals,
        createdBy,
      }: CreateDeliverableTasksInput,
      txDb?: Db,
    ) => {
      // Short-circuit: no DB call needed when there is nothing to create.
      if (proposals.length === 0) return [];

      const effectiveDb = txDb ?? db;
      const txIssues = txDb ? issueService(txDb) : issues;

      // Find the default builder once — O(1) DB call for all tasks.
      const builderAgentId = await findDefaultBuilder(effectiveDb, companyId);

      const created = [];
      for (const proposal of proposals) {
        let resolvedProposal = proposal;

        if (!proposal.assigneeAgentId) {
          if (builderAgentId) {
            resolvedProposal = { ...proposal, assigneeAgentId: builderAgentId };
          } else {
            // No builder configured — flag the task so the founder notices.
            resolvedProposal = { ...proposal, description: flagNeedsWorker(proposal.description) };
          }
        }

        const payload = buildDeliverableInsert(companyId, threadId, resolvedProposal, createdBy);
        const issue = await txIssues.create(companyId, payload as any);
        created.push(issue);
      }
      return created;
    },

    /**
     * P1-T7: Securely approve a scope proposal.
     *
     * Authorization is NOT performed here — the HTTP route layer MUST call
     * `assertCompanyAccess` + `assertRole(db, req, companyId, "founder",
     * "team_lead")` before invoking this method. This service validates only
     * data integrity and business rules (defense-in-depth on tenant ownership).
     *
     * Approval state lives in the purpose-built `proposalStatus` column —
     * NOT `extractionStatus`. `extractionStatus` is the LLM-extraction
     * lifecycle and is mutated by the autonomous Scribe drain (dispatcher
     * pending sweep) and `reprocessAllEntries`, both of which select by
     * extractionStatus with NO inputType filter. Overloading it would let a
     * sweep silently flip a proposal to "completed" and break approval. The
     * proposal is inserted with extractionStatus="skipped" (so no sweep claims
     * it) and proposalStatus="pending".
     *
     * Steps:
     *  1. Load the proposal entry; verify it belongs to threadId + companyId.
     *  2. Reject non-proposal entries (proposalStatus IS NULL) as not_found.
     *  3. proposalStatus already "approved" → idempotent no-op.
     *     proposalStatus "rejected" → 409 rejected.
     *  4. Parse content; stale-check proposalCursorSeq vs thread.entrySeq.
     *  5. CLAIM-FIRST: atomically transition pending -> approved with a single
     *     conditional UPDATE ... RETURNING. If no row comes back, a concurrent
     *     approve already won → return alreadyApproved WITHOUT creating tasks.
     *  6. Only after winning the claim, create the deliverable tasks.
     *  7. Return task IDs for the route to log activity.
     *
     * Crash-safety trade-off: marking approved before task creation means a
     * crash mid-create could leave an approved proposal with fewer tasks than
     * intended. That is strictly preferable to the alternative (create-then-
     * mark), which on a crash or concurrent approve produces DUPLICATE tasks —
     * double budget spend + double auto-dispatch. For an authz boundary that
     * spends real budget, "never duplicate" wins.
     */
    approveProposal: async ({
      threadId,
      companyId,
      proposalEntryId,
      approver,
    }: ApproveProposalInput): Promise<ApproveProposalResult> => {
      // ── Step 1: Load proposal entry ──────────────────────────────────────────
      // Join to discussions to confirm the thread belongs to this company.
      const [entry] = await db
        .select({
          id: discussionEntries.id,
          discussionId: discussionEntries.discussionId,
          inputType: discussionEntries.inputType,
          rawContent: discussionEntries.rawContent,
          proposalStatus: discussionEntries.proposalStatus,
        })
        .from(discussionEntries)
        .innerJoin(discussions, eq(discussionEntries.discussionId, discussions.id))
        .where(
          and(
            eq(discussionEntries.id, proposalEntryId),
            eq(discussions.companyId, companyId),
          ),
        );

      if (!entry) {
        return {
          ok: false,
          reason: "not_found",
          message: "Proposal not found or does not belong to this company",
        };
      }

      // ── Step 2: Verify it belongs to the specified thread ────────────────────
      if (entry.discussionId !== threadId) {
        return {
          ok: false,
          reason: "wrong_thread",
          message: "Proposal belongs to a different thread",
        };
      }

      // ── Step 2b: Must be an actual scope_proposal entry ──────────────────────
      // proposalStatus IS NULL for every non-proposal entry. Refuse to "approve"
      // an arbitrary discussion entry (e.g. a paste/write) into tasks — that
      // would be a privilege/abuse vector independent of role.
      if (entry.inputType !== "scope_proposal" || entry.proposalStatus == null) {
        return {
          ok: false,
          reason: "not_found",
          message: "Entry is not an approvable scope proposal",
        };
      }

      // ── Step 3: Check proposal status (purpose-built field) ──────────────────
      //   "pending"  = awaiting approval
      //   "approved" = already approved (tasks created)
      //   "rejected" = rejected by a human
      if (entry.proposalStatus === "approved") {
        // Idempotent: already approved — no-op.
        return { ok: true, alreadyApproved: true };
      }
      if (entry.proposalStatus === "rejected") {
        return {
          ok: false,
          reason: "rejected",
          message: "Proposal has already been rejected and cannot be approved",
        };
      }

      // ── Step 4: Parse proposal content + stale check ─────────────────────────
      const proposalContent = parseScopeProposalContent(entry.rawContent);
      if (!proposalContent) {
        return {
          ok: false,
          reason: "not_found",
          message: "Proposal entry has invalid or missing content",
        };
      }

      // Read the thread's current entrySeq.
      const [threadRow] = await db
        .select({ entrySeq: discussions.entrySeq })
        .from(discussions)
        .where(
          and(
            eq(discussions.id, threadId),
            eq(discussions.companyId, companyId),
          ),
        );

      const currentSeq: number = threadRow?.entrySeq ?? 0;
      const stampedSeq: number = proposalContent.proposalCursorSeq;

      // STALE CHECK: if newer entries arrived after the proposal was made,
      // reject with a clear "re-propose or reconfirm" message.
      if (currentSeq > stampedSeq) {
        return {
          ok: false,
          reason: "stale",
          message:
            `Proposal is out of date — the thread has ${currentSeq - stampedSeq} new ` +
            "entry(ies) since this proposal was made. Re-propose or ask the Adjutant " +
            "to reconfirm before approving.",
        };
      }

      // ── Steps 5+6: Atomic claim + task creation ──────────────────────────────
      // Wrapped in a single db.transaction so that if createDeliverableTasks
      // throws after the claim wins, the claim UPDATE rolls back — leaving the
      // proposal in "pending" state and making a subsequent re-approve possible.
      // Without this, a task-creation failure would leave the proposal "approved"
      // with zero tasks, and re-approve would return alreadyApproved (no-op),
      // leaving the tasks permanently un-created (Codex #3 robustness gap).
      //
      // CLAIM-FIRST invariant is preserved: only the winner of the conditional
      // UPDATE (WHERE proposalStatus = 'pending' RETURNING) creates tasks; the
      // loser gets zero rows and returns alreadyApproved without creating tasks.
      if (proposalContent.scopeVersionId) {
        const { threadScopeVersionService } = await import("./thread-scope-versions.js");
        const scopeResult = await threadScopeVersionService(db).acceptDraft(
          companyId,
          threadId,
          proposalContent.scopeVersionId,
          { itemIds: [] },
          { userId: approver.userId, isHuman: true },
        );

        if (!scopeResult.ok) {
          return {
            ok: false,
            reason: scopeResult.reason === "stale" ? "stale" : "not_found",
            message: scopeResult.message,
          };
        }

        await db
          .update(discussionEntries)
          .set({ proposalStatus: "approved" })
          .where(
            and(
              eq(discussionEntries.id, proposalEntryId),
              eq(discussionEntries.proposalStatus, "pending"),
            ),
          )
          .returning({ id: discussionEntries.id });

        return {
          ok: true,
          alreadyApproved: scopeResult.alreadyAccepted,
          taskIds: scopeResult.createdTasks.map((task) => task.id),
          createdTasks: scopeResult.createdTasks.map((task) => ({
            id: task.id,
            assigneeAgentId: task.assigneeAgentId ?? null,
            workMode: task.workMode ?? null,
          })),
        };
      }

      let claimResult: { ok: true; alreadyApproved: false; taskIds: string[]; createdTasks: Array<{ id: string; assigneeAgentId: string | null; workMode: string | null }> }
                     | { ok: true; alreadyApproved: true }
                     | null = null;

      await (db as any).transaction(async (tx: any) => {
        const claimed = await tx
          .update(discussionEntries)
          .set({ proposalStatus: "approved" })
          .where(
            and(
              eq(discussionEntries.id, proposalEntryId),
              eq(discussionEntries.proposalStatus, "pending"),
            ),
          )
          .returning({ id: discussionEntries.id });

        if (!claimed || claimed.length === 0) {
          // Lost the race — another approve already claimed it. Idempotent no-op;
          // we did NOT create tasks here, so there are no duplicates.
          claimResult = { ok: true, alreadyApproved: true };
          return;
        }

        // Only after winning the claim, create the deliverable tasks (on tx so
        // a failure rolls back the claim and leaves the proposal pending + retryable).
        const deliverableProposals: DeliverableProposal[] = proposalContent.proposedTasks.map(
          (t) => ({
            title: t.title,
            description: (t.description as string | undefined) ?? null,
            priority: (t.priority as string | undefined) ?? null,
            assigneeAgentId: (t.assigneeAgentId as string | undefined) ?? null,
            assigneeUserId: (t.assigneeUserId as string | undefined) ?? null,
            projectId: (t.projectId as string | undefined) ?? null,
            goalId: (t.goalId as string | undefined) ?? null,
          }),
        );

        // Pass `tx` so all issue inserts run within the same transaction.
        const svc = threadDeliverablesService(db);
        const created = await svc.createDeliverableTasks(
          {
            threadId,
            companyId,
            proposals: deliverableProposals,
            createdBy: { userId: approver.userId },
          },
          tx as unknown as Db,
        );

        const taskIds = created.map((issue: { id: string }) => issue.id);
        const createdTasks = created.map((issue: { id: string; assigneeAgentId: string | null; workMode: string | null }) => ({
          id: issue.id,
          assigneeAgentId: issue.assigneeAgentId ?? null,
          workMode: issue.workMode ?? null,
        }));

        claimResult = { ok: true, alreadyApproved: false, taskIds, createdTasks };
      });

      // Transaction completed — claimResult is always set at this point.
      return claimResult!;
    },
  };
}

// Convenience re-export matching the codebase pattern (named factory only)
export { threadDeliverablesService as default };
