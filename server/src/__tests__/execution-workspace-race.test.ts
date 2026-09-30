import { describe, expect, it } from "vitest";
import { selectConcurrentPersistedExecutionWorkspace } from "../services/execution-workspace-race.js";

describe("selectConcurrentPersistedExecutionWorkspace", () => {
  it("selects a matching issue workspace when realization reused an existing worktree", () => {
    const selected = selectConcurrentPersistedExecutionWorkspace({
      realizedWorkspace: {
        cwd: "C:\\repo\\.aoa\\worktrees\\AOA-22-race",
        worktreePath: "C:\\repo\\.aoa\\worktrees\\AOA-22-race",
        branchName: "AOA-22-race",
        created: false,
      },
      candidates: [
        {
          id: "workspace-1",
          cwd: "C:\\repo\\.aoa\\worktrees\\AOA-22-race",
          providerRef: "C:\\repo\\.aoa\\worktrees\\AOA-22-race",
          branchName: "AOA-22-race",
          status: "active",
        },
      ],
    });

    expect(selected?.id).toBe("workspace-1");
  });

  it("does not select a candidate for a newly-created realization", () => {
    const selected = selectConcurrentPersistedExecutionWorkspace({
      realizedWorkspace: {
        cwd: "/repo/.aoa/worktrees/AOA-22-race",
        worktreePath: "/repo/.aoa/worktrees/AOA-22-race",
        branchName: "AOA-22-race",
        created: true,
      },
      candidates: [
        {
          id: "workspace-1",
          cwd: "/repo/.aoa/worktrees/AOA-22-race",
          providerRef: "/repo/.aoa/worktrees/AOA-22-race",
          branchName: "AOA-22-race",
          status: "active",
        },
      ],
    });

    expect(selected).toBeNull();
  });

  it("rejects terminal, wrong-branch, and wrong-path candidates", () => {
    const selected = selectConcurrentPersistedExecutionWorkspace({
      realizedWorkspace: {
        cwd: "/repo/.aoa/worktrees/AOA-22-race",
        worktreePath: "/repo/.aoa/worktrees/AOA-22-race",
        branchName: "AOA-22-race",
        created: false,
      },
      candidates: [
        {
          id: "archived",
          cwd: "/repo/.aoa/worktrees/AOA-22-race",
          providerRef: "/repo/.aoa/worktrees/AOA-22-race",
          branchName: "AOA-22-race",
          status: "archived",
        },
        {
          id: "wrong-branch",
          cwd: "/repo/.aoa/worktrees/AOA-22-race",
          providerRef: "/repo/.aoa/worktrees/AOA-22-race",
          branchName: "AOA-21-other",
          status: "active",
        },
        {
          id: "cleanup-failed",
          cwd: "/repo/.aoa/worktrees/AOA-22-race",
          providerRef: "/repo/.aoa/worktrees/AOA-22-race",
          branchName: "AOA-22-race",
          status: "cleanup_failed",
        },
        {
          id: "wrong-path",
          cwd: "/repo/.aoa/worktrees/AOA-22-other",
          providerRef: "/repo/.aoa/worktrees/AOA-22-other",
          branchName: "AOA-22-race",
          status: "active",
        },
      ],
    });

    expect(selected).toBeNull();
  });
});
