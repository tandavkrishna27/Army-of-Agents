// server/src/services/internal-agent/tools/post-task-comment-tool.ts
//
// Task 3 (Spec B) — `post_task_comment` (result-write tool).
//
// Lets a crew agent write a comment back onto its assigned task — e.g. a status
// note, a summary of what it did, or a question for the founder. The comment is
// authored by the calling agent (issue_comments.authorAgentId = ctx.agentId,
// authorType = "agent").
//
// SECURITY (company scoping): issueService.getById(id) has NO company filter —
// it looks the issue up by primary key alone, and issueService.addComment only
// derives the comment's companyId from the issue row (no caller-company check).
// This tool MUST therefore enforce row.companyId === ctx.companyId itself and
// return not-found on mismatch (mirroring get-task-tool.ts), so a crew agent can
// never write onto a task belonging to another company.
//
// CATEGORY: `coordination` (deliberately NOT `action`). Per authorize-tool.ts's
// CAPABILITY_TO_CATEGORY map, only the `action`, `discussion`, and `memory`
// categories are capability-gated. An allowlisted `action` tool would widen the
// agent's `system_actions` capability (derive-capabilities.ts); `coordination`
// confers no capability, so exposing this write tool does not widen the calling
// agent's capability set. This is the zero-surface choice.

import type { AgentTool, ToolResult } from "../types.js";

export const postTaskCommentTool: AgentTool = {
  name: "post_task_comment",
  description:
    "Post a comment back onto a task (typically your assigned task) — for example a progress note, a summary of what you did, or a question for the founder. The comment is recorded as authored by you.",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The task (issue) ID to comment on" },
      body: { type: "string", description: "The comment text to post" },
    },
    required: ["taskId", "body"],
  },
  category: "coordination",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const { taskId, body } = (params ?? {}) as {
      taskId?: unknown;
      body?: unknown;
    };
    if (!taskId || typeof taskId !== "string") {
      return {
        success: false,
        data: null,
        summary: "taskId is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!body || typeof body !== "string") {
      return {
        success: false,
        data: null,
        summary: "body is required",
        error: "INVALID_PARAMS",
      };
    }

    const row = await ctx.services.issues.getById(taskId);

    // getById has no company filter — enforce it here. Treat a cross-company
    // hit exactly like a miss (same error, no write) so the tool never confirms
    // the existence of, or writes onto, another company's task.
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

    const comment = await ctx.services.issues.addComment(taskId, body, {
      agentId: ctx.agentId,
    });

    const commentId = (comment as { id?: string } | null)?.id ?? null;
    return {
      success: true,
      data: { commentId, taskId },
      summary: `Posted comment on task ${taskId}`,
    };
  },
};
