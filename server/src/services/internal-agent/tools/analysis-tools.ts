import type { AgentTool } from "../types.js";

export function createAnalysisTools(): AgentTool[] {
  return [
    {
      name: "analyze_workload",
      description: "Get workload balance insights from the suggestion engine.",
      parameters: {
        type: "object",
        properties: {},
      },
      category: "analysis",
      requiredRole: "team_lead",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const suggestions = await ctx.services.suggestions.list(ctx.companyId, {
          category: "workload_balance",
        });
        const count = Array.isArray(suggestions) ? suggestions.length : 0;
        return { success: true, data: suggestions, summary: `Found ${count} workload insight(s)` };
      },
    },
    {
      name: "suggest_improvements",
      description: "Run all detectors and return pending improvement suggestions.",
      parameters: {
        type: "object",
        properties: {},
      },
      category: "analysis",
      requiredRole: "team_lead",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        await ctx.services.suggestions.runAllDetectors(ctx.companyId);
        const suggestions = await ctx.services.suggestions.listPending(ctx.companyId);
        const count = Array.isArray(suggestions) ? suggestions.length : 0;
        return { success: true, data: suggestions, summary: `Generated ${count} suggestion(s)` };
      },
    },
  ];
}
