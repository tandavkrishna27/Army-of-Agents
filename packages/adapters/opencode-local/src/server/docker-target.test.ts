import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunProcessResult } from "@armyofagents/adapter-utils/server-utils";

const mocks = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("@armyofagents/adapter-utils", async (importActual) => {
  const actual = await importActual<typeof import("@armyofagents/adapter-utils")>();
  return {
    ...actual,
    runAdapterExecutionTargetProcess: mocks.runAdapterExecutionTargetProcess,
  };
});

const okResult: RunProcessResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: [
    JSON.stringify({
      type: "text",
      sessionID: "opencode-docker-session",
      part: { text: "hello" },
    }),
    JSON.stringify({
      type: "step_finish",
      sessionID: "opencode-docker-session",
      part: {
        cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }),
  ].join("\n"),
  stderr: "",
};

describe("opencode sandbox-docker target", () => {
  let root = "";
  const previousSecret = process.env.SHOULD_NOT_FORWARD_SECRET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.runAdapterExecutionTargetProcess.mockResolvedValue(okResult);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-opencode-docker-target-"));
    process.env.SHOULD_NOT_FORWARD_SECRET = "do-not-forward";
  });

  afterEach(async () => {
    if (previousSecret === undefined) {
      delete process.env.SHOULD_NOT_FORWARD_SECRET;
    } else {
      process.env.SHOULD_NOT_FORWARD_SECRET = previousSecret;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not require the command on the host and passes only adapter env to Docker", async () => {
    const { execute } = await import("./execute.js");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const result = await execute({
      runId: "run-opencode-docker",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Coder",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: path.join(root, "missing-opencode-command"),
        cwd: workspace,
        model: "test/provider",
        env: { CUSTOM_ENV: "custom-value" },
        promptTemplate: "Prompt for {{agent.id}}.",
      },
      context: {},
      executionTarget: { type: "sandbox-docker", image: "node:22-bookworm" },
      runtimeCommandSpec: { command: "opencode", installCommand: "do-not-run" },
      authToken: "secret-run-token",
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    const [, opts] = mocks.runAdapterExecutionTargetProcess.mock.calls[0]!;
    expect(opts.env.CUSTOM_ENV).toBe("custom-value");
    expect(opts.env.AOA_API_KEY).toBe("secret-run-token");
    expect(opts.env.SHOULD_NOT_FORWARD_SECRET).toBeUndefined();
  });
});
