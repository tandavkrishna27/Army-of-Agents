/**
 * ACK-failure routing (WRK-003, FIX 7). The offer poll succeeds; the ACK then
 * fails in each of the ways the wire allows. Every non-acknowledged ACK MUST
 * release the concurrency slot it took and route the loop correctly:
 *   - 401 unauthorized → recover (within-window session recovery)
 *   - 409 target_revoked → terminal (covered in poll-revoked.component)
 *   - 429/503 transient  → bounded backoff + continue
 *   - 200 rejected (stale_fence-class) → backoff + continue (offer dropped)
 *   - socket drop → transient backoff + continue
 * The ACK-directive queue on the fake drives these deterministically.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMetrics } from "../metrics/metrics.js";
import { measureCapacity, type WorkerSelfModel } from "../poll/capacity.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";
import { createPollLoop, type SessionProvider } from "../poll/poll-loop.js";

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

const CODE = "poll-ack-fail-code";
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

describe("poll-ack-failures.component — a failed ACK releases the slot and routes correctly", () => {
  it("ack 401 unauthorized → the slot is released and the loop RECOVERS the session", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const metrics = createMetrics();
    let recovered = 0;

    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });
    fake.enqueueAck({ kind: "error", status: 401, code: "unauthorized" });
    fake.enqueuePoll({ kind: "drain" });

    const loop = createPollLoop({
      client,
      self,
      key,
      session: {
        get: async () => session,
        recover: async () => {
          recovered += 1;
          return session;
        },
      } satisfies SessionProvider,
      limiter,
      measure: () =>
        measureCapacity({
          probes: fixtureProbes(),
          reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
          slots: limiter.snapshot(),
          ceiling: fixtureCeiling(),
        }),
      supervisor: { accept: () => {} },
      metrics,
      backoff: BACKOFF,
      sleep: async () => {},
    });

    const reason = await loop.run();
    expect(reason).toBe("drained");
    expect(recovered).toBe(1);
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(0);
    expect(limiter.freeSlots("batch")).toBe(1); // slot released on the failed ACK
    const prom = metrics.renderPrometheus();
    expect(prom).toContain('lease_ack{outcome="unauthorized"} 1');
    expect(prom).toContain('poll_outcome{outcome="recovered"} 1');
  });

  it("ack 429 throttled → the slot is released and the loop backs off (bounded), then continues", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const metrics = createMetrics();
    const sleeps: number[] = [];

    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });
    fake.enqueueAck({ kind: "error", status: 429, code: "throttled", retryAfterMs: 1_000 });
    fake.enqueuePoll({ kind: "drain" });

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
      supervisor: { accept: () => {} },
      metrics,
      backoff: BACKOFF,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const reason = await loop.run();
    expect(reason).toBe("drained");
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(0);
    expect(limiter.freeSlots("batch")).toBe(1);
    // Exactly one backoff, honored and floored (never a zero-spin).
    expect(sleeps).toEqual([1_000]);
    expect(metrics.renderPrometheus()).toContain('lease_ack{outcome="throttled"} 1');
  });

  it("ack 200 rejected (stale_fence) → the slot is released, the offer is dropped, the loop backs off", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const metrics = createMetrics();
    const sleeps: number[] = [];

    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });
    fake.enqueueAck({ kind: "rejected", reason: "stale_fence" });
    fake.enqueuePoll({ kind: "drain" });

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
      supervisor: { accept: () => {} },
      metrics,
      backoff: BACKOFF,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const reason = await loop.run();
    expect(reason).toBe("drained");
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(0);
    expect(limiter.freeSlots("batch")).toBe(1);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(Math.min(BACKOFF.baseMs, BACKOFF.maxMs));
    expect(metrics.renderPrometheus()).toContain('lease_ack{outcome="rejected"} 1');
  });

  it("ack socket drop → the slot is released and the loop treats it as a transient backoff", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const metrics = createMetrics();
    const sleeps: number[] = [];

    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });
    fake.enqueueAck({ kind: "socket" });
    fake.enqueuePoll({ kind: "drain" });

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
      supervisor: { accept: () => {} },
      metrics,
      backoff: BACKOFF,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const reason = await loop.run();
    expect(reason).toBe("drained");
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(0);
    expect(limiter.freeSlots("batch")).toBe(1);
    expect(sleeps).toHaveLength(1);
    expect(metrics.renderPrometheus()).toContain('lease_ack{outcome="socket_error"} 1');
  });
});
