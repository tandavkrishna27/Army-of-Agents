// server/src/services/internal-agent/tools/set-task-status-tool.ts
//
// Task 4 (Spec B) — `set_task_status` (own-task status-transition tool).
//
// Lets a crew agent move ITS OWN task forward (e.g. in_progress → in_review →
// done). This tool RE-IMPLEMENTS NO POLICY: the ownership check and the autonomy
// dial gate (Assist≥1 → in_review, Drive≥2 → done) live in the single Task-1 A4
// service chokepoint, `assertAgentStatusTransition`, which `issueService.update`
// invokes. This tool only:
//   1. company-scopes the task (getById has no company filter — mirrors the
//      sibling get_task / post_task_comment tools), returning a clean NOT_FOUND
//      on a miss or cross-company hit (cleaner than the guard's "not your task");
//   2. resolves effectiveDial = ctx.effectiveAutonomy ?? 0 (fail-closed) and
//      forwards it to update via the actor arg (actor.effectiveDial). The tool
//      does NOT read autonomyLevel/internalAgentConfig and does NOT re-check
//      ownership or the dial — the guard owns that;
//   3. catches the guard's thrown rejection (an `unprocessable`/422-ish error
//      from update) and maps it to a { success:false } ToolResult, so the
//      rejection never escapes `execute` as an exception.
//
// CATEGORY: `coordination` (deliberately NOT `action`). Per authorize-tool.ts's
// CAPABILITY_TO_CATEGORY map, only the `action`, `discussion`, and `memory`
// categories are capability-gated. `coordination` confers no capability, so
// exposing this write tool never widens the calling agent's capability set —
// consistent with the other three Spec B task tools (get_task,
// post_task_comment, attach_task_artifact).

import type { AgentTool, ToolResult } from "../types.js";

export const setTaskStatusTool: AgentTool = {
  name: "set_task_status",
  description:
    "Move your own assigned task forward to a new status (for example from in_progress to in_review, or to done). Whether a transition is allowed depends on your autonomy level — moving a task to review requires at least Assist, and completing it requires Drive. Use this when you have finished a unit of work and want to hand the task to the next stage.",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The task (issue) ID to transition — typically your assigned task" },
      status: { type: "string", description: "The target status (e.g. in_review, done)" },
    },
    required: ["taskId", "status"],
  },
  category: "coordination",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const { taskId, status } = (params ?? {}) as {
      taskId?: unknown;
      status?: unknown;
    };
    if (!taskId || typeof taskId !== "string") {
      return {
        success: false,
        data: null,
        summary: "taskId is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!status || typeof status !== "string") {
      return {
        success: false,
        data: null,
        summary: "status is required",
        error: "INVALID_PARAMS",
      };
    }

    const row = await ctx.services.issues.getById(taskId);

    // getById has no company filter — enforce it here. Treat a cross-company hit
    // exactly like a miss (same error, no write) so the tool never confirms the
    // existence of, or transitions, another company's task. This also yields a
    // cleaner error than letting the guard reject with "not your task".
    if (!row || (row as { companyId?: string }).companyId !== ctx.companyId) {
      return {
        success: false,
        data: null,
        summary: "Task not found",
        error: "NOT_FOUND",
      };
    }

    // Dial resolution lives in the tool (fail-closed): absent → 0. The guard
    // (assertAgentStatusTransition, invoked by issueService.update) consumes this
    // as actor.effectiveDial and enforces own-task + dial. We never read the dial
    // ourselves beyond forwarding it.
    const effectiveDial = ctx.effectiveAutonomy ?? 0;

    try {
      await ctx.services.issues.update(
        taskId,
        { status },
        { actorType: "agent", agentId: ctx.agentId, effectiveDial },
      );
    } catch (error) {
      // The A4 guard (or another service-level assertion in update) rejected the
      // transition. Surface it as a failed ToolResult rather than letting it
      // escape `execute` as an exception.
      const message =
        error instanceof Error ? error.message : "Status transition rejected";
      // The guard throws `unprocessable(msg, { code })` = HttpError(422, msg,
      // details). Per server/src/errors.ts the structured code lives at
      // `error.details.code`, NOT `error.code`. Read its real location first,
      // then fall back to a top-level `code` for any other thrower, then to the
      // message so `error` is never empty.
      const code =
        (error as { details?: { code?: unknown } })?.details?.code ??
        (error as { code?: unknown })?.code;
      return {
        success: false,
        data: null,
        summary: message,
        error: typeof code === "string" ? code : message,
      };
    }

    return {
      success: true,
      data: { taskId, status },
      summary: `Task ${taskId} moved to ${status}`,
    };
  },
};
