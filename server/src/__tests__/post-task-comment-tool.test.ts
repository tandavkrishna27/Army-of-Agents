import { describe, expect, it, vi } from "vitest";
import { postTaskCommentTool } from "../services/internal-agent/tools/post-task-comment-tool.js";
import { authorizeToolInvocation } from "../services/internal-agent/authorize-tool.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// Task 3 (Spec B) — post_task_comment tool tests.
//
// post_task_comment lets a crew agent write a comment back onto its assigned
// task. It is `coordination` category (NOT `action`) so exposing it never
// widens the agent's capability set (coordination is absent from
// CAPABILITY_TO_CATEGORY). issueService.addComment / getById have no company
// filter, so the tool enforces row.companyId === ctx.companyId itself.

function makeCtx(
  overrides: {
    issues?: any;
    agentId?: string | null;
    companyId?: string;
    enabledCapabilities?: readonly string[];
  } = {},
): ToolContext {
  return {
    companyId: overrides.companyId ?? "co-1",
    userId: "u-1",
    agentId: overrides.agentId === undefined ? "agent-1" : overrides.agentId,
    userRole: "team_member",
    enabledCapabilities: overrides.enabledCapabilities ?? [],
    db: {} as any,
    services: {
      issues:
        overrides.issues ??
        ({
          getById: vi
            .fn()
            .mockResolvedValue({
              id: "task-1",
              companyId: "co-1",
              assigneeAgentId: "agent-1",
            }),
          addComment: vi
            .fn()
            .mockResolvedValue({ id: "comment-1", issueId: "task-1" }),
        } as any),
    } as any,
  } as unknown as ToolContext;
}

describe("post_task_comment tool (Spec B Task 3)", () => {
  it("has coordination category + open-to-all metadata", () => {
    expect(postTaskCommentTool.name).toBe("post_task_comment");
    expect(postTaskCommentTool.category).toBe("coordination");
    expect(postTaskCommentTool.requiresConfirmation).toBe(false);
    expect(typeof postTaskCommentTool.requiredRole).toBe("string");
  });

  it("happy path: writes a comment with the calling agentId and returns commentId", async () => {
    const addComment = vi
      .fn()
      .mockResolvedValue({ id: "comment-1", issueId: "task-1" });
    const issues = {
      getById: vi.fn().mockResolvedValue({
        id: "task-1",
        companyId: "co-1",
        assigneeAgentId: "agent-7",
      }),
      addComment,
    };
    const ctx = makeCtx({ issues, agentId: "agent-7" });

    const result = await postTaskCommentTool.execute(
      { taskId: "task-1", body: "Done — see the artifact." },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).commentId).toBe("comment-1");
    expect(addComment).toHaveBeenCalledWith(
      "task-1",
      "Done — see the artifact.",
      { agentId: "agent-7" },
    );
  });

  it("cross-company task → NOT_FOUND and does NOT write", async () => {
    const addComment = vi.fn();
    const issues = {
      // Task belongs to a different company than ctx.companyId.
      getById: vi
        .fn()
        .mockResolvedValue({ id: "task-1", companyId: "other-co" }),
      addComment,
    };
    const ctx = makeCtx({ issues, companyId: "co-1" });

    const result = await postTaskCommentTool.execute(
      { taskId: "task-1", body: "leak attempt" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(addComment).not.toHaveBeenCalled();
  });

  it("missing task → NOT_FOUND and does NOT write", async () => {
    const addComment = vi.fn();
    const issues = {
      getById: vi.fn().mockResolvedValue(null),
      addComment,
    };
    const ctx = makeCtx({ issues });

    const result = await postTaskCommentTool.execute(
      { taskId: "ghost", body: "hi" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(addComment).not.toHaveBeenCalled();
  });

  it("another agent's task → NOT_FOUND and does NOT write", async () => {
    const addComment = vi.fn();
    const issues = {
      getById: vi.fn().mockResolvedValue({
        id: "task-1",
        companyId: "co-1",
        assigneeAgentId: "agent-other",
      }),
      addComment,
    };
    const ctx = makeCtx({ issues, agentId: "agent-1" });

    const result = await postTaskCommentTool.execute(
      { taskId: "task-1", body: "not mine" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(addComment).not.toHaveBeenCalled();
  });

  it("missing / non-string params → INVALID_PARAMS and no read", async () => {
    const getById = vi.fn();
    const ctx = makeCtx({ issues: { getById, addComment: vi.fn() } });

    const noTask = await postTaskCommentTool.execute({ body: "hi" }, ctx);
    expect(noTask.success).toBe(false);
    expect(noTask.error).toBe("INVALID_PARAMS");

    const noBody = await postTaskCommentTool.execute({ taskId: "task-1" }, ctx);
    expect(noBody.success).toBe(false);
    expect(noBody.error).toBe("INVALID_PARAMS");

    const badBody = await postTaskCommentTool.execute(
      { taskId: "task-1", body: 42 },
      ctx,
    );
    expect(badBody.success).toBe(false);
    expect(badBody.error).toBe("INVALID_PARAMS");

    expect(getById).not.toHaveBeenCalled();
  });

  it("a caller with NO capabilities is still authorized (coordination does not widen)", () => {
    const decision = authorizeToolInvocation(
      postTaskCommentTool,
      "team_member",
      [], // zero capabilities
    );
    expect(decision.allowed).toBe(true);
  });
});
