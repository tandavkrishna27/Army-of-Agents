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

describe("cloud plugin worker final sinks (U10: host-resident worker — no cloud block)", () => {
  // Disable auto-restart so a fork failure (this fixture's entrypoint does
  // not exist on disk) doesn't schedule a background backoff-restart timer
  // that outlives the test.
  const noRestartOptions = { ...workerOptions, autoRestart: false };

  it("does not short-circuit with the cloud-block error before attempting to fork", async () => {
    setDeploymentMode("cloud_auth");
    const manager = createPluginWorkerManager();

    // assertCloudPluginExecutionAllowed no longer throws on cloud_auth, so
    // startWorker proceeds to the real fork attempt — which fails for an
    // unrelated reason (this fixture's entrypoint doesn't exist), never for
    // the cloud-block sentinel.
    await expect(
      manager.startWorker("plugin-a", noRestartOptions)
    ).rejects.not.toBeInstanceOf(CloudPluginExecutionBlockedError);
    expect(manager.getWorker("plugin-a")?.status).toBe("crashed");
  });

  it("a direct handle no longer rejects immediately with the cloud-block error before fork", async () => {
    setDeploymentMode("cloud_auth");
    const handle = createPluginWorkerHandle("plugin-a", noRestartOptions);

    await expect(handle.start()).rejects.not.toBeInstanceOf(
      CloudPluginExecutionBlockedError
    );
    // The fork was actually attempted (and crashed for an unrelated reason),
    // proving the cloud block no longer short-circuits before fork.
    expect(handle.status).toBe("crashed");
  });
});
