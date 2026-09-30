// server/src/services/internal-agent/tools/get-task-tool.ts
//
// Task 2 (Spec B) — `get_task` (query tool).
//
// Lets a crew agent read its assigned task's full context: identity, status,
// priority, the source discussion thread, the assigned agent, and execution
// workspace pointers.
//
// SECURITY (company scoping): issueService.getById(id) has NO company filter —
// it looks the issue up by primary key alone. This tool MUST therefore enforce
// row.companyId === ctx.companyId itself and return not-found on mismatch, so a
// crew agent can never read a task belonging to another company.
//
// CATEGORY: `query` (deliberately NOT `action`). Per authorize-tool.ts's
// CAPABILITY_TO_CATEGORY map, only the `action`, `discussion`, and `memory`
// categories are capability-gated. `query` confers no capability, so exposing
// this tool does not widen `system_actions` (or any other capability) for the
// calling agent.

import type { AgentTool, ToolResult } from "../types.js";

export const getTaskTool: AgentTool = {
  name: "get_task",
  description:
    "Read the full context of a single task (your assigned task): identifier, title, description, status, priority, source discussion thread, assignee, responsible human owner, and execution workspace. Assignee means who does the task; responsible human owns the outcome.",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The task (issue) ID to read" },
    },
    required: ["taskId"],
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const { taskId } = (params ?? {}) as { taskId?: unknown };
    if (!taskId || typeof taskId !== "string") {
      return {
        success: false,
        data: null,
        summary: "taskId is required",
        error: "INVALID_PARAMS",
      };
    }

    const row = await ctx.services.issues.getById(taskId);

    // getById has no company filter — enforce it here. Treat a cross-company
    // hit exactly like a miss (same error + no row data) so the tool never
    // confirms the existence of, or leaks any field from, another company's
    // task.
    if (
      !row ||
      (row as { companyId?: string }).companyId !== ctx.companyId ||
      (ctx.agentId !== undefined &&
        (row as { assigneeAgentId?: string | null }).assigneeAgentId !== ctx.agentId)
    ) {
      return {
        success: false,
        data: null,
        summary: "Task not found",
        error: "NOT_FOUND",
      };
    }

    const task = row as Record<string, unknown>;
    return {
      success: true,
      data: {
        id: task.id ?? null,
        identifier: task.identifier ?? null,
        title: task.title ?? null,
        description: task.description ?? null,
        status: task.status ?? null,
        priority: task.priority ?? null,
        projectId: task.projectId ?? null,
        goalId: task.goalId ?? null,
        // The source discussion thread that produced this task (Spec B threadId).
        sourceDiscussionId: task.sourceDiscussionId ?? null,
        assigneeAgentId: task.assigneeAgentId ?? null,
        assigneeUserId: task.assigneeUserId ?? null,
        responsibleUserId: task.responsibleUserId ?? null,
        executionWorkspaceId: task.executionWorkspaceId ?? null,
        executionWorkspacePreference: task.executionWorkspacePreference ?? null,
        parentId: task.parentId ?? null,
        artifactId: task.artifactId ?? null,
      },
      summary: `Task ${task.identifier ?? task.id}: ${task.title ?? "(untitled)"} — ${task.status ?? "unknown"}`,
    };
  },
};
