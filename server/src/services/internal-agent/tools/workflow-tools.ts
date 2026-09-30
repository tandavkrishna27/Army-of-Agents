import type { AgentTool } from "../types.js";

const NOT_IMPLEMENTED = { success: false as const, data: null, summary: "Workflow service not yet implemented", error: "NOT_IMPLEMENTED" };

export function createWorkflowTools(): AgentTool[] {
  return [
    {
      name: "create_workflow_template",
      description: "Create a reusable workflow template with steps and dependencies.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Template name (required)" },
          description: { type: "string", description: "Template description" },
          steps: { type: "array", description: "Workflow steps", items: { type: "object" } },
          dependencies: { type: "array", description: "Step dependencies", items: { type: "object" } },
        },
        required: ["name", "steps"],
      },
      category: "workflow",
      requiredRole: "team_lead",
      requiresConfirmation: true,
      execute: async () => NOT_IMPLEMENTED,
    },
    {
      name: "instantiate_workflow",
      description: "Create tasks from a workflow template.",
      parameters: {
        type: "object",
        properties: {
          templateId: { type: "string", description: "Template ID (required)" },
          goalId: { type: "string", description: "Goal to link tasks to (required)" },
          prefix: { type: "string", description: "Prefix for task titles" },
          assignees: { type: "object", description: "Map of step order to agent ID" },
        },
        required: ["templateId", "goalId"],
      },
      category: "workflow",
      requiredRole: "team_lead",
      requiresConfirmation: true,
      execute: async () => NOT_IMPLEMENTED,
    },
    {
      name: "add_task_dependency",
      description: "Add a blocking dependency between two tasks.",
      parameters: {
        type: "object",
        properties: {
          blockingTaskId: { type: "string", description: "Task that blocks (required)" },
          dependentTaskId: { type: "string", description: "Task that is blocked (required)" },
        },
        required: ["blockingTaskId", "dependentTaskId"],
      },
      category: "workflow",
      requiredRole: "team_lead",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { blockingTaskId, dependentTaskId } = (params ?? {}) as Record<string, unknown>;
        const result = await ctx.services.dependencies.addDependency(
          ctx.companyId,
          dependentTaskId as string,
          blockingTaskId as string,
        );
        return { success: true, data: result, summary: `Added dependency: ${blockingTaskId} blocks ${dependentTaskId}` };
      },
    },
  ];
}
