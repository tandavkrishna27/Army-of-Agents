// server/src/services/internal-agent/tools/action-tools.ts
import type { AgentTool } from "../types.js";

export function createActionTools(): AgentTool[] {
  return [
    {
      name: "create_task",
      description:
        "Create a new task with title, optional description, priority, department, goal, assignee, and responsible human. Assignee means who does the task; responsible human owns the outcome.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title (required)" },
          description: { type: "string", description: "Task description" },
          priority: { type: "string", enum: ["urgent", "high", "medium", "low"], description: "Task priority" },
          departmentId: { type: "string", description: "Department to assign task to" },
          goalId: { type: "string", description: "Goal to link task to" },
          assigneeType: { type: "string", enum: ["agent", "user"], description: "Whether assigneeId is an agent id or human user id" },
          assigneeId: { type: "string", description: "Assignee id for the agent or human doing the task" },
          responsibleUserId: {
            type: "string",
            description: "Human accountable for the task outcome, separate from the executor assignee.",
          },
        },
        required: ["title"],
      },
      category: "action",
      requiredRole: "team_lead",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { title, description, priority, departmentId, goalId, assigneeId, assigneeType, responsibleUserId } = (params ?? {}) as Record<string, unknown>;
        if (assigneeId && assigneeType !== "agent" && assigneeType !== "user") {
          return {
            success: false,
            data: null,
            error: "assigneeType is required when assigneeId is provided",
            summary: "Missing assignee type",
          };
        }
        if (assigneeType && !assigneeId) {
          return {
            success: false,
            data: null,
            error: "assigneeId is required when assigneeType is provided",
            summary: "Missing assignee id",
          };
        }
        const assigneePatch =
          assigneeId && assigneeType === "user"
            ? { assigneeAgentId: null, assigneeUserId: assigneeId as string }
            : assigneeId
              ? { assigneeAgentId: assigneeId as string, assigneeUserId: null }
              : {};
        const task = await ctx.services.issues.create(ctx.companyId, {
          title: title as string,
          ...(description ? { description: description as string } : {}),
          ...(priority ? { priority: priority as string } : {}),
          ...(departmentId ? { projectId: departmentId as string } : {}),
          ...(goalId ? { goalId: goalId as string } : {}),
          ...assigneePatch,
          ...(responsibleUserId
            ? { responsibleUserId: responsibleUserId as string }
            : { responsibleFallbackUserId: ctx.userId }),
        });
        return { success: true, data: task, summary: `Created task "${title}"` };
      },
    },
    {
      name: "update_task",
      description:
        "Update an existing task's title, status, priority, or responsible human. Use assign_task for assignee reassignment.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "ID of the task to update (required)" },
          title: { type: "string", description: "New title" },
          status: { type: "string", description: "New status" },
          priority: { type: "string", enum: ["urgent", "high", "medium", "low"], description: "New priority" },
          responsibleUserId: {
            type: ["string", "null"],
            description: "Human accountable for the task outcome; null clears the responsible human.",
          },
        },
        required: ["taskId"],
      },
      category: "action",
      requiredRole: "team_lead",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { taskId, title, status, priority, responsibleUserId } = (params ?? {}) as Record<string, unknown>;
        const updates: Record<string, unknown> = {};
        if (title !== undefined) updates.title = title;
        if (status !== undefined) updates.status = status;
        if (priority !== undefined) updates.priority = priority;
        if (responsibleUserId !== undefined) updates.responsibleUserId = responsibleUserId;
        const task = await ctx.services.issues.update(taskId as string, updates);
        return { success: true, data: task, summary: `Updated task ${taskId}` };
      },
    },
    {
      name: "create_department",
      description: "Create a new department. Founder-only.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Department name (required)" },
          description: { type: "string", description: "Department description" },
        },
        required: ["name"],
      },
      category: "action",
      requiredRole: "founder",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { name, description } = (params ?? {}) as Record<string, unknown>;
        const dept = await ctx.services.projects.create(ctx.companyId, {
          name: name as string,
          type: "department",
          ...(description ? { description: description as string } : {}),
        });
        return { success: true, data: dept, summary: `Created department "${name}"` };
      },
    },
    {
      name: "create_goal",
      description: "Create a new goal with optional department scope.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Goal title (required)" },
          description: { type: "string", description: "Goal description" },
          departmentId: { type: "string", description: "Department to scope goal to" },
        },
        required: ["title"],
      },
      category: "action",
      requiredRole: "team_lead",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { title, description, departmentId } = (params ?? {}) as Record<string, unknown>;
        const goal = await ctx.services.goals.create(ctx.companyId, {
          title: title as string,
          ...(description ? { description: description as string } : {}),
          ...(departmentId ? { projectId: departmentId as string } : {}),
        });
        return { success: true, data: goal, summary: `Created goal "${title}"` };
      },
    },
    {
      name: "create_agent",
      description: "Create a new worker agent. Founder-only.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Agent name (required)" },
          adapter: { type: "string", description: "Adapter type (required, e.g. claude_local, codex_local, opencode_local)" },
          context: { type: "string", description: "Agent context/instructions" },
        },
        required: ["name", "adapter"],
      },
      category: "action",
      requiredRole: "founder",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { name, adapter, context } = (params ?? {}) as Record<string, unknown>;
        const agent = await ctx.services.agents.create(ctx.companyId, {
          name: name as string,
          adapterType: adapter as string,
          ...(context ? { context: context as string } : {}),
        });
        return { success: true, data: agent, summary: `Created agent "${name}"` };
      },
    },
    {
      name: "update_agent",
      description: "Update agent configuration. Founder-only.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent ID (required)" },
          context: { type: "string", description: "Updated agent context/instructions" },
          model: { type: "string", description: "Updated model" },
        },
        required: ["agentId"],
      },
      category: "action",
      requiredRole: "founder",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { agentId, ...updates } = (params ?? {}) as Record<string, unknown>;
        const agent = await ctx.services.agents.update(agentId as string, updates);
        return { success: true, data: agent, summary: `Updated agent ${agentId}` };
      },
    },
    {
      name: "assign_task",
      description: "Assign a task to an agent or human. Assignee means who does the task; responsible human ownership is separate.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID (required)" },
          assigneeType: { type: "string", enum: ["agent", "user"], description: "Whether assigneeId is an agent id or human user id" },
          assigneeId: { type: "string", description: "Assignee id for the agent or human doing the task (required)" },
        },
        required: ["taskId", "assigneeType", "assigneeId"],
      },
      category: "action",
      requiredRole: "team_lead",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { taskId, assigneeId, assigneeType } = (params ?? {}) as Record<string, unknown>;
        if (assigneeType !== "agent" && assigneeType !== "user") {
          return {
            success: false,
            data: null,
            error: "assigneeType must be agent or user",
            summary: "Invalid assignee type",
          };
        }
        const assigneePatch =
          assigneeType === "user"
            ? { assigneeAgentId: null, assigneeUserId: assigneeId as string }
            : { assigneeAgentId: assigneeId as string, assigneeUserId: null };
        const task = await ctx.services.issues.update(taskId as string, assigneePatch);
        return { success: true, data: task, summary: `Assigned task ${taskId} to ${assigneeId}` };
      },
    },
    {
      name: "wakeup_agent",
      description: "Trigger an agent's heartbeat to start working.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent ID to wake up (required)" },
        },
        required: ["agentId"],
      },
      category: "action",
      requiredRole: "team_lead",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { agentId } = (params ?? {}) as Record<string, unknown>;
        const result = await ctx.services.heartbeat.wakeup(agentId as string, {
          source: "on_demand",
          triggerDetail: "manual",
          requestedByActorType: "user",
          requestedByActorId: ctx.userId,
        });
        return { success: true, data: result, summary: `Wakeup triggered for agent ${agentId}` };
      },
    },
    {
      name: "update_company_identity",
      description:
        "Update the company's vision and/or mission statement. Only call this after the user has reviewed and approved the new text. Gated to founders only.",
      parameters: {
        type: "object",
        properties: {
          vision: { type: "string", description: "New one-sentence vision statement (the world change)" },
          mission: { type: "string", description: "New one-sentence mission statement (how you get there)" },
        },
        required: [],
      },
      category: "action",
      requiredRole: "founder",
      requiresConfirmation: true,
      execute: async (params: unknown, ctx) => {
        const { vision, mission } = (params ?? {}) as Record<string, unknown>;
        if (!vision && !mission) {
          return { success: false, error: "At least one of vision or mission must be provided.", data: null, summary: "" };
        }
        const updates: Record<string, string> = {};
        if (vision) updates.vision = vision as string;
        if (mission) updates.mission = mission as string;
        const updated = await ctx.services.companies.update(ctx.companyId, updates);
        return {
          success: true,
          data: updated,
          summary: `Updated company identity: ${Object.keys(updates).join(", ")}`,
        };
      },
    },
  ];
}
