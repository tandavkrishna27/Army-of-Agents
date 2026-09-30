// server/src/services/internal-agent/tools/thread-create-link.ts
//
// Task C2 batch 1 — `thread.createLink` (action tool).
// Creates a typed link between two threads in `thread_links`.

import { and, eq, inArray } from "drizzle-orm";
import { discussions, threadLinks } from "@armyofagents/db";
import { THREAD_LINK_KINDS } from "@armyofagents/shared";
import type { AgentTool } from "../types.js";

export const threadCreateLinkTool: AgentTool = {
  name: "thread.createLink",
  description: "Create a typed link between two threads.",
  parameters: {
    type: "object",
    properties: {
      fromId: { type: "string", description: "Source thread (discussion) ID" },
      toId: { type: "string", description: "Target thread (discussion) ID" },
      kind: {
        type: "string",
        description:
          "Link kind. Valid: " + THREAD_LINK_KINDS.join(", "),
      },
    },
    required: ["fromId", "toId", "kind"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { fromId, toId, kind } = (params ?? {}) as {
      fromId?: string;
      toId?: string;
      kind?: string;
    };
    if (!fromId || typeof fromId !== "string") {
      return {
        success: false,
        data: null,
        summary: "fromId is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!toId || typeof toId !== "string") {
      return {
        success: false,
        data: null,
        summary: "toId is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!kind || typeof kind !== "string") {
      return {
        success: false,
        data: null,
        summary: "kind is required",
        error: "INVALID_PARAMS",
      };
    }
    const validKinds = THREAD_LINK_KINDS as readonly string[];
    if (!validKinds.includes(kind)) {
      return {
        success: false,
        data: null,
        summary: `Invalid kind: ${kind}. Valid: ${THREAD_LINK_KINDS.join(", ")}`,
        error: "INVALID_KIND",
      };
    }
    const endpointIds = [...new Set([fromId, toId])];
    const scopedEndpoints = await ctx.db
      .select({ id: discussions.id })
      .from(discussions)
      .where(and(inArray(discussions.id, endpointIds), eq(discussions.companyId, ctx.companyId)));
    if (!Array.isArray(scopedEndpoints) || scopedEndpoints.length !== endpointIds.length) {
      return { success: false, data: null, summary: "Thread not found", error: "NOT_FOUND" };
    }
    const inserted = await ctx.db
      .insert(threadLinks)
      .values({
        companyId: ctx.companyId,
        fromThreadId: fromId,
        toThreadId: toId,
        kind,
        createdBy: ctx.agentId ?? "aoa-agent",
      })
      .returning();
    const link = Array.isArray(inserted) ? inserted[0] : inserted;
    return {
      success: true,
      data: link,
      summary: `Link created: ${fromId} → ${toId} (${kind})`,
    };
  },
};
