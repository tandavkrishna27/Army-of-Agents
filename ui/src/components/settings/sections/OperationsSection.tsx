import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ListChecks, RefreshCw } from "lucide-react";
import type {
  AttemptSummary,
  EventSummary,
  JobSummary,
  LeaseSummary,
  WorkerSummary,
} from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";
import { jobControlApi } from "@/api/job-control";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Fixed operator reasons — the mutations require a bounded reason and this settings
// surface does not collect free text (the audit trail records the operator + action).
const CANCEL_REASON = "Operator-initiated cancel";
const DRAIN_REASON = "Operator-initiated drain";
const REVOKE_REASON = "Operator-initiated worker revoke";

type StatusKind = "job" | "attempt" | "lease" | "worker";

const JOB_LABELS: Record<string, string> = {
  queued: "Queued", running: "Running", cancel_requested: "Canceling",
  succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled", dead_letter: "Dead letter",
};
const ATTEMPT_LABELS: Record<string, string> = {
  pending: "Pending", offered: "Offered", leased: "Leased", running: "Running",
  cancel_requested: "Canceling", succeeded: "Succeeded", failed: "Failed",
  cancelled: "Cancelled", expired: "Stale",
};
const LEASE_LABELS: Record<string, string> = {
  offered: "Offered", active: "Leased", released: "Released", expired: "Stale", revoked: "Revoked",
};
const WORKER_LABELS: Record<string, string> = {
  enrolled: "Enrolled", active: "Active", draining: "Draining", revoked: "Revoked",
};

function statusLabel(kind: StatusKind, status: string): string {
  const map = kind === "job" ? JOB_LABELS
    : kind === "attempt" ? ATTEMPT_LABELS
    : kind === "lease" ? LEASE_LABELS
    : WORKER_LABELS;
  return map[status] ?? status;
}

function toneClass(label: string): string {
  switch (label) {
    case "Canceling":
    case "Draining":
      return "border-amber-500/40 bg-amber-500/8 text-amber-200";
    case "Failed":
    case "Revoked":
    case "Stale":
    case "Dead letter":
      return "border-red-500/40 bg-red-500/8 text-red-200";
    case "Leased":
    case "Running":
    case "Active":
    case "Succeeded":
      return "border-emerald-500/35 bg-emerald-500/8 text-emerald-100";
    default:
      return "border-border bg-card text-muted-foreground";
  }
}

function StatusPill({ kind, status }: { kind: StatusKind; status: string }) {
  const label = statusLabel(kind, status);
  return (
    <span className={cn("rounded-sm border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]", toneClass(label))}>
      {label}
    </span>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Request failed";
}

function JobDetailPanel({ organizationId, companyId, jobId }: { organizationId: string; companyId: string; jobId: string }) {
  const detail = useQuery({
    queryKey: queryKeys.jobControl.job(organizationId, companyId, jobId),
    queryFn: () => jobControlApi.getJob(organizationId, companyId, jobId),
    enabled: true,
  });

  if (detail.isLoading) {
    return <div className="px-4 py-3 text-sm text-muted-foreground">Loading job detail…</div>;
  }
  if (detail.error) {
    return <div className="px-4 py-3 text-sm text-destructive">Failed to load job detail.</div>;
  }
  const data = detail.data;
  if (!data) return null;

  return (
    <div className="space-y-3 border-t border-border-soft bg-muted/20 px-4 py-3">
      <DetailGroup label="Attempts" empty={data.attempts.length === 0 ? "No attempts." : undefined}>
        {data.attempts.map((a: AttemptSummary) => (
          <div key={a.id} className="flex items-center gap-2 text-xs">
            <StatusPill kind="attempt" status={a.status} />
            <span className="text-muted-foreground">
              #{a.attemptNumber}
              {a.placementTargetClass ? ` · ${a.placementTargetClass}/${a.placementTargetScope ?? "?"}` : ""}
            </span>
          </div>
        ))}
      </DetailGroup>
      <DetailGroup label="Leases" empty={data.leases.length === 0 ? "No leases." : undefined}>
        {data.leases.map((l: LeaseSummary) => (
          <div key={l.id} className="flex items-center gap-2 text-xs">
            <StatusPill kind="lease" status={l.status} />
            <span className="text-muted-foreground">gen {l.targetGeneration ?? "—"}</span>
          </div>
        ))}
      </DetailGroup>
      <DetailGroup label="Events" empty={data.events.length === 0 ? "No events." : undefined}>
        {data.events.map((e: EventSummary) => (
          <div key={e.id} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">#{e.sequence}</span>
            <span>{e.eventType}</span>
          </div>
        ))}
      </DetailGroup>
    </div>
  );
}

function DetailGroup({ label, empty, children }: { label: string; empty?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">{label}</div>
      {empty ? <div className="text-xs text-muted-foreground">{empty}</div> : <div className="space-y-1">{children}</div>}
    </div>
  );
}

export function OperationsSection() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const organizationId = selectedCompany?.organizationId ?? null;
  const queryClient = useQueryClient();
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  const enabled = !!organizationId && !!selectedCompanyId;

  const jobsQuery = useQuery({
    queryKey: enabled
      ? queryKeys.jobControl.jobs(organizationId!, selectedCompanyId!)
      : ["job-control", "disabled", "jobs"],
    queryFn: () => jobControlApi.listJobs(organizationId!, selectedCompanyId!),
    enabled,
  });

  const workersQuery = useQuery({
    queryKey: enabled ? queryKeys.jobControl.workers(organizationId!) : ["job-control", "disabled", "workers"],
    queryFn: () => jobControlApi.listWorkers(organizationId!),
    enabled,
  });

  const invalidate = () => {
    if (!enabled) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.jobControl.jobs(organizationId!, selectedCompanyId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.jobControl.workers(organizationId!) });
  };

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => jobControlApi.cancelJob(organizationId!, selectedCompanyId!, jobId, CANCEL_REASON),
    onSuccess: invalidate,
  });
  const drainMutation = useMutation({
    mutationFn: (jobId: string) => jobControlApi.drainJob(organizationId!, selectedCompanyId!, jobId, DRAIN_REASON),
    onSuccess: invalidate,
  });
  const revokeMutation = useMutation({
    mutationFn: (workerId: string) => jobControlApi.revokeWorker(organizationId!, workerId, REVOKE_REASON),
    onSuccess: invalidate,
  });

  const actionError = cancelMutation.error ?? drainMutation.error ?? revokeMutation.error;

  // Firing one action first clears any stale error from the other two, so the single error
  // banner never keeps showing a prior failed action's message after a different action runs.
  const runCancel = (jobId: string) => {
    drainMutation.reset();
    revokeMutation.reset();
    cancelMutation.mutate(jobId);
  };
  const runDrain = (jobId: string) => {
    cancelMutation.reset();
    revokeMutation.reset();
    drainMutation.mutate(jobId);
  };
  const runRevoke = (workerId: string) => {
    cancelMutation.reset();
    drainMutation.reset();
    revokeMutation.mutate(workerId);
  };

  const refetchAll = () => {
    // invalidate() prefix-matches the jobs key, so Refresh refetches the jobs list, the
    // workers list, AND any open JobDetailPanel (whose key is prefixed by the jobs key) —
    // pulling the full visible state, not just the two lists.
    invalidate();
  };

  if (!enabled) {
    return (
      <div className="p-8">
        <div className="text-sm text-muted-foreground">Select a company to view job operations.</div>
      </div>
    );
  }

  const jobs = jobsQuery.data ?? [];
  const workers = workersQuery.data ?? [];
  const isFetching = jobsQuery.isFetching || workersQuery.isFetching;

  return (
    <div className="mx-auto w-full max-w-[1080px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
            Settings · Operations
          </div>
          <h2 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ListChecks className="size-5 text-brand" />
            Job control<span className="text-brand">.</span>
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Inspect durable job, attempt, lease, and worker status, and invoke cancel, drain, and revoke.
            Live catch-up is unavailable until realtime ships — use Refresh to pull the latest state.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refetchAll} disabled={isFetching}>
          <RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
          {isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {actionError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {errorMessage(actionError)}
        </div>
      )}

      {/* ── Jobs ── */}
      <section className="space-y-3">
        <h3 className="text-base font-semibold">Jobs</h3>
        {jobsQuery.isLoading ? (
          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">Loading jobs…</div>
        ) : jobsQuery.error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            Failed to load jobs.
          </div>
        ) : jobs.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">No jobs.</div>
        ) : (
          <div className="divide-y divide-border-soft rounded-lg border border-border bg-card">
            {jobs.map((job: JobSummary) => {
              const open = expandedJobId === job.id;
              return (
                <div key={job.id}>
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setExpandedJobId(open ? null : job.id)}
                        aria-label={open ? "Hide details" : "Show details"}
                        className="flex items-center gap-1 text-sm font-medium text-foreground/80 hover:text-foreground"
                      >
                        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        Details
                      </button>
                      <StatusPill kind="job" status={job.status} />
                      <span className="truncate font-mono text-xs text-muted-foreground">{shortId(job.id)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => runCancel(job.id)}
                        disabled={cancelMutation.isPending}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => runDrain(job.id)}
                        disabled={drainMutation.isPending}
                      >
                        Drain
                      </Button>
                    </div>
                  </div>
                  {open && (
                    <JobDetailPanel
                      organizationId={organizationId!}
                      companyId={selectedCompanyId!}
                      jobId={job.id}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Workers ── */}
      <section className="space-y-3">
        <h3 className="text-base font-semibold">Workers</h3>
        {workersQuery.isLoading ? (
          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">Loading workers…</div>
        ) : workersQuery.error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            Failed to load workers.
          </div>
        ) : workers.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">No workers.</div>
        ) : (
          <div className="divide-y divide-border-soft rounded-lg border border-border bg-card">
            {workers.map((worker: WorkerSummary) => (
              <div key={worker.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <StatusPill kind="worker" status={worker.status} />
                  <span className="truncate text-sm font-medium">{worker.label}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{shortId(worker.id)}</span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => runRevoke(worker.id)}
                  disabled={revokeMutation.isPending || worker.status === "revoked"}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
