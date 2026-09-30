import { describe, expect, it, vi, beforeEach } from "vitest";

const ensureDirectoryMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const installMock = vi.hoisted(() => vi.fn(async () => null));
const runProcessMock = vi.hoisted(() => vi.fn());
const discoverModelsMock = vi.hoisted(() => vi.fn(async () => [{ id: "openai/gpt-5.4-mini" }]));

vi.mock("@armyofagents/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: (target: { type?: string } | null | undefined) =>
    target?.type === "sandbox-docker" || target?.type === "provider-sandbox",
  describeAdapterExecutionTarget: () => "provider-sandbox e2b at /home/user/aoa-workspace",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetDirectory: ensureDirectoryMock,
  maybeRunSandboxInstallCommand: installMock,
  resolveAdapterExecutionTargetCwd: (_target: unknown, configuredCwd: string, fallbackCwd: string) =>
    configuredCwd || fallbackCwd,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

vi.mock("./models.js", () => ({
  discoverPiModelsCached: discoverModelsMock,
}));

import { testEnvironment } from "./test.js";

describe("pi_local testEnvironment", () => {
  beforeEach(() => {
    ensureDirectoryMock.mockClear();
    ensureCommandMock.mockClear();
    installMock.mockClear();
    runProcessMock.mockReset();
    discoverModelsMock.mockClear();
  });

  it("treats provider-sandbox targets as remote and skips local model discovery", async () => {
    runProcessMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "hello" },
      }),
      stderr: "",
    });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      environmentName: "E2B Cloud QA",
      executionTarget: {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "lease-1",
        remoteCwd: "/home/user/aoa-workspace",
        runner: { execute: vi.fn() },
      },
      config: {
        command: "pi",
        model: "openai/gpt-5.4-mini",
      },
    });

    expect(discoverModelsMock).not.toHaveBeenCalled();
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pi_environment_target",
          message: "Probing inside environment: E2B Cloud QA",
        }),
        expect.objectContaining({
          code: "pi_model_validation_skipped_remote",
        }),
      ]),
    );
  });
});
