import { describe, expect, it } from "vitest";
import { createIssueSchema, updateIssueSchema } from "../validators/issue.js";

describe("issue workspace policy validators", () => {
  it("allows create-time workspace preference without command fields", () => {
    const parsed = createIssueSchema.parse({
      title: "Use existing workspace",
      projectId: "11111111-1111-4111-8111-111111111111",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "reuse_existing",
        reuseWorkspaceId: "22222222-2222-4222-8222-222222222222",
      },
    });

    expect(parsed.executionWorkspacePreference).toBe("reuse_existing");
    expect(parsed.executionWorkspaceSettings).toEqual({
      mode: "reuse_existing",
      reuseWorkspaceId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("rejects create-time command fields", () => {
    expect(() =>
      createIssueSchema.parse({
        title: "Bad task",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: {
            type: "git_worktree",
            provisionCommand: "pnpm install",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects create-time runtime service commands", () => {
    expect(() =>
      createIssueSchema.parse({
        title: "Bad runtime task",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceRuntime: {
            services: [{ name: "web", command: "pnpm dev" }],
          },
        },
      }),
    ).toThrow();
  });

  it("keeps update-time workspace fields accepted", () => {
    const parsed = updateIssueSchema.parse({
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    expect(parsed.executionWorkspaceSettings).toEqual({ mode: "isolated_workspace" });
  });
});
