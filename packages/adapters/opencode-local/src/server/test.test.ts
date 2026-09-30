import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureDirectoryMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const runProcessMock = vi.hoisted(() => vi.fn());
const discoverModelsMock = vi.hoisted(() => vi.fn(async () => [{ id: "openai/gpt-5.2-codex" }]));
const ensureModelMock = vi.hoisted(() => vi.fn(async () => {}));

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

vi.mock("./models.js", () => ({
  discoverOpenCodeModels: discoverModelsMock,
  ensureOpenCodeModelConfiguredAndAvailable: ensureModelMock,
}));

import { testEnvironment } from "./test.js";

describe("opencode_local testEnvironment", () => {
  beforeEach(() => {
    ensureDirectoryMock.mockClear();
    ensureCommandMock.mockClear();
    runProcessMock.mockReset();
    discoverModelsMock.mockClear();
    ensureModelMock.mockClear();
  });

  it("probes provider-sandbox targets and skips local model discovery", async () => {
    runProcessMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        type: "message",
        role: "assistant",
        content: "hello",
      }),
      stderr: "",
    });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      environmentName: "E2B Cloud QA",
      executionTarget: {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "lease-1",
        remoteCwd: "/home/user/aoa-workspace",
        runner: { execute: vi.fn() },
      },
      config: {
        command: "opencode",
        model: "openai/gpt-5.2-codex",
        env: { OPENAI_API_KEY: "secret" },
      },
    });

    expect(discoverModelsMock).not.toHaveBeenCalled();
    expect(ensureModelMock).not.toHaveBeenCalled();
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "opencode_environment_target",
          message: "Probing inside environment: E2B Cloud QA",
        }),
        expect.objectContaining({ code: "opencode_models_discovery_skipped_remote" }),
        expect.objectContaining({ code: "opencode_model_validation_skipped_remote" }),
      ]),
    );
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "provider-sandbox" }),
      expect.objectContaining({
        command: "opencode",
        args: expect.arrayContaining(["run", "--format", "json"]),
      }),
    );
  });
});
