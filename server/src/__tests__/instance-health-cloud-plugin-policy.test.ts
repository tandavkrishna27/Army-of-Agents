import { afterEach, describe, expect, it } from "vitest";
import { buildInstanceHealthReport } from "../services/health/instance-health.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { CLOUD_PLUGIN_BLOCK_MESSAGE } from "../services/cloud-plugin-execution.js";

afterEach(() => setDeploymentMode("local_trusted"));

describe("instance health cloud plugin policy", () => {
  it("does not query or expose tenant plugin state to cloud operators", async () => {
    setDeploymentMode("cloud_auth");
    let queried = false;
    const db = { select: () => { queried = true; throw new Error("must not query"); } } as any;

    const report = await buildInstanceHealthReport(db, {
      deploymentMode: "cloud_auth",
      deploymentExposure: "network",
      authReady: true,
      companyDeletionEnabled: false,
    });

    expect(queried).toBe(false);
    expect(report.sections.platform.plugins).toEqual({ total: 0, ready: 0, notReady: 0, plugins: [] });
    expect(JSON.stringify(report)).not.toContain("plugin-1");
    expect(JSON.stringify(report)).not.toContain("company-1");
  });

  it("does not report a historical cloud block as active after moving to self-hosted", async () => {
    setDeploymentMode("authenticated");
    const rows = [
      {
        id: "plugin-1",
        companyId: "company-1",
        pluginKey: "acme.plugin",
        status: "error",
        statusReasonCode: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
        manifestJson: { displayName: "Acme Plugin" },
        lastError: CLOUD_PLUGIN_BLOCK_MESSAGE,
      },
    ];
    const db = {
      select: () => ({
        from: () => ({
          orderBy: () => ({ limit: async () => rows }),
        }),
      }),
    } as any;

    const report = await buildInstanceHealthReport(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "network",
      authReady: true,
      companyDeletionEnabled: false,
    });

    expect(report.sections.platform.plugins.plugins[0]).toMatchObject({
      id: "plugin-1",
      status: "error",
    });
    expect(report.sections.platform.plugins.plugins[0]?.lastError).toBeUndefined();
    expect(
      report.findings.find((finding) => finding.id === "instance-plugin-plugin-1")
        ?.message,
    ).toBe("Plugin is not ready.");
  });
});
