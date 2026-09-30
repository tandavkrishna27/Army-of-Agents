// server/src/services/internal-agent/tools/artifact-query.ts
//
// Task C2 batch 2 — `query_artifacts` (query tool).
//
// Lists artifacts linked to a thread via the discussion_entry_attachments
// join table. A thread may have many entries; each entry can have many
// attached artifacts. We deliberately use a 2-way join (artifacts →
// discussion_entry_attachments → discussion_entries) rather than a 3-way
// outer join so an artifact attached multiple times shows up once per
// attachment (callers can dedupe by artifactId if needed; surfacing both
// hits matches the underlying physical model).

import { and, eq } from "drizzle-orm";
import {
  artifacts,
  discussionEntries,
  discussionEntryAttachments,
  discussions,
} from "@armyofagents/db";
import type { AgentTool } from "../types.js";

export const queryArtifactsTool: AgentTool = {
  name: "query_artifacts",
  description:
    "List artifacts linked to a thread via discussion_entry_attachments.",
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread (discussion) id" },
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
        artifactId: artifacts.id,
        title: artifacts.title,
        type: artifacts.type,
        currentVersionId: artifacts.currentVersionId,
        status: artifacts.status,
      })
      .from(artifacts)
      .innerJoin(
        discussionEntryAttachments,
        eq(discussionEntryAttachments.artifactId, artifacts.id),
      )
      .innerJoin(
        discussionEntries,
        eq(discussionEntries.id, discussionEntryAttachments.discussionEntryId),
      )
      .innerJoin(discussions, eq(discussions.id, discussionEntries.discussionId))
      .where(and(
        eq(discussionEntries.discussionId, threadId),
        eq(discussions.companyId, ctx.companyId),
        eq(artifacts.companyId, ctx.companyId),
      ));
    const list = Array.isArray(rows) ? rows : [];

    return {
      success: true,
      data: list,
      summary: `Found ${list.length} artifact${list.length === 1 ? "" : "s"} in thread`,
    };
  },
};
