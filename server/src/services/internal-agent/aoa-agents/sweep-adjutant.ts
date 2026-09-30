import { and, eq, ne, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agents,
  aoaAgentTriggers,
  discussions,
  agentWakeupRequests,
  discussionEntries,
} from "@armyofagents/db";

/**
 * QA-BUG-011 — Adjutant sweep dedup window.
 *
 * The original sweep enqueued one wakeup per (Adjutant, active-thread) tuple
 * EVERY tick. When a thread sits in `phase=discuss` with no pending items
 * (already-resolved-but-not-advanced state), each wakeup fires an LLM call
 * that posts a "ready to advance" system notice. The next tick repeats. We
 * observed 20+ near-identical Adjutant notices on a single thread within
 * one minute during the QA pass on 2026-05-29. Each notice costs an LLM
 * call (~$0.01-$0.03) so the loop burns through the company's monthly
 * budget on a single dormant thread.
 *
 * The dedup window suppresses requeues for any (agentId, threadId) tuple
 * that has been enqueued within the last N minutes regardless of the
 * existing wakeup's status. Choice of window:
 *  - Too short (< 5 min) → the loop reopens before the founder can act.
 *  - Too long (> 60 min) → legitimate retries (e.g. after thread updates)
 *    are starved.
 *  - 10 min is the documented Adjutant dispatch cadence in the
 *    implementation plan, and matches the founder's expected response
 *    window for advance notices.
 *
 * If a thread's situation changes (new entry, pending items appear,
 * crewPaused flipped) the founder/UI typically nudges the thread directly,
 * bypassing the sweep cadence. So the 10-min dedup is safe.
 */
const ADJUTANT_DEDUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Periodic sweep driver for the Adjutant role (P3.3).
 *
 * Each tick: for every company that has an active Adjutant with an enabled
 * "sweep" trigger, enqueue one wakeup request per active thread (phase != done,
 * crewPaused = false). The Adjutant then checks each thread for phase-advance
 * readiness.
 *
 * Wakeup payload: { threadId, role: "adjutant" }
 * Source: "sweep.adjutant"
 */
export async function runAdjutantSweep(db: Db): Promise<void> {
  // T1.4: filter sweep triggers by config.role='adjutant'. Pre-T1.4 this
  // driver matched ANY kind='sweep' trigger, which was fine when Adjutant
  // was the only role with a sweep. T1.4 adds Memory Keeper sweep (also
  // kind='sweep'); without the role filter, this driver would cross-fire
  // MK's triggers as Adjutant wakeups. Filtering in JS (not SQL) keeps the
  // mocks simple — volume is trivial.
  const allSweepTriggers = await db
    .select({
      agentId: aoaAgentTriggers.agentId,
      companyId: aoaAgentTriggers.companyId,
      config: aoaAgentTriggers.config,
    })
    .from(aoaAgentTriggers)
    .innerJoin(agents, eq(agents.id, aoaAgentTriggers.agentId))
    .where(
      and(
        eq(aoaAgentTriggers.kind, "sweep"),
        eq(aoaAgentTriggers.enabled, true),
        ne(agents.status, "paused"),
        ne(agents.status, "terminated"),
      ),
    );

  // T1.4 role filter — pre-T1.4 fixtures may have omitted config.role; treat
  // missing role as ADJUTANT for back-compat (the only sweep role pre-T1.4).
  // ensure-adjutant.ts already seeds config: { role: 'adjutant' }; the
  // back-compat branch protects already-seeded companies that haven't run a
  // migration yet.
  const sweepTriggers = allSweepTriggers.filter((t: { config: Record<string, unknown> | null }) => {
    const role = (t.config as Record<string, unknown> | null)?.role;
    return role === undefined || role === "adjutant";
  });

  if (sweepTriggers.length === 0) return;

  for (const trigger of sweepTriggers) {
    // Find active threads for this company (not done, crew not paused)
    const activeThreads = await db
      .select({ id: discussions.id })
      .from(discussions)
      .where(
        and(
          eq(discussions.companyId, trigger.companyId),
          ne(discussions.phase, "done"),
          eq(discussions.crewPaused, false),
          // P1-T11: controller-path threads are driven by the orchestration
          // controller, not the sweep. Exclude them so the peer-wake pipeline
          // remains dormant for new threads.
          eq(discussions.useControllerPath, false),
        ),
      );

    for (const thread of activeThreads) {
      // QA-BUG-011 dedup: skip if we already enqueued a wakeup for this
      // (agent, thread) tuple within the dedup window. Status-agnostic —
      // a wakeup may be queued, claimed, finished, or failed; in all
      // cases the recent activity is enough signal that we should not
      // re-fire. The check is a small focused query (companyId + agentId
      // + thread payload + createdAt) — cheap because it filters down to
      // at most one row in practice.
      const cutoff = new Date(Date.now() - ADJUTANT_DEDUP_WINDOW_MS);
      const [recent] = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, trigger.companyId),
            eq(agentWakeupRequests.agentId, trigger.agentId),
            sql`${agentWakeupRequests.payload} ->> 'threadId' = ${thread.id}`,
            gt(agentWakeupRequests.createdAt, cutoff),
          ),
        )
        .limit(1);
      if (recent) continue;

      // No-flood gate (Task 0.5): only wake the Adjutant when there is at
      // least one human-authored entry in this thread that is NEWER than the
      // agent's last finished action. Without this check every sweep tick
      // fires for dormant threads → floods the thread with "nothing-to-do"
      // system notices (QA complaint, ~$0.01–0.03/notice).
      //
      // "Human entry" mirrors thread-events.ts isHumanEntry:
      //   - authorAgentId IS NULL           (not agent-posted)
      //   - inputType NOT IN ('agent', 'system', 'scope_proposal')
      //
      // "Last action" = finishedAt of the most recent finished/failed/skipped
      // wakeup for this (agent, thread) pair. If no finished wakeup exists,
      // we fall back to epoch so ANY human entry qualifies (first-run case).
      const [lastFinished] = await db
        .select({ finishedAt: agentWakeupRequests.finishedAt })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, trigger.companyId),
            eq(agentWakeupRequests.agentId, trigger.agentId),
            sql`${agentWakeupRequests.payload} ->> 'threadId' = ${thread.id}`,
            sql`${agentWakeupRequests.finishedAt} IS NOT NULL`,
          ),
        )
        .orderBy(sql`${agentWakeupRequests.finishedAt} DESC`)
        .limit(1);

      const lastActionAt: Date = lastFinished?.finishedAt ?? new Date(0);

      const [newerHumanEntry] = await db
        .select({ id: discussionEntries.id })
        .from(discussionEntries)
        .where(
          and(
            eq(discussionEntries.discussionId, thread.id),
            isNull(discussionEntries.authorAgentId),
            ne(discussionEntries.inputType, "agent"),
            ne(discussionEntries.inputType, "system"),
            ne(discussionEntries.inputType, "scope_proposal"),
            gt(discussionEntries.createdAt, lastActionAt),
          ),
        )
        .limit(1);

      // No new human input since the last Adjutant action — skip silently.
      if (!newerHumanEntry) continue;

      await db.insert(agentWakeupRequests).values({
        companyId: trigger.companyId,
        agentId: trigger.agentId,
        source: "sweep.adjutant",
        reason: "adjutant_sweep",
        payload: { threadId: thread.id, role: "adjutant" },
        status: "queued",
      });
    }
  }
}
