import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  leaseOfferV1Schema,
  registeredTargetProfileV1Schema,
  verifyAndBrandProviderConstraintProfileV1,
  type WorkerCapacity,
} from "@armyofagents/worker-protocol";

import { composeDispatchRuntime, type ComposeDispatchRuntimeDeps } from "../lifecycle/dispatch-runtime.js";
import { buildDesktopHello } from "../enrollment/desktop-hello.js";
import { deriveHelloProvisioning } from "../enrollment/hello-provisioning.js";
import { offerSatisfiesWorker, type CapacityProbes, type WorkerSelfModel } from "../poll/capacity.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { generateDeviceKey } from "../identity/device-key.js";
import {
  OWNED_LABELS_CAPABILITY_TTL_MS,
  RUN_OP_DEADLINE_CEILING_MS,
  RUN_OP_DEADLINE_FLOOR_MS,
  RUN_TEARDOWN_HEADROOM_MS,
  resolveRunOpDeadlineMs,
} from "../lifecycle/run-op-deadline.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../tests/fixtures/worker-provisioned-target.json", import.meta.url)),
    "utf8",
  ),
) as { registeredProfile: Record<string, unknown>; providerConstraintProfile: Record<string, unknown>; leaseOffer: unknown };

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const NAMEPLATE: WorkerCapacity = {
  batchSlots: 1, browserSessionSlots: 0, serviceSlots: 0,
  freeCpuMillis: 2000, freeMemoryMiB: 4096, freeDiskMiB: 8192,
};
// Probes reporting far ABOVE the fixture ceiling (cpu 2000 / mem 4096 / disk 8192), so the
// clamp is observable regardless of the test host's real resources.
const HUGE_PROBES: CapacityProbes = {
  freeCpuMillis: () => 999_999,
  freeMemoryMiB: () => 999_999,
  freeDiskMiB: () => 999_999,
};

async function provisionedSelf(): Promise<WorkerSelfModel> {
  const provisioning = deriveHelloProvisioning({
    selfModelResponse: { registeredProfile: fixture.registeredProfile, providerConstraintProfile: fixture.providerConstraintProfile },
    isolation: "none",
    capacity: NAMEPLATE,
  });
  const report = buildDesktopHello({
    workerId: "00000000-0000-4000-8000-000000000001",
    targetId: fixture.registeredProfile.targetId as string,
    deviceGeneration: 1,
    platform: "linux",
    arch: "x64",
    provisioning: provisioning!,
  });
  const verified = await verifyAndBrandProviderConstraintProfileV1(fixture.providerConstraintProfile, sha256);
  return {
    registeredTargetProfile: registeredTargetProfileV1Schema.parse(fixture.registeredProfile),
    verifiedProviderConstraints: verified!,
    report,
  };
}

/** Fake factories that capture the deps composeDispatchRuntime passes, and record the order. */
function harness() {
  const order: string[] = [];
  const captured: Record<string, unknown> = {};
  const sinkSentinel = { emit: () => {}, __sink: true } as never;
  const supSentinel = { accept: () => {}, cancel: () => {}, onLeaseLost: () => {}, shutdown: () => {}, activeRunCount: () => 0, __sup: true } as never;
  const driverSentinel = { accept: () => {}, stop: () => {}, activeRenewalCount: () => 0, proxyFor: () => undefined, __driver: true } as never;
  // JOB-015 (V3): `stopLeasing` RECORDS, so the composed drain handler can be proven to
  // reach it with a real call rather than by the type checker agreeing the port exists.
  const stopLeasingCalls: string[] = [];
  const pollSentinel = {
    run: async () => ({ kind: "stopped" }),
    stopLeasing: () => { stopLeasingCalls.push("stopLeasing"); },
    drain: async () => {},
    activeLeaseCount: () => 0,
  } as never;

  const seams: Partial<ComposeDispatchRuntimeDeps> = {
    probes: HUGE_PROBES,
    openStore: (async (o: unknown) => { order.push("openStore"); captured.storeOpts = o; return { close: () => {}, __store: true } as never; }) as never,
    makeSink: ((d: { store: unknown; kek: unknown }) => { order.push("makeSink"); captured.sinkStore = d.store; captured.sinkKek = d.kek; return sinkSentinel; }) as never,
    makeDrain: ((d: { kek: unknown }) => { order.push("makeDrain"); captured.drainKek = d.kek; return { recover: () => { order.push("recover"); return 0; }, start: () => { order.push("drainStart"); }, stop: () => {}, drainOnce: async () => ({}), flush: async () => {} } as never; }) as never,
    makeSupervisor: ((d: { eventSink: unknown; redactionCanaries: unknown; observeRun?: unknown; opDeadlineMs?: unknown }) => { order.push("makeSupervisor"); captured.supEventSink = d.eventSink; captured.redactionCanaries = d.redactionCanaries; captured.observeRun = d.observeRun; captured.opDeadlineMs = d.opDeadlineMs; return supSentinel; }) as never,
    makeDriver: ((d: { eventSink: unknown; supervisor: unknown; schedule: unknown; controlHandlers?: unknown }) => { order.push("makeDriver"); captured.driverEventSink = d.eventSink; captured.driverSupervisor = d.supervisor; captured.driverSchedule = d.schedule; captured.driverControlHandlers = d.controlHandlers; return driverSentinel; }) as never,
    makePollLoop: ((d: { supervisor: unknown; self: unknown; measure: unknown }) => { order.push("makePollLoop"); captured.pollSupervisor = d.supervisor; captured.pollSelf = d.self; captured.pollMeasure = d.measure; captured.pollRun = () => { order.push("pollRun"); }; return { ...pollSentinel, run: async () => { order.push("pollRun"); return { kind: "stopped" }; } } as never; }) as never,
    makeSchedule: (() => ({ __schedule: true }) as never) as never,
  };
  return { order, captured, seams, sinkSentinel, driverSentinel, stopLeasingCalls };
}

async function compose(extra?: Partial<ComposeDispatchRuntimeDeps>) {
  const self = await provisionedSelf();
  const h = harness();
  const runtime = await composeDispatchRuntime({
    provider: createFakeSandboxProvider({}),
    self,
    key: generateDeviceKey(),
    store: {} as never,
    client: {} as never,
    eventOutboxPath: "/tmp/outbox.db",
    concurrency: { batch: 3, browser: 2, service: 1 },
    backoff: { baseMs: 1, maxMs: 2, jitter: 0 } as never,
    workDir: "/tmp",
    ...h.seams,
    ...extra,
  });
  return { runtime, ...h, self };
}

describe("composeDispatchRuntime — the composition wiring", () => {
  it("★ the poll loop leases through the RENEWAL DRIVER, not the raw supervisor", async () => {
    const { captured, driverSentinel, runtime } = await compose();
    expect(captured.pollSupervisor).toBe(driverSentinel);
    expect(runtime.loopSupervisorSeam).toBe(driverSentinel);
    expect(captured.pollSupervisor).not.toBe(captured.driverSupervisor); // the driver DECORATES the supervisor
  });

  it("★ recovery happens BEFORE the supervisor can emit (recover precedes makeSupervisor)", async () => {
    const { order } = await compose();
    expect(order.indexOf("recover")).toBeLessThan(order.indexOf("makeSupervisor"));
    expect(order.indexOf("recover")).toBeGreaterThan(-1);
  });

  it("★ the SAME event sink goes to BOTH the supervisor and the driver", async () => {
    const { captured, sinkSentinel } = await compose();
    expect(captured.supEventSink).toBe(sinkSentinel);
    expect(captured.driverEventSink).toBe(sinkSentinel);
    expect(captured.driverEventSink).toBe(captured.supEventSink);
  });

  it("★ the KEK reaches the sink (not only the drain)", async () => {
    const { captured } = await compose();
    expect(captured.sinkKek).toBeInstanceOf(Buffer);
    expect(captured.drainKek).toBeInstanceOf(Buffer);
    expect(captured.sinkKek).toEqual(captured.drainKek);
  });

  it("★ redactionCanaries is [] and observeRun is undefined (nothing to redact)", async () => {
    const { captured } = await compose();
    expect(captured.redactionCanaries).toEqual([]);
    expect(captured.observeRun).toBeUndefined();
  });

  it("★ capacity is CLAMPED to the server-owned provider ceiling", async () => {
    const { runtime } = await compose();
    const cap = runtime.measure();
    // Fixture ceiling: cpu 2000, mem 4096, disk 8192 — the huge probes are clamped down to it.
    expect(cap.freeCpuMillis).toBe(2000);
    expect(cap.freeMemoryMiB).toBe(4096);
    expect(cap.freeDiskMiB).toBe(8192);
  });

  it("★ measure() reads the limiter LIVE (not a constant snapshot)", async () => {
    const { runtime } = await compose();
    expect(runtime.measure().batchSlots).toBe(3);
    runtime.limiter.tryAcquire("batch");
    expect(runtime.measure().batchSlots).toBe(2);
  });

  it("the composed self-model is MATCHABLE — offerSatisfiesWorker ADMITS a valid offer, REFUSES an unprovisioned one", async () => {
    const { self } = await compose();
    const offer = leaseOfferV1Schema.parse(fixture.leaseOffer);
    expect(offerSatisfiesWorker(self, NAMEPLATE, offer)).toBe(true);
    const bareReport = buildDesktopHello({
      workerId: "00000000-0000-4000-8000-000000000001",
      targetId: fixture.registeredProfile.targetId as string,
      deviceGeneration: 1, platform: "linux", arch: "x64",
    });
    expect(offerSatisfiesWorker({ ...self, report: bareReport }, NAMEPLATE, offer)).toBe(false);
  });

  it("start() starts the drain then the poll loop (fire-and-forget)", async () => {
    const { runtime, order } = await compose();
    runtime.start();
    expect(order).toContain("drainStart");
    expect(order.indexOf("drainStart")).toBeLessThan(order.indexOf("pollRun"));
  });
});

// -- H1: the run deadline reaches the supervisor -------------------------------
//
// `createSupervisor`'s `opDeadlineMs` defaulted to 60 s and this composition never passed it,
// so 60 s stood for EVERY run. That one number is three things at once — the execute race, the
// E2B sandbox TTL, and the E2B command timeout — while the job envelope's own
// `workload.maxRuntimeSeconds` (up to 600 s from the server's builder) was read by nothing.
// Every task needing more than a minute was killed and terminalized `failed`.

describe("composeDispatchRuntime — H1: the run's own deadline", () => {
  it("passes a per-run opDeadlineMs RESOLVER to the supervisor", async () => {
    const { captured } = await compose();
    // A plain number would re-freeze the deadline at composition time, which is the bug.
    expect(typeof captured.opDeadlineMs).toBe("function");
  });

  it("the composed resolver derives the deadline from the offer's workload", async () => {
    const { captured } = await compose();
    const resolve = captured.opDeadlineMs as (h: unknown) => number;
    const handoff = (max: unknown) => ({
      offer: { job: { workload: { command: "claude", args: [], stdinArtifactId: null, maxRuntimeSeconds: max } } },
    });
    expect(resolve(handoff(120))).toBe(120_000);
    // Under the floor: never SHORTEN a run below what the fleet already tolerated (and the
    // same number is the sandbox TTL at create).
    expect(resolve(handoff(5))).toBe(RUN_OP_DEADLINE_FLOOR_MS);
    // Over the ceiling: clamped inside the capability window.
    expect(resolve(handoff(600))).toBe(RUN_OP_DEADLINE_CEILING_MS);
  });
});

describe("resolveRunOpDeadlineMs — the pure resolver", () => {
  const handoff = (workload: unknown) =>
    ({ offer: { job: { workload } }, leaseId: "l", fenceToken: "1", workloadClass: "batch" }) as never;

  it("honours a workload budget between the floor and the ceiling", () => {
    expect(resolveRunOpDeadlineMs(handoff({ maxRuntimeSeconds: 90 }))).toBe(90_000);
    expect(resolveRunOpDeadlineMs(handoff({ maxRuntimeSeconds: 239 }))).toBe(239_000);
  });

  it("clamps to the ceiling — the capability window, not an arbitrary number", () => {
    expect(resolveRunOpDeadlineMs(handoff({ maxRuntimeSeconds: 600 }))).toBe(RUN_OP_DEADLINE_CEILING_MS);
    expect(resolveRunOpDeadlineMs(handoff({ maxRuntimeSeconds: 86_400 }))).toBe(RUN_OP_DEADLINE_CEILING_MS);
  });

  // ★ THE CEILING'S REASON, asserted rather than asserted-in-a-comment. The owned-labels
  // capability expires at `min(authorityNow + 5 min, leaseDeadline)` and is NEVER re-minted on
  // renewal, so once it lapses `convergeNetworked` goes clock-first, records `orphaned`, and a
  // BILLABLE sandbox is left for the server-side reaper. Running to the edge of the window
  // converts a slow task into a leak.
  it("leaves teardown headroom inside the owned-labels capability window", () => {
    expect(RUN_OP_DEADLINE_CEILING_MS).toBeLessThan(OWNED_LABELS_CAPABILITY_TTL_MS);
    expect(OWNED_LABELS_CAPABILITY_TTL_MS - RUN_OP_DEADLINE_CEILING_MS).toBe(RUN_TEARDOWN_HEADROOM_MS);
    expect(RUN_TEARDOWN_HEADROOM_MS).toBeGreaterThan(0);
    // Mirrored, not imported (provider-capability devDepends on worker-daemon, so importing it
    // back would be a cycle and would breach the E4-D01 closure). Pin the mirrored value.
    expect(OWNED_LABELS_CAPABILITY_TTL_MS).toBe(5 * 60_000);
  });

  // A NaN/absent budget must not become the deadline: `setTimeout(NaN)` fires IMMEDIATELY, so
  // a malformed workload would kill every run instantly instead of falling back.
  it.each([
    ["an absent workload", undefined],
    ["a null workload", null],
    ["a workload with no budget", { command: "claude" }],
    ["a non-numeric budget", { maxRuntimeSeconds: "600" }],
    ["a NaN budget", { maxRuntimeSeconds: Number.NaN }],
    ["an Infinity budget", { maxRuntimeSeconds: Number.POSITIVE_INFINITY }],
    ["a zero budget", { maxRuntimeSeconds: 0 }],
    ["a negative budget", { maxRuntimeSeconds: -30 }],
  ])("falls back to the floor for %s", (_label, workload) => {
    expect(resolveRunOpDeadlineMs(handoff(workload))).toBe(RUN_OP_DEADLINE_FLOOR_MS);
  });

  it("floors a fractional budget before converting to ms", () => {
    expect(resolveRunOpDeadlineMs(handoff({ maxRuntimeSeconds: 90.9 }))).toBe(90_000);
  });

  // ★★★ SVC-008b §3.3 — THE SERVICE ARM, and the only witness it has.
  //
  // `serviceWorkloadV1Schema` carries NO runtime field at all (`gracefulStopSeconds` is a STOP
  // budget, not a runtime one), so a service can only be resolved off `workloadType`. Every
  // other case in this block builds its handoff with NO `workloadType` key, so the arm was
  // unreachable from here; and the 14 SVC-008b supervisor cases pass a LITERAL `opDeadlineMs`
  // number to `createSupervisor`, bypassing the resolver entirely. Neutralising the arm
  // (`workloadType === "service" && false`) therefore left the ENTIRE worker-daemon suite
  // green — 154 files / 1020 passed — while silently returning every service to the 60 s
  // floor. This pair is what makes "a service on this fleet runs for at most 240 seconds" a
  // CHECKED claim rather than a sentence in three documents.
  it("★★★ a service gets the CEILING, and ONLY because the job is typed `service`", () => {
    // A real service workload: schema-shaped, and carrying no runtime budget anywhere.
    const serviceWorkload = {
      serviceId: "svc_01J0000000000000000000000",
      serviceInstanceId: "svi_01J0000000000000000000000",
      generation: 1,
      command: "node",
      args: ["server.js"],
      checkpointArtifactId: null,
      gracefulStopSeconds: 30,
    };
    const typed = (workloadType: string, workload: unknown) =>
      ({ offer: { job: { workloadType, workload } }, leaseId: "l", fenceToken: "1", workloadClass: "service" }) as never;

    // POSITIVE. No `maxRuntimeSeconds` exists on this workload, so the ONLY thing that can
    // lift it off the floor is the service arm.
    expect(resolveRunOpDeadlineMs(typed("service", serviceWorkload))).toBe(RUN_OP_DEADLINE_CEILING_MS);
    // ★ And the headline number itself, pinned: 240 s is the residual the PR claims.
    expect(RUN_OP_DEADLINE_CEILING_MS).toBe(240_000);

    // ★ THE NEGATIVE HALF — what the arm is actually worth. The SAME workload, untyped or
    // typed anything else, falls to the 60 s floor. Delete the arm and this is what every
    // service silently gets.
    expect(resolveRunOpDeadlineMs(handoff(serviceWorkload))).toBe(RUN_OP_DEADLINE_FLOOR_MS);
    expect(resolveRunOpDeadlineMs(typed("batch", serviceWorkload))).toBe(RUN_OP_DEADLINE_FLOOR_MS);
    expect(RUN_OP_DEADLINE_FLOOR_MS).not.toBe(RUN_OP_DEADLINE_CEILING_MS);
  });
});

/**
 * JOB-015 (V3) — THE COMPOSED CONTROL-COMMAND APPLIER.
 *
 * ★★★ Every behavioural JOB-015 test injects its OWN fake `controlHandlers`, so before
 * these tests the production line `drain: () => pollLoop.stopLeasing()` had exactly three
 * references — its declaration, its read in the driver, and this composition — and NOT
 * ONE of them was a test that ran it. The thunk that makes the late binding work was
 * therefore verified by the TYPE CHECKER alone: precisely the "a composition-root port is
 * a NO-OP" class it was written to avoid, and a class this programme has shipped before.
 * These assert with a CALL.
 */
describe("composeDispatchRuntime — JOB-015 control-command handlers", () => {
  it("★★★ the composed drain handler REACHES pollLoop.stopLeasing()", async () => {
    const { captured, stopLeasingCalls } = await compose();
    const thunk = captured.driverControlHandlers as (() => { drain?: (reason: string | null) => void }) | undefined;
    expect(typeof thunk).toBe("function");

    // Nothing has drained yet — otherwise "1 call" could be composition side-effect.
    expect(stopLeasingCalls).toEqual([]);
    const handlers = thunk!();
    expect(typeof handlers.drain).toBe("function");
    handlers.drain!("fleet rollout");
    // ★ THE BAR: the poll loop actually stopped taking offers.
    expect(stopLeasingCalls).toEqual(["stopLeasing"]);
  });

  it("★ the port is a THUNK resolved LATE — the driver is built before the poll loop exists", async () => {
    // `makeDriver` runs at composition line ~209 and `const pollLoop` is assigned at ~268,
    // so a handler passed BY VALUE would read `pollLoop` in its temporal dead zone. The
    // thunk is what makes the port legal, and this pins the ordering it depends on.
    const { order } = await compose();
    expect(order.indexOf("makeDriver")).toBeLessThan(order.indexOf("makePollLoop"));
    expect(order.indexOf("makeDriver")).toBeGreaterThan(-1);
  });

  it("★ `result` is deliberately ABSENT — §5's disclosed gap, pinned in code", async () => {
    // The two governance result kinds have no applier (E8/BRW-004 + E9/SVC-001 own them).
    // The daemon must compose NOTHING for them rather than a stub that ACKs: an ACKed but
    // unapplied command clears `ack_status` forever and reproduces this ticket's own
    // finding. If a future commit composes `result`, this test reds and its author has to
    // decide deliberately whether §5 is still true.
    const { captured } = await compose();
    const handlers = (captured.driverControlHandlers as () => Record<string, unknown>)();
    expect(handlers.result).toBeUndefined();
    expect(Object.keys(handlers)).toEqual(["drain"]);
  });
});
