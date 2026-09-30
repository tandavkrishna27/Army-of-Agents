import { describe, expect, it } from "vitest";
import {
  buildExecutionWorkspaceAdapterConfig,
  defaultIssueExecutionWorkspaceSettingsForProject,
  enforceIssueExecutionWorkspaceOverridePolicy,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.ts";

describe("execution workspace policy helpers", () => {
  it("defaults new issue settings from enabled project policy", () => {
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "isolated_workspace",
      }),
    ).toEqual({ mode: "isolated_workspace" });
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "shared_workspace",
      }),
    ).toEqual({ mode: "shared_workspace" });
    expect(defaultIssueExecutionWorkspaceSettingsForProject(null)).toBeNull();
  });

  it("prefers explicit issue mode over project policy and legacy overrides", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "shared_workspace" },
        issueSettings: { mode: "isolated_workspace" },
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
  });

  it("falls back to project policy before legacy project-workspace compatibility flag", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: null,
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("agent_default");
  });

  it("applies project policy strategy and runtime defaults when isolation is enabled", () => {
    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {
        workspaceStrategy: { type: "project_primary" },
      },
      projectPolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/main",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
        },
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
      issueSettings: null,
      mode: "isolated_workspace",
      legacyUseProjectWorkspace: null,
    });

    expect(result.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "origin/main",
      provisionCommand: "bash ./scripts/provision-worktree.sh",
    });
    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "web", command: "pnpm dev" }],
    });
  });

  it("does not synthesize a git worktree strategy for isolated mode without an explicit strategy", () => {
    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
      },
      issueSettings: null,
      mode: "isolated_workspace",
      legacyUseProjectWorkspace: null,
    });

    expect(result.workspaceStrategy).toBeUndefined();
  });

  it("clears managed workspace strategy when issue opts out to project primary or agent default", () => {
    const baseConfig = {
      workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" },
      workspaceRuntime: { services: [{ name: "web" }] },
    };

    expect(
      buildExecutionWorkspaceAdapterConfig({
        agentConfig: baseConfig,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: { mode: "shared_workspace" },
        mode: "shared_workspace",
        legacyUseProjectWorkspace: null,
      }).workspaceStrategy,
    ).toBeUndefined();

    const agentDefault = buildExecutionWorkspaceAdapterConfig({
      agentConfig: baseConfig,
      projectPolicy: null,
      issueSettings: { mode: "agent_default" },
      mode: "agent_default",
      legacyUseProjectWorkspace: null,
    });
    expect(agentDefault.workspaceStrategy).toBeUndefined();
    expect(agentDefault.workspaceRuntime).toBeUndefined();
  });

  it("parses persisted JSON payloads into typed project and issue workspace settings", () => {
    expect(
      parseProjectExecutionWorkspacePolicy({
        enabled: true,
        defaultMode: "isolated",
        workspaceStrategy: {
          type: "git_worktree",
          worktreeParentDir: ".aoa/worktrees",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          teardownCommand: "bash ./scripts/teardown-worktree.sh",
        },
      }),
    ).toEqual({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        worktreeParentDir: ".aoa/worktrees",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
      },
    });
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "project_primary",
      }),
    ).toEqual({
      mode: "shared_workspace",
    });
  });

  it("parses reuseWorkspaceId from issue workspace settings", () => {
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "reuse_existing",
        reuseWorkspaceId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      mode: "reuse_existing",
      reuseWorkspaceId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("rejects issue-level workspace commands", () => {
    expect(() =>
      enforceIssueExecutionWorkspaceOverridePolicy({
        existingIssue: {
          companyId: "company-1",
          projectId: "project-1",
        },
        isolatedWorkspacesEnabled: true,
        projectPolicy: { enabled: true, allowIssueOverride: true },
        patch: {
          executionWorkspaceSettings: {
            mode: "isolated_workspace",
            workspaceStrategy: {
              type: "git_worktree",
              provisionCommand: "pnpm install",
            },
          },
        },
        reuseWorkspace: null,
      }),
    ).toThrow("Issue workspace overrides cannot include commands");
  });

  it("rejects issue-level workspace command fields even when empty", () => {
    expect(() =>
      enforceIssueExecutionWorkspaceOverridePolicy({
        existingIssue: {
          companyId: "company-1",
          projectId: "project-1",
        },
        isolatedWorkspacesEnabled: true,
        projectPolicy: { enabled: true, allowIssueOverride: true },
        patch: {
          executionWorkspaceSettings: {
            mode: "isolated_workspace",
            workspaceStrategy: {
              type: "git_worktree",
              provisionCommand: "",
            },
          },
        },
        reuseWorkspace: null,
      }),
    ).toThrow("Issue workspace overrides cannot include commands");
  });

  it("rejects issue workspace overrides when project policy disallows them", () => {
    expect(() =>
      enforceIssueExecutionWorkspaceOverridePolicy({
        existingIssue: {
          companyId: "company-1",
          projectId: "project-1",
        },
        isolatedWorkspacesEnabled: true,
        projectPolicy: { enabled: true, allowIssueOverride: false },
        patch: {
          executionWorkspaceSettings: { mode: "isolated_workspace" },
        },
        reuseWorkspace: null,
      }),
    ).toThrow("Project workspace policy does not allow task-level overrides");
  });

  it("rejects reuse_existing workspaces from another project", () => {
    expect(() =>
      enforceIssueExecutionWorkspaceOverridePolicy({
        existingIssue: {
          companyId: "company-1",
          projectId: "project-1",
        },
        isolatedWorkspacesEnabled: true,
        projectPolicy: { enabled: true, allowIssueOverride: true },
        patch: {
          executionWorkspaceSettings: {
            mode: "reuse_existing",
            reuseWorkspaceId: "workspace-1",
          },
        },
        reuseWorkspace: {
          id: "workspace-1",
          companyId: "company-1",
          projectId: "project-2",
          status: "active",
        },
      }),
    ).toThrow("Execution workspace must belong to the task project");
  });

  it("rejects archived reuse_existing workspaces", () => {
    expect(() =>
      enforceIssueExecutionWorkspaceOverridePolicy({
        existingIssue: {
          companyId: "company-1",
          projectId: "project-1",
        },
        isolatedWorkspacesEnabled: true,
        projectPolicy: { enabled: true, allowIssueOverride: true },
        patch: {
          executionWorkspaceSettings: {
            mode: "reuse_existing",
            reuseWorkspaceId: "workspace-1",
          },
        },
        reuseWorkspace: {
          id: "workspace-1",
          companyId: "company-1",
          projectId: "project-1",
          status: "archived",
        },
      }),
    ).toThrow("Execution workspace is archived");
  });

  it("rejects direct executionWorkspaceId from another project", () => {
    expect(() =>
      enforceIssueExecutionWorkspaceOverridePolicy({
        existingIssue: {
          companyId: "company-1",
          projectId: "project-1",
        },
        isolatedWorkspacesEnabled: true,
        projectPolicy: { enabled: true, allowIssueOverride: true },
        patch: {
          executionWorkspaceId: "workspace-1",
        },
        reuseWorkspace: {
          id: "workspace-1",
          companyId: "company-1",
          projectId: "project-2",
          status: "active",
        },
      }),
    ).toThrow("Execution workspace must belong to the task project");
  });

  it("sets executionWorkspaceId for valid reuse_existing reuseWorkspaceId", () => {
    expect(
      enforceIssueExecutionWorkspaceOverridePolicy({
        existingIssue: {
          companyId: "company-1",
          projectId: "project-1",
        },
        isolatedWorkspacesEnabled: true,
        projectPolicy: { enabled: true, allowIssueOverride: true },
        patch: {
          executionWorkspaceSettings: {
            mode: "reuse_existing",
            reuseWorkspaceId: "workspace-1",
          },
        },
        reuseWorkspace: {
          id: "workspace-1",
          companyId: "company-1",
          projectId: "project-1",
          status: "active",
        },
      }),
    ).toEqual({
      executionWorkspaceId: "workspace-1",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "reuse_existing",
        reuseWorkspaceId: "workspace-1",
      },
    });
  });

  it("maps persisted execution workspace modes back to issue settings", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("isolated_workspace")).toBe("isolated_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("operator_branch")).toBe("operator_branch");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("shared_workspace")).toBe("shared_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("adapter_managed")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("cloud_sandbox")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(null)).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(undefined)).toBe("agent_default");
  });

  it("normalizes create-time reuse_existing into executionWorkspaceId", () => {
    expect(
      enforceIssueExecutionWorkspaceOverridePolicy({
        existingIssue: { companyId: "company-1", projectId: "project-1" },
        isolatedWorkspacesEnabled: true,
        projectPolicy: { enabled: true, allowIssueOverride: true },
        patch: {
          executionWorkspacePreference: "reuse_existing",
          executionWorkspaceSettings: {
            mode: "reuse_existing",
            reuseWorkspaceId: "workspace-1",
          },
        },
        reuseWorkspace: {
          id: "workspace-1",
          companyId: "company-1",
          projectId: "project-1",
          status: "active",
        },
      }),
    ).toEqual({
      executionWorkspaceId: "workspace-1",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "reuse_existing",
        reuseWorkspaceId: "workspace-1",
      },
    });
  });

  it("strips create-time workspace override when isolated workspaces are disabled", () => {
    expect(
      enforceIssueExecutionWorkspaceOverridePolicy({
        existingIssue: { companyId: "company-1", projectId: "project-1" },
        isolatedWorkspacesEnabled: false,
        projectPolicy: { enabled: true, allowIssueOverride: true },
        patch: {
          executionWorkspacePreference: "isolated_workspace",
          executionWorkspaceSettings: { mode: "isolated_workspace" },
        },
        reuseWorkspace: null,
      }),
    ).toEqual({});
  });

  it("rejects issue-level runtime service command fields", () => {
    expect(() =>
      enforceIssueExecutionWorkspaceOverridePolicy({
        existingIssue: {
          companyId: "company-1",
          projectId: "project-1",
        },
        isolatedWorkspacesEnabled: true,
        projectPolicy: { enabled: true, allowIssueOverride: true },
        patch: {
          executionWorkspaceSettings: {
            mode: "isolated_workspace",
            workspaceRuntime: {
              services: [{ name: "web", command: "pnpm dev" }],
            },
          },
        },
        reuseWorkspace: null,
      }),
    ).toThrow("Issue workspace overrides cannot include commands");
  });

  it("disables project execution workspace policy when the instance flag is off", () => {
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        false,
      ),
    ).toBeNull();
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        true,
      ),
    ).toEqual({ enabled: true, defaultMode: "isolated_workspace" });
  });
});
