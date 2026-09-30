/**
 * REL-004 Lane C (D5/I8) — a drain that carries `retryAfterMs` is a reversible PAUSE.
 *
 * The frozen protocol has always modelled two drains: `pollResponseV1Schema` makes
 * `retryAfterMs` nullable on the drain outcome. The daemon collapsed both into one terminal
 * stop — `drainRequested = true; stopLeasingRequested = true` — and the parsed `retryAfterMs`
 * was read by nothing at all.
 *
 * That matters because REL-004 clause 3a's whole purpose is a stop button for the Wave-4
 * cutover, and the handoff's justification is that "a bad cutover is reversible in seconds".
 * With a one-way drain, lifting a kill switch would require restarting every worker process.
 * That is a grenade, not a switch.
 *
 * So: `retryAfterMs: null` stays terminal (an operator drain, a shutdown), and a hint makes the
 * drain a pause — finish in-flight work, sleep the server's cadence, resume polling.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMetrics } from "../metrics/metrics.js";
import { measureCapacity, type WorkerSelfModel } from "../poll/capacity.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";
import { createPollLoop, type LeaseHandoff, type SessionProvider } from "../poll/poll-loop.js";

import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import {
  compatibleOffer,
  enrollFixtureWorker,
  enrollmentCodeConfig,
  fixtureCeiling,
  fixtureProbes,
  makeSelfModel,
  POLL_FIXTURE_IDS,
} from "./support/poll-fixtures.js";

const CODE = "poll-drain-resumable-code";
/** maxMs is ABOVE the kill switch's 30s hint, so the honoured delay is not clamped here. */
const WIDE_BACKOFF = { baseMs: 1_000, maxMs: 60_000, jitter: 0 };
/** maxMs is BELOW it, so the honoured delay IS clamped — the clamp is the contract, not 30s. */
const NARROW_BACKOFF = { baseMs: 1_000, maxMs: 5_000, jitter: 0 };
const KILL_SWITCH_HINT_MS = 30_000;

let fake: FakeControlPlane;
let self: WorkerSelfModel;

beforeEach(async () => {
  fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)] });
  self = await makeSelfModel();
});
afterEach(async () => {
  await fake.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function buildLoop(input: {
  backoff: { baseMs: number; maxMs: number; jitter: number };
  slept: number[];
  handoffs: LeaseHandoff[];
  accept?: (handoff: LeaseHandoff) => unknown;
}) {
  const { session, key, client } = await enrollFixtureWorker(fake, CODE);
  const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
  const metrics = createMetrics();
  const loop = createPollLoop({
    client,
    self,
    key,
    session: {
      get: async () => session,
      recover: async () => { throw new Error("no recover"); },
    } satisfies SessionProvider,
    limiter,
    measure: () =>
      measureCapacity({
        probes: fixtureProbes(),
        reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
        slots: limiter.snapshot(),
        ceiling: fixtureCeiling(),
      }),
    supervisor: {
      accept: (handoff) => {
        input.handoffs.push(handoff);
        return input.accept?.(handoff);
      },
    },
    metrics,
    backoff: input.backoff,
    sleep: async (ms) => { input.slept.push(ms); },
  });
  return { loop, limiter, metrics };
}

describe("REL-004 Lane C/I8 — a drain with a retry hint pauses; a null hint stops", () => {
  it("STOPS permanently when retryAfterMs is null — the operator/shutdown drain is unchanged", async () => {
    const slept: number[] = [];
    const handoffs: LeaseHandoff[] = [];
    const { loop } = await buildLoop({ backoff: WIDE_BACKOFF, slept, handoffs });

    fake.enqueuePoll({ kind: "drain", retryAfterMs: null, reason: "operator drain" });
    // Queued behind it, and it must NEVER be reached.
    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });

    expect(await loop.run()).toBe("drained");
    expect(fake.pollCount()).toBe(1);
    expect(handoffs).toHaveLength(0);
  });

  it("PAUSES and resumes when retryAfterMs is set — the switch is reversible", async () => {
    const slept: number[] = [];
    const handoffs: LeaseHandoff[] = [];
    const { loop, limiter } = await buildLoop({ backoff: WIDE_BACKOFF, slept, handoffs });

    // The kill switch is thrown, then lifted: drain -> drain -> no_work -> offer.
    fake.enqueuePoll({ kind: "drain", retryAfterMs: KILL_SWITCH_HINT_MS, reason: "provider incident" });
    fake.enqueuePoll({ kind: "drain", retryAfterMs: KILL_SWITCH_HINT_MS, reason: "provider incident" });
    fake.enqueuePoll({ kind: "no_work", retryAfterMs: 1_000 });
    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });
    // Nothing after the offer: the loop stops once the queue drains to the default no_work and
    // the test stops it explicitly below.

    const runP = loop.run();
    // Give the loop room to work through the queue, then stop it cleanly.
    await new Promise((resolve) => setTimeout(resolve, 250));
    loop.stopLeasing();
    const reason = await runP;

    // It did NOT stop at the first drain, and it came back to real work.
    expect(fake.pollCount()).toBeGreaterThanOrEqual(4);
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(1);
    expect(handoffs).toHaveLength(1);
    // A paused loop that later stops was never "drained" — that word means terminal.
    expect(reason).not.toBe("drained");
    expect(limiter.freeSlots("batch")).toBe(1);
  });

  it("honours the server's hint through the SAME clamp as a no_work cadence", async () => {
    // Not "sleeps 30000": `cadenceSleep` bounds every honoured delay into
    // [min(baseMs, maxMs), maxMs]. Asserting the literal would pin a number the loop does not
    // promise, and would pass or fail on the fixture's backoff config rather than on the code.
    for (const [backoff, expected] of [
      [WIDE_BACKOFF, KILL_SWITCH_HINT_MS],
      [NARROW_BACKOFF, NARROW_BACKOFF.maxMs],
    ] as const) {
      await fake.close();
      fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)] });
      const slept: number[] = [];
      const handoffs: LeaseHandoff[] = [];
      const { loop } = await buildLoop({ backoff, slept, handoffs });
      fake.enqueuePoll({ kind: "drain", retryAfterMs: KILL_SWITCH_HINT_MS, reason: "x" });

      const runP = loop.run();
      await new Promise((resolve) => setTimeout(resolve, 150));
      loop.stopLeasing();
      await runP;

      expect(slept, `backoff maxMs=${backoff.maxMs}`).toContain(expected);
    }
  });

  it("finishes in-flight work BEFORE resuming, so a pause is still a drain", async () => {
    const slept: number[] = [];
    const handoffs: LeaseHandoff[] = [];
    const gate = deferred<void>();
    const started = deferred<void>();
    const settled: string[] = [];

    const { loop, limiter } = await buildLoop({
      backoff: WIDE_BACKOFF,
      slept,
      handoffs,
      accept: () => {
        started.resolve();
        return gate.promise.then(() => { settled.push("handoff"); });
      },
    });

    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });
    fake.enqueuePoll({ kind: "drain", retryAfterMs: KILL_SWITCH_HINT_MS, reason: "provider incident" });

    const runP = loop.run();
    await started.promise;
    expect(loop.activeLeaseCount()).toBe(1);

    // The loop must be blocked draining the in-flight handoff, not already sleeping past it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(slept).toHaveLength(0);
    expect(settled).toHaveLength(0);

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toEqual(["handoff"]);
    expect(loop.activeLeaseCount()).toBe(0);
    expect(limiter.freeSlots("batch")).toBe(1);
    // Only after the in-flight lease settled did the pause sleep happen.
    expect(slept.length).toBeGreaterThan(0);

    loop.stopLeasing();
    await runP;
  });

  it("counts a pause and a terminal drain as DIFFERENT outcomes", async () => {
    // One metric for both would make "the fleet is paused" indistinguishable from "the fleet
    // shut down" on a dashboard, which is the one question an operator asks during a kill.
    const slept: number[] = [];
    const handoffs: LeaseHandoff[] = [];
    const { loop, metrics } = await buildLoop({ backoff: WIDE_BACKOFF, slept, handoffs });
    fake.enqueuePoll({ kind: "drain", retryAfterMs: KILL_SWITCH_HINT_MS, reason: "x" });

    const runP = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 150));
    loop.stopLeasing();
    await runP;

    const rendered = metrics.renderPrometheus();
    expect(rendered).toContain("drain_paused");
  });
});
