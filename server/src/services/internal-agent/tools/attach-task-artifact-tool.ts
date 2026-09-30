// server/src/services/internal-agent/tools/attach-task-artifact-tool.ts
//
// Task 3 (Spec B) — `attach_task_artifact` (result-write tool).
//
// Lets a crew agent write its work product back as a deliverable: it creates an
// AGENT-sourced artifact, links it to the task (issues.artifactId), and records
// a task_outputs row so the deliverable shows up in the unified product index.
//
// IMMUTABILITY (AoA Decisions #43/#45): artifact versions are immutable. This
// tool delegates version numbering to artifactService.create, which writes
// version 1; a downstream re-run that wants a new version goes through
// artifactService.addVersion (never mutating an existing version). This tool
// never mutates an existing version.
//
// SECURITY (company scoping): issueService.getById(id) has NO company filter,
// and issueService.update only loads the issue by primary key. This tool MUST
// therefore enforce row.companyId === ctx.companyId itself and return not-found
// on mismatch (mirroring get-task-tool.ts) BEFORE creating any artifact, so a
// crew agent can never attach a deliverable onto another company's task.
//
// LINKAGE: there is no dedicated issues.setArtifactId method — linkage is done
// via the generic issues.update with actor { actorType: "system" }. We pass NO
// status field, so the A4 agent-status-transition guard (issue-agent-status-
// guard.ts) does not engage; "system" actorType is additionally the guard's
// no-op path, so the linkage write is fully unblocked.
//
// CATEGORY: `coordination` (deliberately NOT `action`). Only `action`/
// `discussion`/`memory` are capability-gated (authorize-tool.ts). `coordination`
// confers no capability, so exposing this write tool does not widen the calling
// agent's `system_actions` (or any other) capability. Zero-surface choice.

import type { AgentTool, ToolResult } from "../types.js";
import type { UpsertTaskOutput } from "@armyofagents/shared";

export const attachTaskArtifactTool: AgentTool = {
  name: "attach_task_artifact",
  description:
    "Attach your work product to a task as a deliverable: creates a new artifact (document, code, report, etc.) authored by you, links it to the task, and records it in the task's output index. Use this to hand back the result of your work.",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The task (issue) ID to attach the deliverable to" },
      title: { type: "string", description: "Title of the artifact" },
      content: { type: "string", description: "Text content of the artifact (the deliverable body)" },
      type: {
        type: "string",
        description:
          "Artifact type: document | presentation | code | design | report | other (default: document)",
      },
    },
    required: ["taskId", "title", "content"],
  },
  category: "coordination",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const { taskId, title, content, type } = (params ?? {}) as {
      taskId?: unknown;
      title?: unknown;
      content?: unknown;
      type?: unknown;
    };
    if (!taskId || typeof taskId !== "string") {
      return {
        success: false,
        data: null,
        summary: "taskId is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!title || typeof title !== "string") {
      return {
        success: false,
        data: null,
        summary: "title is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!content || typeof content !== "string") {
      return {
        success: false,
        data: null,
        summary: "content is required",
        error: "INVALID_PARAMS",
      };
    }
    const artifactType =
      typeof type === "string" && type.length > 0 ? type : "document";

    const row = await ctx.services.issues.getById(taskId);

    // getById has no company filter — enforce it here BEFORE any write. Treat a
    // cross-company hit exactly like a miss (same error, nothing created) so the
    // tool never attaches onto, or leaks the existence of, another company's task.
    if (!row || (row as { companyId?: string }).companyId !== ctx.companyId) {
      return {
        success: false,
        data: null,
        summary: "Task not found",
        error: "NOT_FOUND",
      };
    }

    // Ownership (review #4). A crew agent may only attach a deliverable to a task
    // it is assigned to. Without this, any crew agent could overwrite the primary
    // `issues.artifactId` pointer (the artifact-as-input source, Decision #71) on
    // ANOTHER agent's task. A non-agent caller (no ctx.agentId — e.g. a trusted
    // system/Commander path) is exempt, matching the A4 status-transition guard.
    if (
      ctx.agentId &&
      (row as { assigneeAgentId?: string | null }).assigneeAgentId !== ctx.agentId
    ) {
      return {
        success: false,
        data: null,
        summary: "Task not found",
        error: "NOT_FOUND",
      };
    }

    // Create the artifact as agent-sourced. createdById must be a string; when
    // the creator is an agent (not a user) we pass ctx.agentId, falling back to
    // a sentinel exactly as the sibling create_artifact tool does. The artifacts
    // service writes version 1 immutably (Decisions #43/#45).
    const created = await ctx.services.artifacts.create(
      ctx.companyId,
      ctx.agentId ?? "aoa-agent",
      {
        title,
        type: artifactType,
        source: "agent",
        content,
      },
    );

    const artifactId = (created as { id: string }).id;
    const versionId =
      (created as { versions?: Array<{ id: string }> }).versions?.[0]?.id ?? null;

    // Link the artifact to the task. No status change → A4 status guard stays
    // dormant; actorType "system" is the guard's no-op path either way.
    await ctx.services.issues.update(
      taskId,
      { artifactId },
      { actorType: "system" },
    );

    // Record the deliverable in the unified task-output index. createdByAgentId
    // is a uuid that the task-output service company-owner-checks against the
    // agents table — only include it when we have a real agent id (not the
    // sentinel) so the ownership assertion has a valid row to find.
    const output: UpsertTaskOutput = {
      type: "artifact",
      provider: "aoa",
      title,
      artifactId,
      artifactVersionId: versionId,
      status: "active",
      reviewState: "none",
      isPrimary: false,
      healthStatus: "unknown",
      ...(ctx.agentId ? { createdByAgentId: ctx.agentId } : {}),
    };
    const taskOutput = await ctx.services.taskOutputs.upsertForIssue(
      ctx.companyId,
      taskId,
      output,
    );

    return {
      success: true,
      data: {
        artifactId,
        versionId,
        taskOutputId: (taskOutput as { id?: string } | null)?.id ?? null,
      },
      summary: `Attached artifact "${title}" to task ${taskId}`,
    };
  },
};
