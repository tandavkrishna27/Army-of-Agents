/**
 * DEP-003 (E6 deployment harness): the PURE, deterministic, FAIL-CLOSED transition
 * function for the first populated single-tenant -> `cloud_auth` migration-0188
 * cutover preflight. It performs NO I/O: the orchestrator
 * (`cutover-0188-preflight.ts`) drives the six real steps with injected ports and
 * feeds their results here; this module decides `proceed`/`stop` + whether a
 * durable, VERIFIED marker was established.
 *
 * FAIL-CLOSED contract (verbatim): a missing opt-in, a candidate-SHA that does not
 * exactly equal the image's recorded revision, or a snapshot / checksum /
 * restore-validation / marker-write / marker-verify failure ALL yield
 * `{action:"stop", markerWritten:false}`. The durable marker is written ONLY after
 * opt-in + exact SHA match AND snapshot AND checksum AND restore-validation all
 * pass; the verify step is a read-back AFTER the write. `markerWritten` is true only
 * on the full happy path (`cutover_ready`) — it means "THIS evaluation established a
 * durable, verified marker", so even a first-run marker-verify failure reports
 * `markerWritten:false` (no VERIFIED marker was established; deployment must stop).
 *
 * Idempotent repeat: when the orchestrator finds a present, verified marker for the
 * same candidate SHA it re-runs neither the snapshot nor the restore — it passes
 * `markerWriteResult:"already_present"`, and this function short-circuits to a no-op
 * success (`proceed`, `markerWritten:false`, `idempotent_marker_present`) once
 * opt-in + SHA still hold.
 */

/** The outcome of one orchestrator step. `not_run` = the orchestrator never reached it. */
export type PreflightStepOutcome = "ok" | "failed" | "not_run";

/**
 * The marker-write step outcome. `already_present` is the idempotent-repeat signal
 * the orchestrator sets when a verified marker for this candidate SHA already exists
 * (so the snapshot/checksum/restore steps are legitimately skipped this pass).
 */
export type MarkerWriteOutcome = "written" | "already_present" | "failed" | "not_run";

export interface Cutover0188PreflightStateInput {
  /** Explicit operator opt-in (`AOA_0188_CUTOVER_OPT_IN=1`). */
  optIn: boolean;
  /** The operator-supplied candidate revision (`AOA_0188_CANDIDATE_SHA`). */
  candidateSha: string | null;
  /** The image's recorded source revision. Must EXACTLY equal `candidateSha`. */
  imageSha: string | null;
  snapshotResult: PreflightStepOutcome;
  checksumResult: PreflightStepOutcome;
  restoreValidationResult: PreflightStepOutcome;
  markerWriteResult: MarkerWriteOutcome;
  markerVerifyResult: PreflightStepOutcome;
}

export type Cutover0188PreflightReason =
  | "missing_opt_in"
  | "candidate_sha_mismatch"
  | "snapshot_failed"
  | "checksum_failed"
  | "restore_validation_failed"
  | "marker_write_failed"
  | "marker_verify_failed"
  | "idempotent_marker_present"
  | "cutover_ready";

export interface Cutover0188PreflightDecision {
  action: "proceed" | "stop";
  /** Whether THIS evaluation established a durable, verified marker (happy path only). */
  markerWritten: boolean;
  reason: Cutover0188PreflightReason;
}

const STOP = (reason: Cutover0188PreflightReason): Cutover0188PreflightDecision => ({
  action: "stop",
  markerWritten: false,
  reason,
});

/**
 * The single, side-effect-free transition. Deterministic: the same input always
 * yields the same decision, and every non-happy path fails closed.
 */
export function evaluateCutover0188Preflight(
  input: Cutover0188PreflightStateInput,
): Cutover0188PreflightDecision {
  // 1. Explicit operator intent. Missing opt-in -> STOP, no marker.
  if (!input.optIn) return STOP("missing_opt_in");

  // 2. Exact candidate-SHA match against the image's recorded revision. Any
  //    missing side or mismatch -> STOP, no marker. Empty strings are treated as
  //    missing so a blank env value can never satisfy the gate.
  const candidateSha = input.candidateSha?.trim() ?? "";
  const imageSha = input.imageSha?.trim() ?? "";
  if (candidateSha === "" || imageSha === "" || candidateSha !== imageSha) {
    return STOP("candidate_sha_mismatch");
  }

  // 3. Idempotent repeat: a present, verified marker for this candidate SHA is a
  //    no-op success (the orchestrator skipped snapshot/checksum/restore). A
  //    pre-existing marker that fails read-back verification still fails closed.
  if (input.markerWriteResult === "already_present") {
    return input.markerVerifyResult === "ok"
      ? { action: "proceed", markerWritten: false, reason: "idempotent_marker_present" }
      : STOP("marker_verify_failed");
  }

  // 4. First run — snapshot BEFORE the marker, then checksum, then restore-validate.
  if (input.snapshotResult !== "ok") return STOP("snapshot_failed");
  if (input.checksumResult !== "ok") return STOP("checksum_failed");
  if (input.restoreValidationResult !== "ok") return STOP("restore_validation_failed");

  // 5. The marker is written ONLY now (all gates passed).
  if (input.markerWriteResult !== "written") return STOP("marker_write_failed");

  // 6. Verify the marker by read-back. A verify failure stops deployment even though
  //    a row may physically exist — no VERIFIED marker was established.
  if (input.markerVerifyResult !== "ok") return STOP("marker_verify_failed");

  return { action: "proceed", markerWritten: true, reason: "cutover_ready" };
}

export interface StartupCutoverGateInput {
  /** Whether application startup READ a marker row for the running candidate SHA. */
  markerPresent: boolean;
}

export interface StartupCutoverGateDecision {
  cutoverAuthorized: boolean;
  reason: "marker_present" | "marker_absent";
}

/**
 * The application-startup cutover gate. Startup READS the marker and decides whether
 * a populated cutover is authorized; it can NEVER write or synthesize the marker.
 * Absence -> refuse cutover, stay single-tenant. This module is pure read->decision
 * logic and exports NO marker writer by construction.
 */
export function evaluateStartupCutoverGate(
  input: StartupCutoverGateInput,
): StartupCutoverGateDecision {
  return input.markerPresent
    ? { cutoverAuthorized: true, reason: "marker_present" }
    : { cutoverAuthorized: false, reason: "marker_absent" };
}
