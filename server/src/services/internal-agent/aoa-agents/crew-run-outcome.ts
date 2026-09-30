/**
 * W3a (D4) — Composed crew run-outcome side-effects.
 *
 * When a CREW agent (kind='aoa') finishes a task, its result must post back
 * into the originating discussion thread (loopback) AND get a run-summary
 * comment on the task — the treatment ORG agents already get from heartbeat.
 * These are the composed functions the crew runner calls as ONE best-effort
 * call per outcome, so the exact SEQUENCE the runner runs is a single tested
 * unit (D4) rather than loose calls scattered in runner.ts:
 *   - postCrewRunSuccess: relay ("Completed: …")   THEN success run-summary.
 *   - postCrewRunFailure: failure card ("… could not complete …", crew_thread
 *     origin only) THEN failure run-summary.
 *
 * Best-effort granularity: each sub-step (relay/card, summary) is wrapped in its
 * OWN try/catch inside the composed function, so a relay failure does NOT skip
 * the summary (and vice-versa). The runner then wraps the whole call in one
 * more try/catch as defence-in-depth. Neither the sub-steps nor the composed
 * function ever throws.
 *
 * Acyclic imports: this module imports only leaves —
 *   - run-summary-comment.js  (imports run-summary.js + adapters/utils.js + logger)
 *   - crew-result-relay.js    (imports live-events.js + logger)
 *   - crew-failure-card.js    (imports live-events.js + logger)
 * — and the runner dynamic-imports THIS module. No cycle.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { issues } from "@armyofagents/db";
import { logger } from "../../../middleware/logger.js";
import {
  relayCrewResult,
  deliverCrewRunResult,
  type DeliverCrewRunResultInput,
} from "../../crew-result-relay.js";
import { postCrewFailureCard } from "../../crew-failure-card.js";
import {
  postRunSummaryComment,
  type PostRunSummaryCommentInput,
} from "../../run-summary-comment.js";

const log = logger.child({ svc: "crew-run-outcome" });

/**
 * W3a (holistic finding) — the DISPATCH rule the runner uses to pick which
 * loopback fires for a completed (non-throwing) run: a `succeeded` run routes
 * to postCrewRunSuccess, a `failed` run to postCrewRunFailure. The runner's
 * SUCCESS wiring site (after the internal_agent_runs completion write) must
 * handle BOTH statuses — an adapter can report a non-zero exit / errorMessage /
 * transport failure and produce `runResult.status === "failed"` WITHOUT throwing,
 * so it never reaches the catch (whose failure loopback is for THROWN failures).
 * Before this rule the non-throw-failure path silently posted no failure card /
 * summary. Pure + exported so the "which loopback for which status" decision is
 * a tested unit (mirrors buildAoaRunResultFromAdapter's D4 philosophy).
 */
export function resolveCrewOutcomeKind(
  status: "succeeded" | "failed",
): "success" | "failure" {
  return status === "succeeded" ? "success" : "failure";
}

export interface CrewRunSuccessInput {
  companyId: string;
  issueId: string;
  agentName: string;
  /** The agent's runtimeConfig object; autoRunSummary===false opts out of the summary. */
  runtimeConfig: Record<string, unknown> | null | undefined;
  startedAtMs: number;
  nowMs: number;
  adapterUsage: { inputTokens?: number; outputTokens?: number } | undefined;
  costCents: number | null;
  runId?: string;
  /** The delivering crew agent id (provenance for the run-result refs). */
  agentId?: string | null;
  /**
   * U6.5: files captured out of the crew's in-sandbox working dir
   * (`captureCrewOutputs`, provider-sandbox runs only, S5). `undefined` on
   * non-sandbox / desktop runs — `resolveCrewRunSummaryArgs` defaults it to
   * `[]`.
   */
  detectedFiles?: Array<{ path: string; type?: string }>;
}

/**
 * PURE mapper: runner locals → the shared writer's input. Exported so the
 * costCents→USD + null-token mappings are unit-tested independently of the
 * composed side-effect. `detectedFiles` defaults to `[]` for back-compat with
 * callers that predate capture (e.g. `postCrewRunFailure`, which never
 * captures — a failed run has no confirmed produced-files set) or a run that
 * did not target a provider sandbox (U6.5, S5).
 */
export function resolveCrewRunSummaryArgs(input: {
  companyId: string;
  issueId: string;
  agentName: string;
  runtimeConfig: Record<string, unknown> | null | undefined;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  startedAtMs: number;
  nowMs: number;
  adapterUsage: { inputTokens?: number; outputTokens?: number } | undefined;
  costCents: number | null;
  errorMessage: string | null;
  runId?: string;
  detectedFiles?: Array<{ path: string; type?: string }>;
}): PostRunSummaryCommentInput {
  return {
    companyId: input.companyId,
    issueId: input.issueId,
    agentName: input.agentName,
    runtimeConfig: input.runtimeConfig,
    outcome: input.outcome,
    runId: input.runId,
    durationMs: input.nowMs - input.startedAtMs,
    inputTokens: input.adapterUsage?.inputTokens ?? null,
    outputTokens: input.adapterUsage?.outputTokens ?? null,
    costUsd: input.costCents != null ? input.costCents / 100 : null,
    errorMessage: input.errorMessage,
    detectedFiles: input.detectedFiles ?? [],
  };
}

/**
 * Injectable seams for the two sub-steps so the composition is unit-testable
 * without a live DB. Production callers omit `deps` → the real relay + writer.
 */
export interface CrewRunSuccessDeps {
  relay: (db: Db, params: { issueId: string }) => Promise<{ posted: boolean }>;
  summarize: (db: Db, input: PostRunSummaryCommentInput) => Promise<{ posted: boolean }>;
  /**
   * Phase 7B / Task 4 — deliver navigational refs onto the origin thread on run
   * finish (in-review-safe; distinct from the done-gated `relay`). Optional so a
   * legacy caller that lacks a runId (or omits the dep) simply skips delivery.
   */
  deliver?: (input: DeliverCrewRunResultInput) => Promise<{ delivered: boolean }>;
}

/**
 * SUCCESS: loopback (crew_thread-guarded INSIDE relayCrewResult, so a
 * non-discussion task is a no-op) THEN the run-summary comment. Each sub-step
 * best-effort + isolated. Returns which sub-steps posted (for the unit test and
 * for any future caller telemetry). NEVER throws.
 */
export async function postCrewRunSuccess(
  db: Db,
  input: CrewRunSuccessInput,
  deps: CrewRunSuccessDeps = {
    relay: relayCrewResult,
    summarize: postRunSummaryComment,
    deliver: (deliverInput: DeliverCrewRunResultInput) => deliverCrewRunResult(deliverInput),
  },
): Promise<{ relayed: boolean; summarized: boolean }> {
  let relayed = false;
  let summarized = false;

  // ── Sub-step 1: thread loopback ("Completed: …" agent entry) ──────────────
  try {
    const result = await deps.relay(db, { issueId: input.issueId });
    relayed = result.posted;
  } catch (err) {
    log.warn(
      { err, issueId: input.issueId, runId: input.runId },
      "W3a crew result relay failed (non-fatal)",
    );
  }

  // ── Sub-step 1b (Phase 7B / Task 4): deliver navigational run-result refs ──
  // Fires on run FINISH regardless of task status (in-review included), so the
  // Discussions viewer can open the delivered task/artifacts/outputs. Distinct
  // from the done-gated relay above — both can legitimately post for one task
  // (run-result now, "Completed" on the later done transition). Idempotent per
  // runId inside deliverCrewRunResult. Guarded: a caller without runId (or one
  // that omits the dep) simply skips delivery. Best-effort — never fails a run.
  if (input.runId && deps.deliver) {
    try {
      await deps.deliver({
        db,
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        agentId: input.agentId ?? null,
      });
    } catch (err) {
      log.warn(
        { err, issueId: input.issueId, runId: input.runId },
        "Task 4 crew run-result delivery failed (non-fatal)",
      );
    }
  }

  // ── Sub-step 2: run-summary comment on the task ───────────────────────────
  try {
    const result = await deps.summarize(
      db,
      resolveCrewRunSummaryArgs({
        companyId: input.companyId,
        issueId: input.issueId,
        agentName: input.agentName,
        runtimeConfig: input.runtimeConfig,
        outcome: "succeeded",
        startedAtMs: input.startedAtMs,
        nowMs: input.nowMs,
        adapterUsage: input.adapterUsage,
        costCents: input.costCents,
        errorMessage: null,
        runId: input.runId,
        detectedFiles: input.detectedFiles,
      }),
    );
    summarized = result.posted;
  } catch (err) {
    log.warn(
      { err, issueId: input.issueId, runId: input.runId },
      "W3a crew run summary failed (non-fatal)",
    );
  }

  return { relayed, summarized };
}

// ────────────────────────────────────────────────────────────────────────────
// FAILURE side (Task 3)
// ────────────────────────────────────────────────────────────────────────────

export interface CrewRunFailureInput {
  companyId: string;
  issueId: string;
  agentId: string;
  agentName: string;
  /** The agent's runtimeConfig object; autoRunSummary===false opts out of the summary. */
  runtimeConfig: Record<string, unknown> | null | undefined;
  startedAtMs: number;
  nowMs: number;
  errorMessage: string;
  runId?: string;
}

/** The minimal issue shape the failure card needs (crew_thread gate + title + thread). */
export interface CrewFailureIssueRow {
  title: string | null;
  originKind: string | null;
  sourceDiscussionId: string | null;
}

/**
 * Injectable seams for the three failure sub-steps so the composition is
 * unit-testable without a live DB. Production callers omit `deps` → the real
 * issue fetch + failure card + summary writer.
 */
export interface CrewRunFailureDeps {
  fetchIssue: (db: Db, companyId: string, issueId: string) => Promise<CrewFailureIssueRow | null>;
  failureCard: (
    db: Db,
    params: {
      threadId: string;
      companyId: string;
      issueId: string;
      agentId: string;
      agentName: string;
      taskTitle: string;
      error: string;
    },
  ) => Promise<void>;
  summarize: (db: Db, input: PostRunSummaryCommentInput) => Promise<{ posted: boolean }>;
}

/**
 * Default issue fetch: the exact select the failure card gate needs, COMPANY-SCOPED.
 * The company filter is the tenant-isolation guard (code-review P2) — this failure
 * loopback runs from the runner's catch, reachable when checkout THROWS for a wakeup
 * carrying a FOREIGN-company issueId. Without the companyId predicate a foreign issue
 * would resolve here and leak its company-B sourceDiscussionId / issue into the card +
 * summary. `and(id, companyId)` → a foreign or deleted issue returns null.
 */
async function defaultFetchIssue(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<CrewFailureIssueRow | null> {
  const [row] = await db
    .select({
      title: issues.title,
      originKind: issues.originKind,
      sourceDiscussionId: issues.sourceDiscussionId,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1);
  return row ?? null;
}

/**
 * FAILURE: fetch the issue COMPANY-SCOPED → if it resolves in-company AND is
 * crew_thread-origin with a source thread, post the failure card ("… could not
 * complete …") to that thread; THEN, still gated on that same in-company fetch,
 * post a failure run-summary comment on the task. Each sub-step best-effort +
 * isolated (a card failure still lets the summary post, and vice-versa).
 *
 * TENANT ISOLATION (code-review P2): this runs from the runner's catch, which is
 * reachable when checkout THROWS — including its same-company assignee guard for a
 * wakeup carrying a FOREIGN-company issueId. The fetch is company-filtered
 * (`and(id, companyId)`), and BOTH the card AND the summary are gated on a non-null
 * in-company issue. A foreign OR deleted issue → fetch returns null → NEITHER writes
 * fire ({ carded:false, summarized:false }), so no cross-tenant card/comment can land.
 * (A same-company DELETED issue also yields null → no summary, which is correct: there
 * is nothing left to comment on.) Usage/cost are unreliable on a thrown run, so the
 * summary carries undefined usage + null cost. Returns which sub-steps posted (for the
 * unit test). NEVER throws.
 */
export async function postCrewRunFailure(
  db: Db,
  input: CrewRunFailureInput,
  deps: CrewRunFailureDeps = {
    fetchIssue: defaultFetchIssue,
    failureCard: postCrewFailureCard,
    summarize: postRunSummaryComment,
  },
): Promise<{ carded: boolean; summarized: boolean }> {
  let carded = false;
  let summarized = false;

  // ── Company-scoped fetch: the tenant-isolation gate for BOTH sub-steps. ─────
  // A foreign (or deleted) issueId → null → no card, no summary, no leak.
  let issue: CrewFailureIssueRow | null = null;
  try {
    issue = await deps.fetchIssue(db, input.companyId, input.issueId);
  } catch (err) {
    log.warn(
      { err, issueId: input.issueId, runId: input.runId },
      "W3a crew failure issue fetch failed (non-fatal)",
    );
  }

  // Foreign / deleted issue → do nothing (no card, no summary).
  if (!issue) {
    return { carded: false, summarized: false };
  }

  // ── Sub-step 1: failure card into the originating thread (crew_thread only) ─
  try {
    if (issue.originKind === "crew_thread" && issue.sourceDiscussionId) {
      await deps.failureCard(db, {
        threadId: issue.sourceDiscussionId,
        companyId: input.companyId,
        issueId: input.issueId,
        agentId: input.agentId,
        agentName: input.agentName,
        taskTitle: issue.title ?? "(untitled task)",
        error: input.errorMessage,
      });
      carded = true;
    }
  } catch (err) {
    log.warn(
      { err, issueId: input.issueId, runId: input.runId },
      "W3a crew failure card failed (non-fatal)",
    );
  }

  // ── Sub-step 2: failure run-summary comment on the task (in-company only) ───
  try {
    const result = await deps.summarize(
      db,
      resolveCrewRunSummaryArgs({
        companyId: input.companyId,
        issueId: input.issueId,
        agentName: input.agentName,
        runtimeConfig: input.runtimeConfig,
        outcome: "failed",
        startedAtMs: input.startedAtMs,
        nowMs: input.nowMs,
        adapterUsage: undefined, // usage is unreliable on a thrown run
        costCents: null,
        errorMessage: input.errorMessage,
        runId: input.runId,
      }),
    );
    summarized = result.posted;
  } catch (err) {
    log.warn(
      { err, issueId: input.issueId, runId: input.runId },
      "W3a crew failure run summary failed (non-fatal)",
    );
  }

  return { carded, summarized };
}
