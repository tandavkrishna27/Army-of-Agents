import { describe, expect, it } from "vitest";
import { applyAoaWorkspaceEnv, shapeAoaWorkspaceEnvForExecution } from "../server-utils.js";

describe("applyAoaWorkspaceEnv", () => {
  it("sets all 9 AoA workspace env keys when populated", () => {
    const env: Record<string, string> = {};
    applyAoaWorkspaceEnv(env, {
      workspaceCwd: "/tmp/wt",
      workspaceSource: "task",
      workspaceStrategy: "isolated",
      workspaceId: "ws_abc",
      workspaceRepoUrl: "https://github.com/example/repo.git",
      workspaceRepoRef: "main",
      workspaceBranch: "feat/x",
      workspaceWorktreePath: "/tmp/wt",
      agentHome: "/home/agent",
    });
    expect(env.AOA_WORKSPACE_CWD).toBe("/tmp/wt");
    expect(env.AOA_WORKSPACE_SOURCE).toBe("task");
    expect(env.AOA_WORKSPACE_STRATEGY).toBe("isolated");
    expect(env.AOA_WORKSPACE_ID).toBe("ws_abc");
    expect(env.AOA_WORKSPACE_REPO_URL).toBe("https://github.com/example/repo.git");
    expect(env.AOA_WORKSPACE_REPO_REF).toBe("main");
    expect(env.AOA_WORKSPACE_BRANCH).toBe("feat/x");
    expect(env.AOA_WORKSPACE_WORKTREE_PATH).toBe("/tmp/wt");
    expect(env.AGENT_HOME).toBe("/home/agent");
  });

  it("skips null/undefined/empty values", () => {
    const env: Record<string, string> = {};
    applyAoaWorkspaceEnv(env, {
      workspaceCwd: "/tmp/wt",
      workspaceSource: null,
      workspaceStrategy: "",
      workspaceId: undefined,
      agentHome: "/home/agent",
    });
    expect(env.AOA_WORKSPACE_CWD).toBe("/tmp/wt");
    expect(env.AGENT_HOME).toBe("/home/agent");
    expect(env.AOA_WORKSPACE_SOURCE).toBeUndefined();
    expect(env.AOA_WORKSPACE_STRATEGY).toBeUndefined();
    expect(env.AOA_WORKSPACE_ID).toBeUndefined();
  });
});

describe("shapeAoaWorkspaceEnvForExecution", () => {
  it("returns local execution env unchanged without mutating input", () => {
    const env = {
      AOA_WORKSPACE_CWD: "/repo",
      AOA_WORKSPACE_WORKTREE_PATH: "/repo",
    };

    expect(
      shapeAoaWorkspaceEnvForExecution({
        env,
        targetType: "local",
        localCwd: "/repo",
        executionCwd: "/workspace",
      }),
    ).toEqual(env);
    expect(env.AOA_WORKSPACE_CWD).toBe("/repo");
  });

  it("rewrites Docker workspace cwd and removes matching worktree path", () => {
    expect(
      shapeAoaWorkspaceEnvForExecution({
        env: {
          AOA_WORKSPACE_CWD: "/repo",
          AOA_WORKSPACE_WORKTREE_PATH: "/repo",
        },
        targetType: "sandbox-docker",
        localCwd: "/repo",
        executionCwd: "/workspace",
      }),
    ).toEqual({ AOA_WORKSPACE_CWD: "/workspace" });
  });

  it("rewrites matching workspace entries and strips foreign cwd entries", () => {
    const shaped = shapeAoaWorkspaceEnvForExecution({
      env: {
        AOA_WORKSPACES_JSON: JSON.stringify([
          { id: "one", cwd: "/repo", kind: "active" },
          { id: "two", cwd: "/other", kind: "foreign" },
        ]),
      },
      targetType: "sandbox-docker",
      localCwd: "/repo",
      executionCwd: "/workspace",
    });

    expect(JSON.parse(shaped.AOA_WORKSPACES_JSON ?? "null")).toEqual([
      { id: "one", cwd: "/workspace", kind: "active" },
      { id: "two", kind: "foreign" },
    ]);
  });

  it("removes invalid workspaces JSON", () => {
    expect(
      shapeAoaWorkspaceEnvForExecution({
        env: { AOA_WORKSPACES_JSON: "nope" },
        targetType: "sandbox-docker",
        localCwd: "/repo",
        executionCwd: "/workspace",
      }),
    ).toEqual({});
  });
});
