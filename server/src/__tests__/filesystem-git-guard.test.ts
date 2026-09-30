import { describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile,
  spawn: vi.fn(),
}));

vi.mock("../services/local-workspace-command-guard.js", () => ({
  assertLocalWorkspaceCommandAllowed: vi.fn(() => {
    throw new Error("Refusing unsandboxed filesystem Git probe");
  }),
}));

import { checkGitRepo } from "../routes/filesystem.js";

describe("filesystem Git probe cloud guard", () => {
  it("reports no repository without spawning Git when local commands are refused", async () => {
    await expect(checkGitRepo("C:\\tenant-repo")).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });
});
