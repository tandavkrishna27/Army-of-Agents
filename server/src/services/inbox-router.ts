// server/src/services/inbox-router.ts
//
// Routing-card redesign (Navigator-decides-over-routing-cards).
//
// routeInboxItem — the routing orchestrator. Replaces the former
// classify→resolve→deterministic-act flow with:
//   1. Atomic claim (pending_route → routing) — returns rawContent, writes routingClaimedAt.
//   2. Load the company routing dial.
//   3. dial='off' → leave in Inbox (routingStatus='routed', routerDecision='human').
//   4. dial≥suggest → snapshot the active-thread cards (for reproducibility) → wake
//      the Navigator with the inbound CONTENT (the Navigator fetches cards fresh via
//      list_thread_cards) → routingStatus='escalated'.
//
// Option A (Codex P1 #9): a ZERO-card company still wakes the Navigator — it creates
// the first thread (full_auto) or suggests-new (suggest/auto_attach). Only a true
// assembly/DB error or a missing Navigator fail-closes (routingStatus='failed').
//
// classifyRouting / resolveRoutingAction / inbound-routing-constants are DELETED.
// findSimilarThreadsScored is no longer called from this path.

import { and, eq, ne } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  threadInboxItems,
  internalAgentConfig,
  discussions,
} from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

const log = logger.child({ service: "inbox-router" });

// ── Exported types (retained for consumers that import RoutingAction) ─────────

export type RoutingAction = "escalate_navigator" | "human";

export interface RouteInboxItemArgs {
  inboxItemId: string;
}

export interface RouteInboxItemResult {
  action: RoutingAction;
  /** 'navigator_woken' | 'off' | 'already_claimed' | 'failed' */
  outcome: string;
}

/** Card snapshot stored on the routing record for reproducible-decision audit (A2). */
export interface CandidateCard {
  threadId: string;
  title: string | null;
  summaryText: string | null;
  routingTerms: string[];
}

// ── enqueueNavigatorRoutingWakeup ────────────────────────────────────────────

export interface EnqueueNavigatorRoutingWakeupArgs {
  companyId: string;
  inboxItemId: string;
  /** The raw inbound text — immutable, so safe to freeze in the payload. The
   *  Navigator decides over THIS plus the cards it fetches fresh (Codex P1 #1). */
  inboundContent: string;
}

export interface EnqueueNavigatorRoutingWakeupResult {
  wakeupId: string;
}

/**
 * Look up the company's Navigator and insert an agentWakeupRequests row.
 *
 * IMPORTANT (Codex #4): the payload carries inboxItemId + inboundContent, NOT
 * payload.threadId. A threadId in the payload triggers dispatcher skips. Cards
 * are NOT frozen here — the Navigator fetches them fresh via list_thread_cards (A2).
 *
 * @throws {Error} "NAVIGATOR_NOT_FOUND" if no active Navigator exists.
 */
export async function enqueueNavigatorRoutingWakeup(
  db: Db,
  args: EnqueueNavigatorRoutingWakeupArgs,
): Promise<EnqueueNavigatorRoutingWakeupResult> {
  const { companyId, inboxItemId, inboundContent } = args;

  // Exclude terminated AND paused (Codex re-review P2 #G): the dispatcher ignores
  // paused agents, so a wakeup addressed to a paused Navigator would sit queued
  // until the sweep finalizes the item to human. Treat paused as "no router".
  const [nav] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.kind, "aoa"),
        eq(agents.name, "Navigator"),
        ne(agents.status, "terminated"),
        ne(agents.status, "paused"),
      ),
    )
    .limit(1);

  if (!nav) {
    throw new Error(`NAVIGATOR_NOT_FOUND: no active Navigator for company ${companyId}`);
  }

  const result = await db
    .insert(agentWakeupRequests)
    .values({
      companyId,
      agentId: nav.id,
      // Retained for wire-compat: the dispatcher dial-gate + aoa-trigger-prompt
      // branch both match on this exact source string. (No "ambiguity"
      // classification remains — every dial≥suggest item escalates.)
      source: "inbox.routing_ambiguous",
      reason: "routing_cards",
      payload: {
        inboxItemId,
        inboundContent,
      } as Record<string, unknown>,
      status: "queued",
    })
    .returning({ id: agentWakeupRequests.id });

  const row = result[0];
  if (!row?.id) throw new Error("enqueueNavigatorRoutingWakeup: insert returned no id");

  return { wakeupId: row.id };
}

// ── routeInboxItem ────────────────────────────────────────────────────────────

/**
 * Routing orchestrator.
 *
 * Atomically claims the inbox item (pending_route → routing) before acting.
 * The atomic claim writes routingClaimedAt so sweep-inbox.ts can reclaim
 * items stranded in-flight past the reclaim threshold (C4 / #37).
 *
 * Error containment: action failures set routingStatus='failed'. Never throws.
 */
export async function routeInboxItem(
  db: Db,
  args: RouteInboxItemArgs,
): Promise<RouteInboxItemResult> {
  const { inboxItemId } = args;

  // ── 1. Atomic claim: pending_route → routing + stamp routingClaimedAt ─────
  // Returns rawContent so the Navigator can decide over the actual inbound text
  // (Codex P1 #1).
  const claimed = await db
    .update(threadInboxItems)
    .set({ routingStatus: "routing", routingClaimedAt: new Date() })
    .where(
      and(
        eq(threadInboxItems.id, inboxItemId),
        eq(threadInboxItems.routingStatus, "pending_route"),
        eq(threadInboxItems.status, "pending"),
      ),
    )
    .returning({
      id: threadInboxItems.id,
      companyId: threadInboxItems.companyId,
      rawContent: threadInboxItems.rawContent,
    });

  if (claimed.length === 0) {
    log.debug({ inboxItemId }, "routeInboxItem: already claimed — no-op");
    return { action: "human", outcome: "already_claimed" };
  }

  const { companyId, rawContent } = claimed[0];

  // ── 2. Load routing dial ──────────────────────────────────────────────────
  const configRows = await db
    .select({ inboundRoutingLevel: internalAgentConfig.inboundRoutingLevel })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);

  const dial = (configRows[0]?.inboundRoutingLevel ?? "off") as string;

  // ── 3. dial='off' → leave in Inbox (terminal, human) ─────────────────────
  if (dial === "off") {
    await db
      .update(threadInboxItems)
      .set({ routingStatus: "routed", routerDecision: "human", routedAt: new Date() })
      .where(and(eq(threadInboxItems.id, inboxItemId), eq(threadInboxItems.companyId, companyId)));

    return { action: "human", outcome: "off" };
  }

  // ── 4. dial ≥ suggest → snapshot cards + wake Navigator ───────────────────
  try {
    // Assemble all active thread cards (small-scale path) FOR THE SNAPSHOT only.
    // The Navigator fetches cards fresh via list_thread_cards at run time (A2).
    // An EMPTY result is NOT an error (Option A) — the Navigator will create the
    // first thread (full_auto) or suggest-new (suggest/auto_attach).
    const cardRows = await db
      .select({
        id: discussions.id,
        title: discussions.title,
        summaryText: discussions.summaryText,
        routingTerms: discussions.routingTerms,
      })
      .from(discussions)
      .where(
        and(
          eq(discussions.companyId, companyId),
          eq(discussions.status, "active"),
        ),
      )
      .limit(100);

    const cardSnapshot: CandidateCard[] = cardRows.map((r) => {
      // routingTerms is a jsonb string[] column — read directly (defensive filter).
      const terms = Array.isArray(r.routingTerms)
        ? (r.routingTerms as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
      return { threadId: r.id, title: r.title ?? null, summaryText: r.summaryText ?? null, routingTerms: terms };
    });

    const { wakeupId } = await enqueueNavigatorRoutingWakeup(db, {
      companyId,
      inboxItemId,
      inboundContent: rawContent,
    });

    // Single UPDATE: escalated status + wakeup id + reproducibility snapshot (A2).
    await db
      .update(threadInboxItems)
      .set({
        routingStatus: "escalated",
        routedAt: new Date(),
        navigatorWakeupId: wakeupId,
        routingCardSnapshot: cardSnapshot,
      })
      .where(and(eq(threadInboxItems.id, inboxItemId), eq(threadInboxItems.companyId, companyId)));

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "system",
      action: "thread.inbox_item.routed",
      entityType: "thread_inbox_item",
      entityId: inboxItemId,
      details: { action: "escalate_navigator", cardCount: cardSnapshot.length },
    }).catch((err) => log.warn({ err, inboxItemId }, "routeInboxItem: logActivity failed"));

    return { action: "escalate_navigator", outcome: "navigator_woken" };

  } catch (err: unknown) {
    const isNavMissing = err instanceof Error && err.message.startsWith("NAVIGATOR_NOT_FOUND");
    const errorCode = isNavMissing ? "NAVIGATOR_NOT_FOUND" : "UNKNOWN";

    log.error({ err, inboxItemId }, "routeInboxItem: action step failed");

    // A4 degradation signal: the Navigator is the sole router now. If it's
    // missing, log a distinct, auditable activity entry so the dial isn't a
    // silent no-op. (Surfacing this in the Inbox UI is a follow-up — #38.)
    if (isNavMissing) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "thread.routing.navigator_unavailable",
        entityType: "thread_inbox_item",
        entityId: inboxItemId,
        details: { reason: "NAVIGATOR_NOT_FOUND" },
      }).catch((notifyErr) =>
        log.warn({ notifyErr, companyId }, "routeInboxItem: could not log Navigator-unavailable signal"),
      );
    }

    await db
      .update(threadInboxItems)
      .set({ routingStatus: "failed", routingErrorCode: errorCode })
      .where(and(eq(threadInboxItems.id, inboxItemId), eq(threadInboxItems.companyId, companyId)))
      .catch((updateErr) => log.error({ updateErr, inboxItemId }, "routeInboxItem: could not write failed"));

    // No escalation actually happened — the item is failed and stays in the Inbox
    // for the human. Report action='human' so callers branching on action aren't
    // misled (outcome='failed' distinguishes it from a clean human route).
    return { action: "human", outcome: "failed" };
  }
}
