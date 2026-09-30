/**
 * P3-T1: Crew result relay.
 *
 * When a crew-thread deliverable task finishes successfully, post a visible
 * `agent` entry to the source thread so the result surfaces in the chat.
 * This is the success counterpart to crew-failure-card.ts (P2-T2), which
 * posts a `system` entry when a run fails.
 *
 * Guards (Codex #18 — relay ONLY for crew-thread tasks):
 *   - issues.originKind !== 'crew_thread' → no-op ({ posted: false })
 *   - issues.sourceDiscussionId is null   → no-op ({ posted: false })
 *
 * The entry:
 *   - inputType: 'agent'           (visible as an agent message in the chat)
 *   - authorAgentId: assigneeAgentId  (the agent that did the work)
 *   - createdBy: assigneeAgentId   (mirrors crew-failure-card sentinel pattern)
 *   - extractionStatus: 'skipped'  (not prose for the LLM extractor)
 *   - rawContent: human-readable completion summary with task title + id link
 *   - seq: bumped from discussions.entrySeq atomically (same as crew-failure-card)
 *
 * Best-effort caller contract: callers should wrap this in try/catch so a
 * posting failure never masks the underlying task completion (mirroring the
 * crew-failure-card design).
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { issues, discussions, discussionEntries } from "@armyofagents/db";
import type { ShowRef } from "@armyofagents/shared";
import { publishLiveEvent } from "./live-events.js";
import { synthesizeThreadDeliveryRefs } from "./viewer-ref-synthesis.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ svc: "crew-result-relay" });

export interface RelayCrewResultResult {
  posted: boolean;
}

/**
 * Post the completion entry for a crew-thread deliverable task into its
 * source thread. Returns { posted: true } when an entry was inserted, or
 * { posted: false } for the two no-op guard cases.
 */
export async function relayCrewResult(
  db: Db,
  params: { issueId: string },
): Promise<RelayCrewResultResult> {
  // ── Load the issue (only the fields we need) ──────────────────────────────
  const [issue] = await db
    .select({
      id: issues.id,
      title: issues.title,
      status: issues.status,
      originKind: issues.originKind,
      sourceDiscussionId: issues.sourceDiscussionId,
      assigneeAgentId: issues.assigneeAgentId,
      companyId: issues.companyId,
    })
    .from(issues)
    .where(eq(issues.id, params.issueId));

  if (!issue) {
    log.warn({ issueId: params.issueId }, "crew-result-relay: issue not found");
    return { posted: false };
  }

  // ── Guard 1: only relay crew-thread tasks (Codex #18) ────────────────────
  if (issue.originKind !== "crew_thread") {
    return { posted: false };
  }

  // ── Guard 2: must have a source thread to post into ───────────────────────
  if (!issue.sourceDiscussionId) {
    return { posted: false };
  }

  // A successful adapter process is not the same thing as a completed task.
  // The legacy callers invoke this relay when a run exits successfully, so
  // refuse to publish completion wording unless the task itself is done.
  if (issue.status !== "done") {
    return { posted: false };
  }

  const threadId = issue.sourceDiscussionId;
  // Use the assignee agent id as both author and createdBy (mirrors the
  // crew-failure-card pattern where agentId fills the createdBy sentinel).
  // If for some reason the assignee is null (edge case: re-assigned after
  // completion), fall back to the issue id as a safe non-null sentinel.
  const agentId: string = issue.assigneeAgentId ?? issue.id;

  // ── Guard 3: multi-tenant companyId cross-check (Codex #6) ───────────────
  // Verify the source discussion belongs to the SAME company as the issue.
  // An explicit check here + a constrained UPDATE below ensure a cross-company
  // update cannot happen even if auth somehow passes.
  const [sourceThread] = await db
    .select({ companyId: discussions.companyId })
    .from(discussions)
    .where(eq(discussions.id, threadId));

  if (!sourceThread || sourceThread.companyId !== issue.companyId) {
    log.warn(
      { issueId: params.issueId, issueCompanyId: issue.companyId, threadId, threadCompanyId: sourceThread?.companyId },
      "crew-result-relay: companyId mismatch — refusing to post cross-company entry",
    );
    return { posted: false };
  }

  const rawContent = `Completed: "${issue.title}" (task ${issue.id})`;
  const now = new Date();

  // ── Atomic insert: bump entrySeq + entryCount, assign seq ─────────────────
  const { entry, companyId } = await db.transaction(async (tx) => {
    // Constrained UPDATE: include companyId in WHERE so a cross-company write
    // is impossible even if the explicit check above were somehow bypassed.
    const [{ entrySeq, companyId: cid }] = await tx
      .update(discussions)
      .set({
        entrySeq: sql`${discussions.entrySeq} + 1`,
        entryCount: sql`${discussions.entryCount} + 1`,
        updatedAt: now,
      })
      .where(and(eq(discussions.id, threadId), eq(discussions.companyId, issue.companyId)))
      .returning({ entrySeq: discussions.entrySeq, companyId: discussions.companyId });

    const [inserted] = await tx
      .insert(discussionEntries)
      .values({
        discussionId: threadId,
        inputType: "agent",
        rawContent,
        authorAgentId: issue.assigneeAgentId ?? null,
        createdBy: agentId,
        extractionStatus: "skipped",
        seq: entrySeq,
      })
      .returning();

    return { entry: inserted, companyId: cid };
  });

  // ── Publish live events (same pair as crew-failure-card) ──────────────────
  publishLiveEvent({
    companyId,
    type: "discussion.entry.created",
    payload: { discussionId: threadId, entryId: entry.id, inputType: "agent" },
  });
  publishLiveEvent({
    companyId,
    type: "thread.entry.created",
    payload: { threadId, entryId: entry.id, seq: entry.seq ?? 0 },
  });

  log.debug(
    { threadId, issueId: params.issueId },
    "posted crew-result relay entry",
  );

  return { posted: true };
}

// ────────────────────────────────────────────────────────────────────────────
// Viewer Upgrade Phase 7B / Task 4 — on-run-finish "run result" delivery
// ────────────────────────────────────────────────────────────────────────────

export interface DeliverCrewRunResultInput {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string | null;
}

export interface DeliverCrewRunResultDeps {
  /** Injected for tests; production uses the real synthesizer. */
  synthesize: typeof synthesizeThreadDeliveryRefs;
}

export interface DeliverCrewRunResultResult {
  delivered: boolean;
}

/**
 * Deliver the NAVIGATIONAL refs a crew run produced onto its originating
 * Discussion thread when the run FINISHES — **regardless of task status**
 * (in-review included). This is a SEPARATE side-effect from the `done`-gated
 * `relayCrewResult` ("Completed: …" entry): both can legitimately fire for one
 * task lifecycle (a run finishes while the task stays in review → run-result
 * entry now; the task later transitions to done → "Completed" entry then). They
 * never duplicate each other — the run-result entry is anchored per `runId`,
 * the "Completed" entry is the done transition.
 *
 * Keeps Decision #109 (technical run completion ≠ task completion): this posts
 * on run finish without asserting completion wording or flipping task status.
 *
 * Contract:
 *   - Thread-only: derive `threadId` from `issues.sourceDiscussionId`; no thread
 *     → no delivery (nothing to deliver to).
 *   - Idempotent per `runId` (P3-1): a prior run-result entry for this runId
 *     (marked via `sourceInfo.runResultRunId`) → no double-post.
 *   - RBAC (P2-2): the entry lands ONLY on the origin thread; every synthesized
 *     ref's `provenance.entityId` MUST equal that threadId (the synth helper
 *     sets it — we assert it defensively; a mismatch aborts the delivery).
 *   - Best-effort: wrapped in try/catch. NEVER throws into the crew run.
 *
 * Returns `{ delivered: true }` only when a new entry was inserted.
 */
export async function deliverCrewRunResult(
  input: DeliverCrewRunResultInput,
  deps: DeliverCrewRunResultDeps = { synthesize: synthesizeThreadDeliveryRefs },
): Promise<DeliverCrewRunResultResult> {
  const { db, companyId, issueId, runId, agentId } = input;

  try {
    // ── Load the issue (company-scoped: tenant-isolation guard) ───────────────
    const [issue] = await db
      .select({
        id: issues.id,
        sourceDiscussionId: issues.sourceDiscussionId,
        assigneeAgentId: issues.assigneeAgentId,
        companyId: issues.companyId,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .limit(1);

    if (!issue) {
      // Foreign, deleted, or missing issue → nothing to deliver.
      return { delivered: false };
    }

    // ── Thread-only: no source thread → nothing to deliver to ─────────────────
    const threadId = issue.sourceDiscussionId;
    if (!threadId) {
      return { delivered: false };
    }

    // ── Idempotency (P3-1): one run-result entry per runId ────────────────────
    // Marker lives in `sourceInfo.runResultRunId`. A retried success side-effect
    // finds the prior entry and short-circuits — no double-post.
    const priorRows = await db
      .select({ id: discussionEntries.id })
      .from(discussionEntries)
      .where(
        and(
          eq(discussionEntries.discussionId, threadId),
          sql`${discussionEntries.sourceInfo}->>'runResultRunId' = ${runId}`,
        ),
      )
      .limit(1);
    if (priorRows.length > 0) {
      return { delivered: false };
    }

    // ── Synthesize the navigational refs (aggregate task products) ────────────
    const refs: ShowRef[] = await deps.synthesize({
      db,
      companyId: issue.companyId,
      issueId,
      threadId,
      runId,
      agentId,
    });

    // ── RBAC assert (P2-2): every ref points at THIS origin thread ────────────
    // The synth helper stamps provenance.entityId = threadId. Assert it here so
    // a bug can never deliver a ref scoped to a foreign surface/thread. On
    // mismatch, abort the whole delivery (caught below → { delivered: false }).
    for (const ref of refs) {
      // Only v:2 refs carry provenance (the synth helper emits v:2 exclusively).
      if (ref.v === 2 && ref.provenance && ref.provenance.entityId !== threadId) {
        throw new Error(
          `RBAC assertion failed: ref provenance.entityId (${ref.provenance.entityId}) !== threadId (${threadId})`,
        );
      }
    }

    // ── Compose the human-readable line ───────────────────────────────────────
    // N = the non-task results (refs minus the always-present single task ref).
    const nonTaskCount = Math.max(0, refs.length - 1);
    const rawContent =
      nonTaskCount > 0
        ? `Run finished — ${nonTaskCount} result${nonTaskCount === 1 ? "" : "s"}`
        : "Run finished";
    const now = new Date();
    // author/createdBy: the delivering agent, falling back to the assignee, then
    // a non-null sentinel (createdBy is NOT NULL) — mirrors relayCrewResult.
    const authorAgentId = agentId ?? issue.assigneeAgentId ?? null;
    const createdBy: string = agentId ?? issue.assigneeAgentId ?? issue.id;

    // ── Atomic insert: bump entrySeq + entryCount, assign seq ─────────────────
    const { entry, companyId: threadCompanyId } = await db.transaction(async (tx) => {
      // Constrained UPDATE: companyId in WHERE so a cross-company write is
      // impossible (mirrors relayCrewResult Guard 3).
      const [{ entrySeq, companyId: cid }] = await tx
        .update(discussions)
        .set({
          entrySeq: sql`${discussions.entrySeq} + 1`,
          entryCount: sql`${discussions.entryCount} + 1`,
          updatedAt: now,
        })
        .where(and(eq(discussions.id, threadId), eq(discussions.companyId, issue.companyId)))
        .returning({ entrySeq: discussions.entrySeq, companyId: discussions.companyId });

      const [inserted] = await tx
        .insert(discussionEntries)
        .values({
          discussionId: threadId,
          inputType: "agent",
          rawContent,
          authorAgentId,
          createdBy,
          extractionStatus: "skipped",
          seq: entrySeq,
          outputRefs: refs,
          sourceInfo: { runResultRunId: runId },
        })
        .returning();

      return { entry: inserted, companyId: cid };
    });

    // ── Publish live events (same pair as relayCrewResult; UI refetches) ──────
    publishLiveEvent({
      companyId: threadCompanyId,
      type: "discussion.entry.created",
      payload: { discussionId: threadId, entryId: entry.id, inputType: "agent" },
    });
    publishLiveEvent({
      companyId: threadCompanyId,
      type: "thread.entry.created",
      payload: { threadId, entryId: entry.id, seq: entry.seq ?? 0 },
    });

    log.debug(
      { threadId, issueId, runId, refCount: refs.length },
      "delivered crew run-result entry",
    );

    return { delivered: true };
  } catch (err) {
    // Best-effort: a delivery failure NEVER breaks the run.
    log.warn(
      { err, issueId, runId },
      "deliverCrewRunResult failed (non-fatal)",
    );
    return { delivered: false };
  }
}
