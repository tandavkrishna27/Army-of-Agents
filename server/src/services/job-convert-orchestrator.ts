// server/src/services/job-convert-orchestrator.ts
//
// CLI-005 (D3) — the active-mode convert orchestrator.
//
// For a heartbeat run that resolves to `active`, this composes the five parity bridges
// (via `admitAndSubmit`) into ONE durable, NON-LEASABLE `jobs` + `job_attempts` row that
// establishes run↔job identity + provenance. It NEVER places or leases the attempt (it
// holds no placement dependency at all), so the legacy `adapter.execute` stays the sole
// authoritative executor — active-mode jobs are inert until MIG-002.
//
// Checkout ownership moves harness→bridge for active runs: `admitAndSubmit` drives the
// SAME run-guarded `issueService.checkout` in-transaction, so the caller (heartbeat)
// SUPPRESSES its conditional harness checkout for active runs and lets this be the ONE
// checkout (checkout parity — Invariant 3).
//
// Failure handling (Invariant 5, amended): a throw inside `admitAndSubmit` rolls back the
// WHOLE submission tenant-tx (no job row, checkout undone) — so the issue's legacy claim
// (executionRunId from the wakeup) is already intact. In CLI-005's INERT model the legacy
// adapter still executes this issue, so a failed convert is a NO-OP on issue state: it does
// NOT release the claim (releasing would reset the issue to todo/unassigned out from under
// the legacy run). It NEVER throws into the run — the run proceeds on the legacy path
// (equivalent to the "harness checkout skipped" fallback, where the agent self-checks-out).

import type { SubmitJobResponse, SubmitJobSource } from "@armyofagents/shared";
import type { BridgeActor, JobAdmissionBridge } from "./job-admission-bridge.js";

export type JobConvertReason = "disabled" | "submitted" | "replayed" | "submit_failed";

export interface JobConvertResult {
  readonly converted: boolean;
  readonly reason: JobConvertReason;
  readonly response?: SubmitJobResponse;
  readonly error?: unknown;
}

export interface JobConvertOrchestrator {
  convertRunToJob(input: {
    source: SubmitJobSource;
    actor: BridgeActor;
    idempotencyKey: string;
    input?: Record<string, unknown>;
  }): Promise<JobConvertResult>;
}

export function createJobConvertOrchestrator(deps: {
  bridge: JobAdmissionBridge;
}): JobConvertOrchestrator {
  const { bridge } = deps;

  return {
    async convertRunToJob({ source, actor, idempotencyKey, input }) {
      // Fail-closed gate: a flag-off deployment never invokes the bridge.
      if (!bridge.isEnabled()) {
        return { converted: false, reason: "disabled" };
      }

      try {
        const response = await bridge.admitAndSubmit(source, actor, idempotencyKey, input);
        return {
          converted: true,
          reason: response.replayed ? "replayed" : "submitted",
          response,
        };
      } catch (error) {
        // CLI-005 inert model: the legacy adapter remains the sole executor and STILL owns
        // this issue (executionRunId set by the wakeup tx). `admitAndSubmit` submits the
        // checkout + the job in ONE tenant tx, so a throw rolled the WHOLE tx back — the
        // checkout is undone and no job row exists → the issue's legacy claim is already
        // intact. We MUST NOT release it here: `issueService.release` resets the issue to
        // todo/unassigned, which would strip the claim out from under the legacy run that
        // is about to execute it (double-assignment window + spurious board flicker). A
        // failed convert is a no-op on issue state; just report it and never throw.
        return { converted: false, reason: "submit_failed", error };
      }
    },
  };
}
