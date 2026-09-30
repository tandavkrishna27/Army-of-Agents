// server/src/services/internal-agent/tools/thread-get-summary.ts
//
// Task C2 batch 1 — `get_thread_summary` (query tool).
// Returns a thread's summary, intent, phase, autonomy, visibility, plus
// the list of crew participants.

import { and, eq } from "drizzle-orm";
import { discussions, threadParticipants } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

export const getThreadSummaryTool: AgentTool = {
  name: "get_thread_summary",
  description:
    "Return a thread's summary, intent, phase, and crew participants.",
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread (discussion) ID" },
    },
    required: ["threadId"],
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { threadId } = (params ?? {}) as { threadId?: string };
    if (!threadId || typeof threadId !== "string") {
      return {
        success: false,
        data: null,
        summary: "threadId is required",
        error: "INVALID_PARAMS",
      };
    }
    const rows = await ctx.db
      .select({
        id: discussions.id,
        summaryText: discussions.summaryText,
        routingTerms: discussions.routingTerms,   // NEW — Chronicler reads this to merge
        summaryUpdatedAt: discussions.summaryUpdatedAt,
        intent: discussions.intent,
        phase: discussions.phase,
        autonomyLevel: discussions.autonomyLevel,
        visibility: discussions.visibility,
        ownerUserId: discussions.ownerUserId,
      })
      .from(discussions)
      .where(and(eq(discussions.id, threadId), eq(discussions.companyId, ctx.companyId)))
      .limit(1);
    const thread = Array.isArray(rows) ? rows[0] : null;
    if (!thread) {
      return {
        success: false,
        data: null,
        summary: "Thread not found",
        error: "NOT_FOUND",
      };
    }
    const participants = await ctx.db
      .select()
      .from(threadParticipants)
      .where(eq(threadParticipants.threadId, threadId));
    const participantList = Array.isArray(participants) ? participants : [];
    return {
      success: true,
      data: {
        summaryText: thread.summaryText,
        routingTerms: Array.isArray(thread.routingTerms)
          ? (thread.routingTerms as unknown[]).filter((t): t is string => typeof t === "string")
          : [],
        summaryUpdatedAt: thread.summaryUpdatedAt,
        intent: thread.intent,
        phase: thread.phase,
        autonomyLevel: thread.autonomyLevel,
        visibility: thread.visibility,
        ownerUserId: thread.ownerUserId,
        participants: participantList,
      },
      summary: `Phase: ${thread.phase}, ${participantList.length} participant(s)`,
    };
  },
};
