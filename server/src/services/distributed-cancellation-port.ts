// server/src/services/distributed-cancellation-port.ts
//
// CLI-006 (Task 4) — the cancel routing decision, and the port that carries the
// fence-revoking call to a distributed-owned run's attempt.
//
// **Why the port is module-level and not constructor-injected.**
//
// `heartbeat.cancelRun` has exactly three non-test callers, and none of them
// holds a service instance built with options:
//
//   routes/agents.ts:2161  -> heartbeatService(db) at agents.ts:198
//   routes/issues.ts:386   -> heartbeatService(db) at issues.ts:99
//   index.ts:1835          -> heartbeatService(db) at index.ts:1828
//
// Only the scheduler instance (index.ts:1205) receives `distributedRollout`. A
// `requestCancellation` port added to `heartbeatService`'s options would
// therefore be `undefined` at every real cancel: the code would look wired,
// typecheck, and never fire. That is the same failure shape as the Task 2a
// bivariance defect — a composition that reads correct and is inert.
//
// Module-level registration is instance-independent by construction, which is
// exactly the property that fails above, and it is an idiom heartbeat.ts already
// uses twice (`setSecretResolver`, `registerRuntimeHook`).
//
// The port itself is needed because `requestCancellation` lives on
// `createJobReconciliationService({ appDb })` and runs under `runInTenant` over
// the `aoa_app` pool, which heartbeat's owner-pool `db` cannot reach.

/**
 * The fence-revoking cancel. Idempotent; `graceful` selects graceful vs hard.
 * Implemented in the composition root over JOB-006's reconciliation service.
 */
export interface DistributedCancellationPort {
  /**
   * Note the absence of `organizationId`. `requestCancellation` needs one (it
   * runs under `runInTenant`), but a `heartbeat_runs` row does not carry it and
   * heartbeat has no way to resolve it — that mapping lives on the tenant
   * `appDb`. So the IMPLEMENTATION resolves the Organization from `companyId`,
   * exactly as the rollout hook already does. Keeping it off this interface
   * means no cancel writer has to learn about Organizations.
   */
  requestCancellation(input: {
    jobId: string;
    companyId: string;
    reason: string;
    graceful: boolean;
  }): Promise<{ status: string }>;
}

let registeredPort: DistributedCancellationPort | undefined;

/**
 * Register (or clear, with `undefined`) the process-wide port. Called once from
 * the `index.ts` distributed block. Clearing exists so a test — or a config
 * reload — cannot leak one deployment's port into another.
 */
export function setDistributedCancellationPort(port: DistributedCancellationPort | undefined): void {
  registeredPort = port;
}

export function getDistributedCancellationPort(): DistributedCancellationPort | undefined {
  return registeredPort;
}

/** Why a marked run is nonetheless being cancelled the legacy way. */
export type CancelRouteDegradation =
  | "no_distributed_cancellation_port"
  | "missing_distributed_job_id"
  /** The port was present and the fence revoke FAILED. Not the same thing. */
  | "cancellation_request_failed"
  /** The revoke succeeded, but no worker will ever emit a terminal for it. */
  | "no_distributed_terminal_expected";

export type CancelRoute =
  | { readonly route: "distributed"; readonly jobId: string }
  | { readonly route: "legacy"; readonly degraded?: CancelRouteDegradation };

/**
 * Decide how to cancel one run.
 *
 * **The fail-safe direction here is the OPPOSITE of the seam's, deliberately.**
 * Suppression must never strand a run, so absence of a decision reads as legacy
 * *executes*. Cancel must never leave a run unkillable, so absence of a port
 * reads as legacy *terminalizes*. Both defaults point away from the outcome that
 * cannot be recovered by an operator.
 *
 * Concretely: a control-plane restart with the distributed flag off leaves marked
 * runs behind and no port. Refusing to terminalize them would strand them
 * forever — with the subsystem disabled, no worker will ever terminalize that
 * attempt. So the legacy write is the only convergent outcome, and the caller
 * logs the degradation rather than swallowing it. The cost is losing distributed
 * evidence for a run whose subsystem the operator has already turned off.
 *
 * An unrecognised `executionOwner` reads as legacy: a future owner kind this
 * build does not understand must not be treated as distributed.
 */
export function resolveCancelRoute(
  run: { executionOwner: string | null; distributedJobId: string | null },
  port: DistributedCancellationPort | undefined,
): CancelRoute {
  if (run.executionOwner !== "distributed") return { route: "legacy" };
  if (!port) return { route: "legacy", degraded: "no_distributed_cancellation_port" };
  // A half-written marker must not make a run unkillable — there is no fence to
  // revoke without a job id.
  if (!run.distributedJobId) return { route: "legacy", degraded: "missing_distributed_job_id" };
  return { route: "distributed", jobId: run.distributedJobId };
}

/**
 * Dispatch one run's cancellation and tell the caller whether IT still has to
 * write the legacy terminal.
 *
 * **4-D1 — a throwing port is not the same failure as a missing one.**
 *
 * A MISSING port means the subsystem is disabled, so no worker will ever
 * terminalize that attempt and the legacy write is the only convergent outcome
 * (`writeLegacyTerminal: true`).
 *
 * A THROWING port means the subsystem is enabled and the worker is **live**.
 * Writing `cancelled` locally would claim a stop that did not happen: it latches
 * the run, makes the projector discard the attempt's real terminal when it
 * arrives, and shows the founder a cancelled run while the sandbox keeps burning
 * budget. So a throw NEVER yields `writeLegacyTerminal: true` — under either
 * error mode. That is the single most important property in this module.
 *
 * `onError` splits the two caller shapes, which have genuinely different
 * obligations:
 *  - `"propagate"` — `cancelRun`, which answers an HTTP request. An operator who
 *    asked to cancel must be told it failed rather than shown a false success.
 *  - `"skip"` — the batch writers (agent pause, budget hard-stop, task-ineligible
 *    sweep). One unreachable attempt must not abort a company-wide hard-stop for
 *    every other run; the skipped run stays `running` and the next sweep revisits.
 */
export async function dispatchCancel(input: {
  run: { executionOwner: string | null; distributedJobId: string | null };
  companyId: string;
  reason: string;
  graceful: boolean;
  port: DistributedCancellationPort | undefined;
  onError: "propagate" | "skip";
}): Promise<{ writeLegacyTerminal: boolean; degraded?: CancelRouteDegradation }> {
  const route = resolveCancelRoute(input.run, input.port);
  if (route.route === "legacy") {
    return route.degraded
      ? { writeLegacyTerminal: true, degraded: route.degraded }
      : { writeLegacyTerminal: true };
  }

  try {
    const outcome = await input.port!.requestCancellation({
      jobId: route.jobId,
      companyId: input.companyId,
      reason: input.reason,
      graceful: input.graceful,
    });
    // H1 — the outcome decides who terminalizes. `requestCancellation` returns six
    // statuses, and only two of them mean a fenced worker will deliver a terminal
    // event. The other four mean NOTHING will: `cancelled` is the no-live-lease
    // path, where the repo finalizes job+attempt DIRECTLY with row updates
    // (job-control.ts:3001-3033) and writes no `job_events` row; `job_terminal`
    // and `not_found` never had one coming.
    //
    // `onAttemptTerminal` has exactly one producer — the worker event-ingest path
    // — so treating those as "the distributed side owns it" pins the run at
    // `running` forever, and since every retry then returns `job_terminal`, the
    // run becomes permanently UNCANCELLABLE. An unleased attempt is the ordinary
    // first-canary state, not an edge case (E4-D12 keeps the daemon inert outside
    // the D1 topology).
    //
    // Unknown statuses fail towards a killable run.
    if (outcome.status === "queued" || outcome.status === "already_requested") {
      return { writeLegacyTerminal: false };
    }
    return { writeLegacyTerminal: true, degraded: "no_distributed_terminal_expected" };
  } catch (err) {
    if (input.onError === "propagate") throw err;
    // Skipped, but deliberately NOT terminalized — the worker is still live.
    return { writeLegacyTerminal: false, degraded: "cancellation_request_failed" };
  }
}
