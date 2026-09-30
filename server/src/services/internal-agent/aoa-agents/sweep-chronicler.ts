// server/src/services/internal-agent/aoa-agents/sweep-chronicler.ts
//
// Chronicler card-update sweep.
//
// Queries threads that have new entries since their last card update and
// queues one agentWakeupRequests row per eligible thread.
//
// Eligibility: discussions.status='active' AND discussions.crewPaused=false AND
//   (summaryUpdatedAt IS NULL OR lastEntryAt > summaryUpdatedAt)
// Debounce: skip threads with a Chronicler wakeup queued OR processing in the
//   last CHRONICLER_DEBOUNCE_MS (45s) to absorb entry bursts.
// Concurrency cap: process at most CHRONICLER_MAX_CONCURRENT threads per cycle.
//
// KNOWN LIMITATION (Codex P2 — single-instance assumption): the debounce is a
// read-then-insert, not a DB-level unique constraint. Two server processes
// sweeping the same company within the same 45s window could each queue a
// wakeup for the same thread. v1 runs a single server process, so this is
// acceptable; multi-instance dedup (a unique partial index on
// agentWakeupRequests(agentId, payload->>'threadId') WHERE status IN
// ('queued','processing')) is a follow-up if/when the server scales out.

import { and, eq, ne, gt, isNull, isNotNull, or, inArray, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, aoaAgentTriggers, discussions, agentWakeupRequests, internalAgentConfig } from "@armyofagents/db";
import { logger } from "../../../middleware/logger.js";

const log = logger.child({ svc: "sweep-chronicler" });

/** Matches the sweep interval in index.ts. */
export const CHRONICLER_SWEEP_INTERVAL_MS = 45_000;

/** Skip threads with a Chronicler wakeup queued within this window. */
export const CHRONICLER_DEBOUNCE_MS = 45_000;

/** Max threads to queue per sweep tick. */
export const CHRONICLER_MAX_CONCURRENT = 10;

export interface RunChroniclerSweepResult {
  queued: number;
}

/**
 * For every company that has a Chronicler agent with a 'sweep' trigger,
 * find active threads with stale cards and queue one Chronicler wakeup per thread.
 */
export async function runChroniclerSweep(db: Db): Promise<RunChroniclerSweepResult> {
  // ── 1. Find all companies with an active Chronicler sweep trigger ─────────
  const chroniclerRows = await db
    .select({
      agentId: aoaAgentTriggers.agentId,
      companyId: aoaAgentTriggers.companyId,
    })
    .from(aoaAgentTriggers)
    .innerJoin(agents, eq(agents.id, aoaAgentTriggers.agentId))
    .where(
      and(
        eq(aoaAgentTriggers.kind, "sweep"),
        eq(aoaAgentTriggers.enabled, true),
        sql`(${aoaAgentTriggers.config}->>'role') = 'chronicler'`,
        ne(agents.status, "terminated"),
        ne(agents.status, "paused"),
      ),
    );

  if (chroniclerRows.length === 0) {
    return { queued: 0 };
  }

  // ── 2. For each company, find stale threads + queue wakeups ───────────────
  let totalQueued = 0;

  for (const { agentId, companyId } of chroniclerRows) {
    try {
      const queued = await queueForCompany(db, agentId, companyId);
      totalQueued += queued;
    } catch (err) {
      log.warn({ err, companyId }, "sweep-chronicler: queueForCompany failed — continuing");
    }
  }

  if (totalQueued > 0) {
    log.debug({ queued: totalQueued }, "sweep-chronicler: done");
  }

  return { queued: totalQueued };
}

async function queueForCompany(db: Db, agentId: string, companyId: string): Promise<number> {
  const [companyConfig] = await db
    .select({ crewPaused: internalAgentConfig.crewPaused })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);

  if (companyConfig?.crewPaused === true) {
    log.debug({ companyId }, "sweep-chronicler: company crew paused; skipping");
    return 0;
  }

  // ── Threads with new entries since last card update ───────────────────────
  // Eligibility: active thread that has at least one entry (lastEntryAt set) AND
  // either no card yet (summaryUpdatedAt null) or new entries since the last card.
  // The isNotNull(lastEntryAt) guard (Codex round-3 P2) avoids waking the
  // Chronicler for brand-new no-entry threads (created with lastEntryAt=null) —
  // there is nothing to summarize until a first entry lands.
  const staleThreads = await db
    .select({ id: discussions.id, lastEntryAt: discussions.lastEntryAt })
    .from(discussions)
    .where(
      and(
        eq(discussions.companyId, companyId),
        eq(discussions.status, "active"),
        eq(discussions.crewPaused, false),
        isNotNull(discussions.lastEntryAt),
        or(
          isNull(discussions.summaryUpdatedAt),
          gt(discussions.lastEntryAt, discussions.summaryUpdatedAt),
        ),
      ),
    )
    .limit(CHRONICLER_MAX_CONCURRENT);

  if (staleThreads.length === 0) return 0;

  // ── Debounce: skip threads with a Chronicler wakeup still queued OR in-flight
  //    (Codex P2 — a 'processing' wakeup means a Chronicler is mid-run on that
  //    thread; queuing another would double-run it). Wakeup statuses:
  //    'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'.
  const cutoff = new Date(Date.now() - CHRONICLER_DEBOUNCE_MS);
  const recentWakeups = await db
    .select({ payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.agentId, agentId),
        inArray(agentWakeupRequests.status, ["queued", "processing"]),
        gt(agentWakeupRequests.createdAt, cutoff),
      ),
    );

  const alreadyQueued = new Set(
    recentWakeups
      .map((r) => (r.payload as Record<string, unknown>)?.threadId as string | undefined)
      .filter(Boolean),
  );

  // ── Per-thread "last finished" lookup (bounded — review fix (k)) ───────────
  // The previous version loaded ALL finished Chronicler wakeups for the agent in
  // one unbounded query (no finishedAt lower bound, no LIMIT) and built a map in
  // JS — on a long-lived company that is an ever-growing table scan per tick.
  // Mirror the sibling `sweep-adjutant` no-flood gate: query the most recent
  // finished wakeup PER stale thread with `ORDER BY finishedAt DESC LIMIT 1`,
  // filtered by the thread id in the payload. `staleThreads` is already capped at
  // CHRONICLER_MAX_CONCURRENT, so this is a bounded number of single-row lookups.
  const latestFinishedByThread = new Map<string, Date>();
  for (const t of staleThreads) {
    if (alreadyQueued.has(t.id)) continue; // skip — debounced, never queued below
    const [lastFinished] = await db
      .select({ finishedAt: agentWakeupRequests.finishedAt })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
          inArray(agentWakeupRequests.status, ["succeeded", "completed", "failed"]),
          isNotNull(agentWakeupRequests.finishedAt),
          sql`${agentWakeupRequests.payload} ->> 'threadId' = ${t.id}`,
        ),
      )
      .orderBy(sql`${agentWakeupRequests.finishedAt} DESC`)
      .limit(1);
    if (lastFinished?.finishedAt) {
      const finishedAt =
        lastFinished.finishedAt instanceof Date
          ? lastFinished.finishedAt
          : new Date(lastFinished.finishedAt);
      latestFinishedByThread.set(t.id, finishedAt);
    }
  }

  const toQueue = staleThreads.filter((t) => {
    if (alreadyQueued.has(t.id)) return false;
    const lastFinishedAt = latestFinishedByThread.get(t.id);
    if (!lastFinishedAt || !t.lastEntryAt) return true;
    const lastEntryAt = t.lastEntryAt instanceof Date ? t.lastEntryAt : new Date(t.lastEntryAt);
    return lastFinishedAt < lastEntryAt;
  });
  if (toQueue.length === 0) return 0;

  // ── Insert wakeup rows ────────────────────────────────────────────────────
  const wakeupRows = toQueue.map((t) => ({
    companyId,
    agentId,
    source: "sweep.chronicler" as const,
    reason: "card_stale",
    payload: { threadId: t.id, role: "chronicler" } as Record<string, unknown>,
    status: "queued" as const,
  }));

  await db.insert(agentWakeupRequests).values(wakeupRows);

  return toQueue.length;
}
