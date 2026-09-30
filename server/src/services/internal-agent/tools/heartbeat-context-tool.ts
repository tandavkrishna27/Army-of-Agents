// server/src/services/internal-agent/tools/heartbeat-context-tool.ts
//
// Plan 3 Task 3 (B2) — get_heartbeat_context. Returns { task, recentComments }
// (last 10) for a task. The auto-run-summary comment posted after each
// heartbeat/crew run lives in these comments, so review-agent-output reads the
// run outcome here without a dedicated run-history tool. Company-scoped
// in-tool (getById/listComments have no company filter). Category: query (no
// capability gate).
import type { AgentTool, ToolResult } from "../types.js";

export const getHeartbeatContextTool: AgentTool = {
  name: "get_heartbeat_context",
  description:
    "Read a task plus its 10 most recent comments — including the auto-generated run-summary an agent posts after each run (outcome, duration, cost, files touched). Use to see what an agent actually did on a task.",
  parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const { taskId } = (params ?? {}) as { taskId?: string };
    if (!taskId || typeof taskId !== "string") {
      return { success: false, data: null, summary: "taskId is required", error: "INVALID_PARAMS" };
    }
    const task = await ctx.services.issues.getById(taskId);
    if (!task || (task as { companyId?: string }).companyId !== ctx.companyId) {
      return { success: false, data: null, summary: "Task not found", error: "NOT_FOUND" };
    }
    const comments = await ctx.services.issues.listComments(taskId);
    const recentComments = (Array.isArray(comments) ? comments : []).slice(0, 10);
    return {
      success: true,
      data: { task, recentComments },
      summary: `Task context: ${(task as any).identifier ?? taskId} (+${recentComments.length} comments)`,
    };
  },
};
