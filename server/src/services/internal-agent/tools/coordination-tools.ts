import type { AgentTool } from "../types.js";

export function createCoordinationTools(): AgentTool[] {
  return [
    {
      name: "query_dependency_chain",
      description: "Analyze task dependency chain — find what blocks a task or what it blocks.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID to analyze (required)" },
          direction: { type: "string", enum: ["blocking", "dependent"], description: "Direction: 'blocking' (what blocks this) or 'dependent' (what this blocks)" },
        },
        required: ["taskId"],
      },
      category: "coordination",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const { taskId, direction } = (params ?? {}) as Record<string, unknown>;
        const dir = (direction as string) ?? "blocking";
        const chain = dir === "blocking"
          ? await ctx.services.dependencies.getDependencies(ctx.companyId, taskId as string)
          : await ctx.services.dependencies.getDependents(ctx.companyId, taskId as string);
        const count = Array.isArray(chain) ? chain.length : 0;
        return {
          success: true,
          data: { chain, direction: dir },
          summary: `Found ${count} ${dir} relationship(s) for task ${taskId}`,
        };
      },
    },
  ];
}
