// server/src/services/internal-agent/tools/workspace-request-for-thread.ts
//
// Task C2 batch 2 — `request_thread_workspace` (action tool, Engineer opt-in).
//
// Creates an execution_workspaces row scoped to a thread. The Engineer
// opts into this only when interactive/dev-server work is required for
// the thread's artifact iteration — most thread work doesn't need a
// workspace at all (the thread is the workbench).
//
// Idempotent: if an active (non-archived) workspace already exists for
// (companyId, threadId), the tool returns that workspace's id instead
// of creating a second one. The DB has a partial unique index
// `execution_workspaces_active_thread_workspace_uq` enforcing the same
// invariant — we check first to surface a clean tool result instead of
// surfacing a DB constraint violation.
//
// XOR invariant: the execution_workspaces CHECK constraint (added in
// migration 0120) requires exactly one of sourceIssueId / threadId to
// be set. This tool sets threadId and explicitly sets sourceIssueId to
// null, satisfying the constraint.

import { and, eq } from "drizzle-orm";
import { discussions, executionWorkspaces, projects } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

export const requestThreadWorkspaceTool: AgentTool = {
  name: "request_thread_workspace",
  description:
    "Create an execution_workspace scoped to a thread (Engineer-only; opt-in for interactive/dev-server work).",
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "Thread (discussion) id" },
    },
    required: ["threadId"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: true,
  async execute(params, ctx) {
    const { threadId } = (params ?? {}) as { threadId?: string };
    if (!threadId || typeof threadId !== "string") {
      return {
        success: false,
        data: null,
        summary: "threadId is required",
        error: "INVALID_PARAMS",
      };
    }

    // 1) Verify the thread exists + pick up its scopeType/scopeId so we
    //    can resolve a projectId to attach the workspace to.
    const threadRows = await ctx.db
      .select()
      .from(discussions)
      .where(and(eq(discussions.id, threadId), eq(discussions.companyId, ctx.companyId)))
      .limit(1);
    const thread = Array.isArray(threadRows) ? threadRows[0] : null;
    if (!thread) {
      return {
        success: false,
        data: null,
        summary: "Thread not found",
        error: "NOT_FOUND",
      };
    }

    // 2) Resolve the project to scope the workspace under. We only
    //    accept a project-scoped thread here — a department-scoped or
    //    goal-scoped thread doesn't pin to a single repo/branch and so
    //    can't host a workspace.
    let projectId: string | null = null;
    if (thread.scopeType === "project" && thread.scopeId) {
      projectId = thread.scopeId;
    }
    if (!projectId) {
      return {
        success: false,
        data: null,
        summary:
          "Thread has no associated project for workspace scoping",
        error: "NO_PROJECT",
      };
    }

    const projectRows = await ctx.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, ctx.companyId)))
      .limit(1);
    if (!Array.isArray(projectRows) || projectRows.length === 0) {
      return { success: false, data: null, summary: "Thread has no associated project for workspace scoping", error: "NO_PROJECT" };
    }

    // 3) Idempotency: return existing active thread workspace if one
    //    exists. The partial unique index would block a second insert
    //    anyway, but checking first lets us return a clean reused=true
    //    result instead of a DB error.
    const existingRows = await ctx.db
      .select()
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, ctx.companyId),
          eq(executionWorkspaces.threadId, threadId),
        ),
      )
      .limit(1);
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;
    if (existing && existing.status !== "archived") {
      return {
        success: true,
        data: { workspaceId: existing.id, reused: true },
        summary: "Reused existing thread workspace",
      };
    }

    // 4) Create a fresh workspace. sourceIssueId is explicitly null to
    //    satisfy the XOR check constraint.
    const inserted = await ctx.db
      .insert(executionWorkspaces)
      .values({
        companyId: ctx.companyId,
        projectId,
        threadId,
        sourceIssueId: null,
        mode: "isolated_workspace",
        strategyType: "project_primary",
        name: `thread-${threadId.slice(0, 8)}`,
        status: "active",
      })
      .returning();
    const ws = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!ws || !ws.id) {
      return {
        success: false,
        data: null,
        summary: "execution_workspaces insert returned no row",
        error: "INSERT_FAILED",
      };
    }

    return {
      success: true,
      data: { workspaceId: ws.id, reused: false },
      summary: "Created thread workspace",
    };
  },
};
