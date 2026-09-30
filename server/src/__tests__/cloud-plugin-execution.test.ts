import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { warn, info } = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn,
    info,
  },
}));

import {
  assertCloudPluginExecutionAllowed,
  beginCloudPluginBootReconciliation,
  CLOUD_PLUGIN_BLOCK_MESSAGE,
  CloudPluginExecutionBlockedError,
  getCloudPluginBlockMetrics,
  isCloudPluginExecutionBlocked,
  PLUGIN_WORKER_PROCESS_ENV_VAR,
  projectCloudPluginPolicyState,
  recordCloudPluginBlock,
  recordCloudPluginBootReconciled,
  stripHostedPluginWorkerMarker,
} from "../services/cloud-plugin-execution.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

afterEach(() => setDeploymentMode("local_trusted"));

describe("cloud plugin execution observability", () => {
  beforeEach(() => {
    warn.mockClear();
    info.mockClear();
    beginCloudPluginBootReconciliation();
  });

  it("emits the bounded block event and source/reason counters without secrets", () => {
    const before = getCloudPluginBlockMetrics();
    recordCloudPluginBlock({
      pluginId: "plugin-a",
      companyId: "company-a",
      source: "marketplace",
      sink: "lifecycle",
    });

    const fields = warn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      service: "cloud-plugin-execution",
      event: "plugin.worker.cloud_blocked",
      pluginId: "plugin-a",
      companyId: "company-a",
      activationSource: "marketplace",
      reasonCode: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
    });
    expect(Object.keys(fields)).not.toContain("config");
    expect(Object.keys(fields)).not.toContain("secrets");

    const after = getCloudPluginBlockMetrics();
    expect(after.total).toBe(before.total + 1);
    expect(after.bySource.marketplace).toBe(before.bySource.marketplace + 1);
    expect(after.byReason.PLUGIN_WORKER_BLOCKED_IN_CLOUD).toBe(
      before.byReason.PLUGIN_WORKER_BLOCKED_IN_CLOUD + 1
    );
  });

  it("emits boot reconciliation count and current gauge", () => {
    recordCloudPluginBootReconciled({
      pluginId: "plugin-a",
      companyId: "company-a",
    });

    expect(info.mock.calls.at(-1)?.[0]).toMatchObject({
      service: "cloud-plugin-execution",
      event: "plugin.worker.cloud_boot_reconciled",
      reasonCode: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
      bootReconciledGauge: 1,
    });
  });

  it("keeps the canonical remediation guide published in the docs navigation", () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const guidePath = `${repoRoot}docs/guides/cloud-plugin-execution.md`;
    const docsConfigPath = `${repoRoot}docs/docs.json`;

    expect(existsSync(guidePath)).toBe(true);
    const docsConfig = JSON.parse(readFileSync(docsConfigPath, "utf8"));
    expect(JSON.stringify(docsConfig.navigation)).toContain("guides/cloud-plugin-execution");
  });

  it("FND-006: projects a live block for every non-uninstalled cloud row", () => {
    setDeploymentMode("cloud_auth");
    for (const status of ["installed", "disabled", "error", "upgrade_pending"]) {
      const plugin = {
        id: `plugin-${status}`,
        status,
        statusReasonCode: null,
        lastError: status === "error" ? "generic error" : null,
      };
      // Decision #103 amendment: cloud_auth executes no host-process plugin
      // worker, so isCloudPluginExecutionBlocked() is true and the read
      // projection rewrites every non-uninstalled row to the blocked state so a
      // stale `ready`/`installed` row can never appear runnable in the UI.
      const projected = projectCloudPluginPolicyState(plugin);
      expect(projected).not.toBe(plugin);
      expect(projected).toMatchObject({
        status: "error",
        statusReasonCode: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
        lastError: CLOUD_PLUGIN_BLOCK_MESSAGE,
      });
    }
    // Uninstalled rows are terminal and are left untouched.
    expect(
      projectCloudPluginPolicyState({
        id: "plugin-uninstalled",
        status: "uninstalled",
        statusReasonCode: null,
        lastError: null,
      }).status,
    ).toBe("uninstalled");
  });

  it("treats a persisted cloud block as recoverable after moving to self-hosted", () => {
    setDeploymentMode("authenticated");
    expect(
      projectCloudPluginPolicyState({
        status: "error",
        statusReasonCode: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
        lastError: CLOUD_PLUGIN_BLOCK_MESSAGE,
      }),
    ).toEqual({
      status: "error",
      statusReasonCode: null,
      lastError: null,
    });
  });

  it("preserves unrelated self-hosted error diagnostics", () => {
    setDeploymentMode("authenticated");
    const plugin = {
      status: "error",
      statusReasonCode: "PLUGIN_ACTIVATION_FAILED",
      lastError: "worker crashed",
    };
    expect(projectCloudPluginPolicyState(plugin)).toBe(plugin);
  });
});

describe("cloud plugin execution — Decision #103 amendment: fail closed on cloud_auth (FND-006)", () => {
  afterEach(() => setDeploymentMode("local_trusted"));

  it("BLOCKS plugin worker execution on cloud_auth (bare/legacy form)", () => {
    setDeploymentMode("cloud_auth");
    expect(isCloudPluginExecutionBlocked()).toBe(true);
  });

  it("assertCloudPluginExecutionAllowed throws on cloud for a host worker fork", () => {
    setDeploymentMode("cloud_auth");
    expect(() =>
      assertCloudPluginExecutionAllowed({
        pluginId: "p1",
        sink: "worker-fork",
        source: "direct",
      }),
    ).toThrow(CloudPluginExecutionBlockedError);
  });

  it("bare form: true ONLY on cloud_auth; false on local_trusted/authenticated (self-hosted unchanged)", () => {
    setDeploymentMode("local_trusted");
    expect(isCloudPluginExecutionBlocked()).toBe(false);
    setDeploymentMode("authenticated");
    expect(isCloudPluginExecutionBlocked()).toBe(false);
    setDeploymentMode("cloud_auth");
    expect(isCloudPluginExecutionBlocked()).toBe(true);
  });
});

describe("cloud plugin execution — six-sink parent gate (FND-006, fixes the U10-a allowlist)", () => {
  afterEach(() => {
    setDeploymentMode("local_trusted");
    delete process.env[PLUGIN_WORKER_PROCESS_ENV_VAR];
  });

  it("BLOCKS all six sinks on cloud_auth in the parent (worker-manager, worker-fork, lifecycle, loader, loader-import, ui-static)", () => {
    setDeploymentMode("cloud_auth");
    for (const sink of [
      "worker-manager",
      "worker-fork",
      "lifecycle",
      "loader",
      "loader-import",
      "ui-static",
    ] as const) {
      expect(isCloudPluginExecutionBlocked(sink)).toBe(true);
      expect(() =>
        assertCloudPluginExecutionAllowed({
          pluginId: "p1",
          sink,
          source: "direct",
        }),
      ).toThrow(CloudPluginExecutionBlockedError);
    }
  });

  it("the parent worker-child marker AOA_PLUGIN_WORKER_PROCESS=1 NEVER bypasses the cloud gate (any sink)", () => {
    setDeploymentMode("cloud_auth");
    process.env[PLUGIN_WORKER_PROCESS_ENV_VAR] = "1";
    for (const sink of [
      "worker-manager",
      "worker-fork",
      "lifecycle",
      "loader",
      "loader-import",
      "ui-static",
    ] as const) {
      expect(isCloudPluginExecutionBlocked(sink)).toBe(true);
    }
    // Bare form too.
    expect(isCloudPluginExecutionBlocked()).toBe(true);
  });

  it("stripHostedPluginWorkerMarker(): removes a spoofed marker from the hosted parent env; no-op off-cloud", () => {
    setDeploymentMode("cloud_auth");
    process.env[PLUGIN_WORKER_PROCESS_ENV_VAR] = "1";
    expect(stripHostedPluginWorkerMarker()).toBe(true);
    expect(process.env[PLUGIN_WORKER_PROCESS_ENV_VAR]).toBeUndefined();
    // Idempotent second call: nothing left to strip.
    expect(stripHostedPluginWorkerMarker()).toBe(false);

    // Off-cloud: never strips (the self-hosted worker child legitimately sets it).
    setDeploymentMode("local_trusted");
    process.env[PLUGIN_WORKER_PROCESS_ENV_VAR] = "1";
    expect(stripHostedPluginWorkerMarker()).toBe(false);
    expect(process.env[PLUGIN_WORKER_PROCESS_ENV_VAR]).toBe("1");
  });

  it("off-cloud (local_trusted): every sink + bare stays allowed (self-hosted positives preserved)", () => {
    setDeploymentMode("local_trusted");
    expect(isCloudPluginExecutionBlocked()).toBe(false);
    for (const sink of [
      "worker-fork",
      "worker-manager",
      "lifecycle",
      "loader",
      "loader-import",
      "ui-static",
    ] as const) {
      expect(isCloudPluginExecutionBlocked(sink)).toBe(false);
      expect(() =>
        assertCloudPluginExecutionAllowed({
          pluginId: "p1",
          sink,
          source: "direct",
        }),
      ).not.toThrow();
    }
  });
});
