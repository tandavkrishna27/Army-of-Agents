// packages/adapter-manager/src/reaper-metrics.ts
//
// DEP-011 reaper Slice C — the AM-LOCAL metric counter (recon option c). ONE shared
// in-memory ref, created by the bin BEFORE `startServer` and passed into BOTH the new
// `/metrics` arm of `createProviderServer` AND the reaper loop (single event loop ⇒ no
// race). NO cross-package edit to worker-daemon's CLOSED `outcome` label set — this is
// the AM's own surface, so `reaped`/`skipped`/`unknown`/`failed` are all legal. The
// Prometheus scrape target is Slice-5 deploy wiring; `/metrics` renders zeros until then.

/** A cumulative-across-sweeps tally, disjoint over each snapshot scanned. */
export interface ReaperMetricsCounter {
  reaped: number;
  skipped: number;
  unknown: number;
  failed: number;
}

/** One sweep's tally (structural — matches `ReconcileReaperResult` without importing it). */
export interface ReaperSweepTally {
  readonly reaped: number;
  readonly skipped: number;
  readonly unknown: number;
  readonly failed: number;
}

export function createReaperMetrics(): ReaperMetricsCounter {
  return { reaped: 0, skipped: 0, unknown: 0, failed: 0 };
}

/** Fold one sweep's result into the shared counter (called on the single event loop). */
export function accumulateReaperMetrics(counter: ReaperMetricsCounter, tally: ReaperSweepTally): void {
  counter.reaped += tally.reaped;
  counter.skipped += tally.skipped;
  counter.unknown += tally.unknown;
  counter.failed += tally.failed;
}

/** Render the counter as Prometheus text (a single labelled counter). Renders zeros for a
 * freshly-created (unwired) counter. */
export function renderReaperMetrics(counter: ReaperMetricsCounter): string {
  return [
    "# HELP aoa_reaper_sandboxes_total Adapter-manager reaper sweep outcomes (cumulative).",
    "# TYPE aoa_reaper_sandboxes_total counter",
    `aoa_reaper_sandboxes_total{outcome="reaped"} ${counter.reaped}`,
    `aoa_reaper_sandboxes_total{outcome="skipped"} ${counter.skipped}`,
    `aoa_reaper_sandboxes_total{outcome="unknown"} ${counter.unknown}`,
    `aoa_reaper_sandboxes_total{outcome="failed"} ${counter.failed}`,
    "",
  ].join("\n");
}
