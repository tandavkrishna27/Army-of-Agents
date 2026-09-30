// server/src/services/internal-agent/tools/thread-list-entries.ts
//
// Task C2 batch 1 — `thread.listEntries` (read tool).
// Returns entries from a thread in chronological order, capped at 200.
//
// Why cap at 200 server-side: callers should not be able to request unbounded
// pulls. Even at 200 entries a thread will produce ~50KB of payload (typical
// entry text is small). Front-end + agents that need more should paginate
// with explicit cursors in a future batch.

import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { discussionEntries, discussions } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

const MAX_ENTRIES = 200;

export const threadListEntriesTool: AgentTool = {
  name: "thread.listEntries",
  description:
    "Read entries from a thread in chronological order (capped at 200).",
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread (discussion) ID" },
      limit: {
        type: "number",
        description: "Max entries to return (default 200, hard-capped at 200)",
      },
    },
    required: ["threadId"],
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { threadId, limit } = (params ?? {}) as {
      threadId?: string;
      limit?: number;
    };
    if (!threadId || typeof threadId !== "string") {
      return {
        success: false,
        data: null,
        summary: "threadId is required",
        error: "INVALID_PARAMS",
      };
    }
    const cappedLimit = Math.min(
      typeof limit === "number" && limit > 0 ? limit : MAX_ENTRIES,
      MAX_ENTRIES,
    );
    // Drizzle: fetch newest first, then reverse client-side so the caller sees
    // chronological order. ORDER BY DESC + LIMIT keeps the index scan on
    // (discussion_id, created_at) efficient even for very long threads.
    const rows = await ctx.db
      .select(getTableColumns(discussionEntries))
      .from(discussionEntries)
      .innerJoin(discussions, eq(discussions.id, discussionEntries.discussionId))
      .where(and(eq(discussionEntries.discussionId, threadId), eq(discussions.companyId, ctx.companyId)))
      .orderBy(desc(discussionEntries.createdAt))
      .limit(cappedLimit);
    const chronological = Array.isArray(rows) ? [...rows].reverse() : [];
    return {
      success: true,
      data: chronological,
      summary: `Loaded ${chronological.length} entr${chronological.length === 1 ? "y" : "ies"}`,
    };
  },
};
