// run-op-deadline.ts — H1: the per-run provider-op deadline.
//
// THE PROBLEM. `createSupervisor`'s `opDeadlineMs` defaults to 60_000 and the production
// composition (`dispatch-runtime.ts`) never passed it, so 60 s stood for every run. That one
// number is THREE things at once:
//
//   1. the supervisor-side race that bounds `execute` (`withDeadline(..., opDeadlineMs)`),
//   2. the E2B **sandbox TTL** (`e2b-provider.ts` `#ttl(ctx)` → `transport.create({timeoutMs})`
//      plus an idempotent `setTimeout`), and
//   3. the E2B **command timeout** (`transport.runCommand({timeoutMs: ctx.deadlineMs})`).
//
// Meanwhile the job envelope carries `workload.maxRuntimeSeconds` — up to 600 s from the
// server's own builder — and NOTHING read it. So every agent task needing more than a minute
// was killed and terminalized `failed`, with the workload's declared budget silently ignored.
//
// THE CEILING IS NOT ARBITRARY. The run's owned-labels capability expires at
// `min(authorityNow + 5 min, leaseDeadline)` and is **never re-minted on renewal**. Once it
// expires the worker cannot tear its own sandbox down: `convergeNetworked` goes clock-first,
// records `orphaned`, and a BILLABLE sandbox is left running for the server-side reaper. So a
// deadline that runs to the edge of the capability window converts a slow task into a leak.
// The ceiling here sits a full minute under that window, leaving teardown headroom.
//
// (The constant is a documented literal rather than an import: `provider-capability` — where
// `OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS` lives — devDepends on `worker-daemon`, so importing
// it back would be a cycle and would breach the E4-D01 worker closure. Keep the two in step by
// hand; the relationship is asserted in the tests.)

import type { LeaseHandoff } from "../poll/poll-loop.js";

/** The pre-H1 default, kept as a FLOOR. Threading must never SHORTEN a run below what the
 * fleet already tolerated — and, because this value is also the sandbox TTL at `create`, a
 * very small workload budget would otherwise reap the sandbox out from under its own
 * creation. */
export const RUN_OP_DEADLINE_FLOOR_MS = 60_000;

/** The owned-labels capability's default TTL (`OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS`,
 * `server/src/services/owned-labels-mint.ts`). Mirrored, not imported — see the header. */
export const OWNED_LABELS_CAPABILITY_TTL_MS = 300_000;

/** Headroom reserved for teardown INSIDE the capability window: destroy has to happen while
 * the cap still verifies, or the sandbox is recorded `orphaned` and keeps billing. */
export const RUN_TEARDOWN_HEADROOM_MS = 60_000;

/** The ceiling, DERIVED so it cannot drift away from its reason. */
export const RUN_OP_DEADLINE_CEILING_MS =
  OWNED_LABELS_CAPABILITY_TTL_MS - RUN_TEARDOWN_HEADROOM_MS;

/**
 * Resolve the provider-op deadline for one leased run from its own workload.
 *
 * Reads `workload.maxRuntimeSeconds` defensively: the workload crosses the wire as
 * `Record<string, unknown>` on this side of the boundary, and a malformed or absent value must
 * fall back to the floor rather than produce a NaN deadline (which `setTimeout` would fire
 * immediately, killing every run instantly).
 */
export function resolveRunOpDeadlineMs(
  handoff: LeaseHandoff,
  floorMs: number = RUN_OP_DEADLINE_FLOOR_MS,
  ceilingMs: number = RUN_OP_DEADLINE_CEILING_MS,
): number {
  const workload = handoff.offer.job.workload as Record<string, unknown> | null | undefined;
  // SVC-008b §3.3 — THE SERVICE ARM. `serviceWorkloadV1Schema` carries NO time field at all
  // (`gracefulStopSeconds` is a stop budget, not a runtime one), so without this arm every
  // service falls to the 60 s FLOOR and is born with a 60-second sandbox TTL.
  //
  // ★★★ WHERE THIS DEVIATES FROM THE DESIGN, AND WHY. §3.3 specified
  // `min(profile.maxContinuousRuntimeSeconds * 1000, CEILING)` and asserted "the handoff
  // carries the resolved target, so the value is available without a wire change". MEASURED
  // FALSE: the job envelope carries only a provider-constraint REFERENCE
  // (`placement.targetRequirements.providerConstraints` = `{profileId, version, digest}`,
  // `worker-protocol/src/job.ts`), and `maxContinuousRuntimeSeconds` appears NOWHERE on the
  // worker side of the wire — the only readers in the tree are `job-placement.ts` and
  // `job-leasing.ts`, both server-side. Threading it to the supervisor is a wire or a
  // composition change, and SVC-008b does not smuggle one in.
  //
  // So the service budget is the CEILING, and the ceiling is the honest bound anyway: it is
  // `OWNED_LABELS_CAPABILITY_TTL_MS - RUN_TEARDOWN_HEADROOM_MS`, i.e. exactly the window in
  // which the run's effect authority can still tear its own sandbox down (§5.1 clause 3).
  // WHAT IS LOST by dropping the profile clamp: a fleet advertising LESS than 240 s of
  // continuous runtime would get a service budget above its own profile. That is bounded by
  // the server, not by us — `providerDemandFits` (`job-placement.ts`) refuses any candidate
  // whose `maxContinuousRuntimeSeconds` is below the demanded runtime, so such a target is
  // never offered the job in the first place. Recorded rather than papered over.
  if (handoff.offer.job.workloadType === "service") {
    return Math.max(floorMs, ceilingMs);
  }
  const requested = workload?.maxRuntimeSeconds;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return floorMs;
  }
  return Math.min(ceilingMs, Math.max(floorMs, Math.floor(requested) * 1000));
}
