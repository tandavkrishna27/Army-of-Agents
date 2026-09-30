import { afterEach, describe, expect, it } from "vitest";
import {
  appendStderrExcerpt,
  createPluginWorkerHandle,
  createPluginWorkerManager,
  formatWorkerFailureMessage,
} from "../services/plugin-worker-manager.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { CloudPluginExecutionBlockedError } from "../services/cloud-plugin-execution.js";

const workerOptions = {
  entrypointPath: "does-not-exist.cjs",
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
  activationSource: "direct" as const,
} as any;

afterEach(() => setDeploymentMode("local_trusted"));

describe("plugin-worker-manager stderr failure context", () => {
  it("appends worker stderr context to failure messages", () => {
    expect(
      formatWorkerFailureMessage(
        "Worker process exited (code=1, signal=null)",
        'TypeError: Unknown file extension ".ts"'
      )
    ).toBe(
      'Worker process exited (code=1, signal=null)\n\nWorker stderr:\nTypeError: Unknown file extension ".ts"'
    );
  });

  it("does not duplicate stderr that is already present", () => {
    const message = [
      "Worker process exited (code=1, signal=null)",
      "",
      "Worker stderr:",
      'TypeError: Unknown file extension ".ts"',
    ].join("\n");

    expect(
      formatWorkerFailureMessage(
        message,
        'TypeError: Unknown file extension ".ts"'
      )
    ).toBe(message);
  });

  it("keeps only the latest stderr excerpt", () => {
    let excerpt = "";
    excerpt = appendStderrExcerpt(excerpt, "first line");
    excerpt = appendStderrExcerpt(excerpt, "second line");

    expect(excerpt).toContain("first line");
    expect(excerpt).toContain("second line");

    excerpt = appendStderrExcerpt(excerpt, "x".repeat(9_000));

    expect(excerpt).not.toContain("first line");
    expect(excerpt).not.toContain("second line");
    expect(excerpt.length).toBeLessThanOrEqual(8_000);
  });
});

describe("cloud plugin worker final sinks (FND-006: fail closed on cloud_auth)", () => {
  // Disable auto-restart so a denied start (or fork failure) doesn't schedule a
  // background backoff-restart timer that outlives the test.
  const noRestartOptions = { ...workerOptions, autoRestart: false };

  it("startWorker short-circuits with the cloud-block error BEFORE forking (worker-manager sink)", async () => {
    setDeploymentMode("cloud_auth");
    const manager = createPluginWorkerManager();

    // Decision #103 amendment / FND-006: the worker-manager sink fails closed on
    // cloud_auth, so startWorker rejects with the typed cloud-block sentinel
    // before any handle construction or fork attempt.
    await expect(
      manager.startWorker("plugin-a", noRestartOptions)
    ).rejects.toBeInstanceOf(CloudPluginExecutionBlockedError);
    // No executable worker state was left behind (denied before registration).
    expect(manager.getWorker("plugin-a")).toBeUndefined();
  });

  it("a direct handle rejects immediately with the cloud-block error before fork (worker-fork sink)", async () => {
    setDeploymentMode("cloud_auth");
    const handle = createPluginWorkerHandle("plugin-a", noRestartOptions);

    await expect(handle.start()).rejects.toBeInstanceOf(
      CloudPluginExecutionBlockedError
    );
    // The fork was never attempted — the worker-fork sink denied before it.
    expect(handle.status).not.toBe("crashed");
  });

  it("off cloud (local_trusted): the worker sinks do NOT short-circuit — the fork is attempted", async () => {
    setDeploymentMode("local_trusted");
    const manager = createPluginWorkerManager();

    // Self-hosted positive: startWorker proceeds to a real fork attempt, which
    // fails for an unrelated reason (this fixture's entrypoint does not exist),
    // never for the cloud-block sentinel.
    await expect(
      manager.startWorker("plugin-a", noRestartOptions)
    ).rejects.not.toBeInstanceOf(CloudPluginExecutionBlockedError);
    expect(manager.getWorker("plugin-a")?.status).toBe("crashed");
  });
});
