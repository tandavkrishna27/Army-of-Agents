/**
 * `runServiceLifecycle` — the daemon's SERVICE sequencer (SVC-008b).
 *
 * ★★★ WHY THIS IS NOT A PARAMETERISATION OF THE BATCH PATH. For batch, `execute` RETURNING
 * IS THE RUN ENDING: there is no representation of "the process is still up", so a workload
 * that does not end has no state in that sequencer. `serviceWorkloadV1Schema` also carries
 * `command`/`args`, so before this module a service job flowed through the batch body with
 * no type error and no branch — and a long-running service whose startup script exits 0 was
 * reported `succeeded`. That is SVC-008 §1.2: mis-supervision that looks like success, and
 * it is strictly worse than the `queued` state it replaced.
 *
 * ★★★ THE ONE RULE (SVC-008 §3.1a). An event may assert ONLY what an op the daemon actually
 * CALLED returned. A sandbox-scoped answer may not be reported as a process-scoped fact.
 * Concretely, and enforced by construction below:
 *
 *   service_instance_started  <- `create` resolved a sandboxId AND `startProcess` acknowledged
 *   service_health            <- a `processStatus` READ of THIS run's handle. Never
 *                                `provider.health` (which is `sandbox.isRunning()`; a sandbox
 *                                is up from the moment `create` resolves), and never
 *                                synthesized when the read could not answer.
 *   service_instance_stopped  <- an observation of `exited` or `gone`. Never a stop REQUEST,
 *                                never `ProcessSignalResult.accepted`.
 *   service_instance_lost     <- `inspect` could not describe the sandbox, or a full stop
 *                                ladder ended with the process still observed `running`.
 *
 * ★ WHAT THIS UNIT DOES NOT DO, and who owns each. It supervises ONE instance, on ONE worker,
 * for ONE lease generation, and emits what it observes. It does not decide what any of those
 * observations MEAN. Health policy, the `service_health` -> `recordServiceHealth` projection
 * and lease/ownership semantics are SVC-003's; restart/backoff/checkpoint are SVC-004's;
 * drain, generation rollout and a service-specific stop verb are SVC-005's. It `generation`
 * is READ off the workload and stamped into every event; it is never written or compared.
 */

import {
  serviceWorkloadV1Schema,
  type ServiceWorkloadV1,
} from "@armyofagents/worker-protocol";

import type { Logger } from "../logging/logger.js";
import type { EventSequencer, ServiceInstanceRef } from "./events.js";
import type { EffectAuthority } from "./effect-authority.js";
import {
  deriveStopVerdict,
  UnsupportedProviderOperation,
  type ProcessHandle,
  type ProcessObservation,
  type ProviderOpContext,
} from "./provider.js";

/**
 * The default interval between health ticks.
 *
 * ★ A DEFAULT, NOT A DECISION. SVC-008 §9.3 records the interval as an OPEN question because
 * it interacts with SVC-003's liveness deadline, and choosing it here would pre-empt SVC-003.
 * 10 s over 72 h is ~26 000 durable `service_health` rows per instance; 60 s is ~4 300. The
 * frozen wire imposes no rate. It is injectable (`SupervisorDeps.serviceHealthTickMs`) so
 * whoever rules on §9.3 changes one number in the composition root, not this module.
 */
export const SERVICE_HEALTH_TICK_MS_DEFAULT = 10_000;

/** Why the supervise loop left its steady state. Every arm names an OBSERVATION or a CLOCK. */
type StopTrigger =
  | { readonly kind: "process_exited"; readonly exitCode: number | null }
  | { readonly kind: "stop_requested"; readonly reason: string }
  | { readonly kind: "budget_lapsed" }
  | { readonly kind: "authority_expiring" }
  | { readonly kind: "fence_closed" };

/** What the service sequencer concluded. The CALLER emits `terminal` and runs teardown, so
 * the orphan-aware destroy path is not duplicated (and cannot drift) per workload type. */
export interface ServiceRunOutcome {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly exitCode: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** When set, the caller escalates cleanup with this reason instead of a happy destroy. */
  readonly escalate: string | null;
}

/**
 * A handle the supervisor holds so a COOPERATIVE cancel can ask for a graceful stop and wait
 * for the ladder, instead of hard-destroying the sandbox out from under it.
 *
 * ★ It is deliberately NOT reachable for a LOST lease. §4.5: a run whose fence has closed must
 * stop emitting, not negotiate — `Supervisor.onLeaseLost` takes the non-graceful path.
 */
export interface ServiceStopHandle {
  /** Ask the loop to begin its graceful ladder. Idempotent; the first reason wins. */
  requestStop(reason: string): void;
  /** Resolves when the sequencer has finished (ladder included). */
  readonly finished: Promise<void>;
  /** The workload's own `gracefulStopSeconds`, in ms — the caller's wait bound. */
  readonly gracefulStopMs: number;
}

export interface ServiceLifecycleDeps {
  readonly workload: ServiceWorkloadV1;
  readonly sandboxId: string;
  readonly effect: EffectAuthority;
  readonly events: EventSequencer;
  /** A fresh op context carrying THIS run's budget. */
  readonly makeCtx: () => ProviderOpContext;
  /** ms clock (the supervisor's injected one, so a test can drive it). */
  readonly now: () => number;
  readonly nowIso: () => string;
  /** The supervisor's injected timer — never a bare `setInterval`. */
  readonly schedule: (fn: () => void, ms: number) => unknown;
  readonly tickMs: number;
  /** Absolute ms-epoch at which the run's budget lapses (§3.3). */
  readonly deadlineAt: number;
  /**
   * The run's effect-authority (owned-labels capability) expiry, or null on the desktop
   * branch where no capability is minted. §4.1/§5.1(3).
   */
  readonly capExpiresAt: number | null;
  /** Teardown headroom to reserve inside the capability window. */
  readonly teardownHeadroomMs: number;
  /** True once the fence has closed (lease lost / cancelled / shutdown). Read EVERY tick. */
  readonly fenceClosed: () => boolean;
  readonly logger?: Logger;
  /** Publishes the stop handle to the supervisor before the first tick. */
  readonly publishStopHandle?: (handle: ServiceStopHandle) => void;
}

/**
 * Parse the handoff's workload as a frozen service workload.
 *
 * Returns `null` rather than throwing: the workload crosses the wire as
 * `Record<string, unknown>` on this side of the boundary, and a malformed one must fail the
 * ATTEMPT with a named terminal, not crash the sequencer.
 */
export function parseServiceWorkload(workload: unknown): ServiceWorkloadV1 | null {
  const parsed = serviceWorkloadV1Schema.safeParse(workload);
  return parsed.success ? parsed.data : null;
}

/** The identity every frozen service event repeats. */
function refOf(workload: ServiceWorkloadV1): ServiceInstanceRef {
  return {
    serviceId: String(workload.serviceId),
    serviceInstanceId: String(workload.serviceInstanceId),
    generation: workload.generation,
  };
}

export async function runServiceLifecycle(deps: ServiceLifecycleDeps): Promise<ServiceRunOutcome> {
  const ref = refOf(deps.workload);
  const gracefulStopMs = deps.workload.gracefulStopSeconds * 1000;

  let stopRequest: string | null = null;
  let settleFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    settleFinished = resolve;
  });
  deps.publishStopHandle?.({
    requestStop(reason: string): void {
      stopRequest ??= reason;
    },
    finished,
    gracefulStopMs,
  });

  try {
    // --- 1. LAUNCH. `startProcess` resolves on ACKNOWLEDGEMENT, never on completion. ------
    //
    // ★ §4.2a. No handle ⇒ NO `service_instance_started`. The instance never leaves `leased`
    // and the attempt fails. A "started" for a launch nobody established is the durable false
    // claim this whole module exists to prevent, and it is why the port's `startProcess`
    // THROWS rather than resolving an empty handle.
    let handle: ProcessHandle;
    try {
      const started = await deps.effect.startProcess(
        {
          sandboxId: deps.sandboxId,
          command: deps.workload.command,
          args: [...deps.workload.args],
          env: {},
        },
        deps.makeCtx(),
      );
      handle = started.handle;
    } catch (err) {
      // ★ The two refusals are DISTINGUISHED, because they mean different things to an
      // operator: "this provider cannot supervise processes at all" is a placement/fleet
      // problem, and "this launch was refused" is a workload problem. Collapsing them would
      // send someone hunting the wrong one.
      const unsupported = err instanceof UnsupportedProviderOperation;
      deps.logger?.warn(
        { sandboxId: deps.sandboxId, unsupported },
        unsupported
          ? "service: the provider does not supervise processes — a service cannot be launched on it"
          : "service: the launch was not acknowledged — failing the attempt closed",
      );
      return {
        status: "failed",
        exitCode: null,
        errorCode: unsupported ? "service_supervision_unsupported" : "service_launch_failed",
        errorMessage: null,
        escalate: unsupported ? "service_supervision_unsupported" : "service_launch_failed",
      };
    }

    // The launch was acknowledged on a created sandbox: `starting`, and only that.
    await deps.events.serviceInstanceStarted({ ...ref, providerResourceId: deps.sandboxId });

    // --- 2. THE SUPERVISE LOOP. -----------------------------------------------------------
    let trigger: StopTrigger | null = null;
    while (trigger === null) {
      // (a) Fence first, EVERY tick. §4.5 — a service loop that kept emitting after the
      // renewal driver closed the fence would be the first daemon component to write past a
      // closed one. The batch path only needs this check at one point; a loop needs it at all.
      if (deps.fenceClosed()) {
        trigger = { kind: "fence_closed" };
        break;
      }

      // (b) A cooperative stop asked for by the control plane.
      if (stopRequest !== null) {
        trigger = { kind: "stop_requested", reason: stopRequest };
        break;
      }

      const now = deps.now();

      // (c) ★ AUTHORITY FRESHNESS — §4.1 and §5.1 clause 3. The owned-labels capability is
      // lease-clamped and NEVER re-minted (`owned-labels-mint.ts` mints on exactly one route,
      // and `/leases/:id/renew` does not), so a run longer than its TTL reaches `destroy` with
      // an EXPIRED cap and the supervisor records a billable orphan.
      //
      // ★ WHAT THIS DOES NOT DO, deliberately: it does NOT re-materialize secrets on a
      // schedule to re-mint the cap. That is SVC-008 §9.1 and it is UNRULED — it would re-run
      // a secret RESOLUTION on a timer, widening the blast radius of a compromised worker from
      // one materialization to N, and nobody has ruled on that. So this takes §4.1's other
      // arm: treat the headroom boundary as a STOP DEADLINE and begin the graceful stop while
      // the cap is still valid. Never continue past cap expiry — doing so deliberately would
      // be a designed leak.
      if (deps.capExpiresAt !== null && now + deps.teardownHeadroomMs >= deps.capExpiresAt) {
        trigger = { kind: "authority_expiring" };
        break;
      }

      // (d) The run's own budget.
      if (now >= deps.deadlineAt) {
        trigger = { kind: "budget_lapsed" };
        break;
      }

      // (e) HEALTH — from a PROCESS-scoped read, or not at all.
      const observation = await observe(deps, handle);
      if (observation.state === "exited") {
        trigger = { kind: "process_exited", exitCode: observation.exitCode };
        break;
      }
      if (observation.state === "gone") {
        // The read ANSWERED and the process is not there. It exited without an exit code we
        // can name — honest as `exitCode: null`, never as a fabricated 0.
        trigger = { kind: "process_exited", exitCode: null };
        break;
      }
      if (observation.state === "running") {
        await deps.events.serviceHealth({ ...ref, status: "healthy", detail: null });
      }
      // `unknown` ⇒ EMIT NOTHING. Not a `healthy` (the failure class this module exists to
      // prevent) and not an `unhealthy` either: a fabricated unhealthy is as wrong, and it
      // would additionally drive SVC-003 to kill a working service.
      //
      // ★★★ THE LIVENESS STEP OF §3.2 IS NOT HERE, AND THAT IS A DELIBERATE DEVIATION.
      // §3.2 step 3 specified a per-tick `inspect(sandboxId)` whose `SandboxNotFoundError`
      // becomes `service_instance_lost`. `EffectAuthority` HAS NO `inspect`: the op returns
      // the FULL, UNREDACTED `InspectResult` — `command`/`env`/`logs`/`secrets`/`objectGrants`
      // — which is exactly why it lives on `CleanupAuthority`, whose contract is to return
      // only a `RedactedResourceProjection`. Adding an unredacted read to the effect surface
      // to satisfy a liveness tick would widen a disclosure surface for a signal that is
      // ALREADY representable: SVC-008a's `ProcessUnknownReason` includes
      // `"sandbox_unreachable"`, which both the real and mock E2B transports produce, and it
      // arrives through the process-scoped op above. It is an `unknown` — "a read that was
      // ATTEMPTED and did not answer", retryable by contract — so it is NOT laundered into an
      // affirmative absence here. A sandbox that stays unreachable rides the loop to its
      // budget, where the ladder's undetermined verdict lands on `service_instance_lost`.
      // Recorded rather than silently narrowed; SVC-003 owns the liveness DEADLINE policy.

      await sleep(deps, deps.tickMs);
    }

    // --- 3. RESOLVE THE TRIGGER. ----------------------------------------------------------
    switch (trigger.kind) {
      case "fence_closed":
        // Nothing more is emitted here — not even a `service_instance_lost`. The fence is
        // closed; the supervisor's cancel path owns the teardown and the terminal.
        return { status: "cancelled", exitCode: null, errorCode: "cancelled", errorMessage: null, escalate: null };

      case "process_exited":
        await deps.events.serviceInstanceStopped({ ...ref, exitCode: trigger.exitCode });
        // ★ A service that exits is not a success by default and not a failure by default —
        // the exit code decides, matching the batch rule. WHETHER an exit should be REPLACED
        // is SVC-004's, and this unit has no opinion about it.
        return {
          status: trigger.exitCode === 0 ? "succeeded" : "failed",
          exitCode: trigger.exitCode,
          errorCode: trigger.exitCode === 0 ? null : "service_exited",
          errorMessage: null,
          escalate: null,
        };

      case "stop_requested":
      case "budget_lapsed":
      case "authority_expiring":
        return await gracefulStop(deps, ref, handle, trigger);
    }
  } finally {
    settleFinished();
  }
}

/**
 * The graceful-stop ladder — §4.3a.
 *
 * ★★★ THE VERDICT COMES FROM A STATUS READ, NEVER FROM THE SIGNAL'S RETURN. That is not a
 * style preference: `RealE2bTransport.signal` reported `delivered: true` from its own catch
 * branch (E7-F034), which made `CleanupAuthority`'s `kill` rung structurally unreachable in
 * production, and SVC-008a's `ProcessSignalResult` was built with NO member that can name a
 * stop precisely so no caller can rebuild that defect one layer up. `accepted` describes the
 * CALL; `observation` describes the PROCESS; `deriveStopVerdict` is the single place the
 * predicate lives.
 *
 * ★ ONE DEVIATION FROM §4.3a, and it is a simplification the PORT made available. The design
 * wrote each rung as "signal, then re-read `processStatus`" — two calls. SVC-008a's port
 * defines `signalProcess` as "deliver the signal, then RE-READ its status and report what
 * that read saw", so `ProcessSignalResult.observation` IS the re-read; issuing a second one
 * would be an extra provider round-trip per rung that cannot see anything the first did not.
 * What is NOT dropped is the property the design wanted: the verdict is derived from an
 * observation. The GRACEFUL WINDOW is still polled with real `processStatus` reads, so a
 * process that stops on its own inside it is never escalated to a kill.
 */
async function gracefulStop(
  deps: ServiceLifecycleDeps,
  ref: ServiceInstanceRef,
  handle: ProcessHandle,
  trigger: StopTrigger,
): Promise<ServiceRunOutcome> {
  const gracefulStopMs = deps.workload.gracefulStopSeconds * 1000;
  const deadlineAt = deps.now() + gracefulStopMs;
  // Observes the REQUEST. Its payload is only `{ref, deadline}`, so it is honest either way.
  await deps.events.serviceGracefulStopObserved({ ...ref, deadline: new Date(deadlineAt).toISOString() });

  // Rung 1 — cancel, then RE-READ.
  let verdict = await signalAndVerify(deps, handle, "cancel");
  // Keep re-reading until the graceful deadline lapses; a process that stops on its own during
  // the window must never be escalated to a kill.
  while (verdict === "still_up" && deps.now() < deadlineAt && !deps.fenceClosed()) {
    await sleep(deps, Math.min(deps.tickMs, gracefulStopMs));
    verdict = deriveStopVerdict(await observe(deps, handle));
  }

  // Rung 2 — kill, then RE-READ. Reached only when the graceful window closed on a process
  // still observed up, or on an undetermined read (which ESCALATES, never concludes).
  if (verdict !== "stopped") {
    verdict = await signalAndVerify(deps, handle, "kill");
  }

  if (verdict === "stopped") {
    await deps.events.serviceInstanceStopped({ ...ref, exitCode: null });
    // A run stopped on request/budget/authority is not a workload failure. `cancelled` for an
    // ordered stop; `succeeded` for a service that served its whole budget without dying.
    const cancelled = trigger.kind === "stop_requested";
    return {
      status: cancelled ? "cancelled" : "succeeded",
      exitCode: null,
      errorCode: cancelled ? "cancelled" : null,
      errorMessage: null,
      escalate: null,
    };
  }

  // ★ Still up (or undetermined) after BOTH rungs ⇒ `service_instance_lost`, NEVER `_stopped`.
  // The sandbox teardown that follows will reclaim the resource; what is not established is
  // that the PROCESS stopped, and this is where that distinction is preserved.
  const reason =
    verdict === "undetermined"
      ? `stop ladder completed but the process could not be observed (trigger: ${trigger.kind})`
      : `the process was still running after cancel and kill (trigger: ${trigger.kind})`;
  await deps.events.serviceInstanceLost({ ...ref, reason });
  return {
    status: "failed",
    exitCode: null,
    errorCode: "service_stop_unconfirmed",
    errorMessage: null,
    escalate: "service_stop_unconfirmed",
  };
}

/** Deliver one signal and derive the verdict from the observation it re-read. */
async function signalAndVerify(
  deps: ServiceLifecycleDeps,
  handle: ProcessHandle,
  kind: "cancel" | "kill",
): Promise<"stopped" | "still_up" | "undetermined"> {
  try {
    const result = await deps.effect.signalProcess(deps.sandboxId, handle, kind, deps.makeCtx());
    // `result.accepted` is READ ONLY for the log. It cannot reach the verdict.
    deps.logger?.info(
      { sandboxId: deps.sandboxId, signalKind: kind, accepted: result.accepted },
      "service: stop signal delivered; the verdict comes from the observation",
    );
    return deriveStopVerdict(result.observation);
  } catch {
    // A signal that threw witnessed nothing. Undetermined escalates; it never concludes.
    return "undetermined";
  }
}

/** One process-scoped status read. A throw is `unknown`, never an affirmative absence. */
async function observe(deps: ServiceLifecycleDeps, handle: ProcessHandle): Promise<ProcessObservation> {
  try {
    const status = await deps.effect.processStatus(deps.sandboxId, handle, deps.makeCtx());
    return status.observation;
  } catch {
    return { state: "unknown", reason: "read_failed" };
  }
}

function sleep(deps: ServiceLifecycleDeps, ms: number): Promise<void> {
  return new Promise((resolve) => {
    deps.schedule(() => resolve(), Math.max(0, ms));
  });
}
