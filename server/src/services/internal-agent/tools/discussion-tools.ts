import type { AgentTool } from "../types.js";

export function createDiscussionTools(): AgentTool[] {
  return [
    {
      name: "extract_from_content",
      description: "Trigger extraction of tasks and memory items from a discussion entry.",
      parameters: {
        type: "object",
        properties: {
          entryId: { type: "string", description: "Discussion entry ID to extract from (required)" },
          includeAnnotations: { type: "boolean", description: "Include annotations in extraction context (default false)" },
        },
        required: ["entryId"],
      },
      category: "discussion",
      requiredRole: "founder",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { entryId } = (params ?? {}) as Record<string, unknown>;
        const { extractionService } = await import("../../extraction.js");
        const service = extractionService(ctx.db);
        await service.extractFromDiscussionEntry(ctx.companyId, entryId as string);
        return { success: true, data: { entryId }, summary: `Extraction triggered for entry ${entryId}` };
      },
    },
    {
      name: "search_discussions",
      description: "Search discussions by title.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search text (required)" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
      category: "discussion",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const { query, limit } = (params ?? {}) as Record<string, unknown>;
        const all = await ctx.services.discussions.list(ctx.companyId, {});
        const q = (query as string).toLowerCase();
        const filtered = Array.isArray(all)
          ? all.filter((d: any) => d.title?.toLowerCase().includes(q))
          : all;
        const limited = Array.isArray(filtered) ? filtered.slice(0, (limit as number) ?? 10) : filtered;
        const count = Array.isArray(limited) ? limited.length : 0;
        return { success: true, data: limited, summary: `Found ${count} discussion(s)` };
      },
    },
    {
      name: "link_discussion_to_project",
      description: "Scope a discussion to a project, department, or goal.",
      parameters: {
        type: "object",
        properties: {
          discussionId: { type: "string", description: "Discussion ID (required)" },
          scopeType: { type: "string", enum: ["project", "department", "goal"], description: "Scope type (required)" },
          scopeId: { type: "string", description: "ID of the project/department/goal (required)" },
        },
        required: ["discussionId", "scopeType", "scopeId"],
      },
      category: "discussion",
      requiredRole: "team_lead",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { discussionId, scopeType, scopeId } = (params ?? {}) as Record<string, unknown>;
        const result = await ctx.services.discussions.update(ctx.companyId, discussionId as string, {
          scopeType: scopeType as string,
          scopeId: scopeId as string,
        });
        return { success: true, data: result, summary: `Linked discussion to ${scopeType} ${scopeId}` };
      },
    },
  ];
}
