import type { AgentTool } from "../types.js";
import { buildPostReplyIdempotencyKey } from "./thread-action-keys.js";

export function createPostEntryTool(): AgentTool {
  return {
    name: "post_entry",
    description:
      "Post a message to a thread as this agent. Use for crew coordination, summaries, and @mentions.",
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "The discussion/thread ID",
        },
        content: {
          type: "string",
          description: "Message text (supports @mentions like @Planner, @Router)",
        },
        parentEntryId: {
          type: "string",
          description: "Reply to an existing entry (optional)",
        },
        sourceInfo: {
          type: "object",
          description: "Metadata e.g. { systemNotice: true } (optional)",
        },
      },
      required: ["threadId", "content"],
    },
    category: "discussion",
    requiredRole: "team_member",
    requiresConfirmation: false,
    execute: async (params: unknown, ctx) => {
      const { threadId, content, parentEntryId, sourceInfo } = (params ?? {}) as Record<
        string,
        unknown
      >;

      if (ctx.discussionRunMode === "controller_action_gate") {
        if (!ctx.runId) {
          return {
            success: false,
            data: null,
            summary: "Cannot queue thread reply without a run id",
            error: "MISSING_RUN_ID",
          };
        }

        const { threadAgentActionService } = await import("../../thread-agent-actions.js");
        const action = await threadAgentActionService(ctx.db).proposeThreadAction({
          companyId: ctx.companyId,
          threadId: threadId as string,
          runId: ctx.runId,
          agentId: ctx.agentId ?? null,
          actionType: "post_reply",
          payload: {
            rawContent: content as string,
            parentEntryId: (parentEntryId as string) ?? null,
            sourceInfo: (sourceInfo as Record<string, unknown>) ?? null,
          },
          idempotencyKey: buildPostReplyIdempotencyKey({
            threadId: threadId as string,
            agentId: ctx.agentId,
            parentEntryId: (parentEntryId as string) ?? null,
            content: content as string,
            // Turn anchor: the latest human entry's seq at run start. Stable across a
            // turn's retries (a newer human entry would supersede the run), distinct
            // across turns — so an identical reply in two genuine turns is NOT deduped
            // while a same-turn retry is. Null (agent-only thread) → content-only (#198).
            turnAnchor:
              ctx.threadFreshness?.latestHumanSeq != null
                ? String(ctx.threadFreshness.latestHumanSeq)
                : null,
          }),
          freshness: ctx.threadFreshness ?? {},
        }) as { id?: string };

        return {
          success: true,
          data: { actionId: action.id, queued: true },
          summary: "Queued thread reply for freshness-checked commit",
        };
      }

      // The server engaged this agent on the thread (dispatcher/controller run) —
      // register it as a participant so the posting authz recognizes it. Without
      // this, a crew agent's first post 404s on any thread it can't otherwise view.
      if (ctx.agentId) {
        const { ensureAgentParticipant } = await import("../../threads.js");
        await ensureAgentParticipant(ctx.db, ctx.companyId, threadId as string, ctx.agentId);
      }

      const entry = await ctx.services.discussions.addEntry(
        ctx.companyId,
        threadId as string,
        {
          inputType: "agent",
          rawContent: content as string,
          parentEntryId: (parentEntryId as string) ?? null,
          authorAgentId: ctx.agentId ?? null,
          sourceInfo: (sourceInfo as Record<string, unknown>) ?? null,
        },
        ctx.agentId ?? "aoa-agent",
        {
          userId: ctx.agentId ?? "aoa-agent",
          role: "team_member",
          isHuman: false,
          principalType: "agent",
        },
      );

      // @mention summons are enqueued to the transactional outbox INSIDE
      // addEntry's tx (with hopCount:1 for this agent-authored entry) and drained
      // exactly-once by the mention-outbox worker (PR #291 round-8 #1). The
      // previous direct processMentions call here summoned AGAIN on top of the
      // outbox — a double summon (hop bump / double participation). Removed. A
      // replayed entry (same-key retry / race loser) never gets an outbox row, so
      // it also cannot re-summon.

      return {
        success: true,
        data: { entryId: entry.id },
        summary: "Posted entry to thread",
      };
    },
  };
}
