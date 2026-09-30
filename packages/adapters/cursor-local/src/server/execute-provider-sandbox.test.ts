import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
  syncAdapterExecutionTargetDirectory: vi.fn(async () => {}),
}));

vi.mock("@armyofagents/adapter-utils", async (importActual) => {
  const actual = await importActual<typeof import("@armyofagents/adapter-utils")>();
  return {
    ...actual,
    runAdapterExecutionTargetProcess: mocks.runAdapterExecutionTargetProcess,
    syncAdapterExecutionTargetDirectory: mocks.syncAdapterExecutionTargetDirectory,
  };
});

describe("cursor provider-sandbox execution", () => {
  it("syncs Cursor skills into a sandbox-local HOME before running", async () => {
    const { execute } = await import("./execute.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-cursor-provider-target-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    mocks.runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "cursor-remote-session" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "output_text", text: "hello" }] } }),
        JSON.stringify({ type: "result", usage: { input_tokens: 1, output_tokens: 2 } }),
      ].join("\n"),
      stderr: "",
    });

    try {
      const result = await execute({
        runId: "run-cursor-provider",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Cursor Coder",
          adapterType: "cursor",
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
          model: "auto",
          promptTemplate: "Prompt for {{agent.id}}.",
        },
        context: {
          skills: [{
            key: "company/knowledge",
            name: "Company Knowledge",
            markdown: "---\nname: Company Knowledge\ndescription: test\n---\n",
          }],
        },
        executionTarget: {
          type: "provider-sandbox",
          provider: "e2b",
          providerLeaseId: "lease-1",
          remoteCwd: "/home/user/aoa-workspace",
          runner: { execute: vi.fn() },
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
      expect(mocks.syncAdapterExecutionTargetDirectory).toHaveBeenCalledWith(expect.objectContaining({
        remoteDir: "/home/user/aoa-workspace/.aoa-runtime/cursor/.cursor/skills",
        target: expect.objectContaining({ type: "provider-sandbox" }),
      }));
      expect(mocks.runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
        expect.objectContaining({ type: "provider-sandbox" }),
        expect.objectContaining({
          cwd: workspace,
          env: expect.objectContaining({
            HOME: "/home/user/aoa-workspace/.aoa-runtime/cursor",
          }),
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      vi.clearAllMocks();
    }
  });
});
