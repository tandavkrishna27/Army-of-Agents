import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  describeAdapterExecutionTarget,
  prepareAdapterExecutionTargetRuntime,
  prepareWorkspaceForExecutionTarget,
  resolveAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  syncAdapterExecutionTargetDirectory,
} from "./execution-target.js";
import type { RunProcessResult } from "./server-utils.js";
import type { AdapterProviderSandboxExecutionTarget } from "./types.js";

const okResult: RunProcessResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "ok",
  stderr: "",
};

function providerTarget(
  overrides: Partial<AdapterProviderSandboxExecutionTarget> = {},
): AdapterProviderSandboxExecutionTarget {
  return {
    type: "provider-sandbox",
    provider: "fake",
    providerLeaseId: "lease-1",
    remoteCwd: "/workspace/app",
    shell: "bash",
    env: { BASE: "1" },
    runner: {
      execute: vi.fn(async () => okResult),
    },
    ...overrides,
  };
}

describe("provider-sandbox execution target", () => {
  it("resolves provider-backed targets with an in-memory runner", () => {
    const runner = { execute: vi.fn(async () => okResult) };
    expect(
      resolveAdapterExecutionTarget({
        type: "provider-sandbox",
        provider: "fake",
        providerLeaseId: "lease-1",
        remoteCwd: "/workspace/app",
        shell: "bash",
        env: { A: "1", IGNORED: 2 },
        runner,
      }),
    ).toEqual({
      type: "provider-sandbox",
      provider: "fake",
      providerLeaseId: "lease-1",
      remoteCwd: "/workspace/app",
      shell: "bash",
      env: { A: "1" },
      runner,
    });
  });

  it("requires a runner because provider targets are server-only execution targets", () => {
    expect(() =>
      resolveAdapterExecutionTarget({
        type: "provider-sandbox",
        provider: "fake",
        providerLeaseId: "lease-1",
        remoteCwd: "/workspace/app",
      }),
    ).toThrow('executionTarget.runner is required for target "provider-sandbox"');
  });

  it("runs adapter commands through the provider runner", async () => {
    // U5: "BASE"/"RUN" were arbitrary synthetic keys — under the from-scratch
    // sandbox allowlist a non-allowlisted key is dropped, so this now proves
    // the target-env-below-runtime-env merge with ALLOWLISTED names instead.
    const target = providerTarget({ env: { AOA_EXECUTION_TARGET_ID: "target-1" } });

    const result = await runAdapterExecutionTargetProcess(target, {
      runId: "run-1",
      command: "codex",
      args: ["--json"],
      cwd: "/local/repo",
      env: { AOA_RUNTIME_HOOK_TOKEN: "hook-1" },
      stdin: "prompt",
      timeoutSec: 30,
      graceSec: 2,
      onLog: vi.fn(),
    });

    expect(result).toBe(okResult);
    expect(target.runner.execute).toHaveBeenCalledWith({
      runId: "run-1",
      provider: "fake",
      providerLeaseId: "lease-1",
      command: "codex",
      args: ["--json"],
      cwd: "/workspace/app",
      env: { AOA_EXECUTION_TARGET_ID: "target-1", AOA_RUNTIME_HOOK_TOKEN: "hook-1" },
      stdin: "prompt",
      timeoutSec: 30,
      graceSec: 2,
      onLog: expect.any(Function),
      onSpawn: undefined,
    });
  });

  it("wraps provider-sandbox adapter commands with runtime install commands", async () => {
    const target = providerTarget();

    await runAdapterExecutionTargetProcess(target, {
      runId: "run-install",
      command: "codex",
      args: ["exec", "-"],
      cwd: "/local/repo",
      env: {},
      stdin: "prompt",
      runtimeCommandSpec: {
        command: "codex",
        installCommand: "npm install -g @openai/codex",
      },
      timeoutSec: 30,
      graceSec: 2,
      onLog: vi.fn(),
    });

    expect(target.runner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "bash",
        args: [
          "-lc",
          [
            "set -e",
            "npm install -g @openai/codex",
            'exec "$@"',
          ].join("\n"),
          "bash",
          "codex",
          "exec",
          "-",
        ],
      }),
    );
  });

  it("runs shell commands through the provider target shell", async () => {
    const target = providerTarget();

    await runAdapterExecutionTargetShellCommand(
      "run-shell",
      target,
      "printf ok",
      {
        cwd: "/local/repo",
        env: { RUN: "1" },
        timeoutSec: 9,
        graceSec: 2,
      },
    );

    expect(target.runner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "bash",
        args: ["-lc", "printf ok"],
        cwd: "/workspace/app",
      }),
    );
  });

  it("treats provider-backed targets as remote workspaces", async () => {
    const target = providerTarget();
    expect(describeAdapterExecutionTarget(target)).toBe("provider-sandbox fake at /workspace/app");
    expect(resolveAdapterExecutionTargetCwd(target, "", "/fallback")).toBe("/workspace/app");
    expect(adapterExecutionTargetIsRemote(target)).toBe(true);
    expect(adapterExecutionTargetUsesManagedHome(target)).toBe(true);
    expect(adapterExecutionTargetRemoteCwd(target, "/fallback")).toBe("/workspace/app");
    expect(adapterExecutionTargetSessionIdentity(target)).toEqual({
      type: "provider-sandbox",
      provider: "fake",
      providerLeaseId: "lease-1",
      remoteCwd: "/workspace/app",
    });
    expect(prepareWorkspaceForExecutionTarget(target, "/local/repo")).toEqual({
      localCwd: "/local/repo",
      executionCwd: "/workspace/app",
      restore: null,
    });
    await expect(
      prepareAdapterExecutionTargetRuntime({
        target,
        workspaceLocalDir: "/local/repo",
        adapterKey: "codex_local",
      }),
    ).resolves.toMatchObject({
      workspaceRemoteDir: "/workspace/app",
      runtimeRootDir: "/workspace/app/.aoa-runtime/codex_local",
    });
    await expect(
      resolveAdapterExecutionTargetCommandForLogs("codex", target, "/local/repo", {}),
    ).resolves.toBe("provider-sandbox://fake/workspace/app :: codex");
  });

  it("syncs generated local directories into provider-sandbox runtime paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-provider-sync-"));
    try {
      await fs.mkdir(path.join(root, "skill-one"), { recursive: true });
      await fs.writeFile(path.join(root, "skill-one", "SKILL.md"), "name: skill-one\n", "utf8");
      const target = providerTarget();

      await syncAdapterExecutionTargetDirectory({
        runId: "run-sync",
        target,
        localDir: root,
        remoteDir: "/workspace/app/.aoa-runtime/pi/skills",
        cwd: "/workspace/app",
        env: { HOME: "/workspace/app/.aoa-runtime/pi" },
        timeoutSec: 5,
        graceSec: 1,
      });

      expect(target.runner.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-sync-sync-root",
          command: "bash",
          args: expect.arrayContaining([
            expect.stringContaining("mkdir -p '/workspace/app/.aoa-runtime/pi/skills'"),
          ]),
        }),
      );
      expect(target.runner.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-sync-sync-file-0",
          command: "bash",
          args: expect.arrayContaining([
            expect.stringContaining("base64 -d > '/workspace/app/.aoa-runtime/pi/skills/skill-one/SKILL.md'"),
          ]),
          stdin: Buffer.from("name: skill-one\n").toString("base64"),
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
