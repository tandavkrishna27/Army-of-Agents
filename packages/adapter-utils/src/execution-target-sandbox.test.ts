import { describe, expect, it, vi } from "vitest";
import {
  prepareWorkspaceForExecutionTarget,
  runAdapterExecutionTargetProcess,
} from "./execution-target.js";
import type { RunProcessResult } from "./server-utils.js";

const okResult: RunProcessResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
};

function opts(overrides: Partial<Parameters<typeof runAdapterExecutionTargetProcess>[1]> = {}) {
  return {
    runId: "run_1",
    command: "codex",
    args: ["--ask-for-approval", "never"],
    cwd: "/repo",
    env: {},
    timeoutSec: 45,
    graceSec: 4,
    onLog: vi.fn(),
    ...overrides,
  };
}

describe("prepareWorkspaceForExecutionTarget", () => {
  it("keeps local execution in the local cwd", () => {
    expect(prepareWorkspaceForExecutionTarget({ type: "local" }, "/repo")).toEqual({
      localCwd: "/repo",
      executionCwd: "/repo",
      restore: null,
    });
  });

  it("uses the Docker workdir as the execution cwd for bind mounts", () => {
    expect(
      prepareWorkspaceForExecutionTarget(
        { type: "sandbox-docker", image: "node:22", workdir: "/workspace/app" },
        "/repo",
      ),
    ).toEqual({
      localCwd: "/repo",
      executionCwd: "/workspace/app",
      restore: null,
    });
  });
});

describe("sandbox-docker install command wrapping", () => {
  it("runs adapter commands directly when no install command is configured", async () => {
    const run = vi.fn().mockResolvedValue(okResult);

    await runAdapterExecutionTargetProcess(
      { type: "sandbox-docker", image: "node:22" },
      opts(),
      { run },
    );

    const dockerArgs = run.mock.calls[0]![2] as string[];
    expect(dockerArgs.slice(-4)).toEqual(["node:22", "codex", "--ask-for-approval", "never"]);
  });

  it("runs target install then runtime install in the same Docker invocation", async () => {
    const run = vi.fn().mockResolvedValue(okResult);

    await runAdapterExecutionTargetProcess(
      {
        type: "sandbox-docker",
        image: "node:22",
        shell: "bash",
        installCommand: "corepack enable",
      },
      opts({
        runtimeCommandSpec: {
          command: "codex",
          installCommand: "npm install -g @openai/codex",
        },
      }),
      { run },
    );

    const dockerArgs = run.mock.calls[0]![2] as string[];
    expect(dockerArgs.slice(-8)).toEqual([
      "node:22",
      "bash",
      "-lc",
      'set -e\ncorepack enable\nnpm install -g @openai/codex\nexec "$@"',
      "bash",
      "codex",
      "--ask-for-approval",
      "never",
    ]);
  });

  it("does not run local targets through install wrappers", async () => {
    const run = vi.fn().mockResolvedValue(okResult);

    await runAdapterExecutionTargetProcess(
      { type: "local" },
      opts({
        runtimeCommandSpec: {
          command: "codex",
          installCommand: "npm install -g @openai/codex",
        },
      }),
      { run },
    );

    expect(run).toHaveBeenCalledWith(
      "run_1",
      "codex",
      ["--ask-for-approval", "never"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });
});
