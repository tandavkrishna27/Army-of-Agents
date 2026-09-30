import { describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  executionWorkspaces: makeTableProxy("execution_workspaces"),
  issues: makeTableProxy("issues"),
  projects: makeTableProxy("projects"),
  projectWorkspaces: makeTableProxy("project_workspaces"),
  workspaceRuntimeServices: makeTableProxy("workspace_runtime_services"),
}));

import { executionWorkspaceService } from "../services/execution-workspaces.js";

function workspaceRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-21T00:00:00.000Z");
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: "issue-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "AOA-1-test",
    status: "active",
    cwd: "/repo/.aoa/worktrees/AOA-1-test",
    repoUrl: null,
    baseRef: "main",
    branchName: "AOA-1-test",
    providerType: "git_worktree",
    providerRef: "/repo/.aoa/worktrees/AOA-1-test",
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: now,
    openedAt: now,
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createMockDb(input: {
  selectRows?: unknown[][];
  insertRows?: unknown[][];
  updateRows?: unknown[][];
  insertError?: unknown;
}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  const insertValues: unknown[] = [];
  const updateValues: unknown[] = [];

  const chain = (valueFactory: () => unknown) => {
    const obj: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "values", "set", "returning"]) {
      obj[method] = (arg?: unknown) => {
        if (method === "values") insertValues.push(arg);
        if (method === "set") updateValues.push(arg);
        return obj;
      };
    }
    obj.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      try {
        const value = valueFactory();
        return Promise.resolve(resolve(value));
      } catch (error) {
        if (reject) return Promise.resolve(reject(error));
        return Promise.reject(error);
      }
    };
    return obj;
  };

  return {
    insertValues,
    updateValues,
    db: {
      select: () => chain(() => input.selectRows?.[selectIdx++] ?? []),
      insert: () => chain(() => {
        if (input.insertError) throw input.insertError;
        return input.insertRows?.[insertIdx++] ?? [];
      }),
      update: () => chain(() => input.updateRows?.[updateIdx++] ?? []),
    },
  };
}

describe("executionWorkspaceService.createTaskOwnedIdempotent", () => {
  it("updates an existing non-archived task workspace instead of inserting a duplicate", async () => {
    const existing = workspaceRow({ id: "existing" });
    const updated = workspaceRow({ id: "existing", cwd: "/repo/updated" });
    const mock = createMockDb({
      selectRows: [[existing]],
      updateRows: [[updated]],
    });

    const result = await executionWorkspaceService(mock.db as never).createTaskOwnedIdempotent({
      companyId: "company-1",
      projectId: "project-1",
      sourceIssueId: "issue-1",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "AOA-1-test",
      status: "active",
      providerType: "git_worktree",
      cwd: "/repo/updated",
    });

    expect(result?.id).toBe("existing");
    expect(mock.insertValues).toHaveLength(0);
    expect(mock.updateValues).toHaveLength(1);
  });

  it("recovers from the DB unique-index race by re-fetching and updating the raced row", async () => {
    const uniqueError = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint: "execution_workspaces_active_task_workspace_uq",
    });
    const raced = workspaceRow({ id: "raced" });
    const updated = workspaceRow({ id: "raced", cwd: "/repo/raced" });
    const mock = createMockDb({
      selectRows: [[], [raced]],
      insertError: uniqueError,
      updateRows: [[updated]],
    });

    const result = await executionWorkspaceService(mock.db as never).createTaskOwnedIdempotent({
      companyId: "company-1",
      projectId: "project-1",
      sourceIssueId: "issue-1",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "AOA-1-test",
      status: "active",
      providerType: "git_worktree",
      cwd: "/repo/raced",
    });

    expect(result?.id).toBe("raced");
    expect(mock.insertValues).toHaveLength(1);
    expect(mock.updateValues).toHaveLength(1);
  });
});
