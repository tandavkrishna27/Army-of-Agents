import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, HeartPulse, RefreshCw } from "lucide-react";
import type { HealthFinding, HealthReport } from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function statusLabel(report: HealthReport): string {
  if (report.status === "critical") return "Critical";
  if (report.status === "needs_attention") return "Needs attention";
  return "Healthy";
}

function statusClass(status: HealthReport["status"]): string {
  if (status === "critical") return "border-red-500/40 bg-red-500/8 text-red-200";
  if (status === "needs_attention") return "border-amber-500/40 bg-amber-500/8 text-amber-100";
  return "border-emerald-500/35 bg-emerald-500/8 text-emerald-100";
}

function severityClass(severity: HealthFinding["severity"]): string {
  if (severity === "error") return "border-red-500/35 bg-red-500/6";
  if (severity === "warning") return "border-amber-500/35 bg-amber-500/6";
  return "border-border bg-card";
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}

function FindingRow({ finding }: { finding: HealthFinding }) {
  return (
    <div className={cn("rounded-lg border px-3 py-3", severityClass(finding.severity))}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">{finding.title}</div>
          <p className="mt-1 text-sm text-muted-foreground">{finding.message}</p>
          {finding.fixHint && (
            <p className="mt-2 text-xs text-muted-foreground">{finding.fixHint}</p>
          )}
        </div>
        <span className="rounded-sm border border-border bg-background px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {finding.severity}
        </span>
      </div>
    </div>
  );
}

export function HealthSection() {
  const { selectedCompanyId } = useCompany();
  const query = useQuery({
    queryKey: selectedCompanyId ? queryKeys.companyHealth(selectedCompanyId) : ["health", "company", "none"],
    queryFn: () => healthApi.company(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const report = query.data;
  const actionable = useMemo(
    () => report?.findings.filter((finding) => finding.severity !== "info") ?? [],
    [report],
  );
  const infoFindings = useMemo(
    () => report?.findings.filter((finding) => finding.severity === "info") ?? [],
    [report],
  );

  const liveOperations = asRecord(report?.sections?.liveOperations);
  const adapters = asRecord(report?.sections?.adapters);
  const openclaw = asRecord(report?.sections?.openclaw);
  const integrations = asRecord(report?.sections?.integrations);

  if (!selectedCompanyId) {
    return (
      <div className="p-8">
        <div className="text-sm text-muted-foreground">Select a company to view health.</div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
            Settings · Operations
          </div>
          <h2 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <HeartPulse className="size-5 text-brand" />
            Health<span className="text-brand">.</span>
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Operational readiness for this company, including live runs, adapters, OpenClaw, and integrations.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={cn("size-4", query.isFetching && "animate-spin")} />
          {query.isFetching ? "Refreshing..." : "Refresh checks"}
        </Button>
      </div>

      {query.isLoading && (
        <div className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
          Loading health checks...
        </div>
      )}

      {query.error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive">
          Failed to load company health.
        </div>
      )}

      {report && (
        <>
          <section className={cn("rounded-lg border p-5", statusClass(report.status))}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-lg font-semibold">
                  {report.status === "healthy" ? <CheckCircle2 className="size-5" /> : <AlertTriangle className="size-5" />}
                  {statusLabel(report)}
                </div>
                <p className="mt-1 text-sm opacity-80">
                  Checked {formatCheckedAt(report.summary.checkedAt)}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Errors" value={report.summary.errorCount} />
                <Stat label="Warnings" value={report.summary.warningCount} />
                <Stat label="Info" value={report.summary.infoCount} />
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-base font-semibold">Needs attention</h3>
            {actionable.length === 0 ? (
              <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
                No blocking health issues. This company is ready to run agents.
              </div>
            ) : (
              actionable.map((finding) => <FindingRow key={finding.id} finding={finding} />)
            )}
          </section>

          <section className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold">Live operations</h3>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Stat label="Active runs" value={readNumber(liveOperations.activeRunCount)} />
                <Stat label="Recent failures" value={readNumber(liveOperations.recentFailureCount)} />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold">Adapter health</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                OpenClaw status: {String(adapters.openclawStatus ?? "not configured")}
              </p>
            </div>
            {Boolean(openclaw.checked) && (
              <div className="rounded-lg border border-border bg-card p-4">
                <h3 className="text-sm font-semibold">OpenClaw diagnostics</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Diagnostics recorded for {readNumber(adapters.openclawAgentsChecked)} OpenClaw agent(s).
                </p>
              </div>
            )}
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold">Integrations</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {Boolean(integrations.checked) ? "Integration checks ran." : "No integration warning is currently reported."}
              </p>
            </div>
          </section>

          {infoFindings.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-base font-semibold">Checked</h3>
              {infoFindings.map((finding) => <FindingRow key={finding.id} finding={finding} />)}
            </section>
          )}
        </>
      )}
    </div>
  );
}
