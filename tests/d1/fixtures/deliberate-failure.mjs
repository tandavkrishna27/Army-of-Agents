// -----------------------------------------------------------------------------
// DEP-004 — deliberate-failing fixture for the E6F-07 retained-evidence proof.
//
// The merge-train (d1-merge-train.yml) must, on ANY failure, retain the full
// distributed evidence bundle. To prove that the retention path actually fires
// (and is not a green no-op), this fixture models a run that fails ON PURPOSE and
// exposes the evidence the collector would have gathered from that failed run.
//
//   * `assertDeliberateFailure()` throws — this is what turns the merge-train red.
//   * `simulateFailedRunEvidence()` returns the four-section collector input the
//     evidence bundle is assembled from (as scripts/collect-d1-evidence.mjs would
//     gather from the live stack). It carries real content in every section so the
//     retained bundle is non-empty and complete.
//
// This module is intentionally pure (no Docker) so the retention CONTRACT is
// testable on any host; the LIVE bring-up that exercises the same path end to end
// is the Linux/CI d1-merge-train lane.
// -----------------------------------------------------------------------------

export const DELIBERATE_FAILURE_REASON =
  "deliberate-failure-fixture: E6F-07 retained-evidence proof (this failure is intentional)";

/**
 * The intentional failure the merge-train would hit. Throwing here is what makes
 * the `if: failure()` collect + upload-artifact steps run.
 */
export function assertDeliberateFailure() {
  throw new Error(DELIBERATE_FAILURE_REASON);
}

/**
 * The evidence a collector would gather from the deliberately-failed run —
 * one entry (at least) in each of the four required sections, so the assembled
 * bundle is complete AND non-empty (every section marked present:true).
 */
export function simulateFailedRunEvidence() {
  return {
    runId: "d1-merge-train-deliberate-failure",
    reason: DELIBERATE_FAILURE_REASON,
    generatedAt: "2026-01-01T00:00:00.000Z",
    logs: [
      { service: "control-plane", content: "control-plane up\nplacement race resolved (winner=worker-a)\n" },
      { service: "worker-a", content: "lease acquired job=fx-deliberate\nDELIBERATE FAILURE injected -> attempt failed\n" },
      { service: "fake-provider", content: "scripted fixture: deliberate-failure\nexecute -> non_retryable_failure\n" },
    ],
    events: [
      { seq: 1, type: "job.placed", jobId: "fx-deliberate", eventDigest: "1".repeat(64) },
      { seq: 2, type: "lease.acquired", jobId: "fx-deliberate", eventDigest: "2".repeat(64) },
      { seq: 3, type: "attempt.failed", jobId: "fx-deliberate", reason: "non_retryable_failure", eventDigest: "3".repeat(64) },
    ],
    dbState: {
      rowCounts: ["jobs=1", "leases=1", "attempts=1", "worker_events=3"],
      schemaDump: "-- pg_dump --schema-only excerpt: jobs, leases, attempts, worker_events --",
    },
    objectManifests: [
      { bucket: "aoa-artifacts", key: "runs/fx-deliberate/attempt-1/stderr.log", size: 128 },
      { bucket: "aoa-quarantine", key: "runs/fx-deliberate/late-output.bin", size: 64 },
    ],
  };
}
