import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsertForIssue } = vi.hoisted(() => ({
  upsertForIssue: vi.fn(),
}));

vi.mock("../services/task-outputs.js", () => ({
  taskOutputService: () => ({ upsertForIssue }),
}));

import {
  emitBranchTaskOutput,
  emitPullRequestTaskOutput,
  emitRuntimeServiceTaskOutput,
  prTaskOutputStatus,
} from "../services/task-output-emitters.js";

describe("task output emitters", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps pull request states to task output statuses", () => {
    expect(prTaskOutputStatus("open")).toBe("active");
    expect(prTaskOutputStatus("closed")).toBe("closed");
    expect(prTaskOutputStatus("merged")).toBe("merged");
  });

  it("upserts pull request outputs with stable repo-number external id", async () => {
    await emitPullRequestTaskOutput({} as never, {
      companyId: "company-1",
      issueId: "issue-1",
      executionWorkspaceId: "workspace-1",
      repoUrl: "https://github.com/acme/repo",
      pr: {
        url: "https://github.com/acme/repo/pull/42",
        number: 42,
        state: "open",
        createdAt: "2026-05-25T00:00:00.000Z",
        draft: true,
      },
    });

    expect(upsertForIssue).toHaveBeenCalledWith("company-1", "issue-1", expect.objectContaining({
      type: "pull_request",
      provider: "github",
      externalId: "https://github.com/acme/repo#42",
      status: "active",
      reviewState: "needs_review",
      executionWorkspaceId: "workspace-1",
    }));
  });

  it("upserts preview URL outputs for runtime services with URLs", async () => {
    await emitRuntimeServiceTaskOutput({} as never, {
      id: "runtime-1",
      companyId: "company-1",
      projectId: "project-1",
      issueId: "issue-1",
      executionWorkspaceId: "workspace-1",
      serviceName: "dev server",
      provider: "local_process",
      status: "running",
      healthStatus: "healthy",
      url: "http://127.0.0.1:3100",
      port: 3100,
      lifecycle: "workspace",
      scopeType: "execution_workspace",
      providerRef: "pid:123",
      startedByRunId: "run-1",
      ownerAgentId: "agent-1",
    });

    expect(upsertForIssue).toHaveBeenCalledWith("company-1", "issue-1", expect.objectContaining({
      type: "preview_url",
      externalId: "runtime-service:runtime-1",
      status: "running",
      runtimeServiceId: "runtime-1",
      url: "http://127.0.0.1:3100",
    }));
  });

  it("clears stale preview URLs when a runtime service becomes terminal", async () => {
    await emitRuntimeServiceTaskOutput({} as never, {
      id: "runtime-stopped",
      companyId: "company-1",
      issueId: "issue-1",
      executionWorkspaceId: "workspace-1",
      serviceName: "dev server",
      provider: "local_process",
      status: "stopped",
      healthStatus: "unknown",
      url: "http://127.0.0.1:3100",
      providerRef: null,
    });

    expect(upsertForIssue).toHaveBeenCalledWith("company-1", "issue-1", expect.objectContaining({
      type: "runtime_service",
      status: "stopped",
      url: null,
    }));
  });

  it("upserts branch outputs for task-owned workspaces", async () => {
    await emitBranchTaskOutput({} as never, {
      id: "workspace-1",
      companyId: "company-1",
      projectId: "project-1",
      sourceIssueId: "issue-1",
      providerType: "git_worktree",
      branchName: "codex/upgrades",
      repoUrl: "https://github.com/acme/repo",
      baseRef: "main",
      strategyType: "git_worktree",
      status: "active",
    });

    expect(upsertForIssue).toHaveBeenCalledWith("company-1", "issue-1", expect.objectContaining({
      type: "branch",
      provider: "git_worktree",
      externalId: "workspace:workspace-1:branch:codex/upgrades",
      executionWorkspaceId: "workspace-1",
      title: "codex/upgrades",
      status: "active",
    }));
  });
});
