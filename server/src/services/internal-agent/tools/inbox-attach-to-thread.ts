// server/src/services/internal-agent/tools/inbox-attach-to-thread.ts
//
// Task C2 batch 2 — `attach_to_thread` (action tool, Navigator).
//
// Moves a thread_inbox_items row into a real thread as a new discussion entry.
//
// Task 1.8 rewrite — routing dial gate:
//
//   'suggest'               → record routerDecision='suggest' + suggestedThreadId for
//                             the founder to confirm in the Inbox (Phase 2 UI); do NOT post.
//   'auto_attach'/'full_auto' → post content immediately via the shared, companyId-guarded,
//                             atomic write-path (attachInboxItemToThread).
//   'off'                   → also acts via the shared service. The dispatcher already gates
//                             auto-routing wakeups at 'off'; an explicit attach_to_thread
//                             call at 'off' is a direct / manual Navigator action.
//
// Eliminates:
//   - The duplicated inline transaction (#6) — now owned by the shared service.
//   - The cross-tenant hole (#7) — companyId validation now happens in the shared service
//     (for act paths) or in the pre-flight guard below (for suggest path).
//   - The absent seq bump, atomic claim, live events, and routingStatus update —
//     now all handled by attachInboxItemToThread in inbox-attach.ts.

import { and, eq } from "drizzle-orm";
import { threadInboxItems, internalAgentConfig, discussions } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

// NOTE: `attachInboxItemToThread` is imported DYNAMICALLY inside execute() (the
// act path), NOT statically here. A static import pulls the heavy
// inbox-attach → discussions → execution-workspaces → git → node:child_process
// chain into the tool-registry's eager module graph, which breaks registry-
// loading tests (cli-mode, aoa-runner) whose `node:child_process` mock omits
// `execFile`. Dynamic import keeps that chain off the module-load path —
// mirrors the producer/sweep dynamic-import pattern (Task 1.4).

export const attachToThreadTool: AgentTool = {
  name: "attach_to_thread",
  description:
    "Move a thread_inbox_items entry to a real thread as a new discussion entry.",
  parameters: {
    type: "object",
    properties: {
      inboxItemId: { type: "string", description: "The thread_inbox_items row id" },
      threadId: { type: "string", description: "Destination thread (discussion) id" },
    },
    required: ["inboxItemId", "threadId"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { inboxItemId, threadId } = (params ?? {}) as {
      inboxItemId?: string;
      threadId?: string;
    };
    if (!inboxItemId || typeof inboxItemId !== "string") {
      return {
        success: false,
        data: null,
        summary: "inboxItemId is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!threadId || typeof threadId !== "string") {
      return {
        success: false,
        data: null,
        summary: "threadId is required",
        error: "INVALID_PARAMS",
      };
    }

    // ── Step 1: read the routing dial ─────────────────────────────────────────
    const [cfg] = await ctx.db
      .select({ level: internalAgentConfig.inboundRoutingLevel })
      .from(internalAgentConfig)
      .where(eq(internalAgentConfig.companyId, ctx.companyId))
      .limit(1);
    const level = (cfg?.level ?? "off") as string;

    // ── Step 2: suggest path — record decision, do NOT post content ───────────
    if (level === "suggest") {
      // Pre-flight existence + company guard (shared service not called on this path).
      const [item] = await ctx.db
        .select({ id: threadInboxItems.id, companyId: threadInboxItems.companyId })
        .from(threadInboxItems)
        .where(eq(threadInboxItems.id, inboxItemId))
        .limit(1);
      if (!item) {
        return {
          success: false,
          data: null,
          summary: "Inbox item not found",
          error: "NOT_FOUND",
        };
      }
      if (item.companyId !== ctx.companyId) {
        return {
          success: false,
          data: null,
          summary: "Inbox item belongs to a different company",
          error: "COMPANY_MISMATCH",
        };
      }
      // Pre-flight: verify the target thread exists AND belongs to this company.
      // Without this check a Navigator could (a) store a cross-company thread FK on
      // this company's inbox item, or (b) trigger a FK violation crash on a hallucinated
      // / deleted threadId (the suggest path has no outer try/catch).
      const [thr] = await ctx.db.select({ id: discussions.id })
        .from(discussions)
        .where(and(eq(discussions.id, threadId), eq(discussions.companyId, ctx.companyId)))
        .limit(1);
      if (!thr) {
        return {
          success: false,
          data: null,
          summary: "Target thread not found in this company",
          error: "THREAD_NOT_FOUND",
        };
      }
      // Record the suggestion — leave status='pending' so the item awaits human confirm.
      // First-writer guard (Codex L9): mirror the act path's escalated-claim WHERE
      // (~line 147 below) — only write when the item is still 'escalated'. Without
      // this a stale Navigator run could overwrite routerDecision/suggestedThreadId
      // on an item the reclaim sweep already finalized to the founder
      // (routingStatus 'routed' + routerDecision 'human'). On 0 rows updated the
      // item was already finalized → no-op.
      const suggestClaim = await ctx.db
        .update(threadInboxItems)
        .set({
          routerDecision: "suggest",
          suggestedThreadId: threadId,
          routingStatus: "routed",
        })
        .where(
          and(
            eq(threadInboxItems.id, inboxItemId),
            eq(threadInboxItems.companyId, ctx.companyId),
            eq(threadInboxItems.routingStatus, "escalated"),
          ),
        )
        .returning({ id: threadInboxItems.id });
      if (suggestClaim.length === 0) {
        return {
          success: true,
          data: { action: "already_finalized" },
          summary: "Item was already finalized to the founder — no action",
        };
      }
      return {
        success: true,
        data: { suggested: true, suggestedThreadId: threadId },
        summary:
          "Routing suggestion recorded — founder confirms in the Inbox",
      };
    }

    // ── Step 3: act path (auto_attach | full_auto | off) → shared service ─────
    // Race-guard (Codex round-3 P1): if this item is resolving a routing
    // escalation, atomically claim it so a stale 'processing' Navigator run
    // can't auto-attach an item the reclaim sweep already handed to the founder.
    const escalatedClaim = await ctx.db
      .update(threadInboxItems)
      .set({ routingStatus: "routing" })
      .where(
        and(
          eq(threadInboxItems.id, inboxItemId),
          eq(threadInboxItems.companyId, ctx.companyId),
          eq(threadInboxItems.routingStatus, "escalated"),
        ),
      )
      .returning({ id: threadInboxItems.id });

    if (escalatedClaim.length === 0) {
      // Not currently 'escalated'. Distinguish a sweep-finalized escalation
      // (no-op) from a manual/direct attach on a never-escalated item (proceed).
      const [cur] = await ctx.db
        .select({
          routingStatus: threadInboxItems.routingStatus,
          routerDecision: threadInboxItems.routerDecision,
        })
        .from(threadInboxItems)
        .where(and(eq(threadInboxItems.id, inboxItemId), eq(threadInboxItems.companyId, ctx.companyId)))
        .limit(1);
      if (cur && cur.routingStatus === "routed" && cur.routerDecision === "human") {
        return {
          success: true,
          data: { action: "already_finalized" },
          summary: "Item was already finalized to the founder — no action",
        };
      }
      // else: manual/direct attach on a non-escalated item — fall through.
    }

    try {
      const { attachInboxItemToThread } = await import("../../inbox-attach.js");
      const res = await attachInboxItemToThread(ctx.db, {
        companyId: ctx.companyId,
        inboxItemId,
        threadId,
        actor: {
          actorId: ctx.agentId ?? "system",
          actorType: "agent",
          agentId: ctx.agentId ?? null,
        },
      });
      return {
        success: true,
        data: { entryId: res.entryId, alreadyHandled: res.alreadyHandled },
        summary: res.alreadyHandled
          ? "Inbox item was already attached"
          : "Inbox item attached to thread",
      };
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (msg.includes("COMPANY_MISMATCH")) {
        return {
          success: false,
          data: null,
          summary:
            "Inbox item or thread belongs to a different company",
          error: "COMPANY_MISMATCH",
        };
      }
      return {
        success: false,
        data: null,
        summary: `Failed to attach inbox item: ${msg || "unknown error"}`,
        error: "TRANSACTION_FAILED",
      };
    }
  },
};
