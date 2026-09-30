import type { HealthFinding, HealthReportSummary, HealthStatus } from "@armyofagents/shared";

const SEVERITY_RANK: Record<HealthFinding["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function deriveHealthStatus(findings: HealthFinding[]): HealthStatus {
  if (findings.some((finding) => finding.severity === "error")) return "critical";
  if (findings.some((finding) => finding.severity === "warning")) return "needs_attention";
  return "healthy";
}

export function buildHealthSummary(findings: HealthFinding[], checkedAt: string): HealthReportSummary {
  return {
    errorCount: findings.filter((finding) => finding.severity === "error").length,
    warningCount: findings.filter((finding) => finding.severity === "warning").length,
    infoCount: findings.filter((finding) => finding.severity === "info").length,
    checkedAt,
  };
}

export function sortHealthFindings(findings: HealthFinding[]): HealthFinding[] {
  return [...findings].sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;
    const action = Number(Boolean(b.action)) - Number(Boolean(a.action));
    if (action !== 0) return action;
    return a.id.localeCompare(b.id);
  });
}
