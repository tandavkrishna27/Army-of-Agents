// packages/worker-daemon/src/update/drain-before-swap.ts
//
// DSK-004 Lane D — stop leasing, drain in-flight work, and only then swap the version
// pointer (I9, clauses 2 and 3).
//
// ALMOST NOTHING HERE IS NEW, AND THAT IS THE POINT. WRK-003 already stops leasing before
// draining; WRK-005 already stops renewal timers so no renew fires during a drain;
// WRK-006 already orders the outbox stop → flush → close. This module WIRES an update
// onto those verbs. It calls `createLeaseLifecycleSteps` and `createEventOutboxShutdownSteps`
// rather than restating their order, because two orderings that agree today drift the
// first time one is edited, and the drift is silent: both lists still look plausible.
//
// ONE THING GENUINELY DIFFERS FROM SHUTDOWN, and it is a failure POLICY rather than an
// ordering. `createShutdownHandler` deliberately swallows a failing step — a process that
// is exiting must exit regardless, and a stuck drain must not wedge it forever. An update
// is not exiting. If the drain fails, in-flight work is still running, and moving the
// pointer would kill it. So the same steps run under the opposite policy:
//
//   FAIL CLOSED. The first failing step aborts the sequence and the swap does not happen.
//
// Aborting rather than continuing matters for a second reason: the outbox steps come after
// the drain, and running them past a failed drain would close the event store while work
// is still writing to it.
//
// The swap itself is INJECTED. This package must not import `@armyofagents/worker-keystore`
// (that package depends on this one), and the seam is the right shape anyway: the planner
// decides whether the pointer may move, and this decides when it is safe to ask.

import {
  createEventOutboxShutdownSteps,
  createLeaseLifecycleSteps,
  type EventOutboxLifecycle,
  type LeasingLifecycle,
  type RenewalLifecycle,
  type ShutdownLogger,
  type ShutdownStep,
} from "../lifecycle/shutdown.js";

export interface UpdateDrainDeps {
  readonly leasing: LeasingLifecycle;
  /** WRK-005 renewal driver. Absent in a worker that does not renew. */
  readonly renewal?: RenewalLifecycle;
  /** WRK-006 durable outbox. Absent in a worker without one. */
  readonly outbox?: EventOutboxLifecycle;
}

export type UpdateRefusalReason = "malformed_input" | "step_failed" | "swap_failed";

export type UpdateDrainResult =
  | { readonly outcome: "swapped" }
  | {
      readonly outcome: "refused";
      readonly reason: UpdateRefusalReason;
      readonly failedStep: string | null;
    };

/**
 * The ordered steps an update runs before the pointer may move.
 *
 * Composed from the shared builders, never re-derived: the update path and the shutdown
 * path stop leasing before draining because they are literally the same list.
 */
export function createUpdateDrainSteps(deps: UpdateDrainDeps): readonly ShutdownStep[] {
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
    throw new Error("worker-daemon: update drain requires a leasing lifecycle");
  }
  const { leasing, renewal, outbox } = deps;
  if (
    typeof leasing !== "object" ||
    leasing === null ||
    typeof leasing.stopLeasing !== "function" ||
    typeof leasing.drain !== "function"
  ) {
    throw new Error("worker-daemon: update drain requires a leasing lifecycle");
  }
  const steps: ShutdownStep[] = [...createLeaseLifecycleSteps(leasing, renewal)];
  if (outbox !== undefined) {
    // After the drain, so events produced by work that finished DURING the drain are
    // flushed rather than left behind a store that was already closed.
    steps.push(...createEventOutboxShutdownSteps(outbox));
  }
  return steps;
}

export interface DrainBeforeSwapOptions {
  readonly steps: readonly ShutdownStep[];
  /** Move the pointer. Injected — see the note on the keystore dependency direction. */
  swap(): Promise<void> | void;
  readonly logger: ShutdownLogger;
}

function refused(reason: UpdateRefusalReason, failedStep: string | null): UpdateDrainResult {
  return { outcome: "refused", reason, failedStep };
}

/**
 * Run every step to completion, in order, and only then swap.
 *
 * Each step is AWAITED. A drain that is not awaited is not a drain — the sequence would
 * return while work was still running and the swap would land on top of it.
 */
export async function runDrainBeforeSwap(
  options: DrainBeforeSwapOptions,
): Promise<UpdateDrainResult> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return refused("malformed_input", null);
  }
  const { steps, swap, logger } = options;
  if (!Array.isArray(steps) || typeof swap !== "function") {
    return refused("malformed_input", null);
  }

  for (const step of steps) {
    const name = typeof step?.name === "string" ? step.name : "(unnamed)";
    logger?.info?.({ step: name }, `update: stopping ${name}`);
    try {
      await step.stop();
    } catch (err) {
      // Unlike shutdown, this ABORTS. In-flight work is still running, so the pointer
      // must not move, and the remaining steps must not run past a failed drain.
      logger?.error?.({ step: name, err }, `update: ${name} failed; not swapping`);
      return refused("step_failed", name);
    }
  }

  try {
    await swap();
  } catch (err) {
    logger?.error?.({ err }, "update: the pointer swap failed");
    return refused("swap_failed", null);
  }
  return { outcome: "swapped" };
}
