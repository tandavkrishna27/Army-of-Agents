import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pollRequestV1Schema } from "@armyofagents/worker-protocol";

import { measureCapacity, offerSatisfiesWorker, type WorkerSelfModel } from "../poll/capacity.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";
import { buildPollRequest, createPollLoop, pollOnce, type SessionProvider } from "../poll/poll-loop.js";
import { createMetrics } from "../metrics/metrics.js";

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

const CODE = "poll-backpressure-code";
const BACKOFF = { baseMs: 1_000, maxMs: 30_000, jitter: 0 };
let fake: FakeControlPlane;
let self: WorkerSelfModel;

beforeEach(async () => {
  fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)] });
  self = await makeSelfModel();
});
afterEach(async () => {
  await fake.close();
});

describe("poll-backpressure — a saturated class advertises zero free slots and accepts no work", () => {
  it("measured capacity advertises zero slots for a saturated workload class", async () => {
    const { session } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    // Saturate the only batch slot.
    expect(limiter.tryAcquire("batch")).toBe(true);
    expect(limiter.hasAnyFreeSlot()).toBe(false);

    const capacity = measureCapacity({
      probes: fixtureProbes(),
      reserved: { cpuMillis: 2000, memoryMiB: 4096, diskMiB: 10240 },
      slots: limiter.snapshot(),
      ceiling: fixtureCeiling(),
    });
    expect(capacity.batchSlots).toBe(0);

    // The poll request carries the zero-slot capacity (backpressure on the wire).
    const { request } = buildPollRequest({
      session,
      capacity,
      correlationId: "00000000-0000-4000-8000-0000000000b0",
      issuedAt: "2026-08-13T00:00:00.000Z",
      nonce: "n0",
    });
    expect(pollRequestV1Schema.safeParse(request).success).toBe(true);
    expect(request.capacity.batchSlots).toBe(0);
  });

  it("even if the server offers a batch job at the ceiling, the self-check rejects it (zero slots)", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    limiter.tryAcquire("batch"); // fully saturated

    const capacity = measureCapacity({
      probes: fixtureProbes(),
      reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
      slots: limiter.snapshot(),
      ceiling: fixtureCeiling(),
    });
    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });
    const outcome = await pollOnce({ client, session, capacity, key });
    if (outcome.kind !== "offer") throw new Error("expected an offer");

    // The frozen matcher requires a free slot for the workload; with batchSlots=0
    // the worker cannot accept the work → no ACK.
    expect(offerSatisfiesWorker(self, capacity, outcome.offer)).toBe(false);
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(0);
  });

  it("releasing the in-flight slot re-opens capacity for the next poll", async () => {
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    limiter.tryAcquire("batch");
    expect(measureCapacity({
      probes: fixtureProbes(),
      reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
      slots: limiter.snapshot(),
    }).batchSlots).toBe(0);

    limiter.release("batch");
    expect(measureCapacity({
      probes: fixtureProbes(),
      reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
      slots: limiter.snapshot(),
    }).batchSlots).toBe(1);
  });

  it("the COMPOSED loop advertises backpressure when a slot saturates between measure() and tryAcquire", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    // The real limiter is already saturated; but measure() reports a (stale/racy)
    // free batch slot so the offer passes the capability self-check yet the loop's
    // tryAcquire fails → the backpressure branch fires (a class saturating between
    // the poll and the offer).
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    expect(limiter.tryAcquire("batch")).toBe(true); // saturate the live limiter
    const advertisedFree = measureCapacity({
      probes: fixtureProbes(),
      reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
      slots: { batch: 1, browser_session: 0, service: 0 },
      ceiling: fixtureCeiling(),
    });
    expect(advertisedFree.batchSlots).toBe(1);

    const metrics = createMetrics();
    let accepted = 0;
    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });
    fake.enqueuePoll({ kind: "drain" });

    const loop = createPollLoop({
      client,
      self,
      key,
      session: { get: async () => session, recover: async () => { throw new Error("no recover"); } } satisfies SessionProvider,
      limiter,
      measure: () => advertisedFree,
      supervisor: { accept: () => { accepted += 1; } },
      metrics,
      backoff: BACKOFF,
      sleep: async () => {},
    });

    const reason = await loop.run();
    expect(reason).toBe("drained");
    // Backpressure: the compatible offer was NOT ACKed (no slot to take), nothing
    // handed off, and the live limiter stays at its single saturated slot.
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(0);
    expect(accepted).toBe(0);
    expect(limiter.freeSlots("batch")).toBe(0);
    expect(metrics.renderPrometheus()).toContain('poll_outcome{outcome="backpressure"} 1');
  });
});
