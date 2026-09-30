import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetCwd,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetShellCommand,
} from "./execution-target.js";
import type { RunProcessResult } from "./server-utils.js";

const okResult: RunProcessResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
};

const failResult: RunProcessResult = {
  exitCode: 1,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "missing",
};

describe("execution target compatibility helpers", () => {
  it("describes current AoA target types", () => {
    expect(describeAdapterExecutionTarget({ type: "local" })).toBe("local");
    expect(
      describeAdapterExecutionTarget({
        type: "sandbox-docker",
        image: "node:22",
        workdir: "/workspace/app",
      }),
    ).toBe("sandbox-docker node:22 at /workspace/app");
  });

  it("resolves cwd using AoA local bind-mount semantics", () => {
    expect(resolveAdapterExecutionTargetCwd({ type: "local" }, "/repo", "/fallback")).toBe("/repo");
    expect(resolveAdapterExecutionTargetCwd({ type: "local" }, "", "/fallback")).toBe("/fallback");
    expect(
      resolveAdapterExecutionTargetCwd(
        { type: "sandbox-docker", image: "node:22", workdir: "/workspace" },
        "/repo",
        "/fallback",
      ),
    ).toBe("/repo");
  });

  it("resolves timeout without inventing target-specific overrides", () => {
    expect(resolveAdapterExecutionTargetTimeoutSec({ type: "local" }, 30)).toBe(30);
    expect(resolveAdapterExecutionTargetTimeoutSec({ type: "sandbox-docker", image: "node:22" }, 0)).toBe(0);
  });

  it("runs shell commands locally through the supplied runner", async () => {
    const run = vi.fn().mockResolvedValue(okResult);

    await runAdapterExecutionTargetShellCommand(
      "run-shell",
      { type: "local" },
      "printf ok",
      {
        cwd: "/repo",
        env: { A: "1" },
        timeoutSec: 9,
        graceSec: 2,
      },
      { run },
    );

    expect(run).toHaveBeenCalledWith("run-shell", "sh", ["-c", "printf ok"], {
      cwd: "/repo",
      env: { A: "1" },
      stdin: undefined,
      timeoutSec: 9,
      graceSec: 2,
      onLog: expect.any(Function),
      onSpawn: undefined,
    });
  });

  it("runs shell commands in sandbox-docker through Docker", async () => {
    const run = vi.fn().mockResolvedValue(okResult);

    await runAdapterExecutionTargetShellCommand(
      "run-shell",
      { type: "sandbox-docker", image: "node:22", workdir: "/workspace" },
      "printf ok",
      {
        cwd: "/repo",
        env: { A: "1" },
        timeoutSec: 9,
        graceSec: 2,
      },
      { run },
    );

    const dockerArgs = run.mock.calls[0]![2] as string[];
    expect(run.mock.calls[0]![1]).toBe("docker");
    expect(dockerArgs).toContain("node:22");
    expect(dockerArgs.slice(-4)).toEqual(["node:22", "sh", "-c", "printf ok"]);
  });

  it("checks sandbox command resolution and runs install before retrying", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(failResult)
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(okResult);

    await ensureAdapterExecutionTargetCommandResolvable(
      "codex",
      { type: "sandbox-docker", image: "node:22" },
      "/repo",
      {},
      { installCommand: "npm install -g @openai/codex", run },
    );

    const scripts = run.mock.calls.map((call) => (call[2] as string[]).at(-1));
    expect(scripts).toEqual([
      "command -v 'codex'",
      "npm install -g @openai/codex",
      "command -v 'codex'",
    ]);
  });

  it("ensures local directories using the filesystem", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-target-dir-"));
    const nested = path.join(root, "nested");
    try {
      await ensureAdapterExecutionTargetDirectory(
        "dir-check",
        { type: "local" },
        nested,
        { cwd: root, env: {}, createIfMissing: true },
      );
      const stat = await fs.stat(nested);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ensures sandbox directories through shell checks", async () => {
    const run = vi.fn().mockResolvedValue(okResult);
    await ensureAdapterExecutionTargetDirectory(
      "dir-check",
      { type: "sandbox-docker", image: "node:22", workdir: "/workspace" },
      "/workspace/project",
      { cwd: "/repo", env: {}, createIfMissing: true, run },
    );

    const script = (run.mock.calls[0]![2] as string[]).at(-1);
    expect(script).toBe("mkdir -p '/workspace/project' && [ -d '/workspace/project' ]");
  });

  it("formats command metadata for local and sandbox targets", async () => {
    await expect(
      resolveAdapterExecutionTargetCommandForLogs("codex", { type: "local" }, "/repo", {}),
    ).resolves.toBe("codex");
    await expect(
      resolveAdapterExecutionTargetCommandForLogs(
        "codex",
        { type: "sandbox-docker", image: "node:22", workdir: "/workspace" },
        "/repo",
        {},
      ),
    ).resolves.toBe("sandbox-docker://node:22/workspace :: codex");
  });
});
