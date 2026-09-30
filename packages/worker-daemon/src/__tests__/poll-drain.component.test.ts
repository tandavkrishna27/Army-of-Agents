import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMetrics } from "../metrics/metrics.js";
import { createShutdownHandler } from "../lifecycle/shutdown.js";
import { measureCapacity, type WorkerSelfModel } from "../poll/capacity.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";
import {
  createLeaseLifecycleSteps,
  createPollLoop,
  type LeaseHandoff,
  type SessionProvider,
} from "../poll/poll-loop.js";
import type { ControlPlaneClient } from "../transport/client.js";

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

const CODE = "poll-drain-code";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("poll-drain.component — a drain outcome stops new leasing before in-flight work drains", () => {
  it("ACKs the offer, hands it off, then a drain stops leasing while the in-flight lease finishes", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const gate = deferred<void>();
    const started = deferred<void>();
    const handoffs: LeaseHandoff[] = [];

    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });
    fake.enqueuePoll({ kind: "drain", reason: "server draining" });

    const loop = createPollLoop({
      client,
      self,
      key,
      session: { get: async () => session, recover: async () => { throw new Error("no recover"); } } satisfies SessionProvider,
      limiter,
      measure: () =>
        measureCapacity({
          probes: fixtureProbes(),
          reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
          slots: limiter.snapshot(),
          ceiling: fixtureCeiling(),
        }),
      supervisor: {
        accept: (h) => {
          handoffs.push(h);
          started.resolve();
          return gate.promise;
        },
      },
      metrics: createMetrics(),
      backoff: BACKOFF,
      sleep: async () => {},
    });

    const runP = loop.run();
    await started.promise;

    // The offer was ACKed exactly once and handed off; the lease is in flight and
    // the batch slot is held (backpressure) while draining.
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(1);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ leaseId: POLL_FIXTURE_IDS.lease, workloadClass: "batch" });
    expect(loop.activeLeaseCount()).toBe(1);
    expect(limiter.freeSlots("batch")).toBe(0);

    // Let the in-flight lease complete → drain unblocks → the loop stops "drained".
    gate.resolve();
    const reason = await runP;
    expect(reason).toBe("drained");
    expect(loop.activeLeaseCount()).toBe(0);
    expect(limiter.freeSlots("batch")).toBe(1);
    // The drain poll was the last poll — no new leasing after the drain signal.
    expect(fake.pollCount()).toBe(2);
  });

  it("drops an offer that arrives after stopLeasing() was requested mid-poll (never ACKed after lease-stop)", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const handoffs: LeaseHandoff[] = [];

    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });

    let loop!: ReturnType<typeof createPollLoop>;
    // Model an external stopLeasing() landing WHILE the poll is in flight: it fires
    // the instant the poll resolves with the offer, before the loop can ACK. This
    // is the drain-before-lease-stop race — an offer ACKed after lease-stop and
    // added to activeHandoffs after drain() snapshotted the set would be abandoned.
    const racingClient: ControlPlaneClient = {
      ...client,
      poll: async (req) => {
        const res = await client.poll(req);
        loop.stopLeasing();
        return res;
      },
    };

    loop = createPollLoop({
      client: racingClient,
      self,
      key,
      session: { get: async () => session, recover: async () => { throw new Error("no recover"); } } satisfies SessionProvider,
      limiter,
      measure: () =>
        measureCapacity({
          probes: fixtureProbes(),
          reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
          slots: limiter.snapshot(),
          ceiling: fixtureCeiling(),
        }),
      supervisor: {
        accept: (h) => {
          handoffs.push(h);
        },
      },
      metrics: createMetrics(),
      backoff: BACKOFF,
      sleep: async () => {},
    });

    const reason = await loop.run();

    // The offer arrived after lease-stop → dropped WITHOUT ACK, no handoff, no slot
    // taken (no leak), and the run stops cleanly with nothing left to drain.
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(0);
    expect(fake.acks()).toHaveLength(0);
    expect(handoffs).toHaveLength(0);
    expect(loop.activeLeaseCount()).toBe(0);
    expect(limiter.freeSlots("batch")).toBe(1);
    expect(reason).toBe("stopped");
    // Drain completes cleanly (nothing in flight) even after the dropped offer.
    await loop.drain();
    expect(loop.activeLeaseCount()).toBe(0);
    expect(fake.pollCount()).toBe(1);
  });
});

describe("shutdown wiring — lease-stop is registered ahead of drain", () => {
  it("runs the lease-stop step before the drain step on a shutdown signal", async () => {
    const order: string[] = [];
    const steps = createLeaseLifecycleSteps({
      stopLeasing: () => order.push("lease-stop"),
      drain: async () => {
        order.push("drain");
      },
    });
    expect(steps.map((s) => s.name)).toEqual(["lease-stop", "lease-drain"]);

    const handler = createShutdownHandler({
      steps: [...steps, { name: "health-server", stop: () => order.push("health") }],
      logger: { info: () => {}, error: () => {} },
      exit: () => {},
    });
    await handler("SIGTERM");
    // Lease-stop MUST precede the drain, which precedes the health-server stop.
    expect(order).toEqual(["lease-stop", "drain", "health"]);
  });
});
