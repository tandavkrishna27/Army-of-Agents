/**
 * Thread Orchestration Controller — P1-T3 state bookkeeping + P1-T4 run executor
 * + P1-T6 hop-gated participation invocations.
 *
 * Manages the per-thread `thread_orchestration_state` row that drives the
 * Adjutant agent idempotently as a conversation advances.
 *
 * Public operations:
 *
 *   `ensureController(threadId)` — idempotent INSERT: guarantees exactly one
 *   controller row exists for the thread. Uses `onConflictDoNothing` so two
 *   concurrent callers converge on the same row without error.
 *
 *   `triggerOnHumanEntry(threadId)` — marks the controller as "a run is due":
 *   sets `pendingRun = true`, increments `runEpoch`, resets `hopCount = 0`.
 *   Calls `ensureController` first so callers don't need to pre-check. Does
 *   NOT touch `lastProcessedEntryId` — only the run executor advances that.
 *
 *   `runController(threadId, opts)` — (P1-T4) atomically claims a pending run,
 *   loads unprocessed entries, calls the injected adjutantRunner, then checks
 *   the epoch to detect stale runs. If the epoch changed mid-run (a newer human
 *   entry arrived), the output is suppressed and the cursor is NOT advanced.
 *   Only when the epoch is unchanged does the run commit its output and advance
 *   the cursor. This prevents duplicate replies, lost input, and stuck agents.
 *
 *   `requestParticipation(threadId, params, opts)` — (P1-T6) hop-gated sub-agent
 *   participation. Reads the current hopCount; if already at HOP_CAP returns
 *   `{ spawned: false, atCap: true }` without invoking the runner. Otherwise
 *   calls `incrementHop`, invokes `opts.participantRunner`, then EITHER posts the
 *   runner's output as an `inputType: "agent"` `discussion_entry` (when the runner
 *   returns text) OR skips the insert entirely (when the runner returns "" — the
 *   crew agent already self-posted via the post_entry MCP tool; B1 no-double-post).
 *   Never creates an issue. Returns `{ spawned: true, hopCount, entryId }` where
 *   `entryId` is null on the self-post (skip) path.
 *
 * The `adjutantRunner` seam still defaults to a throwing stub (wired at the
 * call site in thread-events/sweep). The `participantRunner` seam now defaults
 * to the real crew runner (`makeThreadParticipationRunner`, Task 2.1) when not
 * injected — tests pass deterministic fakes; production runs real crew/CLI.
 */

import { eq, gt, and, asc, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, threadOrchestrationState, discussionEntries, discussions, internalAgentConfig } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { preflightCrewDispatch } from "./crew-budget.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Minimal shape of a discussion_entries row as seen by the executor. */
export interface OrchestratedEntry {
  id: string;
  createdAt: Date;
  [key: string]: unknown;
}

/** What the adjutantRunner resolves with. */
export interface AdjutantRunResult {
  output: unknown;
  error?: string;
  runId?: string | null;
}

/** Input to the adjutantRunner seam. */
export interface AdjutantRunnerInput {
  threadId: string;
  entries: OrchestratedEntry[];
  startEpoch: number;
}

/** Injected function that drives the real (or fake) Adjutant crew. */
export type AdjutantRunner = (
  input: AdjutantRunnerInput,
) => Promise<AdjutantRunResult>;

/**
 * Injected commit callback: called only when the epoch re-check passes (i.e.
 * the run is NOT stale). Receives the adjutant output plus the resolved cursor.
 * Implementers use this to post the reply, create tasks, etc. Returning void
 * is fine — errors are surfaced in the runController return value.
 */
export type OnCommitFn = (result: AdjutantRunResult, cursorAdvancedTo: string | null) => Promise<void>;

/** The union of outcomes that runController can return. */
export type RunControllerResult =
  // The atomic claim was lost (another executor owns this thread's run right now) OR
  // pendingRun was already false. THIS caller did NOT claim — it must NOT touch the
  // thread's actions (the owner may have queued-but-uncommitted rows). (Codex P1)
  | { ran: false; reason: "no-pending" }
  // THIS caller claimed the run but there were no entries after the cursor. It owns the
  // thread for this tick (the claim serializes), so a backstop action-drain is safe here.
  | { ran: false; reason: "no-entries" }
  | { ran: true; suppressed: true; startEpoch: number; endEpoch: number }
  | { ran: true; suppressed: false; startEpoch: number; cursorAdvancedTo: string | null }
  | { ran: true; suppressed: false; error: string; startEpoch: number; cursorAdvancedTo: null };

// ── Participation types (P1-T6) ───────────────────────────────────────────────

/**
 * Input passed to the participant runner seam. The runner runs the named
 * sub-agent against the thread and returns its output text.
 */
export interface ParticipantRunnerInput {
  threadId: string;
  agentId: string;
  prompt: string;
}

/**
 * Injected runner for sub-agent participation. Tests inject a fake that returns
 * deterministic output; production wires `makeThreadParticipationRunner(db)`
 * (Task 2.1), which runs the crew agent via `runAoaAgent`.
 *
 * RETURN CONTRACT (B1): the production runner returns "" because the crew agent
 * SELF-POSTS its reply via the post_entry MCP tool DURING its run. An empty or
 * whitespace-only return tells `requestParticipation` to SKIP its own entry-
 * insert (the agent already authored the reply → no double-post). A NON-empty
 * return is posted verbatim as the agent's `inputType:"agent"` entry (legacy /
 * direct-text callers).
 */
export type ParticipantRunner = (
  input: ParticipantRunnerInput,
) => Promise<string>;

/** The union of outcomes that requestParticipation can return. */
export type RequestParticipationResult =
  | {
      spawned: false;
      atCap: false;
      hopCount: number;
      blockedReason: "thread_disabled" | "thread_paused" | "company_paused";
    }
  | { spawned: false; atCap: true; hopCount: number }
  // `entryId` is the id of the agent-comment entry this call inserted, OR null
  // when the participant runner self-posted via MCP (returned ""): in that case
  // the run still happened (spawned:true) and the hop was still counted, but
  // requestParticipation inserted NO entry — the agent is the sole author of its
  // reply (B1 no-double-post; mirrors controller-adjutant-runner self-posting).
  | { spawned: true; hopCount: number; entryId: string | null };

/** Options accepted by `requestParticipation`. */
export interface RequestParticipationOpts {
  /**
   * The participant runner seam. Tests inject a deterministic fake; when omitted,
   * production lazily wires `makeThreadParticipationRunner(db)` (Task 2.1), which
   * runs the crew agent via `runAoaAgent` (the agent self-posts → runner returns
   * "" → this method skips its own entry-insert; see ParticipantRunner above).
   */
  participantRunner?: ParticipantRunner;
  /**
   * The actor id recorded as `createdBy` on the posted discussion_entry.
   * Defaults to the agentId from the params.
   */
  actorId?: string;
}

/** Options accepted by `runController`. */
export interface RunControllerOpts {
  /**
   * The Adjutant driver seam. Tests inject a deterministic fake; production
   * wires the real crew/CLI execution here in a later integration task.
   *
   * The default stub throws "adjutant runner not wired (P1-T4 seam)" so that
   * production code that accidentally omits the injection fails loudly rather
   * than silently. Always inject in production wiring.
   */
  adjutantRunner?: AdjutantRunner;

  /**
   * Optional post-commit hook. Called after a COMMIT (non-stale, no-error) run
   * with the adjutant output and the cursor it advanced to. Use this to post
   * the reply entry, create tasks, etc. Errors thrown here are caught and
   * logged but do not roll back the cursor advance.
   */
  onCommit?: OnCommitFn;
}

const log = logger.child({ service: "thread-orchestration" });

// ── Commit-failure circuit-breaker ─────────────────────────────────────────────
/** After this many consecutive action-commit failures, the controller advances
 *  the cursor past the failing entry so one poison action cannot stall the
 *  thread forever. Transient failures recover before reaching the cap. */
const MAX_CONSECUTIVE_COMMIT_FAILURES = 3;

/** Records an action-commit failure on the controller row.
 *  - Under the cap: re-schedule the thread (pendingRun=true → the 2-min sweep
 *    re-drives it) WITHOUT advancing the cursor, so a transient failure retries.
 *  - At the cap: circuit-break — advance the cursor past `cursorTarget` (skip the
 *    poison), reset the counter, keep pendingRun=true to drain later entries, and
 *    write a `lastError` (persisted + logged; a UI/Inbox surface is tracked in #198).
 *  Returns whether the breaker fired. */
async function recordCommitFailure(
  db: Db,
  threadId: string,
  priorFailures: number,
  cursorTarget: string,
  errorMsg: string,
  log: { warn: (o: unknown, m: string) => void; error: (o: unknown, m: string) => void },
): Promise<{ circuitBroken: boolean }> {
  const newCount = priorFailures + 1;
  if (newCount >= MAX_CONSECUTIVE_COMMIT_FAILURES) {
    log.error(
      { threadId, cursorTarget, failures: newCount },
      "thread orchestration: action commit failed repeatedly — advancing cursor past the entry (circuit breaker)",
    );
    await db
      .update(threadOrchestrationState)
      .set({
        lastProcessedEntryId: cursorTarget,
        consecutiveCommitFailures: 0,
        pendingRun: true,
        lastError: `action_commit_failed_skipped:${errorMsg}`,
        updatedAt: new Date(),
      })
      .where(eq(threadOrchestrationState.threadId, threadId));
    return { circuitBroken: true };
  }
  log.warn(
    { threadId, cursorTarget, failures: newCount },
    "thread orchestration: action commit failed — re-scheduling for retry (cursor NOT advanced)",
  );
  await db
    .update(threadOrchestrationState)
    .set({
      consecutiveCommitFailures: newCount,
      pendingRun: true,
      lastError: errorMsg,
      updatedAt: new Date(),
    })
    .where(eq(threadOrchestrationState.threadId, threadId));
  return { circuitBroken: false };
}

// ── Hop-cap constant ───────────────────────────────────────────────────────────
/**
 * Max agent rounds per quiet window (since the last human entry) before the
 * Adjutant must stop and ask the human.
 *
 * A "hop" is one participation invocation — one sub-agent pulled into the chat.
 * `hopCount` resets to 0 on every human entry (handled by `triggerOnHumanEntry`).
 * When `hopCount` reaches this cap, the Adjutant should post a
 * "scope it / keep going?" decision card instead of spawning another round
 * (card UI and post wiring are later tasks; this constant is the primitive).
 */
export const HOP_CAP = 5;

// ── Default adjutantRunner stub ────────────────────────────────────────────────
/**
 * P1-T4 DI seam placeholder. Throws immediately so any production path that
 * accidentally omits the injection fails loudly and deterministically rather
 * than silently producing no output. Always replaced before going to production.
 */
const defaultAdjutantRunner: AdjutantRunner = async () => {
  throw new Error("adjutant runner not wired (P1-T4 seam)");
};

// ── Default participantRunner ─────────────────────────────────────────────────
/**
 * Phase 2 / Task 2.1 — the production default. Lazily wires
 * `makeThreadParticipationRunner(db)` so a controller-path @mention actually RUNS
 * the crew agent (the agent self-posts its reply via the post_entry MCP tool, so
 * the returned string is "" and requestParticipation skips its own entry-insert).
 *
 * Lazy (dynamic import) for two reasons:
 *   1. `thread-participation-runner.ts` → `runner.ts` builds the heavy crew
 *      tool-registry at module load. discussions.ts imports this module, so a
 *      static import here would drag that subtree onto the discussions
 *      module-load path. Deferring to call time keeps it off the hot path
 *      (identical discipline to controller-adjutant-runner's lazy runAoaAgent).
 *   2. Tests inject `opts.participantRunner` and never reach this default, so the
 *      dynamic import is never resolved in unit tests.
 *
 * Was (P1-T6): a stub that threw "participant runner not wired" — by design,
 * because no real wiring existed yet. Task 2.1 supplies it.
 */
const resolveDefaultParticipantRunner = async (db: Db): Promise<ParticipantRunner> => {
  const { makeThreadParticipationRunner } = await import(
    "./internal-agent/aoa-agents/thread-participation-runner.js"
  );
  return makeThreadParticipationRunner(db);
};

export function threadOrchestrationService(db: Db) {
  return {
    /**
     * Ensure exactly one controller row exists for `threadId`.
     *
     * Idempotent: uses `onConflictDoNothing` on the `threadId` UNIQUE
     * constraint, so multiple concurrent calls converge on the same row
     * with zero errors and exactly one write.
     *
     * Returns the inserted row on the first call, undefined on subsequent
     * (conflict-suppressed) calls — callers should treat the return value
     * as informational only.
     */
    ensureController: async (threadId: string) => {
      const result = await db
        .insert(threadOrchestrationState)
        .values({ threadId })
        .onConflictDoNothing()
        .returning();

      if (result.length > 0) {
        log.debug({ threadId }, "thread orchestration controller created");
      }

      return result[0] ?? null;
    },

    /**
     * Mark the controller as "a run is due" in response to a human entry.
     *
     * - Calls `ensureController` first, so the row is guaranteed to exist.
     * - Sets `pendingRun = true`.
     * - Increments `runEpoch` atomically via SQL expression (`runEpoch + 1`).
     * - Resets `hopCount = 0` (human entry resets the agent-cascade counter).
     * - Bumps `updatedAt` to now.
     *
     * Does NOT touch `lastProcessedEntryId` — only the run executor advances
     * the read cursor after a completed run.
     *
     * Safe to call from the thread-events debounce callback alongside the
     * existing peer-wake path. The two are additive and do not conflict.
     */
    triggerOnHumanEntry: async (threadId: string) => {
      // Always ensure the row exists first so this works even if the CREATE
      // path didn't call ensureController (e.g. legacy threads).
      await threadOrchestrationService(db).ensureController(threadId);

      const [updated] = await db
        .update(threadOrchestrationState)
        .set({
          pendingRun: true,
          runEpoch: sql`${threadOrchestrationState.runEpoch} + 1`,
          hopCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(threadOrchestrationState.threadId, threadId))
        .returning();

      log.debug(
        {
          threadId,
          runEpoch: updated?.runEpoch,
          pendingRun: updated?.pendingRun,
        },
        "thread orchestration controller triggered on human entry",
      );

      return updated ?? null;
    },

    /**
     * Atomically increment `hopCount` for the controller and return the new
     * value plus an at-cap signal.
     *
     * Called once per participation invocation (a sub-agent pulled into the
     * chat — wired in the next task, T6). Callers check `atCap` to decide
     * whether to spawn another agent round or instead post a
     * "scope it / keep going?" decision card (T13).
     *
     * - Calls `ensureController` first so the row is guaranteed to exist.
     * - Increments `hopCount` atomically via SQL expression (`hopCount + 1`).
     * - Bumps `updatedAt` to now.
     * - Returns `{ hopCount, atCap }` where `atCap = hopCount >= HOP_CAP`.
     */
    incrementHop: async (threadId: string): Promise<{ hopCount: number; atCap: boolean }> => {
      await threadOrchestrationService(db).ensureController(threadId);

      const [updated] = await db
        .update(threadOrchestrationState)
        .set({
          hopCount: sql`${threadOrchestrationState.hopCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(threadOrchestrationState.threadId, threadId))
        .returning();

      const hopCount = updated?.hopCount ?? 0;

      log.debug(
        { threadId, hopCount, atCap: hopCount >= HOP_CAP },
        "thread orchestration hop incremented",
      );

      return { hopCount, atCap: hopCount >= HOP_CAP };
    },

    /**
     * P1-T4 — Claim and execute a pending Adjutant run with stale-run
     * suppression.
     *
     * ### Claim (atomic)
     * `UPDATE … SET pendingRun = false WHERE pendingRun = true RETURNING …`
     * — exactly one concurrent executor wins; others get back `no-pending`.
     *
     * ### Read cursor
     * Loads `discussion_entries` rows for the thread ordered by `seq ASC`
     * (the per-thread monotonic counter assigned atomically on insert via
     * `discussions.entrySeq`). When `lastProcessedEntryId` is set, the cursor
     * entry's `seq` is first resolved via a point-read on that id; then only
     * rows with `seq > cursorSeq` are returned. This is correct insertion-order
     * because `seq` is a monotonic integer counter — NOT `id` (UUID v4 is
     * random and lexicographic comparison of UUID strings does NOT reflect
     * insertion order). When `lastProcessedEntryId` is null (or the cursor
     * entry cannot be found), all entries for the thread are returned ordered
     * by `seq ASC`. The cursor itself remains an id pointer and is advanced to
     * the last entry's id on commit — only the COMPARISON changes to use seq.
     *
     * NOTE on "zero unprocessed entries": if the cursor is already at the last
     * entry (no new entries), the run short-circuits and returns
     * `{ ran: false, reason: "no-pending" }`. This is safe: the trigger only
     * fires on new human entries so the cursor should always have rows to
     * process. If it doesn't, nothing useful would happen anyway.
     *
     * ### Adjutant seam
     * `opts.adjutantRunner({ threadId, entries, startEpoch })` is the DI seam.
     * Tests inject a deterministic fake. The default stub throws to make
     * unwired production calls fail loudly.
     *
     * ### Epoch re-check (stale-run suppression)
     * After `adjutantRunner` resolves, re-reads `runEpoch` from the controller.
     * - `endEpoch !== startEpoch` → STALE: discard output, do NOT advance cursor,
     *   do NOT touch pendingRun (triggerOnHumanEntry already set it back to true).
     * - `endEpoch === startEpoch` → COMMIT: call `opts.onCommit`, advance cursor
     *   to the last entry's id, leave pendingRun = false.
     *
     * ### Error handling
     * If `adjutantRunner` throws: record `lastError` on the controller, leave
     * the cursor unchanged so a retry picks up the same entries, and surface the
     * error in the return value. Does NOT set pendingRun — a retry must be
     * triggered externally (e.g. retry logic in a later task).
     */
    runController: async (
      threadId: string,
      opts: RunControllerOpts = {},
    ): Promise<RunControllerResult> => {
      const adjutantRunner = opts.adjutantRunner ?? defaultAdjutantRunner;

      // ── Step 1: Atomic claim ────────────────────────────────────────────────
      // UPDATE … SET pendingRun = false WHERE threadId = X AND pendingRun = true
      // RETURNING runEpoch, lastProcessedEntryId
      // If no row is returned, nothing is pending (or another executor claimed it).
      const [claimed] = await db
        .update(threadOrchestrationState)
        .set({ pendingRun: false, updatedAt: new Date() })
        .where(
          and(
            eq(threadOrchestrationState.threadId, threadId),
            eq(threadOrchestrationState.pendingRun, true),
          ),
        )
        .returning();

      if (!claimed) {
        return { ran: false, reason: "no-pending" };
      }

      const startEpoch: number = claimed.runEpoch;
      const lastProcessedEntryId: string | null = claimed.lastProcessedEntryId ?? null;

      log.debug(
        { threadId, startEpoch, lastProcessedEntryId },
        "thread orchestration run claimed",
      );

      // ── Step 1b: Crew budget + thread-health preflight ─────────────────────────
      // Fetch companyId so we can call preflightCrewDispatch (which checks
      // adjutantEnabled, crewPaused, and company budget). Only fires after we've
      // claimed the run slot — if the thread is healthy and budget is fine, we
      // proceed; if not, we return early without advancing the cursor.
      const [threadRow] = await db
        .select({ companyId: discussions.companyId })
        .from(discussions)
        .where(eq(discussions.id, threadId))
        .limit(1);

      if (threadRow) {
        const preflightResult = await preflightCrewDispatch(db, {
          companyId: threadRow.companyId,
          agentId: "adjutant",
          threadId,
        });
        if (!preflightResult.allowed) {
          log.info(
            { threadId, reasonCode: preflightResult.reasonCode, reason: preflightResult.reason },
            "thread orchestration: preflight blocked — run aborted",
          );
          return {
            ran: true,
            suppressed: false,
            error: preflightResult.reason,
            startEpoch,
            cursorAdvancedTo: null,
          };
        }
      }
      // If threadRow is null (thread deleted mid-claim), proceed — the run will
      // naturally short-circuit at the empty-entries check.

      // ── Step 2: Read unprocessed entries ───────────────────────────────────
      // Load discussion_entries after the cursor (or all if cursor is null).
      // Order by seq ASC — seq is the per-thread monotonic counter and is the
      // only ordering column that reflects true insertion order. UUID v4 `id`
      // comparison is lexicographic and does NOT reflect insertion order.
      //
      // Two-step approach:
      //   a) If lastProcessedEntryId is set, point-read the cursor entry to
      //      resolve its seq. If the entry is not found (deleted; the FK is
      //      onDelete set null so lastProcessedEntryId should already be null,
      //      but guard anyway), fall back to reading from seq 0 (all entries).
      //   b) Select all thread entries with seq > cursorSeq, ordered by seq ASC.
      let entries: OrchestratedEntry[];
      try {
        let cursorSeq: number | null = null;

        if (lastProcessedEntryId) {
          const [cursorRow] = await db
            .select({ seq: discussionEntries.seq })
            .from(discussionEntries)
            .where(eq(discussionEntries.id, lastProcessedEntryId));
          // If the cursor entry is found, use its seq; otherwise fall back to
          // reading all entries (treat as seq 0 / no prior cursor).
          cursorSeq = cursorRow?.seq ?? null;
        }

        const whereClause = cursorSeq !== null
          ? and(
              eq(discussionEntries.discussionId, threadId),
              gt(discussionEntries.seq, cursorSeq),
            )
          : eq(discussionEntries.discussionId, threadId);

        entries = (await db
          .select()
          .from(discussionEntries)
          .where(whereClause)
          .orderBy(asc(discussionEntries.seq))) as OrchestratedEntry[];
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // Bounded reschedule: no cursorTarget exists yet (entries failed to load), so
        // we cannot advance past a poison entry. Reschedule (pendingRun=true) under
        // the cap so the 2-min sweep retries a transient load failure; stop after MAX
        // so a persistent infra failure does not churn (the next human entry re-arms).
        const newCount = claimed.consecutiveCommitFailures + 1;
        const atCap = newCount >= MAX_CONSECUTIVE_COMMIT_FAILURES;
        log.error(
          { threadId, startEpoch, err },
          "thread orchestration: failed to load entries — bounded reschedule",
        );
        await db
          .update(threadOrchestrationState)
          .set({
            lastError: errorMsg,
            consecutiveCommitFailures: atCap ? 0 : newCount,
            pendingRun: !atCap,
            updatedAt: new Date(),
          })
          .where(eq(threadOrchestrationState.threadId, threadId));
        return { ran: true, suppressed: false, error: errorMsg, startEpoch, cursorAdvancedTo: null };
      }

      // Short-circuit: no new entries to process. This is unexpected given the
      // trigger fires on new human entries, but handle it gracefully. Distinct reason
      // ("no-entries") so the sweep knows THIS caller claimed the run (and may safely
      // run a backstop action-drain) vs the claim-lost "no-pending" above. (Codex P1)
      if (entries.length === 0) {
        log.debug({ threadId, startEpoch }, "thread orchestration: no unprocessed entries — skipping run");
        return { ran: false, reason: "no-entries" };
      }

      const cursorTarget = entries[entries.length - 1].id;

      // ── Step 3: Run the Adjutant (injected seam) ───────────────────────────
      let runResult: AdjutantRunResult;
      try {
        runResult = await adjutantRunner({ threadId, entries, startEpoch });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // Route the runner-throw through the same bounded circuit-breaker as a commit
        // failure (cursorTarget is in scope from above): reschedule (pendingRun=true)
        // under the cap so the sweep re-drives it, and advance past the poison entry
        // once the cap is hit — so a deterministically-throwing runner cannot stall
        // the thread forever (Round-1 stall class).
        log.error(
          { threadId, startEpoch, err },
          "thread orchestration: adjutantRunner threw — recording failure (circuit-breaker)",
        );
        const { circuitBroken } = await recordCommitFailure(
          db, threadId, claimed.consecutiveCommitFailures, cursorTarget, errorMsg, log,
        );
        return {
          ran: true,
          suppressed: false,
          error: circuitBroken ? undefined : errorMsg,
          startEpoch,
          cursorAdvancedTo: circuitBroken ? cursorTarget : null,
        };
      }

      // ── Step 4: Re-check epoch (stale-run suppression) ────────────────────
      // Re-read the current runEpoch from the controller row.
      const [current] = await db
        .select({ runEpoch: threadOrchestrationState.runEpoch })
        .from(threadOrchestrationState)
        .where(eq(threadOrchestrationState.threadId, threadId));

      const endEpoch: number = current?.runEpoch ?? startEpoch;

      if (endEpoch !== startEpoch) {
        // STALE: a newer human entry arrived mid-run.
        // - Do NOT post output.
        // - Do NOT advance lastProcessedEntryId.
        // - Do NOT touch pendingRun (triggerOnHumanEntry already set it back to true).
        log.warn(
          { threadId, startEpoch, endEpoch },
          "thread orchestration: stale run suppressed — epoch changed mid-run; output discarded",
        );
        return { ran: true, suppressed: true, startEpoch, endEpoch };
      }

      // Set when a commit leaves retryable work uncommitted (mixed-batch failed rows, or
      // rows that lost the fenced CAS this tick): the cursor still advances, but pendingRun
      // re-drives the thread-scoped commit on the next sweep so leftovers aren't orphaned
      // until an unrelated future trigger. (Codex P2)
      // Controller commit gate (outbox seal, must-fix #1): only drain when the controller run
      // SUCCEEDED. A failed/cancelled run never sealed its actions (the runner seals only on
      // success), so its rows stay `proposed` — un-committable under the ready-only relay, and we
      // additionally skip the commit here so the transient superset relay cannot drain them either,
      // closing the controller-path variant of the failed-run leak (Codex P1). Read defensively:
      // the run is "not failed" unless output.status==='failed' or an error was surfaced — the mock
      // adjutantRunner returns output:"done"/no error and is treated as succeeded.
      const runSucceeded =
        (runResult.output as { status?: string } | undefined)?.status !== "failed" &&
        runResult.error == null;
      let rescheduleAfterCommit = false;
      if (threadRow && runResult.runId && runSucceeded) {
        try {
          const { threadAgentActionService } = await import("./thread-agent-actions.js");
          const commitResult = await threadAgentActionService(db).commitThreadAgentActions({
            companyId: threadRow.companyId,
            threadId,
            runId: runResult.runId,
          });
          rescheduleAfterCommit = commitResult.failed > 0 || commitResult.lostRace > 0;

          // A per-action commit failure is swallowed inside commitThreadAgentActions
          // (the row is set `failed` and the call returns normally). On a PURE failure
          // (nothing committed) we do NOT advance — the circuit-breaker reschedules so
          // a transient failure retries; after MAX consecutive failures it advances
          // past the poison entry. (#198 PR-B) The commit is now THREAD-scoped, so a
          // later run's commit re-selects the prior run's retryable `failed` rows
          // directly (bounded by attemptCount < maxAttempts) — the retry no longer
          // depends on re-running the agent. Cross-run drain is safe because each row
          // commits against its OWN stored freshness snapshot, and `runEpoch`
          // (controller staleness) and `freshness.latestHumanSeq` advance on the SAME
          // event (a new human entry via triggerOnHumanEntry), so the per-action
          // freshness re-check subsumes the epoch gate for the runner self-flush path
          // that does not read runEpoch.
          if (commitResult.failed > 0 && commitResult.committed === 0) {
            // PURE failure (nothing committed) → safe to reschedule/retry via the
            // circuit-breaker; a re-run cannot duplicate because nothing committed.
            log.warn(
              {
                threadId,
                startEpoch,
                runId: runResult.runId,
                failed: commitResult.failed,
                committed: commitResult.committed,
              },
              "thread orchestration: action commit reported failures — recording failure (circuit-breaker)",
            );
            const { circuitBroken } = await recordCommitFailure(
              db,
              threadId,
              claimed.consecutiveCommitFailures,
              cursorTarget,
              `action_commit_failed:${commitResult.failed}`,
              log,
            );
            return {
              ran: true,
              suppressed: false,
              error: circuitBroken ? undefined : `action_commit_failed:${commitResult.failed}`,
              startEpoch,
              cursorAdvancedTo: circuitBroken ? cursorTarget : null,
            };
          }
          if (commitResult.failed > 0) {
            // MIXED batch (committed>0 AND failed>0): advance the cursor (committed work
            // is done) AND reschedule via pendingRun (rescheduleAfterCommit set above) so
            // the retryable failed rows are re-driven on the next sweep instead of waiting
            // for an unrelated future trigger. (Codex P2 — this path previously fell
            // through to Step 5 with pendingRun=false, orphaning the failed rows.)
            log.warn(
              {
                threadId,
                startEpoch,
                runId: runResult.runId,
                failed: commitResult.failed,
                committed: commitResult.committed,
              },
              "thread orchestration: mixed batch — advancing cursor and rescheduling failed actions (retry-safety #198)",
            );
          }
        } catch (commitErr) {
          const errorMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
          log.error(
            { threadId, startEpoch, runId: runResult.runId, err: commitErr },
            "thread orchestration: action gate commit threw — recording failure (circuit-breaker)",
          );
          const { circuitBroken } = await recordCommitFailure(
            db, threadId, claimed.consecutiveCommitFailures, cursorTarget, errorMsg, log,
          );
          return {
            ran: true,
            suppressed: false,
            error: circuitBroken ? undefined : errorMsg,
            startEpoch,
            cursorAdvancedTo: circuitBroken ? cursorTarget : null,
          };
        }
      }

      // ── Step 5: Commit ─────────────────────────────────────────────────────
      // Epoch matches and action-gated side effects are committed; advance the
      // cursor and leave pendingRun = false.
      await db
        .update(threadOrchestrationState)
        .set({
          lastProcessedEntryId: cursorTarget,
          lastError: null,
          consecutiveCommitFailures: 0,
          // Re-drive on the next sweep if a mixed/contended commit left retryable rows
          // uncommitted. Only WRITE pendingRun when rescheduling — leaving it untouched
          // otherwise preserves the pre-existing "don't clobber pendingRun on commit"
          // behavior, so a pendingRun that a concurrent human entry (triggerOnHumanEntry)
          // set between the claim and here is not lost. (Codex P2)
          ...(rescheduleAfterCommit ? { pendingRun: true } : {}),
          updatedAt: new Date(),
        })
        .where(eq(threadOrchestrationState.threadId, threadId));

      log.debug(
        { threadId, startEpoch, cursorTarget },
        "thread orchestration: run committed — cursor advanced",
      );

      // Call the post-commit hook (fire-and-forget style; errors are logged but
      // do not roll back the cursor advance, which is already durable).
      if (opts.onCommit) {
        try {
          await opts.onCommit(runResult, cursorTarget);
        } catch (hookErr) {
          log.error(
            { threadId, startEpoch, err: hookErr },
            "thread orchestration: onCommit hook threw — cursor already advanced, ignoring",
          );
        }
      }

      return { ran: true, suppressed: false, startEpoch, cursorAdvancedTo: cursorTarget };
    },

    /**
     * P1-T6 — Hop-gated sub-agent participation invocation.
     *
     * Pulls a named sub-agent (Scout, Planner, Engineer, etc.) into the
     * thread conversation. The sub-agent runs against the thread and its
     * output is posted as an `inputType: "agent"` `discussion_entry` comment.
     * This does NOT create an issue/task — participation is chat-only.
     *
     * ### Cap check (read-then-act, sequential)
     * Reads the current `hopCount` from the controller row. If already at or
     * above `HOP_CAP`, returns `{ spawned: false, atCap: true, hopCount }`
     * immediately — the caller (Adjutant) should post a "scope it / keep
     * going?" decision card (T13) instead. No hop is counted, no runner is
     * invoked, nothing is posted.
     *
     * ### On spawn
     * 1. `incrementHop(threadId)` — atomically bumps the counter; this round
     *    counts toward the cap.
     * 2. `opts.participantRunner({ threadId, agentId, prompt })` — runs the
     *    sub-agent. The default stub throws so unwired production callers fail
     *    loudly.
     * 3. Posts the runner's output as a `discussion_entry` with:
     *      - `inputType: "agent"` (excluded by `isHumanEntry` → won't re-fire
     *        the controller; QA-BUG-011 loop-guard)
     *      - `authorAgentId: agentId`
     *      - `rawContent: <runner output>`
     *    Uses a DB transaction to atomically bump `discussions.entrySeq` and
     *    insert the entry (same pattern as `discussions.addEntry`).
     * 4. Returns `{ spawned: true, hopCount, entryId }`.
     *
     * ### Race note
     * The cap check and `incrementHop` are separate reads — there is a tiny
     * window between them. This is acceptable because only the Adjutant calls
     * this method, sequentially. In a future multi-caller world a compare-and-
     * swap column would close the gap; for now the sequential constraint makes
     * the race benign.
     */
    requestParticipation: async (
      threadId: string,
      params: { agentId: string; prompt: string },
      opts: RequestParticipationOpts = {},
    ): Promise<RequestParticipationResult> => {
      const [threadGate] = await db
        .select({
          companyId: discussions.companyId,
          adjutantEnabled: discussions.adjutantEnabled,
          crewPaused: discussions.crewPaused,
        })
        .from(discussions)
        .where(eq(discussions.id, threadId))
        .limit(1);

      if (!threadGate) {
        log.info({ threadId, agentId: params.agentId }, "requestParticipation: thread disabled - not spawning");
        return { spawned: false, atCap: false, hopCount: 0, blockedReason: "thread_disabled" };
      }

      if (threadGate.adjutantEnabled === false) {
        const [targetAgent] = await db
          .select({ name: agents.name })
          .from(agents)
          .where(and(eq(agents.id, params.agentId), eq(agents.companyId, threadGate.companyId)))
          .limit(1);
        if (targetAgent?.name === "Adjutant") {
          log.info({ threadId, agentId: params.agentId }, "requestParticipation: adjutant disabled - not spawning");
          return { spawned: false, atCap: false, hopCount: 0, blockedReason: "thread_disabled" };
        }
      }

      if (threadGate.crewPaused === true) {
        log.info({ threadId, agentId: params.agentId }, "requestParticipation: thread paused - not spawning");
        return { spawned: false, atCap: false, hopCount: 0, blockedReason: "thread_paused" };
      }

      const [companyCfg] = await db
        .select({ crewPaused: internalAgentConfig.crewPaused })
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, threadGate.companyId))
        .limit(1);

      if (companyCfg?.crewPaused === true) {
        log.info(
          { threadId, agentId: params.agentId, companyId: threadGate.companyId },
          "requestParticipation: company crew paused - not spawning",
        );
        return { spawned: false, atCap: false, hopCount: 0, blockedReason: "company_paused" };
      }

      // ── Step 1: Cap check — read current hopCount ──────────────────────────
      // ensureController first so the row always exists.
      await threadOrchestrationService(db).ensureController(threadId);

      const [current] = await db
        .select({ hopCount: threadOrchestrationState.hopCount })
        .from(threadOrchestrationState)
        .where(eq(threadOrchestrationState.threadId, threadId));

      const currentHopCount = current?.hopCount ?? 0;

      if (currentHopCount >= HOP_CAP) {
        log.info(
          { threadId, agentId: params.agentId, hopCount: currentHopCount },
          "requestParticipation: at hop cap — not spawning",
        );

        // Post a system entry so the founder sees the hop-cap prompt in the chat.
        // Best-effort — failure must not prevent returning atCap.
        try {
          const [threadRow] = await db
            .select({ companyId: discussions.companyId })
            .from(discussions)
            .where(eq(discussions.id, threadId))
            .limit(1);

          if (threadRow) {
            const now = new Date();
            const { insertedEntry, cid } = await db.transaction(async (tx) => {
              const [{ entrySeq, companyId: cid }] = await tx
                .update(discussions)
                .set({
                  entrySeq: sql`${discussions.entrySeq} + 1`,
                  entryCount: sql`${discussions.entryCount} + 1`,
                  updatedAt: now,
                })
                .where(eq(discussions.id, threadId))
                .returning({ entrySeq: discussions.entrySeq, companyId: discussions.companyId });

              const [insertedEntry] = await tx
                .insert(discussionEntries)
                .values({
                  discussionId: threadId,
                  inputType: "system",
                  rawContent: "Agent loop reached hop cap. Scope the work or continue?",
                  sourceInfo: { type: "hop_cap_reached", hopCount: currentHopCount, cap: HOP_CAP },
                  authorAgentId: null,
                  createdBy: params.agentId,
                  extractionStatus: "skipped",
                  seq: entrySeq,
                })
                .returning();

              return { insertedEntry, cid };
            });

            publishLiveEvent({
              companyId: cid,
              type: "discussion.entry.created",
              payload: { discussionId: threadId, entryId: insertedEntry.id, inputType: "system" },
            });
            publishLiveEvent({
              companyId: cid,
              type: "thread.entry.created",
              payload: { threadId, entryId: insertedEntry.id, seq: insertedEntry.seq },
            });
          }
        } catch (err) {
          log.warn({ threadId, err }, "requestParticipation: failed to post hop-cap system entry — continuing");
        }

        return { spawned: false, atCap: true, hopCount: currentHopCount };
      }

      // ── Step 2: Increment hop (this participation counts) ─────────────────
      // Task 2.1: the default now wires the real crew runner (lazily). Tests
      // inject opts.participantRunner and never resolve the default. Resolve it
      // only after pause/cap gates so blocked paths do not import or run crew.
      const participantRunner =
        opts.participantRunner ?? (await resolveDefaultParticipantRunner(db));
      const actorId = opts.actorId ?? params.agentId;

      const { hopCount } = await threadOrchestrationService(db).incrementHop(threadId);

      // ── Step 3: Run the participant (injected seam) ────────────────────────
      const output = await participantRunner({
        threadId,
        agentId: params.agentId,
        prompt: params.prompt,
      });

      // ── Step 3b: Skip the insert when the runner self-posted (B1) ──────────
      // The production crew runner (makeThreadParticipationRunner) returns ""
      // because the agent ALREADY posted its reply via the post_entry MCP tool
      // DURING its run. If we also inserted an entry here we'd DOUBLE-POST (an
      // empty stray entry). So: an empty/whitespace return means "the agent
      // authored its own reply — do not insert one for it." The hop was already
      // incremented above (this round happened, so it still counts toward the
      // cap — self-posting agents must not get free, uncapped rounds), and the
      // thread_orchestration_state row is untouched here (incrementHop already
      // bumped updatedAt). Legacy/other callers that return real text still get
      // it inserted by Step 4 below.
      const replyText = typeof output === "string" ? output : String(output ?? "");
      if (!replyText.trim()) {
        log.debug(
          { threadId, agentId: params.agentId, hopCount },
          "requestParticipation: runner returned empty — agent self-posted via MCP; skipping entry insert (no double-post)",
        );
        return { spawned: true, hopCount, entryId: null };
      }

      // ── Step 4: Post the output as an agent comment ────────────────────────
      // Atomically bump discussions.entrySeq + entryCount and insert the entry.
      // This deliberately replicates the two posting side-effects of
      // discussions.addEntry (Plan 7 seq assignment + Gotcha 1.2 entryCount
      // bump). We cannot call addEntry directly because discussions.ts already
      // imports threadOrchestrationService from this module — doing the reverse
      // would create a circular import. Instead we replicate the side-effects
      // here and import only from ./live-events.js (which does NOT import this
      // module). A future refactor could extract a shared `postDiscussionEntry`
      // helper into a lower-level module that both discussions.ts and this
      // module import, eliminating the duplication cleanly.
      //
      // The `inputType: "agent"` value ensures isHumanEntry returns false for
      // this entry (QA-BUG-011 loop-guard: the entry must NOT re-fire the
      // orchestration controller).
      const now = new Date();
      const { entry, companyId } = await db.transaction(async (tx) => {
        const [{ entrySeq, companyId: cid }] = await tx
          .update(discussions)
          .set({
            entrySeq: sql`${discussions.entrySeq} + 1`,
            entryCount: sql`${discussions.entryCount} + 1`,
            updatedAt: now,
          })
          .where(eq(discussions.id, threadId))
          .returning({
            entrySeq: discussions.entrySeq,
            companyId: discussions.companyId,
          });

        const [inserted] = await tx
          .insert(discussionEntries)
          .values({
            discussionId: threadId,
            inputType: "agent",
            rawContent: output,
            authorAgentId: params.agentId,
            extractionStatus: "skipped",
            seq: entrySeq,
            createdBy: actorId,
          })
          .returning();

        return { entry: inserted, companyId: cid };
      });

      // Replicate addEntry's two publishLiveEvent calls so the participation
      // comment appears in real-time in the chat UI (WebSocket fan-out).
      // discussion.entry.created — consumed by discussion feed subscribers.
      publishLiveEvent({
        companyId,
        type: "discussion.entry.created",
        payload: {
          discussionId: threadId,
          entryId: entry.id,
          inputType: "agent",
        },
      });
      // thread.entry.created — thread-scoped poke for the live thread view;
      // envelope-RBAC fan-out delivers only to viewers who can see the thread.
      publishLiveEvent({
        companyId,
        type: "thread.entry.created",
        payload: {
          threadId,
          entryId: entry.id,
          seq: entry.seq,
        },
      });

      log.debug(
        { threadId, agentId: params.agentId, hopCount, entryId: entry.id },
        "requestParticipation: spawned and posted agent comment",
      );

      return { spawned: true, hopCount, entryId: entry.id };
    },
  };
}
