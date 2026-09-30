/**
 * FND-006 — hosted plugin PROCESS-composition denial proof (Decision #103
 * cloud-enforcement amendment).
 *
 * WHAT BINDS, and WHERE:
 *   - The strongest, most portable enforcement of the composition boundary is
 *     the dependency-free source-boundary checker
 *     (`scripts/check-distributed-execution-foundation.mjs` — `app.ts` plugin
 *     construction is guarded by `hostedPluginProcessDisabled`; no cloud sink
 *     allowlist; no parent-marker bypass in the gate). That runs in the `policy`
 *     CI job on every platform.
 *   - The runtime negatives below use the REAL production worker manager and a
 *     `node:child_process` `fork` sentinel to prove that on `cloud_auth` the
 *     hosted parent constructs/forks/starts ZERO plugin worker (worker-manager
 *     and worker-fork sinks fail closed BEFORE any child process is created),
 *     while off cloud a real fork is attempted (self-hosted positive). These
 *     need no database, so they run and bind on every platform.
 *
 * REAL-`createApp()` STARTUP: a runtime proof that `createApp()` composes no
 * plugin subsystem in `cloud_auth` cannot be written here — importing the real
 * app (or `plugin-lifecycle.js`) under vitest triggers the drizzle-orm
 * `require(esm)` cycle on EVERY lane, unit and integration alike (finding
 * E0-F005). The final `describe` documents that constraint honestly rather than
 * faking a skipped proof; the checker + the runtime negatives above are the
 * binding evidence.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Sentinel over the actual process fork. The mock delegates to the real
// implementation so the off-cloud path attempts (and naturally fails) a real
// fork, while `forkSpy` counts every attempt. Installed BEFORE the worker
// manager is imported so its `fork` binding is the counted one.
const { forkSpy } = vi.hoisted(() => ({ forkSpy: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (...args: Parameters<typeof actual.fork>) => {
      forkSpy(...args);
      return actual.fork(...args);
    },
  };
});

import {
  createPluginWorkerManager,
  createPluginWorkerHandle,
} from "../services/plugin-worker-manager.js";
import {
  assertCloudPluginExecutionAllowed,
  CloudPluginExecutionBlockedError,
  isCloudPluginExecutionBlocked,
  PLUGIN_WORKER_PROCESS_ENV_VAR,
  stripHostedPluginWorkerMarker,
} from "../services/cloud-plugin-execution.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

const workerOptions = {
  entrypointPath: "cloud-composition-does-not-exist.cjs",
  manifest: {
    id: "test.plugin",
    apiVersion: 1,
    entrypoints: { worker: "index.js" },
  },
  config: {},
  instanceInfo: { instanceId: "test", hostVersion: "test" },
  apiVersion: 1,
  hostHandlers: {},
  companyId: "company-a",
  activationSource: "boot" as const,
  autoRestart: false,
} as any;

const ALL_SINKS = [
  "worker-manager",
  "worker-fork",
  "lifecycle",
  "loader",
  "loader-import",
  "ui-static",
] as const;

afterEach(() => {
  setDeploymentMode("local_trusted");
  delete process.env[PLUGIN_WORKER_PROCESS_ENV_VAR];
});

describe("FND-006 process composition — the hosted parent forks/starts ZERO plugin worker on cloud_auth", () => {
  beforeEach(() => forkSpy.mockClear());

  it("every sink (and the bare form) fails closed on cloud_auth", () => {
    setDeploymentMode("cloud_auth");
    expect(isCloudPluginExecutionBlocked()).toBe(true);
    for (const sink of ALL_SINKS) {
      expect(isCloudPluginExecutionBlocked(sink)).toBe(true);
      expect(() =>
        assertCloudPluginExecutionAllowed({ pluginId: "p1", sink, source: "boot" }),
      ).toThrow(CloudPluginExecutionBlockedError);
    }
  });

  it("the REAL worker manager denies startWorker before any fork (zero child process) on cloud_auth", async () => {
    setDeploymentMode("cloud_auth");
    const manager = createPluginWorkerManager();

    await expect(
      manager.startWorker("p1", workerOptions),
    ).rejects.toBeInstanceOf(CloudPluginExecutionBlockedError);

    // No fork was attempted and no executable worker state was registered.
    expect(forkSpy).not.toHaveBeenCalled();
    expect(manager.getWorker("p1")).toBeUndefined();
  });

  it("a direct worker handle denies before fork (worker-fork sink) on cloud_auth", async () => {
    setDeploymentMode("cloud_auth");
    const handle = createPluginWorkerHandle("p1", workerOptions);

    await expect(handle.start()).rejects.toBeInstanceOf(
      CloudPluginExecutionBlockedError,
    );
    expect(forkSpy).not.toHaveBeenCalled();
    expect(handle.status).not.toBe("crashed");
  });

  it("the parent worker-child marker AOA_PLUGIN_WORKER_PROCESS=1 does NOT unblock the fork on cloud_auth", async () => {
    setDeploymentMode("cloud_auth");
    process.env[PLUGIN_WORKER_PROCESS_ENV_VAR] = "1";
    const manager = createPluginWorkerManager();

    await expect(
      manager.startWorker("p1", workerOptions),
    ).rejects.toBeInstanceOf(CloudPluginExecutionBlockedError);
    expect(forkSpy).not.toHaveBeenCalled();
  });

  it("stripHostedPluginWorkerMarker() removes a spoofed marker from the hosted parent (cloud only)", () => {
    setDeploymentMode("cloud_auth");
    process.env[PLUGIN_WORKER_PROCESS_ENV_VAR] = "1";
    expect(stripHostedPluginWorkerMarker()).toBe(true);
    expect(process.env[PLUGIN_WORKER_PROCESS_ENV_VAR]).toBeUndefined();
  });

  it("self-hosted positive (local_trusted): the worker path is live — a real fork IS attempted", async () => {
    setDeploymentMode("local_trusted");
    const manager = createPluginWorkerManager();

    // Fork is attempted against a non-existent entrypoint, so the worker
    // crashes for an unrelated reason — never the cloud-block sentinel.
    await expect(
      manager.startWorker("p1", workerOptions),
    ).rejects.not.toBeInstanceOf(CloudPluginExecutionBlockedError);
    expect(forkSpy).toHaveBeenCalled();
    expect(manager.getWorker("p1")?.status).toBe("crashed");
  });
});

describe("FND-006 real-createApp() composition — import-constraint (E0-F005)", () => {
  let appModule: typeof import("../app.js") | null = null;
  let importError: unknown = null;

  beforeAll(async () => {
    try {
      appModule = await import("../app.js");
    } catch (err) {
      importError = err;
      appModule = null;
    }
  });

  it("documents that the real app is not importable under vitest (drizzle require(esm) cycle)", () => {
    // The binding composition-boundary proof is the source-boundary checker
    // (app.ts construction guarded by `hostedPluginProcessDisabled`) plus the
    // runtime worker-manager negatives above. A runtime real-`createApp()`
    // startup proof is blocked by the drizzle-orm require(esm) cycle on every
    // vitest lane (E0-F005). If a future toolchain fixes the cycle, assert the
    // entry point at least exists so this test upgrades to a real proof site.
    if (appModule) {
      expect(typeof appModule.createApp).toBe("function");
    } else {
      expect(String((importError as Error)?.message ?? "")).toMatch(
        /require\(\) ES Module|cycle/i,
      );
    }
  });
});
