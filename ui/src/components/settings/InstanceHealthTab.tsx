import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, HeartPulse, RefreshCw } from "lucide-react";
import type { HealthFinding, HealthReport } from "@armyofagents/shared";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
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

export function InstanceHealthTab() {
  const query = useQuery({
    queryKey: queryKeys.instanceHealth,
    queryFn: () => healthApi.instance(),
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
  const platform = asRecord(report?.sections?.platform);
  const deployment = asRecord(platform.deployment);
  const pluginDiagnostics = asRecord(platform.plugins);
  const plugins = asArray(pluginDiagnostics.plugins);
  const deploymentMode = platform.deploymentMode ?? deployment.mode ?? "unknown";
  const deploymentExposure = platform.deploymentExposure ?? deployment.exposure ?? "unknown";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <HeartPulse className="size-4 text-brand" />
            Health
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Instance-wide readiness for setup, authentication, runtime safety, and plugin workers.
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
          Failed to load instance health.
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
                No blocking instance health issues.
              </div>
            ) : (
              actionable.map((finding) => <FindingRow key={finding.id} finding={finding} />)
            )}
          </section>

          <section className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold">Platform</h3>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Stat label="Mode" value={String(deploymentMode)} />
                <Stat label="Exposure" value={String(deploymentExposure)} />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold">Plugin workers</h3>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Stat label="Ready" value={String(pluginDiagnostics.ready ?? 0)} />
                <Stat label="Needs attention" value={String(pluginDiagnostics.notReady ?? 0)} />
              </div>
            </div>
          </section>

          {plugins.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-base font-semibold">Plugin diagnostics</h3>
              {plugins.map((plugin) => (
                <div
                  key={String(plugin.id)}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                >
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      plugin.status === "ready" ? "bg-emerald-400" : "bg-red-400",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {String(plugin.displayName ?? plugin.pluginKey ?? plugin.id)}
                  </span>
                  <span className="rounded-sm border border-border bg-background px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {String(plugin.status ?? "unknown")}
                  </span>
                  {Boolean(plugin.lastError) && (
                    <span className="max-w-[240px] truncate text-xs text-destructive">
                      {String(plugin.lastError)}
                    </span>
                  )}
                </div>
              ))}
            </section>
          )}

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
