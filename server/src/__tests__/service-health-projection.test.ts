// -----------------------------------------------------------------------------
// SVC-003 — the PURE half of the service-health projection: what a worker observation
// means for the instance row, and which observations mean nothing.
//
// EVERY CASE NAMES THE MUTANT THAT MUST RE-RED IT, because this programme's recurring
// defect is a test that was green before the change and nobody checked.
//
// ★ WHY THIS FILE EXISTS SEPARATELY FROM THE INTEGRATION SUITE. The legality predicate is
// derived from the frozen `SERVICE_INSTANCE_TRANSITIONS` table, and the property that
// matters — "no move OUT of a terminal status is ever offered to the writer" — is decidable
// from the derivation alone. Proving it only through the database would prove it for the
// five statuses the integration suite happens to drive; here it is proven for all nine
// targets against all nine sources, which is the whole table.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  SERVICE_INSTANCE_STATUSES,
  canTransitionServiceInstanceStatus,
} from "@armyofagents/worker-protocol";
import {
  decideServiceProjection,
  predecessorsOf,
} from "../services/service-health-projection.js";
import { SERVICE_HEALTH_ASSERTABLE_STATUSES } from "../../../packages/db/src/repositories/tenant/job-control.js";

const TERMINALS = ["stopped", "failed", "lost"] as const;

const ref = {
  serviceId: "11111111-0000-4000-8000-000000000001",
  serviceInstanceId: "22222222-0000-4000-8000-000000000002",
  generation: 3,
};

describe("SVC-003 — predecessorsOf is derived from the frozen transition table", () => {
  // The derivation is a walk BACKWARDS over the frozen table, so it must (a) admit every
  // direct edge and (b) admit nothing that is not connected to `to` by a legal path at all.
  // Both directions, over the whole 9x9 table.
  //
  // MUTANT: invert the argument order (`canTransition(to, from)`), or replace the frozen
  // helper with a hand-written list.
  it("admits every DIRECT frozen edge, and nothing the frozen table does not connect", () => {
    // Legal reachability, computed independently of the implementation.
    const reaches = new Map<string, Set<string>>();
    for (const from of SERVICE_INSTANCE_STATUSES) {
      const seen = new Set<string>();
      let frontier = [from as string];
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const cur of frontier) {
          for (const to of SERVICE_INSTANCE_STATUSES) {
            if (!canTransitionServiceInstanceStatus(cur as never, to)) continue;
            if (seen.has(to)) continue;
            seen.add(to);
            next.push(to);
          }
        }
        frontier = next;
      }
      reaches.set(from, seen);
    }
    for (const to of SERVICE_INSTANCE_STATUSES) {
      const derived = new Set<string>(predecessorsOf(to));
      for (const from of SERVICE_INSTANCE_STATUSES) {
        if (canTransitionServiceInstanceStatus(from, to)) {
          expect(derived.has(from), `predecessorsOf(${to}) drops the DIRECT edge ${from} -> ${to}`).toBe(true);
        }
        if (derived.has(from)) {
          expect(
            reaches.get(from)!.has(to),
            `predecessorsOf(${to}) admits ${from}, which the frozen table cannot reach ${to} from at all`,
          ).toBe(true);
        }
      }
    }
  });

  // ★★★ THE SPLIT-BRAIN PROPERTY, STATED OVER THE WHOLE TABLE.
  //
  // `service_instances_live_service_uq` is unique on (organization_id, service_id) WHERE
  // status NOT IN ('stopped','failed','lost'). An instance that reached a terminal status
  // has LEFT that index and SVC-002's reconciler has already created its replacement. If any
  // predecessor set contained a terminal, a late event from the dead worker could move the
  // corpse back into the index — two live rows under one partial-unique key. This assertion
  // is what makes "the frozen terminals have no outgoing edges" load-bearing rather than a
  // fact recorded in a comment.
  //
  // MUTANT: add `stopped` to the `healthy` predecessor set (or drop the filter entirely so
  // every status is a predecessor of every status).
  it("★ offers NO terminal status as a predecessor of anything", () => {
    for (const to of SERVICE_INSTANCE_STATUSES) {
      for (const terminal of TERMINALS) {
        expect(
          predecessorsOf(to),
          `${terminal} must never be a legal predecessor of ${to}`,
        ).not.toContain(terminal);
      }
    }
  });

  // MUTANT: return `SERVICE_INSTANCE_STATUSES` unfiltered.
  it("is not the trivial all-statuses answer", () => {
    expect(predecessorsOf("healthy")).toEqual(["starting", "unhealthy"]);
    expect(predecessorsOf("leased")).toEqual(["pending"]);
  });

  // ★★★ E9-F004 — THE CASE REVIEW CAUGHT AND MY FIRST VERSION SHIPPED BROKEN.
  //
  // `SERVICE_INSTANCE_TRANSITIONS` makes `stopping` the SOLE predecessor of `stopped`, and no
  // frozen worker event can assert `stopping`: the supervisor emits `service_instance_stopped`
  // directly on an observed exit, from `healthy` (`runServiceLifecycle`'s `case "process_exited"`
  // arm, `service-lifecycle.ts` ~:293, and `gracefulStop`'s `verdict === "stopped"` branch ~:362
  // after the graceful ladder), and `service_graceful_stop_observed` observes a REQUEST so projecting
  // a process fact from it is the E7-F034 fail-open. With a DIRECT-EDGE predecessor set, every
  // normal service stop was refused as `illegal_transition`, leaving the instance `healthy`
  // inside `service_instances_live_service_uq` where the reconciler can never replace it — the
  // exact opposite of this ticket's purpose. It was invisible because the only end-to-end case
  // drove `service_instance_lost`, which the frozen table makes reachable from everything.
  //
  // MUTANT: revert `predecessorsOf` to the direct-edge filter.
  it("★★★ E9-F004 — `stopped` is reachable from the live states, through unprojectable `stopping`", () => {
    expect(predecessorsOf("stopped")).toEqual(["leased", "starting", "healthy", "unhealthy", "stopping"]);
  });

  // ★ The other half of the rule: traversal goes through states a worker CANNOT witness, never
  // through one it could have sent an event for. `leased` is projectable (`attempt_started`),
  // so `starting` stays reachable only from `leased` — which is what keeps the
  // `attempt_started -> leased` arm load-bearing instead of optional.
  //
  // MUTANT: drop the `UNPROJECTABLE_STATUSES` condition so the walk-back is plain reachability
  // (`starting` then becomes reachable from `pending` too, and mutant 1 below stops killing).
  it("★ does NOT traverse through a status a worker could have asserted", () => {
    expect(predecessorsOf("starting")).toEqual(["leased"]);
    expect(predecessorsOf("healthy")).not.toContain("pending");
    expect(predecessorsOf("healthy")).not.toContain("leased");
  });
});

describe("SVC-003 — the observation -> status mapping", () => {
  // MUTANT: map `service_instance_started` to `healthy` (SVC-008b's emitter docstring says
  // in terms that it asserts `starting` and NOTHING about the process).
  it("maps each witnessing event to the status it actually witnesses", () => {
    expect(decideServiceProjection({ eventType: "service_instance_started", payload: { ...ref, providerResourceId: "sbx-1" } }))
      .toMatchObject({ toStatus: "starting", claim: ref });
    expect(decideServiceProjection({ eventType: "service_health", payload: { ...ref, status: "healthy", detail: null } }))
      .toMatchObject({ toStatus: "healthy" });
    expect(decideServiceProjection({ eventType: "service_health", payload: { ...ref, status: "unhealthy", detail: "probe failed" } }))
      .toMatchObject({ toStatus: "unhealthy" });
    expect(decideServiceProjection({ eventType: "service_instance_stopped", payload: { ...ref, exitCode: 0 } }))
      .toMatchObject({ toStatus: "stopped" });
    expect(decideServiceProjection({ eventType: "service_instance_lost", payload: { ...ref, reason: "sandbox gone" } }))
      .toMatchObject({ toStatus: "lost" });
  });

  // MUTANT: delete the `attempt_started` arm. Without it `pending` is a dead end — the frozen
  // table's only edge into `starting` is from `leased`, and nothing else in the tree writes
  // `leased` — so no instance could ever reach `starting` and the whole projection would be
  // unreachable in production while every other case here stayed green.
  it("★ projects `leased` from attempt_started, with NO claim to check", () => {
    const decided = decideServiceProjection({ eventType: "attempt_started", payload: { sandboxId: "sbx-9" } });
    expect(decided).toMatchObject({ toStatus: "leased", claim: null });
    expect(decided?.allowedFromStatuses).toEqual(["pending"]);
  });

  // MUTANT: project `stopping` from `service_graceful_stop_observed`. That event's frozen
  // payload is `{ref, deadline}` — a stop REQUEST — and asserting a process fact from a
  // request is exactly the E7-F034 fail-open SVC-008a exists to refuse.
  it("★ projects NOTHING for the five events that witness no process fact", () => {
    for (const eventType of [
      "service_graceful_stop_observed",
      "service_checkpoint_prepared",
      "service_checkpoint_restored",
      "service_provider_interrupted",
      "service_provider_resumed",
    ]) {
      expect(
        decideServiceProjection({ eventType, payload: { ...ref, deadline: "2026-01-01T00:00:00.000Z" } }),
        `${eventType} must project no instance status`,
      ).toBeNull();
    }
  });

  // ★★★ E9-F005 — THE SECOND CASE REVIEW CAUGHT. `runServiceLifecycle`'s §4.2a launch comment
  // (`service-lifecycle.ts`, ~:166) says in terms that
  // a launch which resolves no handle emits NO `service_instance_started`, so "the instance
  // never leaves `leased` and the attempt fails". Without this arm the attempt is terminal
  // while the instance sits `leased` inside the live unique index forever and the reconciler
  // can never replace it — E9-F004's permanent wedge through a different door.
  //
  // MUTANT: delete the `terminal` arm (return null for it, as the first version did).
  it("★★★ E9-F005 — a NON-SUCCEEDED attempt terminal is the backstop that terminalizes the instance", () => {
    for (const status of ["failed", "cancelled", "expired"]) {
      const decided = decideServiceProjection({
        eventType: "terminal",
        payload: { status, exitCode: 1, errorCode: null, errorMessage: null },
      });
      expect(decided, `terminal(${status}) must drive the instance terminal`).toMatchObject({
        toStatus: "failed",
        claim: null,
        whenAlreadyTerminal: "noop",
      });
      // `leased` and `pending` — the two stranded states — must both be admitted.
      expect(decided!.allowedFromStatuses).toContain("leased");
      expect(decided!.allowedFromStatuses).toContain("pending");
    }
  });

  // ★ The three bounds that make it a BACKSTOP rather than a second opinion.
  //
  // MUTANT: project `failed` for a `succeeded` terminal too — the projection would then
  // overrule the `service_instance_stopped` observation that already landed.
  it("★ a SUCCEEDED terminal projects nothing, and an unreadable one stalls", () => {
    expect(decideServiceProjection({
      eventType: "terminal",
      payload: { status: "succeeded", exitCode: 0, errorCode: null, errorMessage: null },
    })).toBeNull();
    expect(decideServiceProjection({ eventType: "terminal", payload: { status: "weird" } })).toBeNull();
    expect(decideServiceProjection({ eventType: "terminal", payload: null })).toBeNull();
  });

  // ★★★ `whenAlreadyTerminal: "noop"` IS SET ON EXACTLY ONE ARM. If a service event ever
  // carried it, a late `service_health healthy` on a `lost` instance would report a benign
  // no-op instead of the split-brain refusal — gutting the integration suite's T5 while every
  // other case stayed green.
  //
  // MUTANT: default `whenAlreadyTerminal` to `"noop"` in `project`.
  it("★★★ no SERVICE event may carry whenAlreadyTerminal:\"noop\"", () => {
    for (const event of [
      { eventType: "attempt_started", payload: { sandboxId: "s" } },
      { eventType: "service_instance_started", payload: { ...ref, providerResourceId: "s" } },
      { eventType: "service_health", payload: { ...ref, status: "healthy", detail: null } },
      { eventType: "service_health", payload: { ...ref, status: "unhealthy", detail: null } },
      { eventType: "service_instance_stopped", payload: { ...ref, exitCode: 0 } },
      { eventType: "service_instance_lost", payload: { ...ref, reason: "r" } },
    ]) {
      const decided = decideServiceProjection(event);
      expect(decided, `${event.eventType} projects nothing`).not.toBeNull();
      expect(
        decided!.whenAlreadyTerminal,
        `${event.eventType} must REFUSE on an already-terminal instance`,
      ).toBe("refuse");
    }
  });

  // MUTANT: fall back to a default status (or to the attributed row with no claim) when the
  // ref or the health verdict cannot be read. A definite answer for an unreadable observation
  // is the fail-open SVC-008b's stop-verdict work exists to refuse.
  it("★ STALLS rather than defaulting when the observation cannot be read", () => {
    expect(decideServiceProjection({ eventType: "service_health", payload: { ...ref, status: "degraded" } })).toBeNull();
    expect(decideServiceProjection({ eventType: "service_instance_started", payload: { providerResourceId: "sbx-1" } })).toBeNull();
    expect(decideServiceProjection({ eventType: "service_instance_lost", payload: { ...ref, generation: 1.5 } })).toBeNull();
    expect(decideServiceProjection({ eventType: "service_instance_stopped", payload: null })).toBeNull();
  });
});

describe("SVC-003 — E9-F001: the health-status domain is reconciled with the frozen authority", () => {
  // ★★★ THIS IS THE SECOND HALF OF E9-F001'S RESOLUTION, AND THE HALF THAT WAS MISSING.
  // `SVC-001-result.md` recorded that `ServiceHealthStatus` had been narrowed to remove
  // `"interrupted"`. It had not been, and CI was green, because nothing compared the type to
  // the frozen list — `packages/db` cannot import `worker-protocol`, so the reconciliation
  // has to be a server-side test and there was none. `"interrupted"` was never a member of
  // `SERVICE_INSTANCE_STATUSES` and migration 0264 narrowed the CHECK to the frozen nine, so
  // `recordServiceHealth({healthStatus:"interrupted"})` typechecked and threw 23514 at
  // runtime.
  //
  // MUTANT: re-add `"interrupted"` to `SERVICE_HEALTH_ASSERTABLE_STATUSES` — the exact base
  // state of the tree.
  it("★ every assertable health status is a member of the frozen SERVICE_INSTANCE_STATUSES", () => {
    for (const status of SERVICE_HEALTH_ASSERTABLE_STATUSES) {
      expect(
        SERVICE_INSTANCE_STATUSES as readonly string[],
        `${status} is not a frozen service-instance status; the DB CHECK will reject it`,
      ).toContain(status);
    }
  });

  // The other direction, so a future widening is a DECISION and not a drift. The four
  // omissions each have a reason recorded on the constant; this pins the set so removing one
  // of those reasons cannot happen silently.
  //
  // MUTANT: widen the constant to all nine frozen statuses (which E9-F001's resolution note
  // explicitly refuses as the fix).
  it("★ is exactly the five an OBSERVATION can witness — not the frozen nine", () => {
    expect([...SERVICE_HEALTH_ASSERTABLE_STATUSES]).toEqual([
      "starting", "healthy", "unhealthy", "stopped", "lost",
    ]);
    for (const controlPlaneOnly of ["pending", "leased", "stopping", "failed"]) {
      expect(
        SERVICE_HEALTH_ASSERTABLE_STATUSES as readonly string[],
        `${controlPlaneOnly} is not a worker observation`,
      ).not.toContain(controlPlaneOnly);
    }
  });

  // Every status the projection can ever drive must be storable. `leased` is the one target
  // that is NOT an assertable health status (it comes from `attempt_started`, the control
  // plane's own fact), so it needs its own membership check or a typo there would only
  // surface as a 23514 in production.
  //
  // MUTANT: change the `attempt_started` arm's target to `"leasing"`.
  it("every status the decider can drive is storable by the DB CHECK", () => {
    const drivable = new Set<string>();
    for (const event of [
      { eventType: "attempt_started", payload: { sandboxId: "s" } },
      { eventType: "service_instance_started", payload: { ...ref, providerResourceId: "s" } },
      { eventType: "service_health", payload: { ...ref, status: "healthy", detail: null } },
      { eventType: "service_health", payload: { ...ref, status: "unhealthy", detail: null } },
      { eventType: "service_instance_stopped", payload: { ...ref, exitCode: 0 } },
      { eventType: "service_instance_lost", payload: { ...ref, reason: "r" } },
    ]) {
      const decided = decideServiceProjection(event);
      expect(decided, `${event.eventType} unexpectedly projects nothing`).not.toBeNull();
      drivable.add(decided!.toStatus);
    }
    for (const status of drivable) {
      expect(SERVICE_INSTANCE_STATUSES as readonly string[]).toContain(status);
    }
  });
});
