import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

const mockFsStat = vi.fn();
vi.mock("node:fs/promises", () => ({
  default: { stat: (...args: unknown[]) => mockFsStat(...args) },
  stat: (...args: unknown[]) => mockFsStat(...args),
}));

const mockGetExperimental = vi.fn();
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getExperimental: mockGetExperimental,
  }),
}));

const mockParse = vi.fn();
const mockGate = vi.fn();
const mockResolveMode = vi.fn();
const mockParseIssueSettings = vi.fn();
vi.mock("../services/execution-workspace-policy.js", () => ({
  parseProjectExecutionWorkspacePolicy: (...args: unknown[]) => mockParse(...args),
  gateProjectExecutionWorkspacePolicy: (...args: unknown[]) => mockGate(...args),
  resolveExecutionWorkspaceMode: (...args: unknown[]) => mockResolveMode(...args),
  parseIssueExecutionWorkspaceSettings: (...args: unknown[]) => mockParseIssueSettings(...args),
}));

const mockRealize = vi.fn();
vi.mock("../services/workspace-runtime.js", () => ({
  realizeExecutionWorkspace: (...args: unknown[]) => mockRealize(...args),
}));

const mockEwCreate = vi.fn();
vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({
    create: mockEwCreate,
    createTaskOwnedIdempotent: mockEwCreate,
  }),
}));

// ── Minimal sequence-based mock DB ──────────────────────────────────────

function createMockDb(sequences: { select?: unknown[][]; update?: unknown[][] }) {
  let selectIdx = 0;
  let updateIdx = 0;

  const chainable = (data: unknown) => {
    const obj: Record<string, unknown> = {};
    const methods = ["select", "from", "where", "orderBy", "then", "set", "update", "returning"];
    for (const m of methods) {
      obj[m] = (...args: unknown[]) => {
        if (m === "then") {
          // Support .then() as Promise-like
          const resolve = args[0] as (v: unknown) => unknown;
          return Promise.resolve(resolve(data));
        }
        return chainable(data);
      };
    }
    return obj;
  };

  return {
    select: (..._args: unknown[]) => {
      const rows = sequences.select?.[selectIdx] ?? [];
      selectIdx++;
      return chainable(rows);
    },
    update: (..._args: unknown[]) => {
      const rows = sequences.update?.[updateIdx] ?? [];
      updateIdx++;
      return chainable(rows);
    },
  };
}

// ── SUT ─────────────────────────────────────────────────────────────────

import { createEagerWorkspaceForIssue } from "../services/eager-workspace.js";

describe("createEagerWorkspaceForIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: isolated workspaces enabled
    mockGetExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
  });

  it("returns null when isolated workspaces are disabled", async () => {
    mockGetExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });

    const db = createMockDb({});
    const result = await createEagerWorkspaceForIssue(db as never, {
      companyId: "c1",
      issueId: "i1",
      issueIdentifier: "ARM-1",
      issueTitle: "Test",
      projectId: "p1",
    });

    expect(result).toBeNull();
  });

  it("returns null when project has no executionWorkspacePolicy", async () => {
    // select: project row → no policy
    const db = createMockDb({
      select: [[{ executionWorkspacePolicy: null }]],
    });
    mockParse.mockReturnValue(null);
    mockGate.mockReturnValue(null);

    const result = await createEagerWorkspaceForIssue(db as never, {
      companyId: "c1",
      issueId: "i1",
      issueIdentifier: "ARM-1",
      issueTitle: "Test",
      projectId: "p1",
    });

    expect(result).toBeNull();
  });

  it("returns null when project not found", async () => {
    const db = createMockDb({ select: [[]] });

    const result = await createEagerWorkspaceForIssue(db as never, {
      companyId: "c1",
      issueId: "i1",
      issueIdentifier: "ARM-1",
      issueTitle: "Test",
      projectId: "p1",
    });

    expect(result).toBeNull();
  });

  it("returns null when executionWorkspaceMode is agent_default", async () => {
    const db = createMockDb({
      select: [[{ executionWorkspacePolicy: { enabled: true } }]],
    });
    mockParse.mockReturnValue({ enabled: true });
    mockGate.mockReturnValue({ enabled: true });
    mockResolveMode.mockReturnValue("agent_default");

    const result = await createEagerWorkspaceForIssue(db as never, {
      companyId: "c1",
      issueId: "i1",
      issueIdentifier: "ARM-1",
      issueTitle: "Test",
      projectId: "p1",
    });

    expect(result).toBeNull();
  });

  it("returns null for isolated mode when no isolated workspace strategy exists", async () => {
    const db = createMockDb({
      select: [
        [{
          executionWorkspacePolicy: {
            enabled: true,
            defaultMode: "isolated_workspace",
          },
        }],
        [{
          id: "pw-1",
          cwd: "/tmp/test-repo",
          repoUrl: "https://github.com/test/repo",
          repoRef: "main",
        }],
      ],
    });
    mockParse.mockReturnValue({
      enabled: true,
      defaultMode: "isolated_workspace",
    });
    mockGate.mockReturnValue({
      enabled: true,
      defaultMode: "isolated_workspace",
    });
    mockResolveMode.mockReturnValue("isolated_workspace");
    mockFsStat.mockResolvedValue({ isDirectory: () => true });
    mockRealize.mockResolvedValue({
      baseCwd: "/tmp/test-repo",
      source: "project_primary",
      projectId: "p1",
      workspaceId: "pw-1",
      repoUrl: "https://github.com/test/repo",
      repoRef: "main",
      strategy: "project_primary",
      cwd: "/tmp/test-repo",
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
    });

    const result = await createEagerWorkspaceForIssue(db as never, {
      companyId: "c1",
      issueId: "i1",
      issueIdentifier: "ARM-1",
      issueTitle: "Test",
      projectId: "p1",
    });

    expect(result).toBeNull();
    expect(mockRealize).not.toHaveBeenCalled();
    expect(mockEwCreate).not.toHaveBeenCalled();
  });

  it("returns null when no project workspace rows exist", async () => {
    const db = createMockDb({
      select: [
        [{ executionWorkspacePolicy: { enabled: true, workspaceStrategy: { type: "git_worktree" } } }],
        [], // no project workspaces
      ],
    });
    mockParse.mockReturnValue({ enabled: true });
    mockGate.mockReturnValue({ enabled: true });
    mockResolveMode.mockReturnValue("isolated_workspace");

    const result = await createEagerWorkspaceForIssue(db as never, {
      companyId: "c1",
      issueId: "i1",
      issueIdentifier: "ARM-1",
      issueTitle: "Test",
      projectId: "p1",
    });

    expect(result).toBeNull();
  });

  it("creates workspace and links to issue on success", async () => {
    // select 1: project policy row
    // select 2: project workspace rows
    const db = createMockDb({
      select: [
        [{
          executionWorkspacePolicy: {
            enabled: true,
            defaultMode: "isolated_workspace",
            workspaceStrategy: { type: "git_worktree", baseRef: "main" },
          },
        }],
        [{
          id: "pw-1",
          cwd: "/tmp/test-repo",
          repoUrl: "https://github.com/test/repo",
          repoRef: "main",
        }],
      ],
      update: [[]],
    });

    mockParse.mockReturnValue({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", baseRef: "main" },
    });
    mockGate.mockReturnValue({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", baseRef: "main" },
    });
    mockResolveMode.mockReturnValue("isolated_workspace");

    mockRealize.mockResolvedValue({
      baseCwd: "/tmp/test-repo",
      source: "project_primary",
      projectId: "p1",
      workspaceId: "pw-1",
      repoUrl: "https://github.com/test/repo",
      repoRef: "main",
      strategy: "git_worktree",
      cwd: "/tmp/test-repo/.aoa/worktrees/ARM-1-test",
      branchName: "ARM-1-test",
      worktreePath: "/tmp/test-repo/.aoa/worktrees/ARM-1-test",
      warnings: [],
      created: true,
    });

    mockEwCreate.mockResolvedValue({
      id: "ew-1",
      companyId: "c1",
      branchName: "ARM-1-test",
      strategy: "git_worktree",
    });

    // Mock fs.stat to succeed for the baseCwd check
    mockFsStat.mockResolvedValue({ isDirectory: () => true });

    const result = await createEagerWorkspaceForIssue(db as never, {
      companyId: "c1",
      issueId: "i1",
      issueIdentifier: "ARM-1",
      issueTitle: "Test",
      projectId: "p1",
    });

    expect(result).not.toBeNull();
    expect(result!.workspaceId).toBe("ew-1");
    expect(result!.branchName).toBe("ARM-1-test");
    expect(result!.strategy).toBe("git_worktree");

    // Verify realizeExecutionWorkspace was called with correct params
    expect(mockRealize).toHaveBeenCalledWith(
      expect.objectContaining({
        base: expect.objectContaining({
          baseCwd: "/tmp/test-repo",
          source: "project_primary",
          projectId: "p1",
          workspaceId: "pw-1",
        }),
        config: expect.objectContaining({
          workspaceStrategy: expect.objectContaining({ type: "git_worktree" }),
        }),
        issue: expect.objectContaining({
          id: "i1",
          identifier: "ARM-1",
          title: "Test",
        }),
      }),
    );

    // Verify workspace was created with correct mode
    expect(mockEwCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "c1",
        sourceIssueId: "i1",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
      }),
    );
  });

  it("respects explicit shared workspace settings instead of creating a worktree", async () => {
    const db = createMockDb({
      select: [
        [{
          executionWorkspacePolicy: {
            enabled: true,
            defaultMode: "isolated_workspace",
            workspaceStrategy: { type: "git_worktree", baseRef: "main" },
          },
        }],
        [{
          id: "pw-1",
          cwd: "/tmp/test-repo",
          repoUrl: "https://github.com/test/repo",
          repoRef: "main",
        }],
      ],
      update: [[]],
    });

    const projectPolicy = {
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", baseRef: "main" },
    };
    mockParse.mockReturnValue(projectPolicy);
    mockGate.mockReturnValue(projectPolicy);
    mockParseIssueSettings.mockReturnValue({ mode: "shared_workspace" });
    mockResolveMode.mockImplementation((input) => input.issueSettings?.mode ?? "isolated_workspace");
    mockFsStat.mockResolvedValue({ isDirectory: () => true });
    mockRealize.mockResolvedValue({
      baseCwd: "/tmp/test-repo",
      source: "project_primary",
      projectId: "p1",
      workspaceId: "pw-1",
      repoUrl: "https://github.com/test/repo",
      repoRef: "main",
      strategy: "project_primary",
      cwd: "/tmp/test-repo",
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
    });
    mockEwCreate.mockResolvedValue({
      id: "ew-shared",
      companyId: "c1",
      branchName: null,
      strategy: "project_primary",
    });

    const result = await createEagerWorkspaceForIssue(db as never, {
      companyId: "c1",
      issueId: "i1",
      issueIdentifier: "ARM-1",
      issueTitle: "Test",
      projectId: "p1",
      issueExecutionWorkspaceSettings: { mode: "shared_workspace" },
      issueExecutionWorkspacePreference: "shared_workspace",
      issueExecutionWorkspaceId: null,
    } as never);

    expect(result).toEqual({
      workspaceId: "ew-shared",
      branchName: null,
      strategy: "project_primary",
    });
    expect(mockResolveMode).toHaveBeenCalledWith(expect.objectContaining({
      issueSettings: { mode: "shared_workspace" },
    }));
    expect(mockRealize).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.not.objectContaining({
        workspaceStrategy: expect.anything(),
      }),
    }));
    expect(mockEwCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: "shared_workspace",
      strategyType: "project_primary",
      cwd: "/tmp/test-repo",
      branchName: null,
    }));
  });

  it("does not create another workspace when the task already reuses an existing workspace", async () => {
    const db = createMockDb({
      select: [[{ executionWorkspacePolicy: { enabled: true } }]],
    });
    mockParse.mockReturnValue({ enabled: true, defaultMode: "isolated_workspace" });
    mockGate.mockReturnValue({ enabled: true, defaultMode: "isolated_workspace" });
    mockParseIssueSettings.mockReturnValue({
      mode: "reuse_existing",
      reuseWorkspaceId: "ew-existing",
    });

    const result = await createEagerWorkspaceForIssue(db as never, {
      companyId: "c1",
      issueId: "i1",
      issueIdentifier: "ARM-1",
      issueTitle: "Test",
      projectId: "p1",
      issueExecutionWorkspaceSettings: {
        mode: "reuse_existing",
        reuseWorkspaceId: "ew-existing",
      },
      issueExecutionWorkspacePreference: "reuse_existing",
      issueExecutionWorkspaceId: "ew-existing",
    } as never);

    expect(result).toBeNull();
    expect(mockResolveMode).not.toHaveBeenCalled();
    expect(mockRealize).not.toHaveBeenCalled();
    expect(mockEwCreate).not.toHaveBeenCalled();
  });
});
