import { beforeEach, describe, expect, it, vi } from "vitest";
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
  stdout: "ok\n",
  stderr: "",
};

describe("process adapter execution target bridge context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AOA_API_URL;
    mocks.runAdapterExecutionTargetProcess.mockResolvedValue(okResult);
  });

  it("passes computed AOA_API_URL when process env does not define one", async () => {
    const { execute } = await import("../adapters/process/execute.js");

    await execute({
      runId: "run-process-bridge",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Process Runner",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "node",
        cwd: process.cwd(),
        env: {},
      },
      context: {},
      executionTarget: { type: "sandbox-docker", image: "node:22-bookworm" },
      runtimeCommandSpec: null,
      authToken: "ctx-token",
      onLog: async () => {},
    });

    expect(mocks.runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox-docker" }),
      expect.objectContaining({
        apiBaseUrl: "http://localhost:3100",
        authToken: "ctx-token",
      }),
    );
  });

  it("passes explicit AOA_API_KEY as bridge auth token", async () => {
    const { execute } = await import("../adapters/process/execute.js");

    await execute({
      runId: "run-process-explicit-key",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Process Runner",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "node",
        cwd: process.cwd(),
        env: { AOA_API_KEY: "configured-token" },
      },
      context: {},
      executionTarget: { type: "sandbox-docker", image: "node:22-bookworm" },
      runtimeCommandSpec: null,
      authToken: "ctx-token",
      onLog: async () => {},
    });

    expect(mocks.runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox-docker" }),
      expect.objectContaining({
        authToken: "configured-token",
      }),
    );
  });

  it("uses the realized workspace cwd from heartbeat context for process execution", async () => {
    const { execute } = await import("../adapters/process/execute.js");

    await execute({
      runId: "run-process-workspace",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Process Runner",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "node",
        cwd: "C:/server-default",
        env: {},
      },
      context: {
        paperclipWorkspace: {
          cwd: "C:/aoa/worktrees/task-123",
          source: "project_primary",
        },
      },
      executionTarget: { type: "local" },
      runtimeCommandSpec: null,
      authToken: "ctx-token",
      onLog: async () => {},
    });

    expect(mocks.runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.objectContaining({ type: "local" }),
      expect.objectContaining({
        cwd: "C:/aoa/worktrees/task-123",
      }),
    );
  });

  it("injects run id, task id, fallback auth token, and returns execution cwd", async () => {
    const { execute } = await import("../adapters/process/execute.js");
    const cwd = process.cwd();

    const result = await execute({
      runId: "run-process-task-env",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Process Runner",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "node",
        cwd,
        env: {},
      },
      context: {
        taskId: "task-123",
      },
      executionTarget: { type: "local" },
      runtimeCommandSpec: null,
      authToken: "ctx-token",
      onLog: async () => {},
    });

    expect(mocks.runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.objectContaining({ type: "local" }),
      expect.objectContaining({
        cwd,
        authToken: "ctx-token",
        env: expect.objectContaining({
          AOA_RUN_ID: "run-process-task-env",
          AOA_TASK_ID: "task-123",
          AOA_API_KEY: "ctx-token",
        }),
      }),
    );
    expect(result.executionCwd).toBe(cwd);
  });

  it("does not overwrite an explicit process AOA_API_KEY", async () => {
    const { execute } = await import("../adapters/process/execute.js");

    await execute({
      runId: "run-process-explicit-key-env",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Process Runner",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "node",
        cwd: process.cwd(),
        env: { AOA_API_KEY: "configured-token" },
      },
      context: {
        issueId: "issue-123",
      },
      executionTarget: { type: "local" },
      runtimeCommandSpec: null,
      authToken: "ctx-token",
      onLog: async () => {},
    });

    expect(mocks.runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        authToken: "configured-token",
        env: expect.objectContaining({
          AOA_TASK_ID: "issue-123",
          AOA_API_KEY: "configured-token",
        }),
      }),
    );
  });
});
