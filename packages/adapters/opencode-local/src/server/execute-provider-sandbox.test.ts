import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
  syncAdapterExecutionTargetFile: vi.fn(async () => {}),
}));

vi.mock("@armyofagents/adapter-utils", async (importActual) => {
  const actual = await importActual<typeof import("@armyofagents/adapter-utils")>();
  return {
    ...actual,
    runAdapterExecutionTargetProcess: mocks.runAdapterExecutionTargetProcess,
    syncAdapterExecutionTargetFile: mocks.syncAdapterExecutionTargetFile,
  };
});

describe("opencode provider-sandbox execution", () => {
  it("syncs generated workspace MCP config into the remote workspace", async () => {
    const { execute } = await import("./execute.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-opencode-provider-target-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    mocks.runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "text", sessionID: "opencode-remote-session", part: { text: "hello" } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "opencode-remote-session",
          part: { cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
        }),
      ].join("\n"),
      stderr: "",
    });

    try {
      const result = await execute({
        runId: "run-opencode-provider",
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
          cwd: workspace,
          model: "openai/gpt-5.2-codex",
          promptTemplate: "Prompt for {{agent.id}}.",
        },
        context: {},
        executionTarget: {
          type: "provider-sandbox",
          provider: "e2b",
          providerLeaseId: "lease-1",
          remoteCwd: "/home/user/aoa-workspace",
          runner: { execute: vi.fn() },
        },
        mcpBridge: {
          command: "node",
          args: ["/tmp/bridge.js"],
          env: { AOA_API_KEY: "bridge-token" },
        },
        authToken: "run-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.executionCwd).toBe("/home/user/aoa-workspace");
      expect(result.sessionParams).toMatchObject({
        cwd: "/home/user/aoa-workspace",
        remoteExecution: {
          type: "provider-sandbox",
          provider: "e2b",
          providerLeaseId: "lease-1",
          remoteCwd: "/home/user/aoa-workspace",
        },
      });
      expect(mocks.syncAdapterExecutionTargetFile).toHaveBeenCalledWith(expect.objectContaining({
        localPath: path.join(workspace, "opencode.json"),
        remotePath: "/home/user/aoa-workspace/opencode.json",
        target: expect.objectContaining({ type: "provider-sandbox" }),
      }));
      expect(mocks.runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
        expect.objectContaining({ type: "provider-sandbox" }),
        expect.objectContaining({ cwd: workspace }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      vi.clearAllMocks();
    }
  });
});
