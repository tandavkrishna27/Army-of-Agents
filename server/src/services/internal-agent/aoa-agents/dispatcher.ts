import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, inArray, isNull, lte, notInArray, or, sql, gt } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  requestTrackedProcessTermination,
  waitForTrackedProcessExit,
} from "@armyofagents/adapter-utils/server-utils";
import {
  discussionEntries,
  discussions,
  internalAgentRuns,
  agentWakeupRequests,
  agents,
  internalAgentConfig,
  issues,
  workQuestions,
} from "@armyofagents/db";
import { listEnabledOutboxAgents } from "./triggers.js";
import { ensureExtractionAgent } from "./ensure-extraction-agent.js";
import { runExtractionConsumer } from "../subagents/extraction-consumer.js";
import { runAoaAgent } from "./runner.js";
import { createLimiter } from "../subagents/concurrency-limiter.js";
import { publishIssueStatusChanged, publishLiveEvent } from "../../live-events.js";
import { logger } from "../../../middleware/logger.js";
import { isRoleActiveAtAutonomy, ROLE_MIN_AUTONOMY, type CrewRole } from "./autonomy.js";
import { resolveCrewRole } from "./resolve-crew-role.js";
import { isCrewPaused } from "./kill-switch.js";
import { runRateExceeded, resolveRoleModel, DEFAULT_CREW_RATE_LIMIT, DEFAULT_CREW_RUN_COUNT_LIMIT } from "../cost-caps.js";
// A3: pre-spend budget hard-stop. budgets.ts lives at services/ root (sibling
// of live-events.ts, imported as ../../live-events.js above), so from
// internal-agent/aoa-agents/ it resolves up TWO levels: ../../budgets.js.
import { budgetService } from "../../budgets.js";
import {
  failUnstartedInternalAgentWorkQuestionContinuation,
  finalizeInternalAgentWorkQuestionContinuation,
} from "../../work-question-continuation-terminal.js";

const WAKEUP_LEASE_MS = 10 * 60 * 1000;
const WAKEUP_LEASE_RENEW_MS = 60 * 1000;

function crewContinuationAttemptKey(idempotencyKey: string, attempt: number) {
  return `${idempotencyKey}:crew-attempt:${Math.max(1, attempt)}`;
}

export async function recoverExpiredCrewWakeup(
  db: Db,
  wakeup: {
    id: string;
    companyId: string;
    agentId: string;
    runId: string | null;
    idempotencyKey: string | null;
    payload: Record<string, unknown> | null;
  },
) {
  const now = new Date();
  const recoveryToken = randomUUID();
  const issueId = typeof wakeup.payload?.issueId === "string" ? wakeup.payload.issueId : null;
  const questionId = typeof wakeup.payload?.questionId === "string" ? wakeup.payload.questionId : null;
  const outcome = await db.transaction(async (tx) => {
    // Keep the same lock order as task closure: task -> question -> wakeup -> run.
    if (issueId) {
      await tx.select({ id: issues.id }).from(issues).where(and(
        eq(issues.id, issueId),
        eq(issues.companyId, wakeup.companyId),
      )).for("update");
    }
    if (questionId) {
      await tx.select({ id: workQuestions.id }).from(workQuestions).where(and(
        eq(workQuestions.id, questionId),
        eq(workQuestions.companyId, wakeup.companyId),
      )).for("update");
    }

    const currentWakeup = await tx.select({
      runId: agentWakeupRequests.runId,
      source: agentWakeupRequests.source,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      attempts: agentWakeupRequests.attempts,
      leaseExpiresAt: agentWakeupRequests.leaseExpiresAt,
    }).from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.id, wakeup.id),
        eq(agentWakeupRequests.companyId, wakeup.companyId),
        eq(agentWakeupRequests.agentId, wakeup.agentId),
        eq(agentWakeupRequests.status, "processing"),
        or(
          isNull(agentWakeupRequests.leaseExpiresAt),
          lte(agentWakeupRequests.leaseExpiresAt, now),
        ),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!currentWakeup) return { kind: "none" as const, terminal: null, releasedIssueId: null };

    const baseKey = currentWakeup.idempotencyKey;
    const attemptKey = baseKey && currentWakeup.source === "work_question_continuation"
      ? crewContinuationAttemptKey(baseKey, currentWakeup.attempts)
      : null;
    let run = currentWakeup.runId
      ? await tx.select({
          id: internalAgentRuns.id,
          status: internalAgentRuns.status,
          errorMessage: internalAgentRuns.errorMessage,
        }).from(internalAgentRuns).where(and(
          eq(internalAgentRuns.id, currentWakeup.runId),
          eq(internalAgentRuns.companyId, wakeup.companyId),
          eq(internalAgentRuns.agentId, wakeup.agentId),
        )).for("update").then((rows) => rows[0] ?? null)
      : null;
    if (!run && attemptKey && baseKey) {
      // Covers a crash after the run insert but before the runner binds runId to
      // the wakeup. The base-key fallback is only valid for attempt one; after
      // that it would rediscover a retired legacy run from an earlier epoch.
      const keys = currentWakeup.attempts === 1 ? [attemptKey, baseKey] : [attemptKey];
      run = await tx.select({
        id: internalAgentRuns.id,
        status: internalAgentRuns.status,
        errorMessage: internalAgentRuns.errorMessage,
      }).from(internalAgentRuns).where(and(
        eq(internalAgentRuns.companyId, wakeup.companyId),
        eq(internalAgentRuns.agentId, wakeup.agentId),
        inArray(internalAgentRuns.continuationIdempotencyKey, keys),
      )).orderBy(desc(internalAgentRuns.createdAt)).for("update").then((rows) => rows[0] ?? null);
    }

    if (!run) {
      await tx.update(agentWakeupRequests).set({
        status: "queued",
        claimedAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        runId: null,
        updatedAt: now,
      }).where(eq(agentWakeupRequests.id, wakeup.id));
      return { kind: "requeued" as const, terminal: null, releasedIssueId: null };
    }

    const [failedRun] = await tx.update(internalAgentRuns).set({
      status: "failed",
      errorMessage: "reclaimed: expired Crew wakeup lease",
      completedAt: now,
    }).where(and(
      eq(internalAgentRuns.id, run.id),
      eq(internalAgentRuns.companyId, wakeup.companyId),
      eq(internalAgentRuns.agentId, wakeup.agentId),
      eq(internalAgentRuns.status, "running"),
    )).returning({ id: internalAgentRuns.id });
    if (!failedRun && ["completed", "failed", "cancelled"].includes(run.status)) {
        const terminalStatus = run.status as "completed" | "failed" | "cancelled";
        const wakeupStatus = terminalStatus === "completed" ? "succeeded" : terminalStatus;
        await tx.update(agentWakeupRequests).set({
          status: wakeupStatus,
          runId: run.id,
          finishedAt: now,
          error: run.errorMessage,
          claimToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        }).where(eq(agentWakeupRequests.id, wakeup.id));
        if (questionId) {
          await tx.update(workQuestions).set({
            continuationRunId: run.id,
            updatedAt: now,
          }).where(and(
            eq(workQuestions.id, questionId),
            eq(workQuestions.companyId, wakeup.companyId),
            eq(workQuestions.continuationRunKind, "internal_agent"),
            eq(workQuestions.continuationStatus, "dispatched"),
            or(isNull(workQuestions.continuationRunId), eq(workQuestions.continuationRunId, run.id)),
          ));
        }
        let releasedIssueId: string | null = null;
        if (terminalStatus !== "completed") {
          const released = await tx.update(issues).set({
            status: "todo",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          }).where(and(
            eq(issues.companyId, wakeup.companyId),
            eq(issues.status, "in_progress"),
            or(eq(issues.checkoutRunId, run.id), eq(issues.executionRunId, run.id)),
          )).returning({ id: issues.id });
          releasedIssueId = released[0]?.id ?? null;
        }
        return {
          kind: "terminal" as const,
          terminal: {
            runId: run.id,
            status: terminalStatus,
            error: run.errorMessage,
          },
          releasedIssueId,
        };
    }
    if (!failedRun) {
      return { kind: "none" as const, terminal: null, releasedIssueId: null };
    }
    await tx.update(agentWakeupRequests).set({
      // Keep the wakeup non-claimable until the old child has exited. The lease
      // makes this recoverable if this process crashes during teardown.
      status: "processing",
      claimToken: recoveryToken,
      leaseExpiresAt: new Date(now.getTime() + WAKEUP_LEASE_MS),
      runId: run.id,
      updatedAt: now,
    }).where(eq(agentWakeupRequests.id, wakeup.id));
    return {
      kind: "retiring" as const,
      runId: run.id,
      terminal: null,
      releasedIssueId: null,
    };
  });
  if (outcome.releasedIssueId) {
    publishIssueStatusChanged(wakeup.companyId, outcome.releasedIssueId, "todo");
  }
  if (outcome.terminal) {
    await finalizeInternalAgentWorkQuestionContinuation(db, {
      companyId: wakeup.companyId,
      runId: outcome.terminal.runId,
      status: outcome.terminal.status,
      error: outcome.terminal.error,
    });
  }
  if (outcome.kind !== "retiring") return outcome.kind;

  requestTrackedProcessTermination(outcome.runId);
  if (!(await waitForTrackedProcessExit(outcome.runId))) return "none" as const;

  return db.transaction(async (tx) => {
    // Revalidate in the canonical task -> question -> wakeup -> run order before
    // making the replacement claimable.
    const issue = issueId
      ? await tx.select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        }).from(issues).where(and(
          eq(issues.id, issueId),
          eq(issues.companyId, wakeup.companyId),
        )).for("update").then((rows) => rows[0] ?? null)
      : null;
    const question = questionId
      ? await tx.select({
          status: workQuestions.status,
          continuationStatus: workQuestions.continuationStatus,
          continuationRunId: workQuestions.continuationRunId,
        }).from(workQuestions).where(and(
          eq(workQuestions.id, questionId),
          eq(workQuestions.companyId, wakeup.companyId),
        )).for("update").then((rows) => rows[0] ?? null)
      : null;
    const parkedWakeup = await tx.select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.id, wakeup.id),
        eq(agentWakeupRequests.companyId, wakeup.companyId),
        eq(agentWakeupRequests.agentId, wakeup.agentId),
        eq(agentWakeupRequests.status, "processing"),
        eq(agentWakeupRequests.claimToken, recoveryToken),
        eq(agentWakeupRequests.runId, outcome.runId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    await tx.select({ id: internalAgentRuns.id }).from(internalAgentRuns).where(and(
      eq(internalAgentRuns.id, outcome.runId),
      eq(internalAgentRuns.companyId, wakeup.companyId),
    )).for("update");

    if (
      !parkedWakeup
      || (issue && (
        ["done", "cancelled"].includes(issue.status)
        || issue.assigneeAgentId !== wakeup.agentId
      ))
      || (question && (
        question.status !== "answered"
        || question.continuationStatus !== "dispatched"
      ))
    ) {
      return "none" as const;
    }

    await tx.update(issues).set({
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(issues.companyId, wakeup.companyId),
      or(eq(issues.checkoutRunId, outcome.runId), eq(issues.executionRunId, outcome.runId)),
    ));
    await tx.update(workQuestions).set({
      continuationRunId: null,
      updatedAt: new Date(),
    }).where(and(
      eq(workQuestions.companyId, wakeup.companyId),
      eq(workQuestions.continuationRunKind, "internal_agent"),
      eq(workQuestions.continuationRunId, outcome.runId),
      eq(workQuestions.continuationStatus, "dispatched"),
    ));
    const requeued = await tx.update(agentWakeupRequests).set({
      status: "queued",
      claimedAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      runId: null,
      updatedAt: new Date(),
    }).where(and(
      eq(agentWakeupRequests.id, wakeup.id),
      eq(agentWakeupRequests.status, "processing"),
      eq(agentWakeupRequests.claimToken, recoveryToken),
    )).returning({ id: agentWakeupRequests.id });
    return requeued.length > 0 ? "requeued" as const : "none" as const;
  });
}

async function failContinuationWakeup(
  db: Db,
  wakeup: { companyId: string; source: string; idempotencyKey: string | null },
  error: string,
) {
  if (wakeup.source !== "work_question_continuation" || !wakeup.idempotencyKey) return;
  await failUnstartedInternalAgentWorkQuestionContinuation(db, {
    companyId: wakeup.companyId,
    idempotencyKey: wakeup.idempotencyKey,
    error,
  });
}

type QueuedWakeupSkipStatus =
  | "skipped_autonomy"
  | "skipped_budget"
  | "skipped_controller_path"
  | "skipped_paused"
  | "skipped_rate_limit"
  | "skipped_routing_off";

async function skipQueuedWakeup(
  db: Db,
  wakeup: {
    id: string;
    companyId: string;
    agentId: string;
    source: string;
    idempotencyKey: string | null;
  },
  status: QueuedWakeupSkipStatus,
  continuationError?: string,
) {
  const now = new Date();
  const skipped = await db.update(agentWakeupRequests)
    .set({ status, finishedAt: now, updatedAt: now })
    .where(and(
      eq(agentWakeupRequests.id, wakeup.id),
      eq(agentWakeupRequests.companyId, wakeup.companyId),
      eq(agentWakeupRequests.agentId, wakeup.agentId),
      eq(agentWakeupRequests.status, "queued"),
    ))
    .returning({ id: agentWakeupRequests.id });
  if (skipped.length === 0) return false;
  if (continuationError) {
    await failContinuationWakeup(db, wakeup, continuationError);
  }
  return true;
}

export interface DispatchOptions {
  /** Max simultaneous extractions per dispatch tick. */
  limiterMax: number;
  /** A 'processing' entry whose LINKED run has been 'running' (non-terminal)
   *  longer than this is treated as orphaned (crash between the M2 atomic
   *  claim and a terminal status). Must be conservatively larger than the
   *  longest legitimate extraction so healthy in-flight is never reset. */
  staleMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// @deprecated — Phase 1 (Task C1): autonomous Scribe outbox drain is OFF by
// default. The pre-existing Phase-2 code path below (per-company outbox-trigger
// gated dispatch of pending discussion entries through `runExtractionConsumer`)
// is preserved for rollback safety and for the existing aoa-dispatcher tests
// that pin its mechanism, but it does NOT fire in production.
//
// Rationale: extraction is now invoked via tools by Memory Keeper (at
// phase=done sweep) and Adjutant (optional, mid-discussion). Firing the LLM
// on every entry was burning calls on entries that no role needed.
//
// Reactivate by setting `AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED=true`. Tests that
// assert legacy autonomous-drain behaviour MUST set this in `beforeEach`.
// When the new tool path is fully exercised in production the gated block can
// be deleted (and the related Phase-1 / Phase-4 reclaim phases — which only
// matter when entries reach 'processing' via the autonomous consumer — can be
// reassessed). Until then we keep all of them intact.
// ─────────────────────────────────────────────────────────────────────────────
function isScribeAutonomousDrainEnabled(): boolean {
  const raw = process.env.AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * AoA Dispatcher — the generalized durable poll (transactional-outbox
 * pattern), not an event listener. Generalizes the battle-tested
 * Decision-#99 extraction sweeper: the committed row
 * `discussion_entries.extractionStatus='pending'` IS the work item, so no
 * event can be "lost" (spec §6.2). Each tick:
 *
 *  1. RECLAIM orphans (spec §6.3) — VERBATIM the #99 linked-run reclaim.
 *     Orphan = entry `processing` AND its **linked current run**
 *     (`extraction_run_id`, set by the consumer at run creation) is still
 *     `running` and older than staleMs. Reclaim atomically: (a) terminalize
 *     that linked run → `failed` so it can never re-trigger reclaim (no
 *     zombie `running` rows, no perpetual re-reclaim of a healthily-
 *     reprocessing entry — the bug the prior join-on-any-running design
 *     produced); (b) reset the entry → `pending`, `extraction_run_id=null`.
 *     Both guarded so they are safe under concurrency with the consumer /
 *     the untouched reprocess path. Using the LINKED run means a stale
 *     leftover run from a *previous* attempt cannot condemn an entry that a
 *     *fresh* run is healthily processing. (Identical predicates to the
 *     extraction sweeper; only the reclaim error message differs.)
 *
 *  2. DRAIN pending (incl. just-reclaimed), GATED PER COMPANY. A pending
 *     entry is only dispatched if its company has an enabled `outbox`
 *     trigger (`listEnabledOutboxAgents`). Companies with no enabled outbox
 *     agent are SKIPPED — they have not opted into the durable extraction
 *     pipeline. For gated-in companies the extraction agent is resolved
 *     (memoized per company) and the consumer invoked under a bounded
 *     limiter. The Milestone-2 atomic claim inside extractFromDiscussionEntry
 *     guarantees at-most-one extraction per entry even under concurrent
 *     pickup.
 *
 * Memoizes BOTH the per-company enabled-outbox check and the per-company
 * extraction agent id once per tick.
 */
export async function runAoaDispatch(db: Db, opts: DispatchOptions): Promise<void> {
  const staleCutoff = new Date(Date.now() - opts.staleMs);

  // ── Phase 1: reclaim orphaned 'processing' entries (#99 verbatim) ──────────
  const orphanRows: Array<{ id: string; runId: string | null }> = await db
    .select({
      id: discussionEntries.id,
      runId: discussionEntries.extractionRunId,
    })
    .from(discussionEntries)
    .leftJoin(
      internalAgentRuns,
      eq(internalAgentRuns.id, discussionEntries.extractionRunId),
    )
    .where(
      // Orphan = a CONSUMER-driven 'processing' entry whose LINKED run is
      // still 'running' and older than the stale window. The consumer links
      // extraction_run_id *before* the atomic claim, so every consumer-driven
      // 'processing' entry has a non-null linked run — there is no consumer
      // path that yields (processing, run_id NULL). The only producer of
      // (processing, run_id NULL) is the untouched reprocess direct-call path
      // (Q2-b), which is HEALTHY in-flight work; a NULL-guard branch would
      // false-reclaim it and cause double extraction. Reprocess-crash
      // recovery is a deferred follow-up (spec §16.1), not in scope here.
      and(
        eq(discussionEntries.extractionStatus, "processing"),
        eq(internalAgentRuns.status, "running"),
        lt(internalAgentRuns.createdAt, staleCutoff),
      ),
    )
    .then((r: Array<{ id: string; runId: string | null }>) => r);

  if (orphanRows.length > 0) {
    const orphanIds = [...new Set(orphanRows.map((o) => o.id))];
    const staleRunIds = [
      ...new Set(
        orphanRows
          .map((o) => o.runId)
          .filter((v): v is string => typeof v === "string"),
      ),
    ];

    // (a) Terminalize the stale linked runs so they can never re-trigger
    //     reclaim. Guarded on status='running' so an already-terminal run is
    //     never clobbered.
    if (staleRunIds.length > 0) {
      await db
        .update(internalAgentRuns)
        .set({
          status: "failed",
          errorMessage: "reclaimed: orphaned (aoa-dispatcher)",
          completedAt: new Date(),
        })
        .where(
          and(
            inArray(internalAgentRuns.id, staleRunIds),
            eq(internalAgentRuns.status, "running"),
          ),
        );
    }

    // (b) Reset the entries → pending. Guarded on status='processing' so it
    //     is safe even if state changed between the select and the update.
    await db
      .update(discussionEntries)
      .set({ extractionStatus: "pending", extractionRunId: null })
      .where(
        and(
          inArray(discussionEntries.id, orphanIds),
          eq(discussionEntries.extractionStatus, "processing"),
        ),
      );
  }

  // ── Phase 2 & Phase 3 SELECTS issued first, in the original positional
  //    order (Phase-2 pending-select THEN Phase-3 wakeup-select), then the two
  //    DRAIN loops run CONCURRENTLY (M4/FX5) ──────────────────────────────────
  //
  // M4: previously Phase-2 (extraction backlog, up to 200/tick) was fully
  // `await`ed before Phase-3 (the @mention / delegate_to_subagent wakeup
  // queue) was even queried, and BOTH shared a single limiter. Under an
  // extraction backlog every wakeup waited behind the entire extraction batch
  // each tick and one noisy company could starve others — a liveness defect
  // for the delegation/@mention path. Phase-2 and Phase-3 have NO data
  // dependency (disjoint tables/rows: pending discussion entries vs the
  // agent_wakeup_requests queue), so their DRAINS now overlap via
  // Promise.all, each under its OWN limiter so an extraction backlog cannot
  // consume the slots the wakeup drain needs. Phase-1 still runs first and
  // fully awaited (ordering invariant: it resets orphans → 'pending', which
  // Phase-2's pending-select below must see). The two SELECT queries are
  // still issued synchronously here in the original order (Phase-2 then
  // Phase-3) — only the drain loops are parallelized, so the positional
  // select order other suites depend on is unchanged. No double-processing:
  // Phase-2 is keyed by entry + the M2 atomic claim; Phase-3 by the
  // per-wakeup atomic queued→processing claim — both already idempotent and
  // they touch disjoint rows, so overlapping them changes nothing there.
  const rows: Array<{ id: string; companyId: string }> = await db
    .select({ id: discussionEntries.id, companyId: discussions.companyId })
    .from(discussionEntries)
    .innerJoin(discussions, eq(discussions.id, discussionEntries.discussionId))
    // P1-T7 defense-in-depth: never feed a scope_proposal entry to the LLM
    // extractor. Proposals carry their approval lifecycle in proposalStatus and
    // are inserted extractionStatus="skipped" so this filter is normally moot,
    // but excluding by inputType here guarantees that even a mis-inserted
    // proposal (extractionStatus="pending") can't be claimed by the drain and
    // have its approval state clobbered (pending -> processing -> completed).
    .where(
      and(
        eq(discussionEntries.extractionStatus, "pending"),
        notInArray(discussionEntries.inputType, ["scope_proposal"]),
      ),
    )
    .limit(200)
    .then((r: Array<{ id: string; companyId: string }>) => r);

  // T1.2 (codex F6): also read agentWakeupRequests.source so the dispatcher
  // can pass the ORIGINAL trigger source through to runAoaAgent — previously
  // hardcoded "wakeup" in the runAoaAgent call below, which made the prompt's
  // trigger-context block lie about what actually triggered the run.
  // C3: project agents.runtimeConfig (the fetch already INNER JOINs agents) so
  // the activation gate can identify Commander (founder-proxy) by
  // runtimeConfig.aoa.role === 'lead' WITHOUT an extra per-wakeup db.select.
  // Commander has no trigger role → resolveCrewRole returns null → it would be
  // treated Drive-only and wrongly skipped_autonomy at dial 0/1; the exemption
  // below lets it run unconditionally (like inbox-routing).
  const wakeupRows: Array<{ id: string; agentId: string; companyId: string; source: string; status: string; attempts: number; idempotencyKey: string | null; runId: string | null; payload: Record<string, unknown> | null; runtimeConfig: Record<string, unknown> | null }> = await db
    .select({
      id: agentWakeupRequests.id,
      agentId: agentWakeupRequests.agentId,
      companyId: agentWakeupRequests.companyId,
      source: agentWakeupRequests.source,
      status: agentWakeupRequests.status,
      attempts: agentWakeupRequests.attempts,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      runId: agentWakeupRequests.runId,
      payload: agentWakeupRequests.payload,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agentWakeupRequests)
    .innerJoin(agents, eq(agents.id, agentWakeupRequests.agentId))
    .where(
      and(
        or(
          eq(agentWakeupRequests.status, "queued"),
          and(
            eq(agentWakeupRequests.status, "processing"),
            or(
              isNull(agentWakeupRequests.leaseExpiresAt),
              lte(agentWakeupRequests.leaseExpiresAt, new Date()),
            ),
          ),
        ),
        eq(agents.kind, "aoa"),
        notInArray(agents.status, ["paused", "terminated"]),
      ),
    )
    .limit(200)
    .then((r) => r);

  // Each phase gets its OWN limiter so an extraction backlog (Phase-2) cannot
  // exhaust every slot the wakeup drain (Phase-3) needs — the whole point of
  // the M4 fix. limiterMax / its call-site value are unchanged.
  const p2Limiter = createLimiter(opts.limiterMax);
  const p3Limiter = createLimiter(opts.limiterMax);

  const drainPhase2 = async (): Promise<void> => {
    if (rows.length === 0) return;
    // ── Phase 1 (Task C1): autonomous Scribe drain gated OFF by default ──────
    // The SELECT above still runs so the positional-select order other suites
    // depend on is byte-stable (slot 1 = pending-drain) and so the legacy
    // Phase-1 / Phase-4 reclaim phases can still observe what is or isn't
    // pending. Only the dispatch through `runExtractionConsumer` is gated.
    //
    // When the flag is OFF, Memory Keeper (phase=done sweep) and Adjutant
    // (optional, mid-discussion) own extraction — they call the tool-callable
    // functions in `services/extraction.ts` (extractMemoryCandidates, etc.).
    // Set `AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED=true` to reactivate the legacy
    // outbox drain (tests that pin its mechanism do this in `beforeEach`).
    if (!isScribeAutonomousDrainEnabled()) return;

    // Per-company memoization within this tick: the enabled-outbox gate result
    // (true = has an enabled outbox agent) and the resolved extraction agent id.
    const outboxByCompany = new Map<string, boolean>();
    const agentByCompany = new Map<string, string>();

    await Promise.allSettled(
      rows.map((row) =>
        p2Limiter.run(async () => {
          // Gate: only dispatch if the company has an enabled `outbox` trigger.
          let gated = outboxByCompany.get(row.companyId);
          if (gated === undefined) {
            const enabled = await listEnabledOutboxAgents(db, row.companyId);
            gated = enabled.length > 0;
            outboxByCompany.set(row.companyId, gated);
          }
          if (!gated) return; // no outbox trigger for this company → skip

          let agentId = agentByCompany.get(row.companyId);
          if (!agentId) {
            agentId = await ensureExtractionAgent(db, row.companyId);
            agentByCompany.set(row.companyId, agentId);
          }
          await runExtractionConsumer(db, row.companyId, row.id, agentId);
        }),
      ),
    );
  };

  // Per-company config memoization within this tick (autonomy + kill-switch + model + routing dial).
  // D18: crew reads `crewAutonomyLevel`, NOT `autonomyLevel` (Commander-only).
  const configByCompany = new Map<string, { crewAutonomyLevel: number; crewPaused: boolean; model: string; inboundRoutingLevel: string }>();
  async function resolveCompanyConfig(companyId: string): Promise<{ crewAutonomyLevel: number; crewPaused: boolean; model: string; inboundRoutingLevel: string }> {
    if (configByCompany.has(companyId)) return configByCompany.get(companyId)!;
    const [cfg] = await db
      .select({ crewAutonomyLevel: internalAgentConfig.crewAutonomyLevel, crewPaused: internalAgentConfig.crewPaused, model: internalAgentConfig.model, inboundRoutingLevel: internalAgentConfig.inboundRoutingLevel })
      .from(internalAgentConfig)
      .where(eq(internalAgentConfig.companyId, companyId))
      .limit(1);
    const config = {
      // Fail-closed: no config row → Manual (0).
      crewAutonomyLevel: cfg?.crewAutonomyLevel ?? 0,
      crewPaused: cfg?.crewPaused ?? false,
      model: (cfg?.model ?? "claude-sonnet-4-6") as string,
      // D4: inbound routing has its own dial, distinct from crew autonomy.
      // Default 'off' when no config row exists — teams opt-in explicitly.
      inboundRoutingLevel: (cfg?.inboundRoutingLevel ?? "off") as string,
    };
    configByCompany.set(companyId, config);
    return config;
  }
  const drainPhase3 = async (): Promise<void> => {
    if (wakeupRows.length === 0) return;
    await Promise.allSettled(
      wakeupRows.map((w) =>
        p3Limiter.run(async () => {
          if (w.status === "processing") {
            const recovery = await recoverExpiredCrewWakeup(db, w);
            if (recovery !== "requeued") return;
          }

          const companyCfg = await resolveCompanyConfig(w.companyId);

          // D4: inbox-routing wakeups are gated on the routing dial
          // (inboundRoutingLevel), NOT on crew autonomy. The Navigator must
          // be dispatchable to route inbound items even when autonomyLevel=0.
          // #4: the payload deliberately omits threadId so the thread-level
          // pause/controller skips cannot silently swallow the escalation.
          const isInboxRouting = w.source === "inbox.routing_ambiguous";
          // Chronicler is infrastructure-level (autonomy 0): it can maintain
          // thread summaries without the crew autonomy dial being on, but it
          // still honors explicit company/thread pause. It only bypasses the
          // controller-path gate so summary maintenance is not swallowed by
          // strangler routing on modern threads.
          const isInfraSweep = w.source === "sweep.chronicler";
          if (isInboxRouting) {
            if (companyCfg.inboundRoutingLevel === "off") {
              const skipped = await skipQueuedWakeup(db, w, "skipped_routing_off");
              if (!skipped) return;
              logger.child({ subagent: "aoa-dispatcher" }).info(
                { wakeupId: w.id, companyId: w.companyId },
                "aoa wakeup skipped: inbound routing dial off",
              );
              return;
            }
            // suggest / auto_attach / full_auto → fall through to rate-brake,
            // atomic claim, and runAoaAgent dispatch below.
          }

          // Plan 3 Task 8: kill-switch gate — check company pause first.
          // Thread-level pause is read live from discussions.crewPaused so a
          // founder's pause/resume is reflected immediately, even for wakeups
          // that were already queued before the pause. Payload-based
          // threadCrewPaused is NOT used — nothing populates it at enqueue
          // time, so reading it would make the gate permanently inert.
          //
          // UAT iteration 2 fix: the wakeup payload uses `threadId` (set by
          // the mention parser in threads.ts, sweep-adjutant, sweep-memory-
          // keeper, notify-owner-tool) — NOT `discussionId`. Reading
          // `discussionId` made this gate silently inert because the lookup
          // key never matched. `threads` and `discussions` are the same
          // table; `threadId` IS the discussion's primary key.
          //
          // #3 / #4: inbox-routing wakeups have no threadId (by design) and
          // must NOT be gated by thread-level pause or controller-path checks.
          // The isInboxRouting branch above returns early on 'off', so by the
          // time we reach here, inbox-routing wakeups have inboundRoutingLevel
          // != 'off' and must fall straight through to dispatch.
          // Infra sweeps (Chronicler) still read the thread row so pause applies,
          // but bypass the controller-path gate to keep summary maintenance from
          // being swallowed by strangler routing.
          const threadIdInPayload = (w.payload as Record<string, unknown> | null)?.threadId;
          const threadRow = !isInboxRouting && typeof threadIdInPayload === "string" && threadIdInPayload.length > 0
            ? await db
                .select({
                  crewPaused: discussions.crewPaused,
                  useControllerPath: discussions.useControllerPath,
                  autonomyLevel: discussions.autonomyLevel,
                })
                .from(discussions)
                // Cross-tenant guard (defence-in-depth): these thread flags
                // (crewPaused / useControllerPath / autonomyLevel) GATE crew
                // dispatch, and threadIdInPayload originates from the wakeup
                // payload — which can be caller-supplied via agent.dispatch.
                // Scope the read to the wakeup's own company so a foreign
                // thread id resolves to NO row (safe defaults below), never a
                // different tenant's flags. Layer 1 (agent-dispatch.ts) already
                // refuses foreign ids at the source; this is belt-and-braces.
                .where(and(
                  eq(discussions.id, threadIdInPayload),
                  eq(discussions.companyId, w.companyId),
                ))
                .then((rows: Array<{
                  crewPaused: boolean | null;
                  useControllerPath: boolean | null;
                  autonomyLevel: number | null;
                }>) => rows[0] ?? null)
            : null;
          // Thread-level pause is skipped only for inbox-routing (#3/#4). Infra
          // sweeps still obey pause, but controller-path checks only apply to
          // peer-wake agent work.
          if (!isInboxRouting) {
            const threadPaused = Boolean(threadRow?.crewPaused);
            if (isCrewPaused({ companyPaused: companyCfg.crewPaused, threadPaused })) {
              // P2 fix: distinct terminal status so the wakeup table tells you
              // WHY a wakeup ended, not just that it ended. Was collapsed into
              // 'done' which made silent failures invisible.
              const skipped = await skipQueuedWakeup(
                db,
                w,
                "skipped_paused",
                "Crew continuation blocked by the crew pause policy",
              );
              if (!skipped) return;
              logger.child({ subagent: "aoa-dispatcher" }).info(
                { agentId: w.agentId, companyId: w.companyId, threadPaused },
                "aoa wakeup skipped: crew kill-switch active",
              );
              return;
            }

            // P1-T11: Defense-in-depth gate — controller-path threads are driven
            // by the orchestration controller, not the peer-wake pipeline. Any
            // wakeup that slipped through (e.g. from a pre-T11 row) is skipped.
            //
            // Task 1.1: TERMINALIZE before returning. Pre-fix this branch just
            // `return`ed, leaving the wakeup 'queued' forever (confirmed live: a
            // stranded queued row, re-evaluated every tick, never reaped). Mirror
            // the sibling skip branches (skipped_paused / skipped_autonomy /
            // skipped_rate_limit / skipped_budget): write a distinct terminal
            // status + finishedAt so the wakeup table records WHY it ended.
            if (!isInfraSweep && threadRow?.useControllerPath) {
              const skipped = await skipQueuedWakeup(db, w, "skipped_controller_path");
              if (!skipped) return;
              logger.child({ subagent: "aoa-dispatcher" }).debug(
                { wakeupId: w.id },
                "peer-wake skipped: controller-path thread",
              );
              return;
            }
          }

          // C1/C2 — unify the dial. effectiveAutonomy = thread.autonomyLevel ??
          // company is resolved HERE, BEFORE the activation gate, so the gate
          // and the runner read the SAME dial. Previously this was computed
          // AFTER the atomic claim and fed only to the runner, while the gate
          // read companyCfg.crewAutonomyLevel — they diverged for thread-bearing
          // wakeups (C1: thread=Drive/company=Manual silently killed the
          // per-thread override; C2: thread=Manual/company=Drive ran + burned an
          // LLM call the completion gate then refused). Resolution logic is
          // identical to the prior post-claim block: default company; if the
          // payload carries a string threadId, look up discussions.autonomyLevel
          // and use thread.autonomyLevel ?? company. Task wakeups (no threadId),
          // infra-sweep, and inbox-routing therefore keep effectiveAutonomy =
          // company exactly as before — only thread-bearing wakeups change.
          const wkPayload = (w.payload ?? {}) as Record<string, unknown>;
          let effectiveAutonomy: number = companyCfg.crewAutonomyLevel;
          if (typeof wkPayload.threadId === "string") {
            if (threadRow) {
              effectiveAutonomy = threadRow.autonomyLevel ?? companyCfg.crewAutonomyLevel;
            }
          }

          // Autonomy gate applies to all non-inbox-routing wakeups (including
          // the Chronicler, which passes at chronicler:0). C3: Commander
          // (founder-proxy, runtimeConfig.aoa.role==='lead') is ALSO exempt —
          // it has no crew trigger role, so the fail-closed "no role → Drive-
          // only" default would wrongly skip a founder delegation at dial 0/1.
          // It runs unconditionally, like inbox-routing.
          const isCommander = (w.runtimeConfig as Record<string, unknown> | null)?.aoa != null
            && ((w.runtimeConfig as { aoa?: { role?: unknown } }).aoa?.role === "lead");
          // Founder decision (2026-07-04): the company crew-autonomy dial gates
          // agent-INITIATED work only (mentions, sweeps, phase-advance). Explicit
          // founder/upstream authorization of a SPECIFIC task always dispatches —
          // the authorization already happened upstream (crew_dispatch approval +
          // planning→standard flip + preflightCrewDispatch for Assist;
          // resolveScopeAutoAcceptGate≥2 for Drive; a direct founder assignment;
          // dependency-unblock of already-scoped work). crewPaused stays the kill-
          // switch (checked above, BEFORE this gate) and every other guard (thread-
          // pause, spend/run-count brakes, budget hard-stop) still applies below.
          //
          // P1-2: there is NO single chokepoint to stamp — the PATCH /issues/:id
          // reassign path builds its own wakeup (routes/issues.ts) and bypasses
          // enqueueIssueAssigneeWakeup. So key the exemption on the wakeup PAYLOAD,
          // not a stamp: a task-dispatch wakeup carries `payload.issueId` (string)
          // AND `source` ∈ {assignment, automation} — the only two sources both the
          // chokepoint (issue-assignee-wakeup.ts) and the PATCH-reassign path use.
          // Mention/sweep wakeups use `thread_mention`/`sweep.*` and carry no
          // issueId, so they stay gated (agent initiative).
          const isTaskDispatch = typeof wkPayload.issueId === "string"
            && (w.source === "assignment" || w.source === "automation" || w.source === "work_question_continuation");
          if (!isInboxRouting && !isCommander && !isTaskDispatch) {
            // Plan 3 Task 4: autonomyLevel gate — agentic crew roles (router,
            // planner, dispatcher) require autonomyLevel ≥ 2. Core roles
            // (scribe, memory_keeper, curator) are always active (min = 0).
            //
            // UAT iteration 2 contract: ALL wakeup enqueue sites populate
            // payload.role with the crew role key (router/planner/maker/...).
            // - Sweeps: sweep-adjutant + sweep-memory-keeper already do this.
            // - Mentions: threads.ts processMentions now does this too (looks
            //   up aoaAgentTriggers.config.role). Without that, every @Router
            //   / @Planner / @Dispatcher mention bypassed the gate.
            // runtimeConfig.aoa.role is NOT the source — that field is always
            // the literal string "member" (a template default, never
            // specialized per agent). Don't read it.
            // A2 — FAIL CLOSED. The pre-fix gate only fired
            // `if (payloadRole && !isRoleActiveAtAutonomy(...))`, so a wakeup
            // with NO payload.role skipped the gate and ran regardless of the
            // dial (the live bug). Now resolve the role — payload.role first
            // (only if it's a KNOWN crew role), else the durable
            // aoaAgentTriggers lookup (resolveCrewRole). An unresolved/unknown
            // role must NOT be a free pass: treat it as Drive-only (the most
            // restrictive default — only autonomyLevel ≥ 2 runs it).
            const payloadRole = (w.payload as Record<string, unknown> | null)?.role as string | undefined;
            const resolvedRole = (payloadRole && (Object.keys(ROLE_MIN_AUTONOMY) as string[]).includes(payloadRole))
              ? (payloadRole as CrewRole)
              : await resolveCrewRole(db, w.agentId);
            // C1/C2: gate on effectiveAutonomy (thread override ?? company), NOT
            // the raw company dial — so the activation gate and the completion
            // gate read the SAME dial. For task wakeups / infra-sweep / inbox-
            // routing effectiveAutonomy === companyCfg.crewAutonomyLevel, so their
            // behavior is unchanged.
            const roleActive = resolvedRole
              ? isRoleActiveAtAutonomy(resolvedRole, effectiveAutonomy)
              : effectiveAutonomy >= 2; // no role → only at Drive
            if (!roleActive) {
              // P2 fix: distinct terminal status (was 'done'). The wakeup was
              // correctly queued but the autonomy level prevents execution for
              // agentic roles. Mark explicitly so the wakeup table is debuggable.
              const skipped = await skipQueuedWakeup(
                db,
                w,
                "skipped_autonomy",
                "Crew continuation blocked by the autonomy policy",
              );
              if (!skipped) return;
              logger.child({ subagent: "aoa-dispatcher" }).info(
                { agentId: w.agentId, role: resolvedRole ?? null, autonomy: effectiveAutonomy, companyAutonomy: companyCfg.crewAutonomyLevel, companyId: w.companyId },
                "aoa wakeup skipped: autonomy gate (fail-closed)",
              );
              return;
            }
          }

          // T1.1: rate-brake counts only PAID runs (costCents > 0). Fast-
          // failing $0 runs (e.g. broken adapter exiting in <1s) don't
          // contribute to the LLM-spend safety net — the brake's actual
          // purpose. A separate failure-storm brake (T1.9) catches runaway
          // failure loops independently of cost. Codex finding #3+#5.
          const windowStart = new Date(Date.now() - DEFAULT_CREW_RATE_LIMIT.windowMinutes * 60_000);
          const windowRuns = await db
            .select({ id: internalAgentRuns.id })
            .from(internalAgentRuns)
            .where(and(
              eq(internalAgentRuns.companyId, w.companyId),
              gt(internalAgentRuns.createdAt, windowStart),
              gt(internalAgentRuns.costCents, 0), // T1.1: only paid runs
            ))
            .then((r: Array<{ id: string }>) => r.length);
          if (runRateExceeded(windowRuns, DEFAULT_CREW_RATE_LIMIT.maxRunsPerWindow)) {
            // P2 fix: distinct terminal status (was 'done'). Rate-limit skips
            // were the dominant cause of "wakeup vanished" symptoms before
            // P1-B was fixed — now they're visible in the wakeup table.
            const skipped = await skipQueuedWakeup(
              db,
              w,
              "skipped_rate_limit",
              "Crew continuation blocked by the run-rate limit",
            );
            if (!skipped) return;
            logger.child({ subagent: "aoa-dispatcher" }).warn(
              { agentId: w.agentId, windowRuns, limit: DEFAULT_CREW_RATE_LIMIT.maxRunsPerWindow, companyId: w.companyId },
              "aoa wakeup skipped: run-rate brake (D3)",
            );
            return;
          }

          // A5 (T1.9): run-COUNT brake. The D3 spend brake above counts ONLY
          // paid runs (costCents > 0), so it is BLIND to $0 CLI-subscription
          // runs — exactly what a runaway crew loop produces. This separate
          // brake counts EVERY crew run in the window (no cost filter), so a
          // tight $0 loop is caught regardless of spend. Kept SEPARATE from the
          // spend brake (different window + threshold) so neither weakens the
          // other.
          const countWindowStart = new Date(Date.now() - DEFAULT_CREW_RUN_COUNT_LIMIT.windowMinutes * 60_000);
          const allWindowRuns = await db
            .select({ id: internalAgentRuns.id })
            .from(internalAgentRuns)
            .where(and(
              eq(internalAgentRuns.companyId, w.companyId),
              gt(internalAgentRuns.createdAt, countWindowStart),
            )) // NO costCents filter — count every run
            .then((r: Array<{ id: string }>) => r.length);
          if (runRateExceeded(allWindowRuns, DEFAULT_CREW_RUN_COUNT_LIMIT.maxRunsPerWindow)) {
            const skipped = await skipQueuedWakeup(
              db,
              w,
              "skipped_rate_limit",
              "Crew continuation blocked by the run-count limit",
            );
            if (!skipped) return;
            logger.child({ subagent: "aoa-dispatcher" }).warn(
              { agentId: w.agentId, allWindowRuns, limit: DEFAULT_CREW_RUN_COUNT_LIMIT.maxRunsPerWindow, companyId: w.companyId },
              "aoa wakeup skipped: run-count brake (T1.9)",
            );
            return;
          }

          // Plan 3 Task 9: resolve per-role model (role config > company default).
          // The resolved model is passed in the payload so runner.ts can use it.
          const agentRow = await db
            .select({ runtimeConfig: agents.runtimeConfig, adapterConfig: agents.adapterConfig })
            .from(agents)
            .where(eq(agents.id, w.agentId))
            .then((r: Array<{ runtimeConfig: unknown; adapterConfig: unknown }>) => r[0] ?? null);
          const agentRc = (agentRow?.runtimeConfig as Record<string, unknown>) ?? {};
          const agentAdapterCfg = (agentRow?.adapterConfig as Record<string, unknown>) ?? {};
          const roleModel = resolveRoleModel({
            roleModel: (agentRc.model ?? agentAdapterCfg.model ?? null) as string | null,
            companyDefault: companyCfg.model,
          });

          // A3: pre-spend budget hard-stop (per-agent + company). Returns a reason
          // string when blocked, null when clear. Runs as the LAST gate before the
          // atomic claim so we never spend on a run the budget policy forbids.
          const budgetBlock = await budgetService(db).getInvocationBlock(w.agentId, w.companyId);
          if (budgetBlock) {
            const skipped = await skipQueuedWakeup(
              db,
              w,
              "skipped_budget",
              `Crew continuation blocked by budget policy: ${budgetBlock}`,
            );
            if (!skipped) return;
            logger.child({ subagent: "aoa-dispatcher" }).warn(
              { agentId: w.agentId, companyId: w.companyId, reason: budgetBlock },
              "aoa wakeup skipped: budget hard-stop",
            );
            return;
          }

          // Atomic claim: queued → processing
          const claimToken = randomUUID();
          const claimedAt = new Date();
          const claimed = await db
            .update(agentWakeupRequests)
            .set({
              status: "processing",
              claimedAt,
              claimToken,
              leaseExpiresAt: new Date(claimedAt.getTime() + WAKEUP_LEASE_MS),
              attempts: sql`${agentWakeupRequests.attempts} + 1`,
              updatedAt: claimedAt,
            })
            .where(and(
              eq(agentWakeupRequests.id, w.id),
              eq(agentWakeupRequests.companyId, w.companyId),
              eq(agentWakeupRequests.agentId, w.agentId),
              eq(agentWakeupRequests.status, "queued"),
            ))
            .returning({ id: agentWakeupRequests.id, attempts: agentWakeupRequests.attempts });
          if (claimed.length === 0) return; // already claimed by concurrent tick

          const leaseRenewal = setInterval(() => {
            const now = new Date();
            void db
              .update(agentWakeupRequests)
              .set({
                leaseExpiresAt: new Date(now.getTime() + WAKEUP_LEASE_MS),
                updatedAt: now,
              })
              .where(and(
                eq(agentWakeupRequests.id, w.id),
                eq(agentWakeupRequests.companyId, w.companyId),
                eq(agentWakeupRequests.agentId, w.agentId),
                eq(agentWakeupRequests.status, "processing"),
                eq(agentWakeupRequests.claimToken, claimToken),
              ))
              .catch((error: unknown) => {
                logger.child({ subagent: "aoa-dispatcher" }).warn(
                  { err: error, wakeupId: w.id },
                  "aoa wakeup lease renewal failed",
                );
              });
          }, WAKEUP_LEASE_RENEW_MS);
          leaseRenewal.unref?.();

          // D10/C1/C2: effectiveAutonomy (thread override ?? company) was already
          // resolved BEFORE the activation gate above and reused here, so the gate
          // and the runner read the SAME dial. (Previously a SECOND, post-claim
          // lookup computed it only for the runner while the gate read the raw
          // company dial — the divergence this fix removes.)
          try {
            // T1.0: runAoaAgent now returns AoaRunResult. The wakeup row
            // reflects the actual outcome (succeeded/failed) the runner
            // reports, not just whether it threw. Cost/usage already
            // persisted to internal_agent_runs by the runner itself.
            const continuationAttemptIdempotencyKey = w.source === "work_question_continuation" && w.idempotencyKey
              ? crewContinuationAttemptKey(w.idempotencyKey, claimed[0]!.attempts)
              : null;
            const result = await runAoaAgent(db, w.agentId, {
              // L2 / SECURITY (Layer B): spread the stored payload FIRST, then set
              // EVERY trusted, server-resolved field AFTER it so a seeded or
              // attacker-controlled `w.payload` can never override them (last-key-
              // wins). Originally only `effectiveAutonomy` was defended this way;
              // `companyId` sat BEFORE the spread and a smuggled `payload.companyId`
              // (via agent.dispatch context) could redirect the run into another
              // tenant — the run's live MCP tools then operated on the foreign
              // company's tasks/memory/artifacts. The run's company is the wakeup
              // row's trusted `w.companyId`, full stop. `source`, `wakeupId`, and
              // `resolvedModel` are likewise server-resolved (wakeup row columns /
              // per-role model resolution) and must not be payload-overridable.
              ...(w.payload ?? {}),
              ...(continuationAttemptIdempotencyKey
                ? {
                    continuationIdempotencyKey: w.idempotencyKey,
                    continuationAttemptIdempotencyKey,
                  }
                : {}),
              companyId: w.companyId,
              // T1.2 (codex F6): pass the wakeup's ORIGINAL source (e.g.
              // 'thread_mention', 'sweep.adjutant', 'phase-advance') NOT the
              // hardcoded 'wakeup'. The runner's role-aware trigger prompt
              // shows the LLM exactly what triggered this run.
              source: w.source,
              wakeupId: w.id,
              resolvedModel: roleModel, // Plan 3 Task 9: pass resolved model to runner
              // effectiveAutonomy (thread override ?? company dial) stays AFTER the
              // spread so the gate and the runner read the SAME dial.
              effectiveAutonomy,
            });
            // P2 + T1.0: status reflects what the runner actually saw.
            // 'succeeded' = adapter exited cleanly with no errorMessage.
            // 'failed' = adapter exitCode != 0, errorMessage set, or a
            // runner guard tripped (e.g. silent-failure guard from T1.5).
            await db
              .update(agentWakeupRequests)
              .set({
                status: result.status,
                error: result.errorMessage ?? null,
                runId: result.runId ?? null,
                finishedAt: new Date(),
                claimToken: null,
                leaseExpiresAt: null,
              })
              .where(and(
                eq(agentWakeupRequests.id, w.id),
                eq(agentWakeupRequests.companyId, w.companyId),
                eq(agentWakeupRequests.agentId, w.agentId),
                eq(agentWakeupRequests.status, "processing"),
                eq(agentWakeupRequests.claimToken, claimToken),
              ));
          } catch (err: unknown) {
            await db
              .update(agentWakeupRequests)
              .set({
                status: "failed",
                error: err instanceof Error ? err.message : String(err),
                finishedAt: new Date(),
                claimToken: null,
                leaseExpiresAt: null,
              })
              .where(and(
                eq(agentWakeupRequests.id, w.id),
                eq(agentWakeupRequests.companyId, w.companyId),
                eq(agentWakeupRequests.agentId, w.agentId),
                eq(agentWakeupRequests.status, "processing"),
                eq(agentWakeupRequests.claimToken, claimToken),
              ));
          } finally {
            clearInterval(leaseRenewal);
          }
        }),
      ),
    );
  };

  // Drains overlap; selects above already ran in the original order.
  await Promise.all([drainPhase2(), drainPhase3()]);

  // ── Phase 4 (FX1/B1): disjoint reclaim — 'processing' entries whose LINKED
  //    run is already 'failed' ────────────────────────────────────────────────
  // Phase 1 handles entries whose linked run is still 'running' & stale (crash
  // mid-flight) → reset to 'pending' for a retry. This phase handles a
  // DIFFERENT terminal case: the runner's catch terminalized the RUN →
  // 'failed' but (pre-FX1) left the entry stuck 'processing' forever — silent
  // permanent loss. The run already failed, so retrying is wrong — terminalize
  // the ENTRY → 'failed' (NOT 'pending') + emit the
  // discussion.extraction.failed LiveEvent. Mirrors extraction.ts's failure
  // branch (status + sourceInfo.extractionError + event; NO notification).
  // Disjoint from Phase 1 (linked run 'running' vs 'failed' are mutually
  // exclusive) and from the runner's own in-process terminalizer (this is the
  // durable safety net for a run that died before it could run its catch —
  // e.g. SIGKILL). Runs LAST: it neither feeds Phase 2 (output is terminal
  // 'failed', not 'pending') nor interacts with the Phase 3 wakeup queue, so
  // ordering is irrelevant to correctness. Each transition individually
  // guarded; per-entry best-effort so one failure can't abort the tick.
  const failedRunRows: Array<{
    id: string;
    discussionId: string;
    companyId: string;
  }> = await db
    .select({
      id: discussionEntries.id,
      discussionId: discussionEntries.discussionId,
      companyId: discussions.companyId,
    })
    .from(discussionEntries)
    .innerJoin(discussions, eq(discussions.id, discussionEntries.discussionId))
    .leftJoin(
      internalAgentRuns,
      eq(internalAgentRuns.id, discussionEntries.extractionRunId),
    )
    .where(
      and(
        eq(discussionEntries.extractionStatus, "processing"),
        eq(internalAgentRuns.status, "failed"),
      ),
    )
    .limit(200)
    .then(
      (
        r: Array<{ id: string; discussionId: string; companyId: string }>,
      ) => r,
    );

  if (failedRunRows.length > 0) {
    const reclaimErr = "reclaimed: extraction run failed (aoa-dispatcher)";
    for (const fr of failedRunRows) {
      // Guarded on status='processing' so a concurrent transition is never
      // clobbered.
      try {
        await db
          .update(discussionEntries)
          .set({
            extractionStatus: "failed",
            sourceInfo: sql`jsonb_set(COALESCE(${discussionEntries.sourceInfo}, '{}'::jsonb), '{extractionError}', ${JSON.stringify(reclaimErr)}::jsonb)`,
          })
          .where(
            and(
              eq(discussionEntries.id, fr.id),
              eq(discussionEntries.extractionStatus, "processing"),
            ),
          );
      } catch (updateErr: unknown) {
        logger
          .child({ subagent: "aoa-dispatcher" })
          .error(
            { err: updateErr, entryId: fr.id },
            "Phase-4: failed to terminalize entry with failed linked run",
          );
      }
      publishLiveEvent({
        companyId: fr.companyId,
        type: "discussion.extraction.failed",
        payload: {
          discussionId: fr.discussionId,
          entryId: fr.id,
          error: reclaimErr,
        },
      });
    }
  }

  logger
    .child({ subagent: "aoa-dispatcher" })
    .info(
      {
        reclaimed: orphanRows.length,
        failedRunReclaimed: failedRunRows.length,
        drained: rows.length,
        wakeups: wakeupRows.length,
      },
      "aoa dispatch complete",
    );
}
