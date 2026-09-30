import type { Db } from "@armyofagents/db";
import { plugins } from "@armyofagents/db";
import { asc } from "drizzle-orm";
import type {
  DeploymentExposure,
  DeploymentMode,
  HealthFinding,
  HealthReport,
} from "@armyofagents/shared";
import { sanitizeHealthDiagnostic } from "./redaction.js";
import {
  buildHealthSummary,
  deriveHealthStatus,
  sortHealthFindings,
} from "./status.js";
import { projectCloudPluginPolicyState } from "../cloud-plugin-execution.js";

export interface InstanceHealthOptions {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  authReady: boolean;
  companyDeletionEnabled: boolean;
}

function canQuery(db: Db): boolean {
  return typeof (db as unknown as { select?: unknown }).select === "function";
}

export async function buildInstanceHealthReport(
  _db: Db,
  opts: InstanceHealthOptions
): Promise<HealthReport> {
  const checkedAt = new Date().toISOString();
  const findings: HealthFinding[] = [
    {
      id: "instance-deployment-context",
      scope: "instance",
      category: "setup",
      severity: "info",
      title: "Deployment context detected",
      message: `Mode ${opts.deploymentMode}, exposure ${opts.deploymentExposure}.`,
      source: "server",
      detectedAt: checkedAt,
    },
  ];

  if (!opts.authReady) {
    findings.push({
      id: "instance-auth-not-ready",
      scope: "instance",
      category: "auth",
      severity: "error",
      title: "Authentication is not ready",
      message: "Authentication configuration is incomplete for this instance.",
      fixHint: "Check BETTER_AUTH_SECRET and deployment auth settings.",
      source: "server",
      detectedAt: checkedAt,
    });
  }

  const pluginSection = {
    total: 0,
    ready: 0,
    notReady: 0,
    plugins: [] as Array<{
      id: string;
      pluginKey: string;
      displayName: string;
      companyId: string;
      status: string;
      lastError?: string;
    }>,
  };

  // Cloud instance health is host/operator-plane only. Tenant plugin health is
  // available from the company-scoped report after assertCompanyAccess.
  if (canQuery(_db) && opts.deploymentMode !== "cloud_auth") {
    try {
      const pluginRows = await _db
        .select({
          id: plugins.id,
          companyId: plugins.companyId,
          pluginKey: plugins.pluginKey,
          status: plugins.status,
          statusReasonCode: plugins.statusReasonCode,
          manifestJson: plugins.manifestJson,
          lastError: plugins.lastError,
        })
        .from(plugins)
        .orderBy(asc(plugins.pluginKey))
        .limit(100);

      const policyRows = pluginRows.map(projectCloudPluginPolicyState);
      pluginSection.total = policyRows.length;
      pluginSection.ready = policyRows.filter(
        (plugin) => plugin.status === "ready"
      ).length;
      pluginSection.notReady = pluginRows.length - pluginSection.ready;
      const detailedPlugins = policyRows.map((plugin) => ({
        id: plugin.id,
        companyId: plugin.companyId,
        pluginKey: plugin.pluginKey,
        displayName: plugin.manifestJson?.displayName ?? plugin.pluginKey,
        status: plugin.status,
        lastError: sanitizeHealthDiagnostic(plugin.lastError),
      }));
      pluginSection.plugins = detailedPlugins;

      for (const plugin of detailedPlugins.filter(
        (entry) => entry.status !== "ready"
      )) {
        findings.push({
          id: `instance-plugin-${plugin.id}`,
          scope: "instance",
          category: "runtime",
          severity: plugin.status === "error" ? "error" : "warning",
          title: `Plugin ${plugin.displayName} is ${plugin.status}`,
          message: plugin.lastError ?? "Plugin is not ready.",
          action: {
            label: "Review plugin diagnostics",
            href: "/instance/settings?tab=health",
          },
          source: "server",
          detectedAt: checkedAt,
        });
      }
    } catch (err) {
      findings.push({
        id: "instance-plugin-diagnostics-unavailable",
        scope: "instance",
        category: "runtime",
        severity: "warning",
        title: "Plugin diagnostics could not be loaded",
        message:
          err instanceof Error
            ? sanitizeHealthDiagnostic(err.message) ??
              "Plugin diagnostics failed."
            : "Plugin diagnostics failed.",
        source: "server",
        detectedAt: checkedAt,
      });
    }
  }

  const sorted = sortHealthFindings(findings);
  return {
    scope: "instance",
    status: deriveHealthStatus(sorted),
    summary: buildHealthSummary(sorted, checkedAt),
    findings: sorted,
    sections: {
      platform: {
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        authReady: opts.authReady,
        companyDeletionEnabled: opts.companyDeletionEnabled,
        plugins: pluginSection,
      },
    },
  };
}
