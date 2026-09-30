/**
 * Backstop drain for the orchestration controller — `runControllerSweep`.
 *
 * The PRIMARY driver of controller-path threads is the inline fire-and-forget
 * `runController` call in thread-events.ts (immediate reaction to a human entry,
 * fired within the 30s debounce window). This sweep is the SAFETY NET: it
 * catches threads where the inline drain crashed or was missed and
 * `pendingRun` is still true.
 *
 * Serialization: the atomic claim inside `runController`
 * (`UPDATE … SET pendingRun=false WHERE pendingRun=true RETURNING …`) means
 * only one caller wins per thread — the sweep and the inline drain cannot
 * both execute the same run. If the inline drain already claimed the run,
 * `runController` returns `{ ran: false, reason: "no-pending" }` for the sweep.
 *
 * Scheduled in server/src/index.ts at a 2-minute interval (backstop cadence).
 */

import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { discussions, threadOrchestrationState } from "@armyofagents/db";
import { threadOrchestrationService } from "../../thread-orchestration.js";
import {
  reapStaleThreadAgentActions,
  gcOrphanedProposedActions,
  threadAgentActionService,
} from "../../thread-agent-actions.js";
import { makeControllerAdjutantRunner } from "./controller-adjutant-runner.js";
import type { AdjutantRunner } from "../../thread-orchestration.js";
import { logger } from "../../../middleware/logger.js";

const log = logger.child({ svc: "sweep-controller" });

/**
 * Drain all controller-path threads that have `pendingRun = true`.
 *
 * @param db - Drizzle db instance.
 * @param deps - Injectable for tests. Pass `{ adjutantRunner: myFake }` to
 *               avoid spawning a real CLI process in unit tests.
 */
export async function runControllerSweep(
  db: Db,
  deps: { adjutantRunner?: AdjutantRunner } = {},
): Promise<void> {
  const adjutantRunner = deps.adjutantRunner ?? makeControllerAdjutantRunner(db);

  // Reap crash-stranded `committing` rows (past STALE_COMMITTING_TTL_MS) so they
  // don't accumulate; best-effort — never block the sweep.
  try {
    await reapStaleThreadAgentActions(db);
  } catch (err) {
    log.warn({ err }, "controller sweep: stale-action reaper failed — continuing");
  }

  // Drive UNSEALED `proposed` rows to a terminal state — the idempotent-retry relay for the producer
  // seal: re-seal a COMPLETED run's rows (recover a crashed in-band seal), terminalize failed/cancelled
  // and orphan rows, and force-fail genuinely-crashed (zombie) runs. Best-effort — never block the
  // sweep. (Outbox seal, must-fix #5.)
  try {
    await gcOrphanedProposedActions(db);
  } catch (err) {
    log.warn({ err }, "controller sweep: orphaned-proposed GC failed — continuing");
  }

  // Select threads that need a run: pendingRun=true + useControllerPath=true
  // + not done + crew not paused. The `innerJoin` ties the state row to the
  // live discussions row so we can filter on phase and crewPaused in one query.
  const pending = await db
    .select({
      threadId: threadOrchestrationState.threadId,
      companyId: discussions.companyId,
    })
    .from(threadOrchestrationState)
    .innerJoin(discussions, eq(discussions.id, threadOrchestrationState.threadId))
    .where(
      and(
        eq(threadOrchestrationState.pendingRun, true),
        eq(discussions.useControllerPath, true),
        ne(discussions.phase, "done"),
        eq(discussions.crewPaused, false),
      ),
    );

  if (pending.length === 0) return;

  log.debug({ count: pending.length }, "controller sweep: draining pending threads");

  const svc = threadOrchestrationService(db);
  const actionSvc = threadAgentActionService(db);

  for (const { threadId, companyId } of pending) {
    const result = await svc
      .runController(threadId, { adjutantRunner })
      .catch((err) => {
        log.warn({ err, threadId }, "controller sweep: runController failed — continuing");
        return null;
      });

    // Backstop action drain (Codex P2/P1): runController short-circuits on no-entries
    // BEFORE its commit, so retryable rows left by a mixed/lost-race commit or the reaper
    // (both of which set pendingRun → this thread is in `pending`) would be orphaned until
    // a new human entry. Drain them here — BUT ONLY when runController reported
    // "no-entries", which proves THIS sweep won the atomic claim for this tick. We must NOT
    // drain on "no-pending" (the claim was lost to a concurrently-running inline executor):
    // that owner may have queued-but-uncommitted actions, and committing them thread-scoped
    // here would race its freshness/epoch gate, defeating the per-thread serialization. When
    // runController itself ran (ran:true) it already committed; a mixed/lost leftover re-arms
    // pendingRun and is drained on the NEXT sweep via this same no-entries path.
    if (result?.ran === false && result.reason === "no-entries") {
      try {
        const drain = await actionSvc.commitThreadAgentActions({ companyId, threadId });
        if (drain.failed > 0 || drain.lostRace > 0) {
          await db
            .update(threadOrchestrationState)
            .set({ pendingRun: true, updatedAt: new Date() })
            .where(eq(threadOrchestrationState.threadId, threadId));
        }
      } catch (err) {
        log.warn({ err, threadId }, "controller sweep: thread-action drain failed — continuing");
      }
    }
  }
}
