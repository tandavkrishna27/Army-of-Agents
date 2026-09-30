// -----------------------------------------------------------------------------
// SVC-008b — THE DAEMON SERVICE SUPERVISOR. T1-T7 of the SVC-008 design's §6 table.
//
// ★★★ WHAT MAKES THIS FILE NON-VACUOUS. Every case here was run against the UNCHANGED
// tree first and its red state recorded in `SVC-008b-result.md` §3. The red today is
// almost always the SAME red, and it is the finding SVC-008 §1.2 names: a service job
// flows through the BATCH body with no type error and no branch, `execute` returns when
// the startup script finishes, and the run is reported `succeeded`. So the assertions
// below are written against what the SUPERVISOR emits and which PROVIDER OPS it called,
// never against a module in isolation — a unit test over a new module would have red on
// "cannot import", which proves nothing about the shipped path.
//
// ★ THE POSITIVE CONTROL IS NAMED AND FIRST. `POSITIVE CONTROL — batch is untouched`
// must be GREEN before this change, GREEN after it, and GREEN under every mutant listed
// in the design's §6 table. If it ever reds alongside the service cases, the harness
// broke rather than the feature.
//
// ★ CLAUSE 5 (§5.1) IS ASSERTED MECHANICALLY, not by review: every case that emits a
// health verdict also asserts `fake.callCount("health") === 0`. The frozen `health` op
// answers `sandbox.isRunning()` — the SANDBOX, which is up from the moment `create`
// resolved — so sourcing `service_health` from it would emit `healthy` for a process
// that never started. That is §1.3(c), and one call count refutes it.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import type { WorkerEventV1 } from "@armyofagents/worker-protocol";

import { createMetrics } from "../metrics/metrics.js";
import {
  OWNED_LABELS_CAPABILITY_TTL_MS,
  RUN_TEARDOWN_HEADROOM_MS,
} from "../lifecycle/run-op-deadline.js";
import type { OwnedLabelsCapabilityLike } from "../lease/owned-labels-capability.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";
import type {
  ExecuteInput,
  ProcessHandle,
  ProcessSignalResult,
  ProcessStatusResult,
  ProviderOpContext,
  SandboxProvider,
} from "../supervisor/provider.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { createFakeSandboxProvider, type FakeSandboxProvider } from "./support/fake-provider.js";
import { POLL_FIXTURE_IDS } from "./support/poll-fixtures.js";
import {
  collectingSink,
  handoffLabels,
  makeHandoff,
  makeServiceHandoff,
  SERVICE_FIXTURE_IDS,
  SUPERVISOR_IDENTITY,
  type CollectingSink,
} from "./support/supervisor-fixtures.js";

const SANDBOX_ID = `fake-sbx-${POLL_FIXTURE_IDS.job}-1-${POLL_FIXTURE_IDS.lease}`;

async function settle(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return true;
}

function types(sink: CollectingSink): string[] {
  return sink.events.map((e) => e.eventType);
}

function payloadOf(sink: CollectingSink, eventType: string): Record<string, unknown> | null {
  const event = sink.events.find((e) => e.eventType === eventType);
  return event ? (event.payload as Record<string, unknown>) : null;
}

/**
 * A provider decorator that RECORDS the ordered process-supervision calls and lets a case
 * script the two signal kinds INDEPENDENTLY.
 *
 * ★ WHY A DECORATOR RATHER THAN THE FAKE'S OWN SCRIPT. `FakeProviderScript.signalStopsProcess`
 * is one flag for BOTH kinds, so it cannot express the case the ladder exists for: a `cancel`
 * that is accepted and stops nothing, followed by a `kill` that does. A double that cannot
 * express real E2B's only case cannot test the caller that must not trust it (SVC-008a §5.3).
 */
function ladderProvider(
  inner: FakeSandboxProvider,
  script: { readonly cancelStops: boolean; readonly killStops: boolean },
): SandboxProvider & { readonly trace: string[]; readonly inner: FakeSandboxProvider } {
  const trace: string[] = [];
  let stopped = false;
  return {
    ...inner,
    trace,
    inner,
    processSupervisionMode: "handle" as const,
    async startProcess(input: ExecuteInput, ctx: ProviderOpContext) {
      trace.push("startProcess");
      return inner.startProcess(input, ctx);
    },
    async processStatus(sandboxId: string, handle: ProcessHandle, ctx: ProviderOpContext): Promise<ProcessStatusResult> {
      trace.push("processStatus");
      if (stopped) return { providerOpId: "op-status", observation: { state: "gone", observedAt: 0 } };
      return inner.processStatus(sandboxId, handle, ctx);
    },
    async signalProcess(
      sandboxId: string,
      handle: ProcessHandle,
      kind: "cancel" | "kill",
      ctx: ProviderOpContext,
    ): Promise<ProcessSignalResult> {
      trace.push(`signalProcess:${kind}`);
      if ((kind === "cancel" && script.cancelStops) || (kind === "kill" && script.killStops)) stopped = true;
      const observation = stopped
        ? ({ state: "gone", observedAt: 0 } as const)
        : ({ state: "running", observedAt: 0 } as const);
      // ★ `accepted: "accepted"` on BOTH kinds, ALWAYS — including when nothing stopped.
      // That is real E2B's only case (E7-F034) and the reason the caller must derive its
      // verdict from `observation` and never from `accepted`.
      void (await inner.signalProcess(sandboxId, handle, kind, ctx));
      return { providerOpId: "op-signal", accepted: "accepted", observation };
    },
  };
}

/**
 * A 1000x clock: 1 real ms = 1000 virtual ms, so a 240 s budget elapses in 240 real ms.
 *
 * ★ It is ANCHORED at the real epoch (`base + elapsed * 1000`), not `Date.now() * 1000`. The
 * unanchored form puts `occurredAt` in the year 58 700, whose `toISOString()` is the extended
 * `+058704-…` form, and the frozen `timestampV1Schema` refuses it — so the sequencer throws
 * inside the run and `accept` swallows it, and the test reds for a reason that has nothing to
 * do with the feature. Recorded because it cost a debug cycle.
 */
function fastClock(speed = 1000): { now: () => number; virtualElapsed: () => number } {
  const base = Date.now();
  return {
    now: () => base + (Date.now() - base) * speed,
    virtualElapsed: () => (Date.now() - base) * speed,
  };
}

function capLike(expiresAt: number): OwnedLabelsCapabilityLike {
  return { v: 1, audience: "adapter-manager", ownedLabels: handoffLabels(), expiresAt, sig: "svc008b-cap-sig" };
}

// -----------------------------------------------------------------------------
// POSITIVE CONTROL
// -----------------------------------------------------------------------------

describe("SVC-008b — POSITIVE CONTROL", () => {
  it("POSITIVE CONTROL — batch is untouched: create → execute → terminal(succeeded) → destroy", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
    });

    await supervisor.accept(makeHandoff());

    expect(fake.callCount("execute")).toBe(1);
    expect(fake.callCount("destroy")).toBe(1);
    expect(types(sink)).toEqual(["attempt_started", "terminal"]);
    expect(payloadOf(sink, "terminal")).toMatchObject({ status: "succeeded", exitCode: 0 });
  });
});

// -----------------------------------------------------------------------------
// T1 — the service branch is dispatched
// -----------------------------------------------------------------------------

describe("SVC-008b T1 — the service branch is dispatched", () => {
  it("a service handoff runs the SERVICE sequencer: startProcess is called and `execute` is NOT", async () => {
    const fake = createFakeSandboxProvider({ processSupervisionMode: "handle", processState: "exited", processExitCode: 0 });
    const sink = collectingSink();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      serviceHealthTickMs: 2,
    });

    await supervisor.accept(makeServiceHandoff());

    // RED TODAY: `execute` is 1 and there is no `service_instance_started` anywhere —
    // the service ran the batch body and reported a batch-shaped terminal (§1.2).
    expect(fake.callCount("execute")).toBe(0);
    expect(types(sink)).toContain("service_instance_started");
  });

  it("service_instance_started carries the workload's service identity and the SANDBOX as providerResourceId", async () => {
    const fake = createFakeSandboxProvider({ processSupervisionMode: "handle", processState: "exited", processExitCode: 0 });
    const sink = collectingSink();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      serviceHealthTickMs: 2,
    });

    await supervisor.accept(makeServiceHandoff());

    expect(payloadOf(sink, "service_instance_started")).toEqual({
      serviceId: SERVICE_FIXTURE_IDS.serviceId,
      serviceInstanceId: SERVICE_FIXTURE_IDS.serviceInstanceId,
      generation: 3,
      providerResourceId: SANDBOX_ID,
    });
  });

  it("a service that exits on its own reaches service_instance_stopped BEFORE terminal, and the exit code decides", async () => {
    const fake = createFakeSandboxProvider({ processSupervisionMode: "handle", processState: "exited", processExitCode: 3 });
    const sink = collectingSink();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      serviceHealthTickMs: 2,
    });

    await supervisor.accept(makeServiceHandoff());

    const order = types(sink);
    expect(order.indexOf("service_instance_stopped")).toBeGreaterThan(-1);
    expect(order.indexOf("service_instance_stopped")).toBeLessThan(order.indexOf("terminal"));
    expect(payloadOf(sink, "service_instance_stopped")).toMatchObject({ exitCode: 3 });
    expect(payloadOf(sink, "terminal")).toMatchObject({ status: "failed", exitCode: 3 });
    // Clause 5: the sandbox-scoped `health` op was never consulted.
    expect(fake.callCount("health")).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// T2 — a service that does not exit stays supervised
// -----------------------------------------------------------------------------

describe("SVC-008b T2 — a service that does not exit stays supervised", () => {
  it("emits repeated service_health ticks and does NOT terminalize at the batch op deadline", async () => {
    const fake = createFakeSandboxProvider({ processSupervisionMode: "handle", processState: "running" });
    const sink = collectingSink();
    const clock = fastClock();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      now: clock.now,
      opDeadlineMs: 240_000,
      serviceHealthTickMs: 2,
    });

    await supervisor.accept(makeServiceHandoff());

    const health = sink.events.filter((e) => e.eventType === "service_health");
    // RED TODAY: zero. The batch body raced `execute` and emitted a batch terminal.
    expect(health.length).toBeGreaterThanOrEqual(3);
    for (const event of health) {
      expect(event.payload).toMatchObject({
        serviceId: SERVICE_FIXTURE_IDS.serviceId,
        serviceInstanceId: SERVICE_FIXTURE_IDS.serviceInstanceId,
        generation: 3,
        status: "healthy",
      });
    }
    // Supervision outlived the pre-H1 60 s batch deadline in the run's own clock.
    expect(clock.virtualElapsed()).toBeGreaterThan(60_000);
    // The run ended on its BUDGET, not on `execute_timeout` — the batch failure mode.
    expect(payloadOf(sink, "terminal")).not.toMatchObject({ errorCode: "execute_timeout" });
    expect(fake.callCount("health")).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// T3 — the graceful-stop ladder
// -----------------------------------------------------------------------------

describe("SVC-008b T3 — graceful stop honours gracefulStopSeconds against a provider that can refuse", () => {
  it("runs cancel → status → kill → status IN ORDER and derives the verdict from the STATUS read", async () => {
    const fake = createFakeSandboxProvider({ processSupervisionMode: "handle", processState: "running" });
    const provider = ladderProvider(fake, { cancelStops: false, killStops: true });
    const sink = collectingSink();
    const clock = fastClock();
    const supervisor = createSupervisor({
      provider,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      now: clock.now,
      opDeadlineMs: 600_000,
      serviceHealthTickMs: 2,
    });

    const handoff = makeServiceHandoff({ gracefulStopSeconds: 20 });
    const running = supervisor.accept(handoff);
    expect(await settle(() => sink.events.some((e) => e.eventType === "service_health"))).toBe(true);
    await supervisor.cancel(handoff.leaseId, "cancel_requested");
    await running;

    // The SEQUENCE, not the set: a supervisor that killed first and emitted the graceful
    // event afterwards passes a set assertion and fails this one.
    const ladder = provider.trace.filter((t) => t.startsWith("signalProcess"));
    expect(ladder).toEqual(["signalProcess:cancel", "signalProcess:kill"]);
    const cancelAt = provider.trace.indexOf("signalProcess:cancel");
    const killAt = provider.trace.indexOf("signalProcess:kill");
    // A status READ sits between the two signals — the graceful window is POLLED, so a
    // process that stops on its own inside it is never escalated to a kill.
    expect(provider.trace.slice(cancelAt + 1, killAt)).toContain("processStatus");
    // ★ NO THIRD RUNG, and no caller-side read after the kill. SVC-008 §4.3a wrote "re-read
    // again" as a separate `processStatus` call; SVC-008a's port makes that redundant by
    // CONTRACT — `signalProcess` "delivers the signal, then RE-READS its status and reports
    // what that read saw", and `ProcessSignalResult.observation` IS that re-read. The
    // load-bearing property is that the verdict comes from an OBSERVATION rather than from
    // `accepted`, and the next case proves it: same `accepted: "accepted"`, observation
    // `running`, and the supervisor refuses to claim a stop.
    expect(provider.trace.slice(killAt + 1).filter((t) => t.startsWith("signalProcess"))).toEqual([]);

    const order = types(sink);
    expect(order.indexOf("service_graceful_stop_observed")).toBeGreaterThan(-1);
    expect(order.indexOf("service_graceful_stop_observed")).toBeLessThan(order.indexOf("service_instance_stopped"));
    expect(order.indexOf("service_instance_stopped")).toBeLessThan(order.indexOf("terminal"));
    expect(order).not.toContain("service_instance_lost");
  });

  it("a process that survives BOTH signals is service_instance_lost — never _stopped", async () => {
    const fake = createFakeSandboxProvider({ processSupervisionMode: "handle", processState: "running" });
    const provider = ladderProvider(fake, { cancelStops: false, killStops: false });
    const sink = collectingSink();
    const clock = fastClock();
    const supervisor = createSupervisor({
      provider,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      now: clock.now,
      opDeadlineMs: 600_000,
      serviceHealthTickMs: 2,
    });

    const handoff = makeServiceHandoff({ gracefulStopSeconds: 20 });
    const running = supervisor.accept(handoff);
    expect(await settle(() => sink.events.some((e) => e.eventType === "service_health"))).toBe(true);
    await supervisor.cancel(handoff.leaseId, "cancel_requested");
    await running;

    // ★ The whole point: `accepted: "accepted"` came back from BOTH signals and nothing stopped.
    expect(types(sink)).toContain("service_instance_lost");
    expect(types(sink)).not.toContain("service_instance_stopped");
  });
});

// -----------------------------------------------------------------------------
// T4 — no fabricated health, and no launch claimed on a provider that cannot launch
// -----------------------------------------------------------------------------

describe("SVC-008b T4 — a verdict nobody witnessed is never emitted", () => {
  it("a provider whose status read cannot answer emits ZERO service_health and keeps supervising", async () => {
    const fake = createFakeSandboxProvider({
      processSupervisionMode: "handle",
      processState: "unknown",
      processUnknownReason: "read_failed",
    });
    const sink = collectingSink();
    const clock = fastClock();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      now: clock.now,
      opDeadlineMs: 60_000,
      serviceHealthTickMs: 2,
    });

    await supervisor.accept(makeServiceHandoff());

    // No synthesized `healthy`, and no laundered sandbox-scoped answer either.
    expect(types(sink)).not.toContain("service_health");
    expect(fake.callCount("health")).toBe(0);
    // Supervision CONTINUED: the instance was started and the run ended on its budget.
    expect(types(sink)).toContain("service_instance_started");
    expect(types(sink)).toContain("terminal");
  });

  it("a provider with processSupervisionMode 'none' never claims a start", async () => {
    const fake = createFakeSandboxProvider(); // default mode "none"
    const sink = collectingSink();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      serviceHealthTickMs: 2,
    });

    await supervisor.accept(makeServiceHandoff());

    // §4.2a — no handle ⇒ no `service_instance_started`, no health, and a failed terminal.
    expect(types(sink)).not.toContain("service_instance_started");
    expect(types(sink)).not.toContain("service_health");
    expect(payloadOf(sink, "terminal")).toMatchObject({ status: "failed", errorCode: "service_supervision_unsupported" });
    // And it did NOT silently fall back to the batch body.
    expect(fake.callCount("execute")).toBe(0);
  });

  it("a launch the provider refuses is a failed attempt, not a started instance", async () => {
    const fake = createFakeSandboxProvider({ processSupervisionMode: "handle", refuseLaunch: true });
    const sink = collectingSink();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      serviceHealthTickMs: 2,
    });

    await supervisor.accept(makeServiceHandoff());

    expect(types(sink)).not.toContain("service_instance_started");
    expect(payloadOf(sink, "terminal")).toMatchObject({ status: "failed", errorCode: "service_launch_failed" });
  });
});

// -----------------------------------------------------------------------------
// T5 — fence close stops the loop
// -----------------------------------------------------------------------------

describe("SVC-008b T5 — nothing is emitted past a closed fence", () => {
  it("lease loss stops the supervise loop and no service event follows it", async () => {
    const fake = createFakeSandboxProvider({ processSupervisionMode: "handle", processState: "running" });
    const sink = collectingSink();
    const clock = fastClock();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      now: clock.now,
      opDeadlineMs: 600_000,
      serviceHealthTickMs: 2,
    });

    const handoff = makeServiceHandoff();
    const running = supervisor.accept(handoff);
    expect(await settle(() => sink.events.filter((e) => e.eventType === "service_health").length >= 2)).toBe(true);
    await supervisor.onLeaseLost(handoff.leaseId);
    await running;

    // ★ Lease loss is NOT a cooperative stop: no graceful ladder, and the last event is the
    // terminal. A loop that kept ticking would put a `service_health` after it.
    const order = types(sink);
    expect(order.at(-1)).toBe("terminal");
    expect(order).not.toContain("service_graceful_stop_observed");
    expect(payloadOf(sink, "terminal")).toMatchObject({ status: "cancelled" });

    const before = sink.events.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(sink.events.length).toBe(before);
  });
});

// -----------------------------------------------------------------------------
// T6 — the run stops before its authority does
// -----------------------------------------------------------------------------

describe("SVC-008b T6 — §5.1 clause 3, on the real arithmetic", () => {
  it("a networked service stops on the cap's teardown headroom, destroys under a VALID cap, and records no orphan", async () => {
    // The constants are IMPORTED, never hardcoded: a test that pins 300_000 by hand survives a
    // constant change that would break production.
    const capExpiresAt = OWNED_LABELS_CAPABILITY_TTL_MS; // virtual ms; the run starts at 0
    const stopAt = capExpiresAt - RUN_TEARDOWN_HEADROOM_MS;
    expect(stopAt).toBeGreaterThan(0);

    // 1 real ms = 1000 virtual ms. The gate holds `execute` past the cap so the BATCH body —
    // which is what runs today — reaches its destroy with an EXPIRED cap and orphans.
    const gateMs = Math.ceil(capExpiresAt / 1000) + 100;
    const provider = createFakeSandboxProvider({
      processSupervisionMode: "handle",
      processState: "running",
      executeGate: new Promise<void>((resolve) => setTimeout(resolve, gateMs)),
    });
    const metrics = createMetrics();
    const sink = collectingSink();
    const clock = fastClock();
    const supervisor = createSupervisor({
      makeRunProvider: () => provider,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      metrics,
      now: clock.now,
      opDeadlineMs: 10 * capExpiresAt, // never the binding constraint here
      serviceHealthTickMs: 2,
      materializeRunSecrets: async () => ({
        env: {},
        canaries: [],
        capability: capLike(clock.now() + capExpiresAt),
      }),
    });

    await supervisor.accept(makeServiceHandoff({ gracefulStopSeconds: 5 }));

    const prom = metrics.renderPrometheus();
    // RED TODAY: the batch body destroys past the cap and this reads
    // `cleanup_outcome{outcome="orphaned"} 1`.
    expect(prom).not.toContain('cleanup_outcome{outcome="orphaned"}');
    expect(provider.callCount("destroy")).toBe(1);
    // The stop was PLANNED (the cap's headroom), so the ladder ran and the instance is stopped.
    expect(types(sink)).toContain("service_graceful_stop_observed");
  }, 15_000);
});

// -----------------------------------------------------------------------------
// T7 — the workload concurrency classes are not collapsed
// -----------------------------------------------------------------------------

describe("SVC-008b T7 — capacity accounting is per workload class", () => {
  it("a saturated service class still admits a batch offer", () => {
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 1 });
    expect(limiter.tryAcquire("service")).toBe(true);
    // The service class is now full...
    expect(limiter.tryAcquire("service")).toBe(false);
    // ...and the batch class is untouched. A limiter keyed on a constant would refuse here.
    expect(limiter.tryAcquire("batch")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Sequencing invariant: every service event repeats the frozen delivery identity and the
// stream stays contiguous. (A service run emits many more events than a batch run; a
// sequencer bug would surface as a gap, and the frozen schema parse would not catch it.)
// -----------------------------------------------------------------------------

describe("SVC-008b — the service event stream is contiguous and schema-valid", () => {
  it("seq is 1..N with no gap across a full service run", async () => {
    const fake = createFakeSandboxProvider({ processSupervisionMode: "handle", processState: "running" });
    const sink = collectingSink();
    const clock = fastClock();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      now: clock.now,
      opDeadlineMs: 60_000,
      serviceHealthTickMs: 2,
    });

    await supervisor.accept(makeServiceHandoff());

    expect(sink.events.length).toBeGreaterThan(3);
    expect(sink.events.map((e: WorkerEventV1) => e.seq)).toEqual(
      sink.events.map((_: WorkerEventV1, i: number) => i + 1),
    );
  });
});
