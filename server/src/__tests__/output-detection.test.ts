import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  putFile: vi.fn(async (input: { originalFilename: string; contentType: string; body: Buffer }) => ({
    provider: "local",
    objectKey: `agent-outputs/${input.originalFilename}`,
    contentType: input.contentType,
    byteSize: input.body.length,
    sha256: "stored-sha",
    originalFilename: input.originalFilename,
  })),
}));

vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({ putFile: mocks.putFile }),
}));

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

function buildDb() {
  return {
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: "asset-1" }],
      }),
    }),
  };
}

describe("outputDetectionService", () => {
  it("captures untracked markdown files from a git workspace", async () => {
    const { outputDetectionService } = await import("../services/output-detection.js");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-output-git-"));
    try {
      await git(cwd, ["init"]);
      await fs.writeFile(path.join(cwd, "README.md"), "base\n", "utf8");
      await git(cwd, ["add", "README.md"]);
      await git(cwd, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "base"]);
      await fs.writeFile(path.join(cwd, "summary.md"), "# Summary\n", "utf8");

      const result = await outputDetectionService(buildDb() as never).detectAndCapture({
        runId: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        cwd,
        startedAt: new Date(Date.now() - 1000),
        adapterType: "codex_local",
        issueId: "issue-1",
      });

      expect(result).toEqual([
        expect.objectContaining({
          path: "summary.md",
          filename: "summary.md",
          contentType: "text/markdown",
          source: "diff",
          status: "pending",
        }),
      ]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not capture dirty git files that existed before the run started", async () => {
    const { outputDetectionService } = await import("../services/output-detection.js");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-output-dirty-git-"));
    try {
      await git(cwd, ["init"]);
      await fs.writeFile(path.join(cwd, "README.md"), "base\n", "utf8");
      await git(cwd, ["add", "README.md"]);
      await git(cwd, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "base"]);

      await fs.writeFile(path.join(cwd, "old-output.md"), "# Old\n", "utf8");
      const startedAt = new Date(Date.now() + 100);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await fs.writeFile(path.join(cwd, "new-output.md"), "# New\n", "utf8");

      const result = await outputDetectionService(buildDb() as never).detectAndCapture({
        runId: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        cwd,
        startedAt,
        adapterType: "codex_local",
        issueId: "issue-1",
      });

      expect(result.map((item) => item.path)).toContain("new-output.md");
      expect(result.map((item) => item.path)).not.toContain("old-output.md");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("captures files by mtime in a non-git workspace", async () => {
    const { outputDetectionService } = await import("../services/output-detection.js");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-output-nongit-"));
    try {
      const startedAt = new Date(Date.now() - 1000);
      await fs.writeFile(path.join(cwd, "report.html"), "<h1>Report</h1>", "utf8");

      const result = await outputDetectionService(buildDb() as never).detectAndCapture({
        runId: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        cwd,
        startedAt,
        adapterType: "process",
        issueId: "issue-1",
      });

      expect(result[0]).toEqual(
        expect.objectContaining({
          path: "report.html",
          filename: "report.html",
          contentType: "text/html",
          status: "pending",
        }),
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not capture logs, lockfiles, or node_modules outputs", async () => {
    const { outputDetectionService } = await import("../services/output-detection.js");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-output-noise-"));
    try {
      await fs.mkdir(path.join(cwd, "node_modules"), { recursive: true });
      await fs.writeFile(path.join(cwd, "debug.log"), "noise", "utf8");
      await fs.writeFile(path.join(cwd, "pnpm-lock.yaml"), "noise", "utf8");
      await fs.writeFile(path.join(cwd, "node_modules", "x.md"), "noise", "utf8");

      const result = await outputDetectionService(buildDb() as never).detectAndCapture({
        runId: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        cwd,
        startedAt: new Date(Date.now() - 1000),
        adapterType: "codex_local",
        issueId: "issue-1",
      });

      expect(result).toEqual([]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  // U6.3 (S5): sandboxed org runs source changed files from an in-VM diff
  // (collectSandboxDiff) instead of the host git/mtime scan.
  it("sources files from changedFileSource instead of the host git scan, even when cwd is a real dirty git repo", async () => {
    const { outputDetectionService } = await import("../services/output-detection.js");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-output-sandbox-source-"));
    try {
      // A real, dirty git repo with an untracked file the HOST git branch
      // would normally capture if it ran.
      await git(cwd, ["init"]);
      await fs.writeFile(path.join(cwd, "README.md"), "base\n", "utf8");
      await git(cwd, ["add", "README.md"]);
      await git(cwd, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "base"]);
      await fs.writeFile(path.join(cwd, "host-file.md"), "# Should not be captured\n", "utf8");

      let changedFileSourceCalls = 0;
      const result = await outputDetectionService(buildDb() as never).detectAndCapture({
        runId: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        cwd,
        startedAt: new Date(Date.now() - 1000),
        adapterType: "codex_local",
        issueId: "issue-1",
        changedFileSource: async () => {
          changedFileSourceCalls += 1;
          return [{ path: "sandbox-file.md", content: Buffer.from("# From the VM\n", "utf8") }];
        },
      });

      expect(changedFileSourceCalls).toBe(1);
      expect(result).toEqual([
        expect.objectContaining({
          path: "sandbox-file.md",
          filename: "sandbox-file.md",
          source: "diff",
          status: "pending",
          confirmedArtifactId: null,
        }),
      ]);
      expect(result.map((item) => item.path)).not.toContain("host-file.md");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("works when cwd does not exist on the host at all (VM remoteCwd)", async () => {
    const { outputDetectionService } = await import("../services/output-detection.js");
    // A path guaranteed to never exist on the host — mirrors a sandboxed
    // run's remoteCwd (e.g. "/home/user/aoa-workspace"), which is a path
    // inside the E2B VM, not on the machine running this service.
    const cwd = path.join(os.tmpdir(), `aoa-nonexistent-remote-cwd-${Date.now()}`);

    const result = await outputDetectionService(buildDb() as never).detectAndCapture({
      runId: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      cwd,
      startedAt: new Date(Date.now() - 1000),
      adapterType: "codex_local",
      issueId: "issue-1",
      changedFileSource: async () => [
        { path: "src/a.ts", content: Buffer.from("export const a = 1;\n", "utf8") },
      ],
    });

    expect(result).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        filename: "a.ts",
        status: "pending",
        confirmedArtifactId: null,
        confirmedVersionId: null,
      }),
    ]);
  });
});
