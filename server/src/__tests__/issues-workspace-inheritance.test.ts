import { describe, expect, it } from "vitest";
import {
  pickWorkspaceInheritanceSourceIssueId,
  resolveExecutionWorkspaceInheritance,
  resolveCreateIssueExecutionWorkspaceFields,
  shouldClearExecutionWorkspaceForProjectChange,
} from "../services/issues.js";

describe("pickWorkspaceInheritanceSourceIssueId", () => {
  it("picks inheritExecutionWorkspaceFromIssueId when provided", () => {
    expect(
      pickWorkspaceInheritanceSourceIssueId({
        inheritExecutionWorkspaceFromIssueId: "source-id",
        parentId: null,
      }),
    ).toBe("source-id");
  });

  it("falls back to parentId when inheritExecutionWorkspaceFromIssueId is absent", () => {
    expect(
      pickWorkspaceInheritanceSourceIssueId({
        inheritExecutionWorkspaceFromIssueId: null,
        parentId: "parent-id",
      }),
    ).toBe("parent-id");
  });

  it("picks inheritExecutionWorkspaceFromIssueId over parentId when both provided", () => {
    expect(
      pickWorkspaceInheritanceSourceIssueId({
        inheritExecutionWorkspaceFromIssueId: "explicit-source",
        parentId: "parent-id",
      }),
    ).toBe("explicit-source");
  });

  it("returns null when neither provided", () => {
    expect(pickWorkspaceInheritanceSourceIssueId({})).toBeNull();
    expect(
      pickWorkspaceInheritanceSourceIssueId({
        inheritExecutionWorkspaceFromIssueId: null,
        parentId: null,
      }),
    ).toBeNull();
  });
});

describe("resolveExecutionWorkspaceInheritance", () => {
  const sourceWithWorkspace = {
    executionWorkspaceId: "ws-source",
    executionWorkspaceSettings: { customField: "keep-me" } as Record<string, unknown>,
  };

  it("inherits workspace id + reuse_existing preference + merged settings with mapped mode", () => {
    const resolved = resolveExecutionWorkspaceInheritance({
      sourceIssue: sourceWithWorkspace,
      sourceWorkspace: {
        mode: "operator_branch",
        companyId: "company-1",
        projectId: "project-1",
        status: "active",
      },
      targetCompanyId: "company-1",
      targetProjectId: "project-1",
      isolatedWorkspacesEnabled: true,
      hasExplicitOverride: false,
    });

    expect(resolved).toEqual({
      executionWorkspaceId: "ws-source",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        customField: "keep-me",
        mode: "operator_branch",
      },
    });
  });

  it("maps adapter_managed source mode to agent_default for the issue settings", () => {
    const resolved = resolveExecutionWorkspaceInheritance({
      sourceIssue: { executionWorkspaceId: "ws-1", executionWorkspaceSettings: null },
      sourceWorkspace: {
        mode: "adapter_managed",
        companyId: "company-1",
        projectId: "project-1",
        status: "active",
      },
      targetCompanyId: "company-1",
      targetProjectId: "project-1",
      isolatedWorkspacesEnabled: true,
      hasExplicitOverride: false,
    });

    expect(resolved?.executionWorkspaceSettings).toEqual({ mode: "agent_default" });
  });

  it("returns null when source issue is null", () => {
    expect(
      resolveExecutionWorkspaceInheritance({
        sourceIssue: null,
        sourceWorkspace: null,
        targetCompanyId: "company-1",
        targetProjectId: "project-1",
        isolatedWorkspacesEnabled: true,
        hasExplicitOverride: false,
      }),
    ).toBeNull();
  });

  it("returns null when isolatedWorkspacesEnabled is false", () => {
    expect(
      resolveExecutionWorkspaceInheritance({
        sourceIssue: sourceWithWorkspace,
        sourceWorkspace: {
          mode: "isolated_workspace",
          companyId: "company-1",
          projectId: "project-1",
          status: "active",
        },
        targetCompanyId: "company-1",
        targetProjectId: "project-1",
        isolatedWorkspacesEnabled: false,
        hasExplicitOverride: false,
      }),
    ).toBeNull();
  });

  it("returns null when the caller passed an explicit workspace override", () => {
    expect(
      resolveExecutionWorkspaceInheritance({
        sourceIssue: sourceWithWorkspace,
        sourceWorkspace: {
          mode: "isolated_workspace",
          companyId: "company-1",
          projectId: "project-1",
          status: "active",
        },
        targetCompanyId: "company-1",
        targetProjectId: "project-1",
        isolatedWorkspacesEnabled: true,
        hasExplicitOverride: true,
      }),
    ).toBeNull();
  });

  it("returns null when source issue has no executionWorkspaceId", () => {
    expect(
      resolveExecutionWorkspaceInheritance({
        sourceIssue: { executionWorkspaceId: null, executionWorkspaceSettings: null },
        sourceWorkspace: null,
        targetCompanyId: "company-1",
        targetProjectId: "project-1",
        isolatedWorkspacesEnabled: true,
        hasExplicitOverride: false,
      }),
    ).toBeNull();
  });

  it("produces mode agent_default when source workspace mode is null/undefined", () => {
    const resolved = resolveExecutionWorkspaceInheritance({
      sourceIssue: { executionWorkspaceId: "ws-1", executionWorkspaceSettings: null },
      sourceWorkspace: {
        mode: null,
        companyId: "company-1",
        projectId: "project-1",
        status: "active",
      },
      targetCompanyId: "company-1",
      targetProjectId: "project-1",
      isolatedWorkspacesEnabled: true,
      hasExplicitOverride: false,
    });
    expect(resolved?.executionWorkspaceSettings).toEqual({ mode: "agent_default" });
  });

  it("returns null when the source workspace is not in the target project", () => {
    expect(
      resolveExecutionWorkspaceInheritance({
        sourceIssue: sourceWithWorkspace,
        sourceWorkspace: {
          mode: "isolated_workspace",
          companyId: "company-1",
          projectId: "other-project",
          status: "active",
        },
        targetCompanyId: "company-1",
        targetProjectId: "project-1",
        isolatedWorkspacesEnabled: true,
        hasExplicitOverride: false,
      }),
    ).toBeNull();
  });

  it("returns null when the source workspace is archived", () => {
    expect(
      resolveExecutionWorkspaceInheritance({
        sourceIssue: sourceWithWorkspace,
        sourceWorkspace: {
          mode: "isolated_workspace",
          companyId: "company-1",
          projectId: "project-1",
          status: "archived",
        },
        targetCompanyId: "company-1",
        targetProjectId: "project-1",
        isolatedWorkspacesEnabled: true,
        hasExplicitOverride: false,
      }),
    ).toBeNull();
  });
});

describe("shouldClearExecutionWorkspaceForProjectChange", () => {
  it("clears when a task moves projects and its workspace belongs to the old project", () => {
    expect(
      shouldClearExecutionWorkspaceForProjectChange({
        projectChanged: true,
        companyId: "company-1",
        nextProjectId: "project-2",
        workspace: {
          companyId: "company-1",
          projectId: "project-1",
          status: "active",
        },
      }),
    ).toBe(true);
  });

  it("keeps the workspace when it still belongs to the next project", () => {
    expect(
      shouldClearExecutionWorkspaceForProjectChange({
        projectChanged: true,
        companyId: "company-1",
        nextProjectId: "project-2",
        workspace: {
          companyId: "company-1",
          projectId: "project-2",
          status: "active",
        },
      }),
    ).toBe(false);
  });
});

describe("resolveCreateIssueExecutionWorkspaceFields", () => {
  it("uses an explicit reuse_existing override instead of inherited workspace fields", () => {
    const resolved = resolveCreateIssueExecutionWorkspaceFields({
      explicitPatch: {
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: {
          mode: "reuse_existing",
          reuseWorkspaceId: "ws-explicit",
        },
      },
      inherited: {
        executionWorkspaceId: "ws-inherited",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      },
      existingIssue: {
        companyId: "company-1",
        projectId: "project-1",
      },
      isolatedWorkspacesEnabled: true,
      projectPolicy: { enabled: true, allowIssueOverride: true },
      reuseWorkspace: {
        id: "ws-explicit",
        companyId: "company-1",
        projectId: "project-1",
        status: "active",
      },
    });

    expect(resolved).toEqual({
      executionWorkspaceId: "ws-explicit",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "reuse_existing",
        reuseWorkspaceId: "ws-explicit",
      },
    });
  });

  it("strips explicit create-time overrides when isolated workspaces are disabled", () => {
    const resolved = resolveCreateIssueExecutionWorkspaceFields({
      explicitPatch: {
        executionWorkspacePreference: "isolated_workspace",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      },
      inherited: null,
      existingIssue: {
        companyId: "company-1",
        projectId: "project-1",
      },
      isolatedWorkspacesEnabled: false,
      projectPolicy: { enabled: true, allowIssueOverride: true },
      reuseWorkspace: null,
    });

    expect(resolved).toEqual({});
  });

  it("falls back to inherited workspace fields when no explicit override exists", () => {
    const inherited = {
      executionWorkspaceId: "ws-inherited",
      executionWorkspacePreference: "reuse_existing" as const,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    };

    expect(
      resolveCreateIssueExecutionWorkspaceFields({
        explicitPatch: {},
        inherited,
        existingIssue: {
          companyId: "company-1",
          projectId: "project-1",
        },
        isolatedWorkspacesEnabled: true,
        projectPolicy: { enabled: true, allowIssueOverride: true },
        reuseWorkspace: null,
      }),
    ).toEqual(inherited);
  });
});

describe("resolveCreateIssueExecutionWorkspaceFields", () => {
  it("uses an explicit reuse_existing override instead of inherited workspace fields", () => {
    const resolved = resolveCreateIssueExecutionWorkspaceFields({
      explicitPatch: {
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: {
          mode: "reuse_existing",
          reuseWorkspaceId: "ws-explicit",
        },
      },
      inherited: {
        executionWorkspaceId: "ws-inherited",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      },
      existingIssue: {
        companyId: "company-1",
        projectId: "project-1",
      },
      isolatedWorkspacesEnabled: true,
      projectPolicy: { enabled: true, allowIssueOverride: true },
      reuseWorkspace: {
        id: "ws-explicit",
        companyId: "company-1",
        projectId: "project-1",
        status: "active",
      },
    });

    expect(resolved).toEqual({
      executionWorkspaceId: "ws-explicit",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "reuse_existing",
        reuseWorkspaceId: "ws-explicit",
      },
    });
  });

  it("strips explicit create-time overrides when isolated workspaces are disabled", () => {
    const resolved = resolveCreateIssueExecutionWorkspaceFields({
      explicitPatch: {
        executionWorkspacePreference: "isolated_workspace",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      },
      inherited: null,
      existingIssue: {
        companyId: "company-1",
        projectId: "project-1",
      },
      isolatedWorkspacesEnabled: false,
      projectPolicy: { enabled: true, allowIssueOverride: true },
      reuseWorkspace: null,
    });

    expect(resolved).toEqual({});
  });

  it("falls back to inherited workspace fields when no explicit override exists", () => {
    const inherited = {
      executionWorkspaceId: "ws-inherited",
      executionWorkspacePreference: "reuse_existing" as const,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    };

    expect(
      resolveCreateIssueExecutionWorkspaceFields({
        explicitPatch: {},
        inherited,
        existingIssue: {
          companyId: "company-1",
          projectId: "project-1",
        },
        isolatedWorkspacesEnabled: true,
        projectPolicy: { enabled: true, allowIssueOverride: true },
        reuseWorkspace: null,
      }),
    ).toEqual(inherited);
  });
});
