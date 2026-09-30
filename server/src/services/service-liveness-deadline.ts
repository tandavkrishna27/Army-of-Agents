// server/src/services/service-liveness-deadline.ts
//
// SVC-003b — THE LIVENESS DEADLINE. What it means for a service instance to have stopped
// being live when NOTHING SAID SO.
//
// ── THE FAILURE THIS EXISTS FOR, and it is reachable in the SHIPPED daemon ───────────────
//
// SVC-003a gave `service_instances.status` its first consumer: a worker event that WITNESSES
// a fact moves the row, and an instance driven `stopped`/`failed`/`lost` leaves
// `service_instances_live_service_uq`, which is what lets SVC-002's reconciler create its
// replacement. Every one of those paths is EDGE-TRIGGERED BY AN EVENT.
//
// The whole failure is the ABSENCE of events, and the supervisor's own source says so. In
// `packages/worker-daemon/src/supervisor/service-lifecycle.ts`, the supervise loop's health
// step handles a `processStatus` read that could not answer with `unknown ⇒ EMIT NOTHING` —
// not a fabricated `healthy`, and deliberately not an `unhealthy` either, because "a
// fabricated unhealthy is as wrong, and it would additionally drive SVC-003 to kill a working
// service". That arm is correct AND it means a sandbox that becomes unreachable produces NO
// events at all while the loop keeps spinning. The comment closes: *"SVC-003 owns the liveness
// DEADLINE policy."* This module is that policy.
//
// ★ AND THE LEASE REAPER IS STRUCTURALLY BLIND TO IT. `reapExpiredLeases` fires on an EXPIRED
// LEASE, and lease renewal is driven by `lease-renewal.ts` — a different driver from the
// supervise loop. A worker whose supervision has gone silent while its renewal driver still
// runs holds a lease that never expires, so the reaper never sees it. Even in the cruder case
// where the whole worker dies, the reaper revokes the lease and terminalizes the ATTEMPT and
// the JOB and touches `service_instances` NOT AT ALL — so the instance stays inside the live
// index and the reconciler can never replace it. That is a stuck service that no code
// notices; it is the failure E9 exists to prevent, and it is what this closes.
//
// ── ★★★ TWO WINDOWS, AND THEY NEVER SUBSTITUTE FOR EACH OTHER ───────────────────────────
//
// SVC-008b's lesson governs the shape: an honest UNKNOWN that stalls beats a confident wrong
// verdict that acts. A deadline that terminalizes a LIVE instance because an observation was
// unreadable is worse than the stuck instance it was trying to fix. So "the worker went
// silent" and "the worker was never heard from" are DIFFERENT FACTS, aged against DIFFERENT
// clocks, under DIFFERENT windows:
//
//   observedAgeMs != null  the worker HAS been observed. `livenessDeadlineMs` applies, and it
//                          is short: it is a multiple of the health-tick interval.
//   observedAgeMs == null  the worker has NEVER been observed. There is no liveness fact to
//                          age, so the liveness window MAY NOT BE APPLIED. The instance is
//                          aged instead against `createdAgeMs` — the control plane's own row,
//                          a fact about when IT started waiting, never an observation — under
//                          the separate and deliberately longer `admissionDeadlineMs`.
//
// Collapsing them in either direction is a defect with a name:
//
//   * `COALESCE(last_observed_at, created_at)` — or any decider that treats a missing
//     observation as an old one — applies the SHORT window to an instance whose worker has
//     simply not polled yet, and kills services that are merely slow to start.
//   * treating a missing observation as INFINITELY stale terminalizes a freshly created
//     instance on the first tick, before any worker could possibly have reached it. That is
//     literally "terminalize a live instance because the observation was unreadable".
//
// Both are pinned by named cases and by mutants.
//
// ── WHAT THIS MODULE DOES NOT DECIDE ────────────────────────────────────────────────────
//
// WHETHER a terminalized instance is replaced, and with what backoff, is not decided here and
// is not decided anywhere in this ticket. Terminalizing is sufficient BY CONSTRUCTION: the row
// leaves `service_instances_live_service_uq`, `listReconcilableServices` stops filtering its
// service out, and SVC-002's existing reconciler creates the replacement on its next pass —
// which is the same tick, because the sweep runs ahead of the convergence pages. Crash-loop
// policy (should a service that keeps dying be replaced at all, and how fast) is SVC-004's
// clause and this module has no opinion about it.

import {
  SERVICE_INSTANCE_STATUSES,
  canTransitionServiceInstanceStatus,
  type ServiceInstanceStatus,
} from "@armyofagents/worker-protocol";
import type { ServiceInstanceLivenessRow } from "@armyofagents/db";
import { predecessorsOf } from "./service-health-projection.js";

/**
 * The status a deadline drives a condemned instance to.
 *
 * `lost` and not `failed`, and the frozen table is the reason rather than taste.
 * `SERVICE_INSTANCE_TRANSITIONS` documents `lost` as reachable from EVERY non-terminal status
 * (`pending`, `leased`, `starting`, `healthy`, `unhealthy`, `stopping`), which is exactly the
 * population this sweep reads — so a deadline can never be refused as an illegal move on a
 * live row. `failed` is equally reachable, but it means the workload failed, and a deadline
 * knows nothing about the workload: it knows only that the instance can no longer be accounted
 * for, which is what the frozen lifecycle names `lost`.
 */
export const SERVICE_LIVENESS_DEADLINE_TO_STATUS: ServiceInstanceStatus = "lost";

/**
 * ★ A DEFAULT, NOT A RULING. SVC-008 §9.3 records the health-tick interval as an OPEN question
 * *because it interacts with SVC-003's liveness deadline*, and SVC-008b's
 * `SERVICE_HEALTH_TICK_MS_DEFAULT` (10 s) is itself a default for the same reason. Choosing a
 * number here does not close §9.3 and does not claim to.
 *
 * What IS a decision, and the part that must survive any later ruling on §9.3: the liveness
 * window must be a MULTIPLE of the tick interval, not a comparable quantity. A single dropped
 * tick — one slow `processStatus` read, one renewal that took longer than usual — must not
 * terminalize a working service. 180 s is eighteen 10 s ticks. Injectable, so whoever rules on
 * §9.3 changes one argument at the composition root rather than this module.
 */
export const SERVICE_LIVENESS_DEADLINE_MS_DEFAULT = 180_000;

/**
 * The window for an instance whose worker has NEVER been observed, aged against the instance
 * row's own creation.
 *
 * LONGER THAN THE LIVENESS WINDOW, and by a wide margin, because it covers a completely
 * different span: a `pending` instance is waiting for the placement loop to offer its job to a
 * daemon, for the daemon to poll, ACK, create a sandbox and launch a process — none of which
 * is bounded by a health-tick interval, and any of which can legitimately be slow on a busy or
 * briefly empty fleet. Ten minutes is chosen to be comfortably longer than any of that while
 * still being far shorter than "forever", which is the value it replaces.
 */
export const SERVICE_ADMISSION_DEADLINE_MS_DEFAULT = 600_000;

/** The two windows, together. Both are required: neither has a default at the call site, so a
 *  caller cannot half-configure the policy and silently inherit the other half. */
export interface ServiceLivenessPolicy {
  livenessDeadlineMs: number;
  admissionDeadlineMs: number;
}

/**
 * What one live instance's timestamps say about it. Four arms, and the two that DO NOT act are
 * as load-bearing as the two that do — a sweep that reported only its kills could not
 * distinguish "nothing was stale" from "the classifier never fired".
 */
export type ServiceInstanceLivenessVerdict =
  /** Observed inside the liveness window. Alive; no write. */
  | { verdict: "fresh"; observedAgeMs: number }
  /** Observed, then went quiet for longer than the liveness window. ★ TERMINALIZE. */
  | { verdict: "silent"; observedAgeMs: number }
  /** Never observed, and still inside the admission window. ★ AN HONEST STALL: there is no
   *  liveness fact to age, and the control plane has not been waiting long enough for its own
   *  row's age to mean anything. No write. */
  | { verdict: "awaiting_first_observation"; createdAgeMs: number }
  /** Never observed, and the control plane has been waiting past the admission window.
   *  ★ TERMINALIZE — on the ROW's age, never on a liveness window it has no input for. */
  | { verdict: "never_observed"; createdAgeMs: number };

/**
 * The whole policy, as one pure function of two numbers.
 *
 * Pure and clock-free on purpose: both ages are measured by the DATABASE's `clock_timestamp()`
 * inside the sweep's own transaction (`sweepServiceInstanceLiveness`), so this function cannot
 * introduce app/database clock skew and cannot be tested against a mocked `Date.now()` that
 * does not resemble production.
 *
 * ★ THE COMPARISONS ARE STRICT (`>`), so an age exactly equal to its window is still alive.
 * A deadline is the point past which an instance is condemned, not the point at which it is.
 */
export function classifyServiceInstanceLiveness(
  row: Pick<ServiceInstanceLivenessRow, "observedAgeMs" | "createdAgeMs">,
  policy: ServiceLivenessPolicy,
): ServiceInstanceLivenessVerdict {
  if (row.observedAgeMs === null) {
    // ★ THE UNREADABLE ARM. No observation exists, so `livenessDeadlineMs` is NOT consulted —
    // not even as a fallback, not even as a minimum. The only fact available is the age of the
    // control plane's own row, and it is judged under its own window.
    if (row.createdAgeMs > policy.admissionDeadlineMs) {
      return { verdict: "never_observed", createdAgeMs: row.createdAgeMs };
    }
    return { verdict: "awaiting_first_observation", createdAgeMs: row.createdAgeMs };
  }
  // ★ AND THE OBSERVED ARM DOES NOT CONSULT `createdAgeMs` EITHER. A long-running healthy
  // service is arbitrarily old and observed seconds ago; ageing it against its creation would
  // terminalize every service that outlives the admission window. The two windows read two
  // different columns and never each other's.
  if (row.observedAgeMs > policy.livenessDeadlineMs) {
    return { verdict: "silent", observedAgeMs: row.observedAgeMs };
  }
  return { verdict: "fresh", observedAgeMs: row.observedAgeMs };
}

/** Which verdicts condemn. Split out from the classifier so the four arms stay a
 *  DESCRIPTION of the row and this stays the single place the ACTION is decided. */
export function livenessVerdictTerminalizes(verdict: ServiceInstanceLivenessVerdict): boolean {
  return verdict.verdict === "silent" || verdict.verdict === "never_observed";
}

/**
 * The frozen predecessor set for the deadline's target status, computed from
 * `SERVICE_INSTANCE_TRANSITIONS` through SVC-003a's own `predecessorsOf` rather than
 * hand-listed — so a frozen-table amendment moves this with it.
 *
 * The assertion is not decoration. The sweep reads exactly the NON-TERMINAL instances, so if
 * this set ever failed to cover all six of them the deadline would silently refuse some
 * population of stuck instances as `illegal_transition` and the wedge would come back for
 * them alone — the E9-F004 shape, one door along. Failing at module load makes a frozen-table
 * change that breaks the deadline impossible to ship quietly.
 */
export function livenessDeadlineAllowedFromStatuses(): readonly ServiceInstanceStatus[] {
  return predecessorsOf(SERVICE_LIVENESS_DEADLINE_TO_STATUS);
}

/**
 * The statuses the sweep's population actually contains, DERIVED from the frozen table rather
 * than hand-listed — a status is non-terminal exactly when it has at least one outgoing edge,
 * which is the same derivation `service_instances_live_service_uq`'s predicate and
 * `TERMINAL_SERVICE_INSTANCE_STATUSES` are hand-written copies of. Deriving it here adds no
 * fifth copy.
 */
export function nonTerminalServiceInstanceStatuses(): readonly ServiceInstanceStatus[] {
  return SERVICE_INSTANCE_STATUSES.filter((from) =>
    SERVICE_INSTANCE_STATUSES.some((to) => canTransitionServiceInstanceStatus(from, to)),
  );
}

const uncoveredLiveStatuses = (() => {
  const allowed = new Set(livenessDeadlineAllowedFromStatuses());
  return nonTerminalServiceInstanceStatuses().filter((status) => !allowed.has(status));
})();
if (uncoveredLiveStatuses.length > 0) {
  throw new Error(
    "SVC-003b: the liveness deadline cannot reach " +
      `${SERVICE_LIVENESS_DEADLINE_TO_STATUS} from ${JSON.stringify(uncoveredLiveStatuses)}, ` +
      "so an instance stuck in one of those statuses would be swept and then refused. The " +
      "frozen SERVICE_INSTANCE_TRANSITIONS table changed under this deadline.",
  );
}
