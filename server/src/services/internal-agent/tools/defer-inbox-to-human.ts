// server/src/services/internal-agent/tools/defer-inbox-to-human.ts
//
// defer_inbox_to_human — the Navigator's "I'm unsure" finalization (Codex P1 #2).
//
// When the Navigator cannot confidently attach or create, it MUST call this
// rather than returning silently. It moves the item to a TERMINAL routed state
// (routingStatus='routed', routerDecision='human') so:
//   - the item stays visible in the Inbox (status='pending') for founder triage, AND
//   - the reclaim sweep does NOT re-escalate it (escalated → reclaim → escalated loop).

import { and, eq } from "drizzle-orm";
import { threadInboxItems } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

export const deferInboxToHumanTool: AgentTool = {
  name: "defer_inbox_to_human",
  description:
    "Finalize an inbound item you are UNSURE about: leave it in the Inbox for the " +
    "founder to triage. Call this instead of returning silently when no thread is a " +
    "confident home and a new thread isn't clearly warranted.",
  parameters: {
    type: "object",
    properties: {
      inboxItemId: { type: "string", description: "ID of the thread_inbox_items row to defer" },
    },
    required: ["inboxItemId"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { inboxItemId } = (params ?? {}) as { inboxItemId?: string };
    if (!inboxItemId || typeof inboxItemId !== "string") {
      return { success: false, data: null, summary: "inboxItemId is required", error: "INVALID_PARAMS" };
    }

    // Cross-tenant guard.
    const itemRows = await ctx.db
      .select({ companyId: threadInboxItems.companyId })
      .from(threadInboxItems)
      .where(eq(threadInboxItems.id, inboxItemId))
      .limit(1);
    const item = itemRows[0];
    if (!item) {
      return { success: false, data: null, summary: `Inbox item ${inboxItemId} not found`, error: "ITEM_NOT_FOUND" };
    }
    if (item.companyId !== ctx.companyId) {
      return { success: false, data: null, summary: "Inbox item belongs to a different company", error: "COMPANY_MISMATCH" };
    }

    // Terminal: routed + human. Item stays status='pending' (visible in Inbox),
    // routingStatus='routed' means the reclaim sweep will NOT re-escalate it.
    //
    // First-writer-wins guard (Codex round-3 P1): require routingStatus='escalated'.
    // If the reclaim sweep already finalized this item (because this Navigator run
    // ran past the reclaim threshold), the claim returns 0 rows and we no-op —
    // the sweep's finalization stands. This closes the processing-wakeup race
    // (the sweep cancels only QUEUED wakeups; a live 'processing' run reaches here).
    const claimed = await ctx.db
      .update(threadInboxItems)
      .set({ routingStatus: "routed", routerDecision: "human", routedAt: new Date() })
      .where(
        and(
          eq(threadInboxItems.id, inboxItemId),
          eq(threadInboxItems.companyId, ctx.companyId),
          eq(threadInboxItems.routingStatus, "escalated"),
        ),
      )
      .returning({ id: threadInboxItems.id });

    if (claimed.length === 0) {
      return {
        success: true,
        data: { action: "already_finalized" },
        summary: "Item was already finalized (no longer escalated) — no action",
      };
    }

    return {
      success: true,
      data: { action: "deferred_to_human" },
      summary: "Item left in Inbox for founder triage (Navigator unsure)",
    };
  },
};
