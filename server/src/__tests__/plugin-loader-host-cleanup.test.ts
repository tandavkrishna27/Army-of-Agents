import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  asc: vi.fn(),
  eq: vi.fn(),
  ne: vi.fn(),
  sql: vi.fn(),
  and: vi.fn(),
}));

vi.mock("@armyofagents/db", () => ({
  plugins: {} as unknown,
  pluginConfig: {} as unknown,
  pluginCompanySettings: {} as unknown,
  pluginEntities: {} as unknown,
  pluginJobs: {} as unknown,
  pluginJobRuns: {} as unknown,
  pluginLogs: {} as unknown,
  pluginState: {} as unknown,
  pluginWebhookDeliveries: {} as unknown,
}));

import {
  pluginLoader,
  type PluginRuntimeServices,
} from "../services/plugin-loader.js";

function makeRuntime(overrides: Partial<PluginRuntimeServices> = {}) {
  return {
    workerManager: {
      isRunning: vi.fn(() => false),
      stopWorker: vi.fn(),
      stopAll: vi.fn(async () => {}),
    },
    eventBus: { clearPlugin: vi.fn() },
    jobScheduler: {
      unregisterPlugin: vi.fn(async () => {}),
      stop: vi.fn(),
    },
    jobStore: {},
    toolDispatcher: { unregisterPluginTools: vi.fn() },
    lifecycleManager: {},
    buildHostHandlers: vi.fn(),
    disposeHostServices: vi.fn(),
    disposeAllHostServices: vi.fn(),
    instanceInfo: { instanceId: "instance-a", hostVersion: "test" },
    ...overrides,
  } as unknown as PluginRuntimeServices;
}

describe("plugin loader host-service cleanup", () => {
  it("releases host resources when a plugin runtime is unloaded", async () => {
    const runtime = makeRuntime();
    const loader = pluginLoader({} as never, {}, runtime);

    await loader.unloadSingle("plugin-a", "acme.a");

    expect(runtime.disposeHostServices).toHaveBeenCalledWith("plugin-a");
    expect(runtime.eventBus.clearPlugin).toHaveBeenCalledWith("plugin-a");
    expect(runtime.toolDispatcher.unregisterPluginTools).toHaveBeenCalledWith(
      "plugin-a"
    );
  });

  it("releases every host resource even when worker shutdown fails", async () => {
    const stopFailure = new Error("worker did not stop");
    const runtime = makeRuntime({
      workerManager: {
        stopAll: vi.fn(async () => {
          throw stopFailure;
        }),
      } as never,
    });
    const loader = pluginLoader({} as never, {}, runtime);

    await expect(loader.shutdownAll()).rejects.toThrow(stopFailure);
    expect(runtime.jobScheduler.stop).toHaveBeenCalledOnce();
    expect(runtime.disposeAllHostServices).toHaveBeenCalledOnce();
  });
});
