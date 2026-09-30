import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

vi.mock("../services/local-workspace-command-guard.js", () => ({
  assertLocalWorkspaceCommandAllowed: vi.fn(() => {
    throw new Error("Refusing unsandboxed output-detection Git command");
  }),
}));

const putFile = vi.hoisted(() => vi.fn(async (input: { originalFilename: string; body: Buffer }) => ({
  provider: "local",
  objectKey: `agent-outputs/${input.originalFilename}`,
  contentType: "text/markdown",
  byteSize: input.body.length,
  sha256: "stored-sha",
  originalFilename: input.originalFilename,
})));
vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({ putFile }),
}));

import { outputDetectionService } from "../services/output-detection.js";

const cleanupDirs = new Set<string>();
afterEach(async () => {
  await Promise.all([...cleanupDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

describe("output detection cloud Git fallback", () => {
  it("uses mtime detection without invoking Git when local commands are refused", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-output-cloud-"));
    cleanupDirs.add(cwd);
    await fs.mkdir(path.join(cwd, ".git"));
    await fs.writeFile(path.join(cwd, "report.md"), "# Report\n", "utf8");
    const db = {
      insert: () => ({
        values: () => ({ returning: async () => [{ id: "asset-1" }] }),
      }),
    };

    const result = await outputDetectionService(db as never).detectAndCapture({
      runId: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      cwd,
      startedAt: new Date(Date.now() - 1000),
      adapterType: "provider-sandbox",
      issueId: "issue-1",
    });

    expect(execFile).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({ path: "report.md", filename: "report.md" }),
    ]);
  });
});
