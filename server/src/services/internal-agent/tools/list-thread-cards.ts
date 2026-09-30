// server/src/services/internal-agent/tools/list-thread-cards.ts
//
// list_thread_cards — fetch routing cards for the Navigator.
//
// Small scale (≤ SMALL_SCALE_LIMIT active threads): return ALL active thread
// cards. No retrieval, no recall risk.
//
// The Navigator calls this tool to get the candidate set it reasons over.
// findSimilarThreadsScored is NOT called from here — it's a retrieval shortlister
// reserved for large-scale deployments (deferred).

import { and, eq } from "drizzle-orm";
import { discussions } from "@armyofagents/db";
import type { AgentTool } from "../types.js";
import { logger } from "../../../middleware/logger.js";

const log = logger.child({ tool: "list_thread_cards" });

/** Below this count, return all active cards. Above it, a top-K retrieval
 *  would be used (deferred to large-scale phase). The tool logs when the cap
 *  is hit so the silent-truncation case is visible (Codex P2 — no silent caps). */
export const SMALL_SCALE_LIMIT = 100;

export interface ThreadCard {
  threadId: string;
  title: string | null;
  summaryText: string | null;
  routingTerms: string[];
}

export const listThreadCardsTool: AgentTool = {
  name: "list_thread_cards",
  description:
    "Fetch routing cards (summaryText + routingTerms) for active threads. " +
    "Use this to get candidate threads before deciding where an inbound item belongs.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional: extract intent/entities from the inbound item to filter results at scale. Unused at small scale.",
      },
    },
    required: [],
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(_params, ctx) {
    const rows = await ctx.db
      .select({
        id: discussions.id,
        title: discussions.title,
        summaryText: discussions.summaryText,
        routingTerms: discussions.routingTerms,
      })
      .from(discussions)
      .where(
        and(
          eq(discussions.companyId, ctx.companyId),
          eq(discussions.status, "active"),
        ),
      )
      .limit(SMALL_SCALE_LIMIT);

    const cards: ThreadCard[] = (Array.isArray(rows) ? rows : []).map((r) => {
      // routingTerms is a jsonb string[] column — read directly (defensive filter).
      const terms = Array.isArray(r.routingTerms)
        ? (r.routingTerms as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
      return {
        threadId: r.id,
        title: r.title ?? null,
        summaryText: r.summaryText ?? null,
        routingTerms: terms,
      };
    });

    // No-silent-caps (Codex P2): if we returned exactly the cap, more cards may
    // exist that the Navigator never saw. Surface it.
    if (cards.length >= SMALL_SCALE_LIMIT) {
      log.warn(
        { companyId: ctx.companyId, cap: SMALL_SCALE_LIMIT },
        "list_thread_cards hit SMALL_SCALE_LIMIT — some active cards omitted; at-scale hybrid retrieval is deferred",
      );
    }

    return {
      success: true,
      data: cards,
      summary:
        cards.length >= SMALL_SCALE_LIMIT
          ? `${cards.length} routing card(s) returned (capped — more may exist)`
          : `${cards.length} routing card(s) returned`,
    };
  },
};
