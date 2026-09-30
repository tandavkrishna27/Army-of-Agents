// server/src/services/internal-agent/aoa-agents/sweep-inbox.ts
//
// Inbox routing backstop sweep.
//
// Three jobs per tick:
//   1. Reclaim 'routing' (claimed, but Navigator NEVER woken — process died
//      mid-route) → 'pending_route' so it gets re-routed.
//   2. Finalize 'escalated' (Navigator WAS woken but never finalized — it was
//      unsure and returned silently, or crashed mid-route) → 'routed'+'human'.
//      Resetting these to pending_route instead would re-wake the Navigator,
//      which would re-escalate, looping forever (Codex P1 #2). Terminal-to-human
//      is the correct fail-safe.
//   3. Drain: call routeInboxItem for each 'pending_route' item.
//
// Reclaim threshold (routingClaimedAt) gates phases 1+2 — only items stranded
// longer than RECLAIM_THRESHOLD_MS are touched, so a normally-in-flight item
// (Navigator running right now) is left alone.

import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { threadInboxItems, agentWakeupRequests } from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import { routeInboxItem } from "../../inbox-router.js";
import { logger } from "../../../middleware/logger.js";

const log = logger.child({ svc: "sweep-inbox" });

/** Items stuck in routing/escalated longer than this are reclaimed. 10 minutes. */
export const RECLAIM_THRESHOLD_MS = 10 * 60 * 1000;

export interface RunInboxSweepResult {
  swept: number;
  reclaimed: number;   // 'routing' → pending_route (retry)
  finalized: number;   // 'escalated' → routed+human (terminal, no loop)
}

export async function runInboxSweep(db: Db): Promise<RunInboxSweepResult> {
  const reclaimCutoff = new Date(Date.now() - RECLAIM_THRESHOLD_MS);

  // ── Phase 1: Reclaim stale 'routing' (Navigator never woken) → pending_route
  const staleRouting = await db
    .select({ id: threadInboxItems.id })
    .from(threadInboxItems)
    .where(
      and(
        eq(threadInboxItems.routingStatus, "routing"),
        isNotNull(threadInboxItems.routingClaimedAt),
        lt(threadInboxItems.routingClaimedAt, reclaimCutoff),
        eq(threadInboxItems.status, "pending"),
      ),
    );

  let reclaimed = 0;
  if (staleRouting.length > 0) {
    log.debug({ count: staleRouting.length }, "sweep-inbox: reclaiming stale routing → pending_route");
    await db
      .update(threadInboxItems)
      .set({ routingStatus: "pending_route", routingClaimedAt: null, routingErrorCode: null })
      .where(inArray(threadInboxItems.id, staleRouting.map((r) => r.id)));
    reclaimed = staleRouting.length;
  }

  // ── Phase 2: Finalize stale 'escalated' (Navigator woken, never acted) → routed+human
  // Terminal (NOT pending_route) — re-routing would re-escalate and loop (Codex P1 #2).
  // Also CANCEL the still-queued Navigator wakeup (Codex re-review P1 #C): the
  // attach/promote write-paths claim on status='pending', and a finalized item
  // stays status='pending' (visible in Inbox), so a delayed queued wakeup could
  // still attach/promote it after the human took over. Cancelling the queued
  // wakeup closes that race. (A wakeup already 'processing' is not cancelled, but
  // after 10min stranded that run is almost certainly dead.)
  const staleEscalated = await db
    .select({
      id: threadInboxItems.id,
      navigatorWakeupId: threadInboxItems.navigatorWakeupId,
    })
    .from(threadInboxItems)
    .where(
      and(
        eq(threadInboxItems.routingStatus, "escalated"),
        isNotNull(threadInboxItems.routingClaimedAt),
        lt(threadInboxItems.routingClaimedAt, reclaimCutoff),
        eq(threadInboxItems.status, "pending"),
      ),
    );

  let finalized = 0;
  if (staleEscalated.length > 0) {
    log.debug({ count: staleEscalated.length }, "sweep-inbox: finalizing stale escalated → routed+human");

    // Cancel the orphaned queued wakeups FIRST (crash-safety): if the process
    // dies between this and the finalize below, the item stays 'escalated' and is
    // re-swept next cycle (safe) rather than ending terminal with a live wakeup.
    const wakeupIds = staleEscalated
      .map((r) => r.navigatorWakeupId)
      .filter((id): id is string => typeof id === "string");
    if (wakeupIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({ status: "cancelled" })
        .where(
          and(
            inArray(agentWakeupRequests.id, wakeupIds),
            eq(agentWakeupRequests.status, "queued"),
          ),
        )
        .catch((err) => log.warn({ err }, "sweep-inbox: could not cancel orphaned wakeups"));
    }

    // Then finalize the items to terminal routed+human.
    await db
      .update(threadInboxItems)
      .set({ routingStatus: "routed", routerDecision: "human", routedAt: new Date() })
      .where(inArray(threadInboxItems.id, staleEscalated.map((r) => r.id)));

    finalized = staleEscalated.length;
  }

  // ── Phase 3: Drain pending_route ─────────────────────────────────────────
  const pending = await db
    .select({ id: threadInboxItems.id })
    .from(threadInboxItems)
    .where(eq(threadInboxItems.routingStatus, "pending_route"));

  if (pending.length === 0) {
    return { swept: 0, reclaimed, finalized };
  }

  log.debug({ count: pending.length }, "sweep-inbox: draining pending_route items");

  let swept = 0;
  for (const row of pending) {
    try {
      await routeInboxItem(db, { inboxItemId: row.id });
    } catch (err) {
      log.warn({ err, inboxItemId: row.id }, "sweep-inbox: routeInboxItem failed — continuing");
    }
    swept++;
  }

  log.debug({ swept, reclaimed, finalized }, "sweep-inbox: done");
  return { swept, reclaimed, finalized };
}
