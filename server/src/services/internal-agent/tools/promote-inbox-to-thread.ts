// server/src/services/internal-agent/tools/promote-inbox-to-thread.ts
//
// promote_inbox_to_thread — Navigator tool that creates a new thread from an
// inbox item (C1 BLOCKER: spin_off_thread cannot do this — it is thread→thread).
//
// Dial-gated (D2):
//   full_auto  → auto-creates the new thread via promoteInboxItemToNewThread.
//   auto_attach / suggest → records routerDecision='suggest_new' with a proposed
//     title; the Unlisted lane surfaces this as a confirm-create suggestion.

import { and, eq } from "drizzle-orm";
import { internalAgentConfig, threadInboxItems } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

const SYSTEM_ACTOR = { actorId: "system", actorType: "system" as const, agentId: null };

export const promoteInboxToThreadTool: AgentTool = {
  name: "promote_inbox_to_thread",
  description:
    "Create a new thread from an inbound inbox item. " +
    "At full_auto dial: auto-creates the thread. " +
    "At auto_attach/suggest dial: records a 'suggest_new' decision surfaced to the founder.",
  parameters: {
    type: "object",
    properties: {
      inboxItemId: { type: "string", description: "ID of the thread_inbox_items row to promote" },
      proposedTitle: {
        type: "string",
        description: "Suggested title for the new thread (shown in the suggest_new banner)",
      },
    },
    required: ["inboxItemId"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { inboxItemId, proposedTitle } = (params ?? {}) as {
      inboxItemId?: string;
      proposedTitle?: string;
    };

    if (!inboxItemId || typeof inboxItemId !== "string") {
      return { success: false, data: null, summary: "inboxItemId is required", error: "INVALID_PARAMS" };
    }

    // Cross-tenant guard (Codex P1 #6): verify the inbox item exists AND belongs
    // to the caller's company before any write. Without this, a Navigator scoped
    // to company A could flip company B's item by knowing its ID.
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

    // Read routing dial.
    const configRows = await ctx.db
      .select({ inboundRoutingLevel: internalAgentConfig.inboundRoutingLevel })
      .from(internalAgentConfig)
      .where(eq(internalAgentConfig.companyId, ctx.companyId))
      .limit(1);
    const dial = (configRows[0]?.inboundRoutingLevel ?? "off") as string;

    if (dial === "full_auto") {
      // First-writer-wins guard (Codex round-3 P1): atomically claim the item
      // ONLY if it is still 'escalated'. If the reclaim sweep already finalized
      // it to routed+human (this run ran past the reclaim threshold), the claim
      // returns 0 rows and we no-op — the sweep's human-finalization stands.
      // This prevents a live 'processing' Navigator run from auto-creating a
      // thread for an item the founder was already handed.
      const claimed = await ctx.db
        .update(threadInboxItems)
        .set({
          routingStatus: "routing",
          // Persist the Navigator's proposed title so promoteInboxItemToNewThread
          // (which reads suggestedThreadTitle from the row) titles the auto-created
          // thread with the clean title — consistent with the suggest_new human path.
          suggestedThreadTitle: proposedTitle ?? null,
        })
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

      // Auto-create the new thread. promoteInboxItemToNewThread sets the inbox
      // row's terminal status internally.
      const { promoteInboxItemToNewThread } = await import("../../inbox-attach.js");
      const result = await promoteInboxItemToNewThread(ctx.db, {
        companyId: ctx.companyId,
        inboxItemId,
        actor: SYSTEM_ACTOR,
      });

      return {
        success: true,
        data: { action: "created", threadId: result.threadId, entryId: result.entryId },
        summary: result.alreadyHandled
          ? "Item was already handled"
          : `New thread created: ${result.threadId}`,
      };
    }

    // Suggest path (suggest | auto_attach): record suggest_new decision.
    // companyId guard (Codex P1 #6) + escalated guard (Codex round-3 P1) in WHERE.
    const recorded = await ctx.db
      .update(threadInboxItems)
      .set({
        routerDecision: "suggest_new",
        suggestedThreadTitle: proposedTitle ?? null,
        routingStatus: "routed",
        routedAt: new Date(),
      })
      .where(
        and(
          eq(threadInboxItems.id, inboxItemId),
          eq(threadInboxItems.companyId, ctx.companyId),
          eq(threadInboxItems.routingStatus, "escalated"),
        ),
      )
      .returning({ id: threadInboxItems.id });

    if (recorded.length === 0) {
      return {
        success: true,
        data: { action: "already_finalized" },
        summary: "Item was already finalized (no longer escalated) — no action",
      };
    }

    return {
      success: true,
      data: { action: "suggest_new", proposedTitle: proposedTitle ?? null },
      summary: `Suggest-new decision recorded${proposedTitle ? `: "${proposedTitle}"` : ""}`,
    };
  },
};
