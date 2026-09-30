import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureDirectoryMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@armyofagents/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: (target: { type?: string } | null | undefined) =>
    target?.type === "sandbox-docker" || target?.type === "provider-sandbox",
  describeAdapterExecutionTarget: () => "provider-sandbox e2b at /home/user/aoa-workspace",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetDirectory: ensureDirectoryMock,
  resolveAdapterExecutionTargetCwd: (_target: unknown, configuredCwd: string, fallbackCwd: string) =>
    configuredCwd || fallbackCwd,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

import { testEnvironment } from "./test.js";

describe("gemini_local testEnvironment", () => {
  beforeEach(() => {
    ensureDirectoryMock.mockClear();
    ensureCommandMock.mockClear();
    runProcessMock.mockReset();
  });

  it("probes provider-sandbox targets through the execution target", async () => {
    runProcessMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        type: "result",
        result: "hello",
      }),
      stderr: "",
    });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "gemini_local",
      environmentName: "E2B Cloud QA",
      executionTarget: {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "lease-1",
        remoteCwd: "/home/user/aoa-workspace",
        runner: { execute: vi.fn() },
      },
      config: {
        command: "gemini",
        env: { GEMINI_API_KEY: "secret" },
      },
    });

    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "gemini_environment_target",
          message: "Probing inside environment: E2B Cloud QA",
        }),
        expect.objectContaining({ code: "gemini_command_resolvable" }),
      ]),
    );
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "provider-sandbox" }),
      expect.objectContaining({
        command: "gemini",
        cwd: expect.any(String),
      }),
    );
  });
});
