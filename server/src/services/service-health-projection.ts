// server/src/services/service-health-projection.ts
//
// SVC-003 — WHAT A SERVICE OBSERVATION MEANS FOR THE INSTANCE ROW.
//
// This module is the whole semantic half of the service-health projection, and it is
// deliberately PURE: one frozen worker event in, one decided projection (or `null`) out, no
// database, no clock, no I/O. The transactional half — attribution, the generation fence, the
// legality predicate and the write — is `applyServiceProjectionForFence` in
// `packages/db/src/repositories/tenant/job-control.ts`.
//
// ── WHY THE DECISION IS MADE HERE AND NOT IN THE REPOSITORY ──────────────────────────────
//
// The authority for a legal service-instance status move is `SERVICE_INSTANCE_TRANSITIONS` in
// `packages/worker-protocol`, and `packages/db` deliberately does not depend on that package
// (the `services` / `service_instances` schema headers say so, and it is why the status CHECK
// and the partial-index predicate are hand-written copies reconciled by a server-side test).
// Re-deriving the table inside the repository would be a FIFTH copy of a frozen list. So the
// server — which owns the frozen helper — computes the predecessor set and hands it down, the
// same shape `commitArtifactVersion` uses for its pre-evaluated `prefixValid`/`tenantValid`.
//
// ★ THIS IS ALSO WHAT ARMS `canTransitionServiceInstanceStatus`. At the base commit that
// exported helper had ZERO production callers — its only references were its own definition,
// the package barrel, and its own unit test. A frozen lifecycle table that nothing consults is
// a clause that is vacuously true. `predecessorsOf` below is its first production consumer.
//
// ── THE MAPPING, WITH THE JUSTIFICATION FOR EVERY LINE ───────────────────────────────────
//
//   attempt_started            -> `leased`     the control plane's own fact. `guardActiveFence`
//                                              has just proven an ACTIVE lease for this
//                                              attempt, and nothing else in the tree writes
//                                              `leased`, so without this arm `pending` is a
//                                              dead end and `starting` is unreachable.
//                                              Carries NO claim (its payload is `{sandboxId}`);
//                                              see `ServiceInstanceProjectionInput.claim`.
//   service_instance_started   -> `starting`   SVC-008b emits it meaning exactly `starting` and
//                                              its docstring says it "asserts `starting` and
//                                              NOTHING about the process".
//   service_health healthy     -> `healthy`    the provider's verdict about the supervised
//   service_health unhealthy   -> `unhealthy`  process, verbatim, from a `processStatus` read.
//   service_instance_stopped   -> `stopped`    the process was OBSERVED gone.
//   service_instance_lost      -> `lost`       the instance can no longer be accounted for.
//
// ── AND THE SIX THAT DELIBERATELY PROJECT NOTHING ────────────────────────────────────────
//
//   service_graceful_stop_observed  A stop REQUEST is not an observation of the process.
//                                   Its frozen payload is `{ref, deadline}` and SVC-008b's own
//                                   emitter docstring says it "claims nothing about the
//                                   process". Moving the row to `stopping` here would assert
//                                   from a request exactly the way E7-F034's
//                                   `ProcessSignalResult.accepted` did — the fail-open
//                                   SVC-008a exists to refuse. SVC-005 owns the request side.
//   service_checkpoint_prepared     Checkpoint policy is SVC-004's, and neither event says
//   service_checkpoint_restored     anything about whether the process is up.
//   service_provider_interrupted    No emitter exists for either (SVC-008b §6.3: `SandboxState`
//   service_provider_resumed        has no suspended inhabitant), so a projection for them
//                                   would be a consumer of something nothing can produce —
//                                   vacuously true, and untestable end to end.
//   terminal / log / usage / …      Attempt-scoped, not instance-scoped.
//
// A worker that wants an instance status it cannot witness therefore has no event that
// produces one. That is the property, not an accident of coverage.

import {
  SERVICE_INSTANCE_STATUSES,
  canTransitionServiceInstanceStatus,
  type ServiceInstanceStatus,
  type WorkerEventV1,
} from "@armyofagents/worker-protocol";
import type { ServiceInstanceProjectionInput } from "@armyofagents/db";

/**
 * ★★★ THE STATUSES NO FROZEN WORKER EVENT CAN ASSERT — and `stopping` being one of them is a
 * REAL CONTRACT MISMATCH between the frozen lifecycle and the shipped daemon (E9-F004).
 *
 * The four here are the complement of §"THE MAPPING" above: `pending` (the reconciler's
 * INSERT), `stopping`, `failed` and — for a while — nothing else. `stopping` is the dangerous
 * one, and it was caught by review rather than by me:
 *
 *   `SERVICE_INSTANCE_TRANSITIONS` makes `stopping` the **sole** predecessor of `stopped`.
 *   The shipped supervisor never passes through it: in `service-lifecycle.ts`,
 *   `runServiceLifecycle`'s `case "process_exited"` arm (~:293) emits
 *   `service_instance_stopped` directly on an observed `exited`/`gone` — from `healthy` — and
 *   `gracefulStop`'s `verdict === "stopped"` branch (~:362) does the same after the graceful
 *   ladder. `service_graceful_stop_observed` cannot
 *   supply it either: its payload is `{ref, deadline}`, it observes a REQUEST, and projecting
 *   a process fact from it is the E7-F034 fail-open this module refuses.
 *
 * So a DIRECT-EDGE predecessor set would refuse **every normal service stop** as
 * `illegal_transition`, leaving the instance `healthy` inside
 * `service_instances_live_service_uq` where SVC-002's reconciler can never replace it. That is
 * the exact opposite of this ticket's purpose, and the first version of this file shipped it —
 * invisible because the only end-to-end case drove `service_instance_lost`, which the frozen
 * table makes reachable from everything.
 */
const UNPROJECTABLE_STATUSES: readonly ServiceInstanceStatus[] = ["pending", "stopping"];

/**
 * Every status from which `to` is reachable by a legal path whose EVERY INTERMEDIATE STEP is a
 * status no event can project. In one sentence: **a worker may skip only the states it cannot
 * witness.**
 *
 * ★ WHY NOT PLAIN REACHABILITY. Unbounded transitive closure would also make `starting`
 * reachable from `pending` (via `leased`), and `leased` IS projectable — `attempt_started`
 * asserts it. Admitting that would make the `attempt_started -> leased` arm optional, i.e. it
 * would delete a real ordering guarantee to fix an unrelated gap. Traversing only through
 * unprojectable states is the narrowest rule that closes E9-F004: it says the worker may not
 * skip a state it had an event for.
 *
 * ★ THE SAFETY PROPERTY IS UNAFFECTED, AND THAT IS WHY THIS IS SAFE AT ANY PATH LENGTH. The
 * three terminal statuses (`stopped`/`failed`/`lost`) have NO OUTGOING EDGES, so no path of any
 * length leaves one, so none of them is ever in a predecessor set. That is the split-brain
 * refusal: an instance that reached `lost` has left `service_instances_live_service_uq` and
 * SVC-002's reconciler has already replaced it, so a late event resurrecting it would put two
 * live rows under one partial-unique key. `stopping` is deliberately NOT terminal, so
 * traversing through it cannot smuggle a terminal in.
 */
export function predecessorsOf(to: ServiceInstanceStatus): readonly ServiceInstanceStatus[] {
  const reached = new Set<ServiceInstanceStatus>();
  // Breadth-first BACKWARDS from `to`. A frontier entry is a status already known reachable-to;
  // we admit its direct predecessors, and keep walking back only THROUGH unprojectable ones.
  let frontier: ServiceInstanceStatus[] = [to];
  const walkedBack = new Set<ServiceInstanceStatus>();
  while (frontier.length > 0) {
    const next: ServiceInstanceStatus[] = [];
    for (const target of frontier) {
      for (const from of SERVICE_INSTANCE_STATUSES) {
        if (!canTransitionServiceInstanceStatus(from, target)) continue;
        if (!reached.has(from)) reached.add(from);
        // Walk back through it ONLY if a worker could never have asserted it directly.
        if (UNPROJECTABLE_STATUSES.includes(from) && !walkedBack.has(from)) {
          walkedBack.add(from);
          next.push(from);
        }
      }
    }
    frontier = next;
  }
  // `to` itself is never its own predecessor: no status has a self-edge, and a same-status
  // replay is handled upstream as `noop_same_status`.
  reached.delete(to);
  return SERVICE_INSTANCE_STATUSES.filter((status) => reached.has(status));
}

/** The service-instance ref every service event payload carries (`serviceInstanceRefShape`). */
interface ServiceRefPayload {
  serviceId: string;
  serviceInstanceId: string;
  generation: number;
}

function claimOf(payload: unknown): ServiceRefPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<ServiceRefPayload>;
  if (typeof p.serviceId !== "string" || typeof p.serviceInstanceId !== "string") return null;
  if (typeof p.generation !== "number" || !Number.isInteger(p.generation)) return null;
  return { serviceId: p.serviceId, serviceInstanceId: p.serviceInstanceId, generation: p.generation };
}

/**
 * Decide the service-instance projection ONE accepted worker event drives, or `null` for the
 * events that drive none.
 *
 * ★ A SERVICE EVENT WHOSE REF CANNOT BE READ RETURNS `null`, WHICH IS A STALL, NOT A DEFAULT.
 * The event is still appended durably and still acknowledged; it simply projects nothing, and
 * the instance keeps whatever status it had. The alternative — projecting with a synthesized
 * ref, or projecting onto the attributed row while ignoring an unreadable claim — would be a
 * definite answer derived from an unreadable observation, which is the fail-open SVC-008b's
 * stop-verdict work exists to refuse. (In practice `workerEventV1Schema` is `.strict()` and
 * has already validated the ref, so this arm is defence in depth rather than a live path.)
 */
export function decideServiceProjection(event: {
  eventType: string;
  payload: unknown;
}): ServiceInstanceProjectionInput | null {
  const project = (
    toStatus: ServiceInstanceStatus,
    claim: ServiceRefPayload | null,
    whenAlreadyTerminal: "refuse" | "noop" = "refuse",
  ): ServiceInstanceProjectionInput => ({
    claim: claim
      ? {
          serviceInstanceId: claim.serviceInstanceId,
          serviceId: claim.serviceId,
          generation: claim.generation,
        }
      : null,
    toStatus: toStatus as ServiceInstanceProjectionInput["toStatus"],
    allowedFromStatuses: predecessorsOf(toStatus),
    whenAlreadyTerminal,
  });

  // The one arm with no claim to read — see the module header and `claim`'s docstring.
  if (event.eventType === "attempt_started") return project("leased", null);

  // ★★★ THE ATTEMPT-TERMINAL BACKSTOP, and the gap it closes is a REAL one (E9-F005).
  //
  // The supervisor emits exactly one of `_stopped`/`_lost` before the attempt `terminal` —
  // WHEN IT GOT THAT FAR. It does not always: `runServiceLifecycle`'s §4.2a launch comment
  // (`service-lifecycle.ts`, ~:166) says in terms that a
  // launch which resolves no handle emits NO `service_instance_started`, so *"the instance
  // never leaves `leased` and the attempt fails"*. Same for a workload rejected before the
  // loop. In those paths the attempt is terminal while the instance sits `pending`/`leased`
  // INSIDE `service_instances_live_service_uq` forever, and SVC-002's reconciler can never
  // replace it — the same permanent wedge as E9-F004, reached by a different door.
  //
  // So a NON-SUCCEEDED attempt terminal drives the instance to `failed`. Three bounds make
  // this a backstop rather than a second opinion:
  //   * `succeeded` projects NOTHING. A service that exited cleanly already emitted
  //     `_stopped`, and re-asserting would be the projection overruling an observation.
  //   * it carries NO claim (the frozen terminal payload has no service ref), so the target is
  //     fixed by (job, attempt) attribution exactly like `attempt_started`.
  //   * `whenAlreadyTerminal: "noop"` — on the NORMAL path the instance is already `stopped`
  //     or `lost` when this arrives, and reporting `illegal_transition` there would be a
  //     refusal on the happy path that drowns the real ones. ★ It is set HERE and NOWHERE
  //     ELSE: every service event keeps `"refuse"`, so the split-brain refusal is untouched.
  if (event.eventType === "terminal") {
    // The null guard is not decoration: `payload` is typed `unknown` here and a bare
    // `(payload as {status}).status` THROWS on null, which inside `toAcceptInputs` would turn
    // a malformed event into a 500 for the whole batch instead of a stall.
    if (!event.payload || typeof event.payload !== "object") return null;
    const status = (event.payload as { status?: unknown }).status;
    if (status === "succeeded") return null;
    // An unreadable terminal status is a stall, not an assumed failure.
    if (status !== "failed" && status !== "cancelled" && status !== "expired") return null;
    return project("failed", null, "noop");
  }

  const claim = claimOf(event.payload);
  if (!claim) return null;

  switch (event.eventType) {
    case "service_instance_started":
      return project("starting", claim);
    case "service_health": {
      const status = (event.payload as { status?: unknown }).status;
      // The frozen `SERVICE_HEALTH_STATUSES` are exactly these two. An unreadable verdict is
      // not projected — same reasoning as an unreadable ref.
      if (status === "healthy") return project("healthy", claim);
      if (status === "unhealthy") return project("unhealthy", claim);
      return null;
    }
    case "service_instance_stopped":
      return project("stopped", claim);
    case "service_instance_lost":
      return project("lost", claim);
    default:
      return null;
  }
}

/** Narrow overload for a fully typed frozen event, so callers keep their discrimination. */
export function decideServiceProjectionForEvent(
  event: WorkerEventV1,
): ServiceInstanceProjectionInput | null {
  return decideServiceProjection({ eventType: event.eventType, payload: event.payload });
}
