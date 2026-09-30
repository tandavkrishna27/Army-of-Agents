import { describe, expect, it } from "vitest";
import { sniffsShellCommandFields } from "../routes/projects.js";

describe("sniffsShellCommandFields", () => {
  it("returns false for null", () => {
    expect(sniffsShellCommandFields(null)).toBe(false);
  });
  it("returns false for undefined", () => {
    expect(sniffsShellCommandFields(undefined)).toBe(false);
  });
  it("returns false for empty object", () => {
    expect(sniffsShellCommandFields({})).toBe(false);
  });
  it("returns false for object without workspaceStrategy", () => {
    expect(sniffsShellCommandFields({ defaultMode: "shared_workspace" })).toBe(false);
  });
  it("returns true when provisionCommand is set", () => {
    expect(sniffsShellCommandFields({
      workspaceStrategy: { type: "git_worktree", provisionCommand: "echo ok" },
    })).toBe(true);
  });
  it("returns true when teardownCommand is set", () => {
    expect(sniffsShellCommandFields({
      workspaceStrategy: { teardownCommand: "rm -rf .cache" },
    })).toBe(true);
  });
  it("returns true when cleanupCommand is set", () => {
    expect(sniffsShellCommandFields({
      workspaceStrategy: { cleanupCommand: "git clean -fd" },
    })).toBe(true);
  });
  it("returns true when a runtime service command is set", () => {
    expect(sniffsShellCommandFields({
      workspaceRuntime: {
        services: [{ name: "web", command: "pnpm dev" }],
      },
    })).toBe(true);
  });
});
