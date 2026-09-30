export type HealthScope = "company" | "instance";
export type HealthSeverity = "info" | "warning" | "error";
export type HealthStatus = "healthy" | "needs_attention" | "critical";

export type HealthCategory =
  | "setup"
  | "auth"
  | "database"
  | "storage"
  | "budget"
  | "adapter"
  | "openclaw"
  | "integration"
  | "runtime"
  | "security"
  | "control_plane";

export interface HealthFindingAction {
  label: string;
  href?: string;
  command?: string;
}

export interface HealthFinding {
  id: string;
  scope: HealthScope;
  category: HealthCategory;
  severity: HealthSeverity;
  title: string;
  message: string;
  fixHint?: string;
  action?: HealthFindingAction;
  docsHref?: string;
  source?: "server" | "cli" | "adapter" | "runtime";
  checkCode?: string;
  detectedAt: string;
}

export interface HealthReportSummary {
  errorCount: number;
  warningCount: number;
  infoCount: number;
  checkedAt: string;
}

export interface HealthReport {
  scope: HealthScope;
  companyId?: string;
  status: HealthStatus;
  summary: HealthReportSummary;
  findings: HealthFinding[];
  sections?: {
    liveOperations?: unknown;
    adapters?: unknown;
    openclaw?: unknown;
    integrations?: unknown;
    platform?: unknown;
  };
}
