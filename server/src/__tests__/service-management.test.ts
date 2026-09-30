// -----------------------------------------------------------------------------
// SVC-007 (Unit A) — the create-definition boundary and the desired-state control, purely.
//
// EVERY CASE NAMES THE MUTANT THAT MUST RE-RED IT, and `SVC-007a-result.md` records which
// did. This programme's recurring defect is a test that was green before the change and
// nobody checked.
//
// ★ WHY THE TRANSITION CASES WALK THE WHOLE 4x4 TABLE RATHER THAN A FEW EXAMPLES. E9-F004 is
// exactly this mistake one lifecycle over: SVC-003a proved its instance-transition predicate
// over the transitions its suite happened to exercise, the one terminal it drove was the one
// reachable from everywhere, and a predicate that refused EVERY NORMAL SERVICE STOP survived
// a named positive control and thirteen killed mutants. A lifecycle table proven over a
// sample is not proven over the table.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  SERVICE_DESIRED_STATES,
  canTransitionServiceDesiredState,
  serviceWorkloadV1Schema,
  type ServiceDesiredState,
} from "@armyofagents/worker-protocol";
import { SERVICE_INGRESS_DENY_KEYS } from "../services/service-job-config.js";
import { decideServiceProjection } from "../services/service-health-projection.js";
import {
  CONTROLLABLE_DESIRED_STATES,
  CREATABLE_DESIRED_STATES,
  SERVICE_CONTROL_PLANE_OWNED_WORKLOAD_FIELDS,
  SERVICE_DEFINITION_FIELDS,
  normalizeServiceDefinition,
  setServiceDesiredStateWithinTenant,
} from "../services/service-management.js";

const ORG = "b1000000-0000-4000-8000-000000000001";
const COMPANY = "b1000000-0000-4000-8000-000000000002";
const SERVICE = "b1000000-0000-4000-8000-000000000003";
const VALID = { command: "node", args: ["queue-worker.js"], gracefulStopSeconds: 30 };

describe("SVC-007 — the create definition boundary", () => {
  // MUTANT: delete the `.strict()` on `serviceDefinitionSchema`.
  it("P1 — a definition carrying exactly the three frozen non-identity fields is accepted", () => {
    const result = normalizeServiceDefinition({ ...VALID });
    expect(result.ok, "the positive branch must actually accept").toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(VALID);
    expect(Object.keys(result.value).sort()).toEqual([...SERVICE_DEFINITION_FIELDS].sort());
  });

  // MUTANT: drop the ingress loop, or replace SERVICE_INGRESS_DENY_KEYS with a local list.
  //
  // Driven over the SHIPPED deny-set rather than a copied literal: SVC-001 owns that list,
  // and a key added there must be refused here without anyone editing this file.
  it("P2 — every key in the shipped ingress deny-set is refused, with the reason that names the policy", () => {
    expect(SERVICE_INGRESS_DENY_KEYS.length, "the deny-set must not be empty").toBeGreaterThan(0);
    for (const key of SERVICE_INGRESS_DENY_KEYS) {
      const result = normalizeServiceDefinition({ ...VALID, [key]: 8080 });
      expect(result.ok, `${key} must be refused`).toBe(false);
      if (result.ok) continue;
      expect(result.reason, key).toBe("ingress_configuration_rejected");
    }
  });

  // MUTANT: delete the control-plane-owned loop — `serviceInstanceId` then falls through to
  // `unknown_field`, which still refuses, so this case pins the REASON as well as the refusal.
  // Collapsing the two reasons would let the loop be deleted with nothing going red.
  it("P3 — every control-plane-owned workload field is refused by its own reason", () => {
    expect(SERVICE_CONTROL_PLANE_OWNED_WORKLOAD_FIELDS).toContain("serviceInstanceId");
    for (const key of SERVICE_CONTROL_PLANE_OWNED_WORKLOAD_FIELDS) {
      const result = normalizeServiceDefinition({ ...VALID, [key]: "b1000000-0000-4000-8000-00000000000f" });
      expect(result.ok, `${key} must be refused`).toBe(false);
      if (result.ok) continue;
      expect(result.reason, key).toBe("control_plane_owned_field");
    }
  });

  // MUTANT: accept unknown fields (drop the SERVICE_DEFINITION_FIELDS membership loop).
  it("P4 — an unrecognised field is refused, and a non-object is refused before anything else", () => {
    expect(normalizeServiceDefinition({ ...VALID, retries: 3 })).toEqual({
      ok: false,
      reason: "unknown_field",
    });
    for (const raw of [null, undefined, 7, "node", ["node"]]) {
      expect(normalizeServiceDefinition(raw)).toEqual({ ok: false, reason: "not_an_object" });
    }
  });

  // MUTANT: relax the pick to a hand-written z.object without the frozen bounds.
  it("P5 — the FROZEN bounds are the authority, not a local re-statement", () => {
    const rejected = [
      { ...VALID, command: "" },
      { ...VALID, command: "x".repeat(257) },
      { ...VALID, args: "not-an-array" },
      { ...VALID, args: [1, 2] },
      { ...VALID, gracefulStopSeconds: 0 },
      { ...VALID, gracefulStopSeconds: 301 },
      { ...VALID, gracefulStopSeconds: 1.5 },
      { command: "node", args: [] },
    ];
    for (const raw of rejected) {
      const result = normalizeServiceDefinition(raw);
      expect(result.ok, JSON.stringify(raw).slice(0, 60)).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("frozen_schema_rejected");
    }
    // …and the bounds' own edges are accepted, so the case is not vacuously refusing.
    expect(normalizeServiceDefinition({ ...VALID, gracefulStopSeconds: 1 }).ok).toBe(true);
    expect(normalizeServiceDefinition({ ...VALID, gracefulStopSeconds: 300 }).ok).toBe(true);
    expect(normalizeServiceDefinition({ ...VALID, args: [] }).ok).toBe(true);
  });

  // MUTANT: add a field to SERVICE_DEFINITION_FIELDS that the frozen schema does not have,
  // or drop one of the four control-plane-owned names. Both make the module throw at load —
  // which is the intended outcome, and this case states the property independently so a
  // future edit to the guard cannot quietly weaken it.
  it("P6 — the partition of the frozen workload is EXHAUSTIVE and DISJOINT", () => {
    const frozen = Object.keys(serviceWorkloadV1Schema.shape).sort();
    const declared = [
      ...SERVICE_DEFINITION_FIELDS,
      ...SERVICE_CONTROL_PLANE_OWNED_WORKLOAD_FIELDS,
    ].sort();
    expect(declared).toEqual(frozen);
    expect(new Set(declared).size).toBe(declared.length);
  });

  // MUTANT: add "deleted" to either list.
  it("P7 — both state lists are subsets of the frozen authority, and neither admits `deleted`", () => {
    for (const state of [...CREATABLE_DESIRED_STATES, ...CONTROLLABLE_DESIRED_STATES]) {
      expect(SERVICE_DESIRED_STATES).toContain(state);
    }
    expect(CREATABLE_DESIRED_STATES).not.toContain("deleted");
    expect(CONTROLLABLE_DESIRED_STATES).not.toContain("deleted");
    // `stopped` is controllable but not creatable: a service created stopped never ran.
    expect(CONTROLLABLE_DESIRED_STATES).toContain("stopped");
    expect(CREATABLE_DESIRED_STATES).not.toContain("stopped");
  });
});

// ── The desired-state control, over a repository stub ─────────────────────────────────────
//
// ★ NO `vi.mock` OF THE TENANT CONTEXT ANY MORE, and that is a consequence of the review fix
// rather than a style change. The control is now ONE transaction, so `setServiceDesiredState`
// is a two-line wrapper and every decision — verdict, cancellation, terminalization — lives in
// `setServiceDesiredStateWithinTenant`, which takes `repos` directly. A stub repository is the
// whole harness.

interface StubOptions {
  service: { desiredState: string; generation: number } | null;
  updateReturns?: { desiredState: string; generation: number } | null;
  instance?: { serviceInstanceId: string; status: string; jobId: string | null } | null;
  cancellation?: { status: string };
  cancelThrows?: boolean;
  terminalize?: { outcome: string };
}

function stubRepos(input: StubOptions) {
  const updates: unknown[] = [];
  const cancellations: unknown[] = [];
  const terminalizations: unknown[] = [];
  const repos = {
    jobControl: {
      async lockServiceForReconcile() {
        return input.service;
      },
      async updateServiceDesiredState(values: unknown) {
        updates.push(values);
        return input.updateReturns === undefined
          ? { desiredState: (values as { desiredState: string }).desiredState, generation: input.service?.generation ?? 1 }
          : input.updateReturns;
      },
      async findLiveServiceInstance() {
        return input.instance ?? null;
      },
      async currentDatabaseTime() {
        return new Date("2026-09-10T12:00:00.000Z");
      },
      async requestCancellation(values: unknown) {
        cancellations.push(values);
        if (input.cancelThrows) throw new Error("cancellation channel unavailable");
        return input.cancellation ?? { status: "cancelled", command: null };
      },
      async terminalizeServiceInstanceForCancelledAttempt(values: unknown) {
        terminalizations.push(values);
        return input.terminalize ?? { outcome: "applied" };
      },
    },
  };
  return { repos, updates, cancellations, terminalizations };
}

/**
 * SVC-007 Unit B — the audit context the control now REQUIRES.
 *
 * ★ The recorder is deliberately not asserted on in THIS file. What each verdict does to the
 * audit is `service-control-audit.test.ts`'s subject (B7-B9); this file's subject is the
 * verdict itself, and the two are kept apart so a change to one cannot quietly re-green the
 * other. The `tx` implements exactly the chain `insertActivityLog` uses and nothing else.
 */
function auditContext() {
  const tx = {
    insert() {
      return { values() { return { async returning() { return [{ id: "activity-stub" }]; } }; } };
    },
  };
  return {
    tx: tx as never,
    actor: { actorType: "user" as const, actorId: "operator-1" },
    published: [],
  };
}

async function control(repos: unknown, desiredState: string, reason = "operator") {
  return setServiceDesiredStateWithinTenant(repos as never, {
    organizationId: ORG, companyId: COMPANY, serviceId: SERVICE,
    desiredState: desiredState as ServiceDesiredState, reason,
  }, auditContext());
}

describe("SVC-007 — the desired-state control is fenced by the FROZEN transition table", () => {
  // MUTANT: return `absent` as a thrown 500, or resolve a missing service to a default state.
  it("P8a — an absent service is a definite `absent`, and nothing is written or cancelled", async () => {
    const s = stubRepos({ service: null, instance: { serviceInstanceId: "i", status: "pending", jobId: "j" } });
    const result = await control(s.repos, "stopped");
    expect(result.verdict).toEqual({ outcome: "absent" });
    expect(result.stop).toBeNull();
    expect(s.updates).toEqual([]);
    expect(s.cancellations).toEqual([]);
  });

  // MUTANT: delete the same-state short-circuit. The FROZEN table has NO self-edges, so
  // running->running would then answer `illegal` — a satisfiable request refused, and the
  // re-issue path that re-requests the cancellation (P10b) unreachable.
  it("P8b — re-issuing the current state is `unchanged` and writes no desired-state row", async () => {
    const s = stubRepos({ service: { desiredState: "stopped", generation: 4 } });
    const result = await control(s.repos, "stopped");
    expect(result.verdict).toEqual({ outcome: "unchanged", state: "stopped", generation: 4 });
    expect(s.updates).toEqual([]);
  });

  // MUTANT: drop the compare-and-set predicate's failure branch (treat `null` as success).
  it("P8c — a compare-and-set that matched no row is a reported `conflict`, never a silent success", async () => {
    const s = stubRepos({
      service: { desiredState: "running", generation: 1 },
      updateReturns: null,
      instance: { serviceInstanceId: "i", status: "pending", jobId: "j" },
    });
    const result = await control(s.repos, "stopped");
    expect(result.verdict).toEqual({ outcome: "conflict", from: "running", to: "stopped" });
    expect(result.stop, "a conflict must not cancel anything").toBeNull();
    expect(s.cancellations).toEqual([]);
  });

  // MUTANT: pass an unrecognised stored state straight to the frozen predicate as a cast.
  it("P8d — a stored desired_state outside the frozen list has NO legal move", async () => {
    const s = stubRepos({ service: { desiredState: "zombie", generation: 1 } });
    const result = await control(s.repos, "running");
    expect(result.verdict).toEqual({ outcome: "illegal", from: "zombie", to: "running" });
    expect(s.updates).toEqual([]);
  });

  // ★ MUTANT: replace `canTransitionServiceDesiredState` with `() => true`, or with a
  // hand-written edge list. This case walks EVERY (from, to) pair the control can be asked
  // for — 4 stored states x 3 controllable targets — and demands the verdict agree with the
  // frozen predicate on each. E9-F004's lesson, applied to the other lifecycle.
  it("★ P9 — the WHOLE 4x3 table agrees with the frozen predicate, edge for edge", async () => {
    const seen: string[] = [];
    for (const from of SERVICE_DESIRED_STATES) {
      for (const to of CONTROLLABLE_DESIRED_STATES) {
        const s = stubRepos({ service: { desiredState: from, generation: 2 } });
        const result = await control(s.repos, to);
        seen.push(`${from}->${to}:${result.verdict.outcome}`);
        if (from === to) {
          expect(result.verdict.outcome, `${from}->${to}`).toBe("unchanged");
          expect(s.updates, `${from}->${to}`).toEqual([]);
          continue;
        }
        const legal = canTransitionServiceDesiredState(from as ServiceDesiredState, to);
        expect(result.verdict.outcome, `${from}->${to} (frozen says ${legal})`)
          .toBe(legal ? "updated" : "illegal");
        expect(s.updates.length, `${from}->${to} writes`).toBe(legal ? 1 : 0);
      }
    }
    // Anti-vacuity: the table must contain BOTH answers, or a predicate stuck on one of them
    // would pass every assertion above.
    expect(seen.filter((row) => row.endsWith(":updated")).length).toBeGreaterThan(0);
    expect(seen.filter((row) => row.endsWith(":illegal")).length).toBeGreaterThan(0);
    expect(seen).toContain("deleted->running:illegal");
    expect(seen).toContain("stopped->paused:illegal");
    expect(seen).toContain("stopped->running:updated");
  });
});

// ── The stop side effects, in the SAME transaction as the verdict ─────────────────────────

describe("SVC-007 — the stop control reaches the shipped cancellation channel", () => {
  // ★ MUTANT: delete the `requestCancellation` call. The desired-state column still moves,
  // every verdict assertion above stays green, and `stop` becomes a button that does nothing.
  it("P10a — stopping a service with a live instance asks THAT instance's job to stop, gracefully", async () => {
    const s = stubRepos({
      service: { desiredState: "running", generation: 1 },
      instance: { serviceInstanceId: "inst-1", status: "pending", jobId: "job-1" },
    });
    const result = await control(s.repos, "stopped", "budget");
    expect(s.cancellations).toHaveLength(1);
    expect(s.cancellations[0]).toMatchObject({
      organizationId: ORG, companyId: COMPANY, jobId: "job-1", reason: "budget", graceful: true,
    });
    expect(result.stop).toEqual({
      status: "requested", serviceInstanceId: "inst-1", jobId: "job-1",
      cancellation: "cancelled", instance: "applied",
    });
  });

  // ★★★ MUTANT: delete the `terminalizeServiceInstanceForCancelledAttempt` call. Every
  // assertion about the desired-state column and the cancellation stays green, and the
  // instance is stranded non-terminal inside `service_instances_live_service_uq` forever —
  // so a later resume converges NOTHING on every tick (E9-F006).
  it("★ P10a2 — the stop ALSO drives the control-plane attempt-terminal backstop, with the frozen mapping", async () => {
    const s = stubRepos({
      service: { desiredState: "running", generation: 1 },
      instance: { serviceInstanceId: "inst-1", status: "pending", jobId: "job-1" },
    });
    await control(s.repos, "stopped");
    expect(s.terminalizations).toHaveLength(1);
    const call = s.terminalizations[0] as { toStatus: string; allowedFromStatuses: string[]; jobId: string };
    expect(call.jobId).toBe("job-1");
    // The mapping is READ from the worker path's own decider, so it must equal what that
    // decider answers for the same attempt status — not a value restated here.
    const fromDecider = decideServiceProjection({ eventType: "terminal", payload: { status: "cancelled" } });
    expect(fromDecider, "the decider must project something for a cancelled attempt").not.toBeNull();
    expect(call.toStatus).toBe(fromDecider!.toStatus);
    expect(call.allowedFromStatuses).toEqual(fromDecider!.allowedFromStatuses);
    expect(call.allowedFromStatuses.length).toBeGreaterThan(0);
  });

  // ★ MUTANT: short-circuit the cancellation on `unchanged`. "Already stopped" does not imply
  // "nothing is running": a reconcile pass that began before an earlier stop can commit an
  // instance after that stop moved the column. Without this arm the operator has no way to
  // reach such an instance again and the button reports success while doing nothing.
  it("★ P10b — re-issuing a stop that changed nothing STILL re-requests the cancellation", async () => {
    const s = stubRepos({
      service: { desiredState: "stopped", generation: 1 },
      instance: { serviceInstanceId: "inst-1", status: "pending", jobId: "job-1" },
    });
    const result = await control(s.repos, "stopped", "retry");
    expect(s.updates, "no desired-state write").toEqual([]);
    expect(s.cancellations, "but the cancellation IS re-issued").toHaveLength(1);
    expect(result.stop?.status).toBe("requested");
  });

  // MUTANT: run the cancellation for every target state.
  it("P10c — resuming never cancels anything, and a refused verdict never does either", async () => {
    for (const from of ["stopped", "running"]) {
      const s = stubRepos({
        service: { desiredState: from, generation: 1 },
        instance: { serviceInstanceId: "i", status: "pending", jobId: "j" },
      });
      const result = await control(s.repos, "running", "resume");
      expect(s.cancellations, from).toEqual([]);
      expect(result.stop, from).toBeNull();
    }
    // …and `deleted` has no outgoing edge, so a stop from there is refused before any effect.
    const refused = stubRepos({
      service: { desiredState: "deleted", generation: 1 },
      instance: { serviceInstanceId: "i", status: "pending", jobId: "j" },
    });
    const result = await control(refused.repos, "stopped");
    expect(result.verdict).toMatchObject({ outcome: "illegal" });
    expect(refused.cancellations).toEqual([]);
    expect(refused.terminalizations).toEqual([]);
  });

  // ★★★ MUTANT: catch the cancellation error and return a partial success. Under ONE
  // transaction a throw here rolls the desired-state write back with it, which is the whole
  // point of the review fix (PR #412, P1): the operator gets one definite answer instead of
  // "the column moved but the thing is still running". Swallowing it would re-create exactly
  // the split outcome the single transaction removed.
  it("★ P10d — a failing cancellation PROPAGATES, so the desired-state write rolls back with it", async () => {
    const s = stubRepos({
      service: { desiredState: "running", generation: 1 },
      instance: { serviceInstanceId: "inst-1", status: "pending", jobId: "job-1" },
      cancelThrows: true,
    });
    await expect(control(s.repos, "stopped")).rejects.toThrow("cancellation channel unavailable");
    expect(s.terminalizations, "nothing runs after the failure").toEqual([]);
  });

  // MUTANT: treat a missing `job_id` as "already stopped". An instance whose attribution
  // write has not committed yet has no job to cancel, and saying so is the honest answer.
  it("P10e — no live instance, and an instance with no job, are distinct reported answers", async () => {
    const none = stubRepos({ service: { desiredState: "running", generation: 1 }, instance: null });
    expect((await control(none.repos, "stopped")).stop).toEqual({ status: "no_instance" });
    expect(none.cancellations).toEqual([]);

    const unattributed = stubRepos({
      service: { desiredState: "running", generation: 1 },
      instance: { serviceInstanceId: "inst-9", status: "pending", jobId: null },
    });
    expect((await control(unattributed.repos, "stopped")).stop)
      .toEqual({ status: "no_job", serviceInstanceId: "inst-9" });
    expect(unattributed.cancellations).toEqual([]);
  });
});
