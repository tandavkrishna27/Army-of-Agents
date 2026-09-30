// Focused unit test for `resolveExecutionWorkspacePolicyInputs` — the shared
// execution-workspace POLICY-INPUT resolver extracted from the heartbeat and
// crew paths (they previously wired the same block twice). Exercises the REAL
// leaf helpers (execution-workspace-policy.ts) so the parameterized branching
// is proven end-to-end, not against mocked returns:
//
//   • divergence 1 — the `legacyUseProjectWorkspace` PARAMETER (heartbeat's
//     assignee override vs crew's null) has an observable effect on the mode.
//   • divergence 2 — `projectEnv` is ALWAYS read + returned; the caller decides
//     whether to merge it (heartbeat) or ignore it (crew).
//   • the instance flag gates both the issue settings and the project policy.

import { describe, it, expect, vi, beforeEach } from "vitest";

const getExperimentalMock = vi.fn();
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getExperimental: getExperimentalMock }),
}));

// Only pulled in transitively via workspace-resolution's resolveWorkspaceForRun;
// resolveExecutionWorkspacePolicyInputs itself does no fs I/O.
vi.mock("node:fs/promises", () => {
  const api = { stat: vi.fn(), mkdir: vi.fn() };
  return { ...api, default: api };
});

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  asc: (a: unknown) => ({ asc: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (typeof prop === "string") return Symbol(`${name}.${prop}`);
        return undefined;
      },
    });
  return {
    issues: makeTable("issues"),
    projects: makeTable("projects"),
    projectWorkspaces: makeTable("project_workspaces"),
  };
});

import { resolveExecutionWorkspacePolicyInputs } from "../services/workspace-resolution.js";

/** A db whose single `select` (the projects read) resolves to `projectRows`. */
function makeDb(projectRows: Array<Record<string, unknown>>) {
  const selectCalls: number[] = [];
  const db: any = {
    _selectCalls: selectCalls,
    select: () => {
      selectCalls.push(1);
      const c: any = {};
      c.from = () => c;
      c.where = () => c;
      c.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(projectRows));
      return c;
    },
  };
  return db;
}

describe("resolveExecutionWorkspacePolicyInputs", () => {
  beforeEach(() => {
    getExperimentalMock.mockReset().mockResolvedValue({ enableIsolatedWorkspaces: true });
  });

  it("gates issue settings + project policy to null when isolated workspaces are disabled", async () => {
    getExperimentalMock.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const db = makeDb([
      { executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" }, env: { FOO: "bar" } },
    ]);

    const result = await resolveExecutionWorkspacePolicyInputs(db, {
      companyId: "co-1",
      executionProjectId: "p1",
      // Even a live isolated setting is ignored while the instance flag is off.
      rawIssueExecutionWorkspaceSettings: { mode: "isolated_workspace" },
      legacyUseProjectWorkspace: null,
    });

    expect(result.isolatedWorkspacesEnabled).toBe(false);
    expect(result.issueExecutionWorkspaceSettings).toBeNull();
    expect(result.projectExecutionWorkspacePolicy).toBeNull();
    // divergence 2: env is still read + returned regardless of the merge.
    expect(result.projectEnv).toEqual({ FOO: "bar" });
    // Nothing to elevate the mode → the shared floor.
    expect(result.executionWorkspaceMode).toBe("shared_workspace");
  });

  it("honours a project policy's isolated defaultMode and returns projectEnv", async () => {
    const db = makeDb([
      { executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" }, env: { A: "1" } },
    ]);

    const result = await resolveExecutionWorkspacePolicyInputs(db, {
      companyId: "co-1",
      executionProjectId: "p1",
      rawIssueExecutionWorkspaceSettings: null,
      legacyUseProjectWorkspace: null,
    });

    expect(result.projectExecutionWorkspacePolicy).toMatchObject({ enabled: true, defaultMode: "isolated_workspace" });
    expect(result.projectEnv).toEqual({ A: "1" });
    expect(result.executionWorkspaceMode).toBe("isolated_workspace");
    expect(result.executionProjectId).toBe("p1");
  });

  it("lets an issue-settings mode override the project policy", async () => {
    const db = makeDb([
      { executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" }, env: null },
    ]);

    const result = await resolveExecutionWorkspacePolicyInputs(db, {
      companyId: "co-1",
      executionProjectId: "p1",
      rawIssueExecutionWorkspaceSettings: { mode: "operator_branch" },
      legacyUseProjectWorkspace: null,
    });

    expect(result.executionWorkspaceMode).toBe("operator_branch");
    expect(result.projectEnv).toBeNull();
  });

  describe("divergence 1 — the legacyUseProjectWorkspace parameter", () => {
    it("legacyUseProjectWorkspace=false forces agent_default when no policy elevates the mode", async () => {
      // No project → no project select at all, so projectPolicy stays null.
      const db = makeDb([]);

      const result = await resolveExecutionWorkspacePolicyInputs(db, {
        companyId: "co-1",
        executionProjectId: null,
        rawIssueExecutionWorkspaceSettings: null,
        legacyUseProjectWorkspace: false,
      });

      expect(db._selectCalls).toHaveLength(0);
      expect(result.projectExecutionWorkspacePolicy).toBeNull();
      expect(result.projectEnv).toBeNull();
      expect(result.executionWorkspaceMode).toBe("agent_default");
    });

    it("legacyUseProjectWorkspace=null (the crew value) yields shared_workspace on the same inputs", async () => {
      const db = makeDb([]);

      const result = await resolveExecutionWorkspacePolicyInputs(db, {
        companyId: "co-1",
        executionProjectId: null,
        rawIssueExecutionWorkspaceSettings: null,
        legacyUseProjectWorkspace: null,
      });

      expect(result.executionWorkspaceMode).toBe("shared_workspace");
    });
  });
});
