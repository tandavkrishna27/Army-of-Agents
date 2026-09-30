import { describe, expect, it, vi } from "vitest";
import {
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTarget,
  runAdapterExecutionTargetProcess,
  runLocalTargetProcess,
} from "./execution-target.js";
import type { RunProcessResult } from "./server-utils.js";

const okResult: RunProcessResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
};

describe("resolveAdapterExecutionTarget", () => {
  it("defaults missing config to local", () => {
    expect(resolveAdapterExecutionTarget(undefined)).toEqual({ type: "local" });
  });

  it("resolves explicit local config", () => {
    expect(resolveAdapterExecutionTarget({ type: "local", image: "ignored" })).toEqual({
      type: "local",
    });
  });

  it("requires a Docker image", () => {
    expect(() => resolveAdapterExecutionTarget({ type: "sandbox-docker" })).toThrow(
      'executionTarget.image is required for target "sandbox-docker"',
    );
  });

  it("keeps only string-valued Docker env entries", () => {
    expect(
      resolveAdapterExecutionTarget({
        type: "sandbox-docker",
        image: "node:22",
        env: { CI: "1", COUNT: 2, EMPTY: "", ENABLED: true },
      }),
    ).toMatchObject({
      type: "sandbox-docker",
      image: "node:22",
      env: { CI: "1", EMPTY: "" },
    });
  });

  it("throws for an unknown target type", () => {
    expect(() => resolveAdapterExecutionTarget({ type: "remote-ssh" })).toThrow(
      'Unsupported execution target "remote-ssh"',
    );
  });
});

describe("runLocalTargetProcess", () => {
  it("forwards child process options without target-only fields", async () => {
    const onLog = vi.fn();
    const onSpawn = vi.fn();
    const run = vi.fn().mockResolvedValue(okResult);

    await runLocalTargetProcess(
      {
        runId: "run_1",
        command: "node",
        args: ["script.js"],
        cwd: "/repo",
        env: { A: "1" },
        stdin: "prompt",
        authToken: "secret",
        apiBaseUrl: "http://localhost:3100",
        runtimeCommandSpec: { command: "node" },
        timeoutSec: 30,
        graceSec: 2,
        onLog,
        onSpawn,
      },
      run,
    );

    expect(run).toHaveBeenCalledWith("run_1", "node", ["script.js"], {
      cwd: "/repo",
      env: { A: "1" },
      stdin: "prompt",
      timeoutSec: 30,
      graceSec: 2,
      onLog,
      onSpawn,
    });
  });

  it("forwards unsetEnvKeys to the runner when set (env-strip threading)", async () => {
    const run = vi.fn().mockResolvedValue(okResult);
    await runLocalTargetProcess(
      {
        runId: "run_2",
        command: "codex",
        args: ["exec"],
        cwd: "/repo",
        env: { A: "1" },
        timeoutSec: 30,
        graceSec: 2,
        onLog: vi.fn(),
        unsetEnvKeys: ["OPENAI_API_KEY"],
      },
      run,
    );

    expect(run).toHaveBeenCalledWith(
      "run_2",
      "codex",
      ["exec"],
      expect.objectContaining({ env: { A: "1" }, unsetEnvKeys: ["OPENAI_API_KEY"] }),
    );
  });
});

describe("runAdapterExecutionTargetProcess — provider-sandbox env (Codex finding 3)", () => {
  function providerSandboxTarget(execute: ReturnType<typeof vi.fn>) {
    return resolveAdapterExecutionTarget({
      type: "provider-sandbox",
      provider: "e2b",
      providerLeaseId: "lease-1",
      remoteCwd: "/sandbox",
      runner: { execute },
      env: {},
    });
  }
  function baseOpts(env: Record<string, string>) {
    return {
      runId: "run-ps",
      command: "codex",
      args: ["exec"],
      cwd: "/repo",
      env,
      timeoutSec: 30,
      graceSec: 2,
      onLog: async () => {},
      unsetEnvKeys: ["OPENAI_API_KEY"],
      // U5: this describe block is codex/OPENAI_API_KEY-specific — without a
      // resolved provider the sandbox allowlist admits no provider auth key at
      // all (fail-closed default), which would make the "DOES pass" case below
      // indistinguishable from the "does not pass" case.
      sandboxProvider: "openai",
    };
  }

  it("does not pass the ambient OPENAI_API_KEY to the provider runner (env built from opts.env, not process.env)", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-server-ambient";
    try {
      const execute = vi.fn().mockResolvedValue(okResult);
      await runAdapterExecutionTargetProcess(providerSandboxTarget(execute), baseOpts({}));
      const passedEnv = (execute.mock.calls[0][0] as { env: Record<string, string> }).env;
      expect(passedEnv.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("DOES pass an opts.env OPENAI_API_KEY to the provider runner (agent-set key)", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-server-ambient";
    try {
      const execute = vi.fn().mockResolvedValue(okResult);
      await runAdapterExecutionTargetProcess(providerSandboxTarget(execute), baseOpts({ OPENAI_API_KEY: "sk-agent" }));
      const passedEnv = (execute.mock.calls[0][0] as { env: Record<string, string> }).env;
      expect(passedEnv.OPENAI_API_KEY).toBe("sk-agent");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe("ensureAdapterExecutionTargetRuntimeCommandInstalled", () => {
  it("does nothing for local targets", async () => {
    const runShellCommand = vi.fn();
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      target: { type: "local" },
      runtimeCommandSpec: { command: "node", installCommand: "npm install -g node" },
      runShellCommand,
    });
    expect(runShellCommand).not.toHaveBeenCalled();
  });

  it("runs Docker runtime command install commands", async () => {
    const runShellCommand = vi.fn().mockResolvedValue(okResult);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      target: { type: "sandbox-docker", image: "node:22" },
      runtimeCommandSpec: { command: "codex", installCommand: "npm install -g @openai/codex" },
      runShellCommand,
    });
    expect(runShellCommand).toHaveBeenCalledWith("npm install -g @openai/codex");
  });

  it("runs Docker target install commands before runtime command installs", async () => {
    const runShellCommand = vi.fn().mockResolvedValue(okResult);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      target: {
        type: "sandbox-docker",
        image: "node:22",
        installCommand: "corepack enable",
      },
      runtimeCommandSpec: { command: "codex", installCommand: "npm install -g @openai/codex" },
      runShellCommand,
    });
    expect(runShellCommand).toHaveBeenNthCalledWith(1, "corepack enable");
    expect(runShellCommand).toHaveBeenNthCalledWith(2, "npm install -g @openai/codex");
  });

  it("throws when Docker install fails", async () => {
    await expect(
      ensureAdapterExecutionTargetRuntimeCommandInstalled({
        target: { type: "sandbox-docker", image: "node:22" },
        runtimeCommandSpec: { command: "codex", installCommand: "npm install -g @openai/codex" },
        runShellCommand: async () => ({
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "nope",
        }),
      }),
    ).rejects.toThrow("Failed to install runtime command: nope");
  });
});
