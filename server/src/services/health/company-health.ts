import type { Db } from "@armyofagents/db";
import { agents, heartbeatRuns } from "@armyofagents/db";
import { and, desc, eq, gte, inArray, not, sql } from "drizzle-orm";
import type {
  AdapterEnvironmentCheck,
  DeploymentExposure,
  DeploymentMode,
  HealthFinding,
  HealthReport,
} from "@armyofagents/shared";
import { findServerAdapter } from "../../adapters/index.js";
import { RECENT_FAILURE_WINDOW_MS, sanitizeHealthDiagnostic } from "./redaction.js";
import { buildHealthSummary, deriveHealthStatus, sortHealthFindings } from "./status.js";

export interface CompanyHealthOptions {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost?: string;
  allowedHostnames?: string[];
}

const LIVE_RUN_LIMIT = 20;
const RECENT_RUN_LIMIT = 20;
const OPENCLAW_AGENT_LIMIT = 3;
const STUCK_RUN_MS = 30 * 60 * 1000;

function canQuery(db: Db): boolean {
  return typeof (db as unknown as { select?: unknown }).select === "function";
}

function adapterSeverity(level: AdapterEnvironmentCheck["level"]): HealthFinding["severity"] {
  if (level === "error") return "error";
  if (level === "warn") return "warning";
  return "info";
}

export async function buildCompanyHealthReport(
  _db: Db,
  companyId: string,
  opts: CompanyHealthOptions,
): Promise<HealthReport> {
  const checkedAt = new Date().toISOString();
  const findings: HealthFinding[] = [
    {
      id: "company-health-ready",
      scope: "company",
      category: "setup",
      severity: "info",
      title: "Company health checks ran",
      message: "No blocking company setup issue was detected by the initial health checks.",
      source: "server",
      detectedAt: checkedAt,
    },
  ];
  const liveOperations = {
    activeRunCount: 0,
    recentFailureCount: 0,
    stuckRunCount: 0,
    activeRuns: [] as Array<{
      id: string;
      status: string;
      agentId: string;
      agentName: string;
      adapterType: string;
      issueId: string | null;
      createdAt: Date;
      lastOutputAt: Date | null;
    }>,
    recentFailures: [] as Array<{
      id: string;
      status: string;
      agentId: string;
      agentName: string;
      adapterType: string;
      issueId: string | null;
      createdAt: Date;
      error: string | null;
    }>,
  };
  const adaptersSection = {
    openclawAgentsChecked: 0,
    openclawStatus: "not_configured" as "not_configured" | "pass" | "warn" | "fail",
  };
  const openclawSection = {
    checked: false,
    diagnostics: [] as Array<{
      agentId: string;
      agentName: string;
      status: string;
      checks: AdapterEnvironmentCheck[];
    }>,
  };

  if (canQuery(_db)) {
    try {
      const activeRuns = await _db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          agentId: heartbeatRuns.agentId,
          agentName: agents.name,
          adapterType: agents.adapterType,
          issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
          createdAt: heartbeatRuns.createdAt,
          lastOutputAt: heartbeatRuns.lastOutputAt,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, ["queued", "running"]),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(LIVE_RUN_LIMIT);

      const recentFailureSince = new Date(Date.now() - RECENT_FAILURE_WINDOW_MS);
      const recentFailures = await _db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          agentId: heartbeatRuns.agentId,
          agentName: agents.name,
          adapterType: agents.adapterType,
          issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
          createdAt: heartbeatRuns.createdAt,
          error: heartbeatRuns.error,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, ["failed", "timed_out"]),
            gte(heartbeatRuns.createdAt, recentFailureSince),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(RECENT_RUN_LIMIT);

      liveOperations.activeRuns = activeRuns;
      liveOperations.activeRunCount = activeRuns.length;
      liveOperations.recentFailures = recentFailures.map((run) => ({
        ...run,
        error: sanitizeHealthDiagnostic(run.error) ?? null,
      }));
      liveOperations.recentFailureCount = recentFailures.length;

      const stuckBefore = Date.now() - STUCK_RUN_MS;
      liveOperations.stuckRunCount = activeRuns.filter((run) => {
        if (run.status !== "running") return false;
        const lastOutput = run.lastOutputAt?.getTime() ?? run.createdAt.getTime();
        return lastOutput < stuckBefore;
      }).length;

      if (liveOperations.activeRunCount > 0) {
        findings.push({
          id: "company-live-runs-active",
          scope: "company",
          category: "runtime",
          severity: "info",
          title: "Agents are currently running",
          message: `${liveOperations.activeRunCount} run${liveOperations.activeRunCount === 1 ? " is" : "s are"} active.`,
          action: { label: "Open live operations", href: "/active-agents" },
          source: "server",
          detectedAt: checkedAt,
        });
      }

      if (liveOperations.recentFailureCount > 0) {
        findings.push({
          id: "company-recent-runs-failed",
          scope: "company",
          category: "runtime",
          severity: "warning",
          title: "Recent agent runs failed",
          message: `${liveOperations.recentFailureCount} recent run${liveOperations.recentFailureCount === 1 ? " has" : "s have"} failed or timed out.`,
          action: { label: "Open live operations", href: "/active-agents" },
          source: "server",
          detectedAt: checkedAt,
        });
      }

      if (liveOperations.stuckRunCount > 0) {
        findings.push({
          id: "company-runs-stuck",
          scope: "company",
          category: "runtime",
          severity: "warning",
          title: "Some running agents look quiet",
          message: `${liveOperations.stuckRunCount} running run${liveOperations.stuckRunCount === 1 ? " has" : "s have"} had no output for more than 30 minutes.`,
          action: { label: "Open live operations", href: "/active-agents" },
          source: "server",
          detectedAt: checkedAt,
        });
      }
    } catch (err) {
      findings.push({
        id: "company-live-operations-unavailable",
        scope: "company",
        category: "runtime",
        severity: "warning",
        title: "Live operations could not be loaded",
        message: err instanceof Error ? sanitizeHealthDiagnostic(err.message) ?? "Live operations check failed." : "Live operations check failed.",
        source: "server",
        detectedAt: checkedAt,
      });
    }

    try {
      const openclawAgents = await _db
        .select({
          id: agents.id,
          name: agents.name,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.adapterType, "openclaw"),
            not(inArray(agents.status, ["archived", "terminated"])),
          ),
        )
        .orderBy(desc(agents.updatedAt))
        .limit(OPENCLAW_AGENT_LIMIT);

      adaptersSection.openclawAgentsChecked = openclawAgents.length;
      if (openclawAgents.length > 0) openclawSection.checked = true;

      const openclawAdapter = findServerAdapter("openclaw");
      if (openclawAdapter?.testEnvironment) {
        for (const agent of openclawAgents) {
          const result = await openclawAdapter.testEnvironment({
            companyId,
            adapterType: "openclaw",
            config: agent.adapterConfig,
            deployment: {
              mode: opts.deploymentMode,
              exposure: opts.deploymentExposure,
              bindHost: opts.bindHost,
              allowedHostnames: opts.allowedHostnames ?? [],
            },
          });
          openclawSection.diagnostics.push({
            agentId: agent.id,
            agentName: agent.name,
            status: result.status,
            checks: result.checks.map((check) => ({
              ...check,
              message: sanitizeHealthDiagnostic(check.message) ?? "",
              hint: sanitizeHealthDiagnostic(check.hint),
            })),
          });
          for (const check of result.checks) {
            findings.push({
              id: `openclaw-${agent.id}-${check.code}`,
              scope: "company",
              category: "openclaw",
              severity: adapterSeverity(check.level),
              title: check.code.replace(/_/g, " "),
              message: sanitizeHealthDiagnostic(check.message) ?? "",
              fixHint: sanitizeHealthDiagnostic(check.hint),
              docsHref: "/docs/start/openclaw-integration",
              source: "adapter",
              checkCode: check.code,
              detectedAt: checkedAt,
            });
          }
        }
      }

      if (openclawSection.diagnostics.some((entry) => entry.status === "fail")) {
        adaptersSection.openclawStatus = "fail";
      } else if (openclawSection.diagnostics.some((entry) => entry.status === "warn")) {
        adaptersSection.openclawStatus = "warn";
      } else if (openclawSection.diagnostics.length > 0) {
        adaptersSection.openclawStatus = "pass";
      }
    } catch (err) {
      findings.push({
        id: "company-openclaw-diagnostics-unavailable",
        scope: "company",
        category: "openclaw",
        severity: "warning",
        title: "OpenClaw diagnostics could not be loaded",
        message: err instanceof Error ? sanitizeHealthDiagnostic(err.message) ?? "OpenClaw diagnostics failed." : "OpenClaw diagnostics failed.",
        source: "server",
        detectedAt: checkedAt,
      });
    }
  }

  const sorted = sortHealthFindings(findings);
  return {
    scope: "company",
    companyId,
    status: deriveHealthStatus(sorted),
    summary: buildHealthSummary(sorted, checkedAt),
    findings: sorted,
    sections: {
      liveOperations,
      adapters: adaptersSection,
      openclaw: openclawSection,
      integrations: { checked: false },
    },
  };
}
