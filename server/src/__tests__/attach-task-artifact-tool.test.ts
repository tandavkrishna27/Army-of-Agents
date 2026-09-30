import { describe, expect, it, vi } from "vitest";
import { attachTaskArtifactTool } from "../services/internal-agent/tools/attach-task-artifact-tool.js";
import { authorizeToolInvocation } from "../services/internal-agent/authorize-tool.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// Task 3 (Spec B) — attach_task_artifact tool tests.
//
// attach_task_artifact lets a crew agent write its work product back: it
// creates an AGENT-sourced artifact via the artifacts service (which numbers
// the version immutably), links it to the task by setting issues.artifactId
// (via the generic update with actorType:"system" so the A4 status guard is
// bypassed — no status change), and records a task_outputs row.
//
// Category is `coordination` (NOT `action`) — exposing it never widens the
// agent's capability set. getById/update have no company filter, so the tool
// enforces row.companyId === ctx.companyId itself.

function makeIssues(
  overrides: Partial<{ companyId: string | null; assigneeAgentId: string | null }> = {},
) {
  return {
    getById: vi.fn().mockResolvedValue({
      id: "task-1",
      companyId: overrides.companyId === undefined ? "co-1" : overrides.companyId,
      // Default owner = the default ctx.agentId ("agent-1") so owned-path tests pass.
      assigneeAgentId:
        overrides.assigneeAgentId === undefined ? "agent-1" : overrides.assigneeAgentId,
    }),
    update: vi
      .fn()
      .mockResolvedValue({ id: "task-1", artifactId: "art-1" }),
  };
}

function makeArtifacts() {
  return {
    create: vi
      .fn()
      .mockResolvedValue({ id: "art-1", versions: [{ id: "ver-1" }] }),
  };
}

function makeTaskOutputs() {
  return {
    upsertForIssue: vi.fn().mockResolvedValue({ id: "to-1" }),
  };
}

function makeCtx(
  overrides: {
    issues?: any;
    artifacts?: any;
    taskOutputs?: any;
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
      issues: overrides.issues ?? makeIssues(),
      artifacts: overrides.artifacts ?? makeArtifacts(),
      taskOutputs: overrides.taskOutputs ?? makeTaskOutputs(),
    } as any,
  } as unknown as ToolContext;
}

describe("attach_task_artifact tool (Spec B Task 3)", () => {
  it("has coordination category + open-to-all metadata", () => {
    expect(attachTaskArtifactTool.name).toBe("attach_task_artifact");
    expect(attachTaskArtifactTool.category).toBe("coordination");
    expect(attachTaskArtifactTool.requiresConfirmation).toBe(false);
    expect(typeof attachTaskArtifactTool.requiredRole).toBe("string");
  });

  it("happy path: creates agent artifact, links it, records a task_outputs row", async () => {
    const issues = makeIssues({ assigneeAgentId: "agent-9" }); // owned by the caller
    const artifacts = makeArtifacts();
    const taskOutputs = makeTaskOutputs();
    const ctx = makeCtx({ issues, artifacts, taskOutputs, agentId: "agent-9" });

    const result = await attachTaskArtifactTool.execute(
      {
        taskId: "task-1",
        title: "Design Spec",
        content: "# Heading\n\nbody",
        type: "document",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).artifactId).toBe("art-1");
    expect((result.data as any).versionId).toBe("ver-1");

    // Artifact created as agent-sourced, createdById = ctx.agentId.
    expect(artifacts.create).toHaveBeenCalledWith(
      "co-1",
      "agent-9",
      expect.objectContaining({
        title: "Design Spec",
        type: "document",
        source: "agent",
        content: "# Heading\n\nbody",
      }),
    );

    // Linked to the task via issues.update with actorType "system" (A4 bypass).
    expect(issues.update).toHaveBeenCalledWith(
      "task-1",
      { artifactId: "art-1" },
      { actorType: "system" },
    );

    // task_outputs row written for the artifact.
    const [toCompanyId, toIssueId, toInput] = taskOutputs.upsertForIssue.mock.calls[0];
    expect(toCompanyId).toBe("co-1");
    expect(toIssueId).toBe("task-1");
    expect(toInput).toMatchObject({
      type: "artifact",
      title: "Design Spec",
      artifactId: "art-1",
    });
  });

  it("defaults type to 'document' when omitted", async () => {
    const artifacts = makeArtifacts();
    const ctx = makeCtx({ artifacts });

    await attachTaskArtifactTool.execute(
      { taskId: "task-1", title: "Notes", content: "x" },
      ctx,
    );

    expect(artifacts.create).toHaveBeenCalledWith(
      "co-1",
      expect.any(String),
      expect.objectContaining({ type: "document" }),
    );
  });

  it("cross-company task → NOT_FOUND and writes NOTHING", async () => {
    const issues = makeIssues({ companyId: "other-co" });
    const artifacts = makeArtifacts();
    const taskOutputs = makeTaskOutputs();
    const ctx = makeCtx({ issues, artifacts, taskOutputs, companyId: "co-1" });

    const result = await attachTaskArtifactTool.execute(
      { taskId: "task-1", title: "leak", content: "x" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(artifacts.create).not.toHaveBeenCalled();
    expect(issues.update).not.toHaveBeenCalled();
    expect(taskOutputs.upsertForIssue).not.toHaveBeenCalled();
  });

  it("non-owned task → NOT_FOUND and writes NOTHING (review #4)", async () => {
    // The task belongs to a different crew agent; the caller may not overwrite
    // its artifactId pointer.
    const issues = makeIssues({ assigneeAgentId: "agent-OTHER" });
    const artifacts = makeArtifacts();
    const taskOutputs = makeTaskOutputs();
    const ctx = makeCtx({ issues, artifacts, taskOutputs, agentId: "agent-9" });

    const result = await attachTaskArtifactTool.execute(
      { taskId: "task-1", title: "hijack", content: "x" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(artifacts.create).not.toHaveBeenCalled();
    expect(issues.update).not.toHaveBeenCalled();
    expect(taskOutputs.upsertForIssue).not.toHaveBeenCalled();
  });

  it("missing task → NOT_FOUND and writes NOTHING", async () => {
    const issues = {
      getById: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    };
    const artifacts = makeArtifacts();
    const taskOutputs = makeTaskOutputs();
    const ctx = makeCtx({ issues, artifacts, taskOutputs });

    const result = await attachTaskArtifactTool.execute(
      { taskId: "ghost", title: "t", content: "x" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(artifacts.create).not.toHaveBeenCalled();
    expect(taskOutputs.upsertForIssue).not.toHaveBeenCalled();
  });

  it("missing / non-string params → INVALID_PARAMS and no read", async () => {
    const issues = makeIssues();
    const ctx = makeCtx({ issues });

    const noTask = await attachTaskArtifactTool.execute(
      { title: "t", content: "x" },
      ctx,
    );
    expect(noTask.error).toBe("INVALID_PARAMS");

    const noTitle = await attachTaskArtifactTool.execute(
      { taskId: "task-1", content: "x" },
      ctx,
    );
    expect(noTitle.error).toBe("INVALID_PARAMS");

    const noContent = await attachTaskArtifactTool.execute(
      { taskId: "task-1", title: "t" },
      ctx,
    );
    expect(noContent.error).toBe("INVALID_PARAMS");

    expect(issues.getById).not.toHaveBeenCalled();
  });

  it("a caller with NO capabilities is still authorized (coordination does not widen)", () => {
    const decision = authorizeToolInvocation(
      attachTaskArtifactTool,
      "team_member",
      [], // zero capabilities
    );
    expect(decision.allowed).toBe(true);
  });
});
