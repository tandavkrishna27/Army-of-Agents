import { and, eq } from "drizzle-orm";
import { discussionExtractedItems, discussionEntries, discussions } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

export function createThreadTools(): AgentTool[] {
  return [
    {
      name: "query_threads",
      description: "List threads (discussions) in this company. Optionally filter by phase or scope.",
      parameters: {
        type: "object",
        properties: {
          phase: {
            type: "string",
            description: "Filter by phase: discuss | scope | assign | execute | done",
          },
          scopeType: {
            type: "string",
            description: "Filter by scope type: project | department | goal",
          },
          scopeId: {
            type: "string",
            description: "Filter by scope ID (requires scopeType)",
          },
          limit: {
            type: "number",
            description: "Max results to return (default 20)",
          },
        },
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const { phase, scopeType, scopeId, limit } = (params ?? {}) as Record<string, unknown>;
        const all = await ctx.services.discussions.list(ctx.companyId, {
          ...(scopeType ? { scopeType: scopeType as string } : {}),
          ...(scopeId ? { scopeId: scopeId as string } : {}),
        });
        const filtered = Array.isArray(all)
          ? all.filter((d: any) => !phase || d.phase === phase)
          : all;
        const limited = Array.isArray(filtered)
          ? filtered.slice(0, (limit as number) ?? 20)
          : filtered;
        const count = Array.isArray(limited) ? limited.length : 0;
        const summaries = Array.isArray(limited)
          ? limited.map((d: any) => ({
              id: d.id,
              title: d.title,
              phase: d.phase,
              entryCount: d.entryCount,
              pendingItemCount: d.pendingItemCount,
              scopeType: d.scopeType,
              scopeId: d.scopeId,
            }))
          : [];
        return { success: true, data: summaries, summary: `Found ${count} thread(s)` };
      },
    },
    {
      name: "query_extracted_items",
      description: "List extracted items from a thread (decisions, tasks, insights, references, etc).",
      parameters: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "The discussion/thread ID (required)",
          },
          status: {
            type: "string",
            description: "Filter by item status: pending | approved | rejected | edited",
          },
          type: {
            type: "string",
            description: "Filter by item type: decision | task | insight | context | reference | preference",
          },
        },
        required: ["threadId"],
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const { threadId, status, type } = (params ?? {}) as Record<string, unknown>;
        const rows = await ctx.db
          .select({
            id: discussionExtractedItems.id,
            type: discussionExtractedItems.type,
            title: discussionExtractedItems.title,
            status: discussionExtractedItems.status,
            description: discussionExtractedItems.description,
            entryId: discussionExtractedItems.discussionEntryId,
            resultTaskId: discussionExtractedItems.resultTaskId,
          })
          .from(discussionExtractedItems)
          .innerJoin(
            discussionEntries,
            eq(discussionEntries.id, discussionExtractedItems.discussionEntryId),
          )
          .innerJoin(discussions, eq(discussions.id, discussionEntries.discussionId))
          .where(and(
            eq(discussionEntries.discussionId, threadId as string),
            eq(discussions.companyId, ctx.companyId),
          ));
        const filtered = rows
          .filter((r: any) => !status || r.status === status)
          .filter((r: any) => !type || r.type === type);
        return { success: true, data: filtered, summary: `Found ${filtered.length} extracted item(s)` };
      },
    },
  ];
}
