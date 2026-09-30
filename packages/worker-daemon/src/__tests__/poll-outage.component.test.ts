import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMetrics } from "../metrics/metrics.js";
import { measureCapacity, type WorkerSelfModel } from "../poll/capacity.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";
import { createPollLoop, pollOnce, type SessionProvider } from "../poll/poll-loop.js";

import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import {
  enrollFixtureWorker,
  enrollmentCodeConfig,
  fixtureCeiling,
  fixtureProbes,
  makeSelfModel,
} from "./support/poll-fixtures.js";

const CODE = "poll-outage-code";
const BACKOFF = { baseMs: 1_000, maxMs: 30_000, jitter: 0.5 };
let fake: FakeControlPlane;
let self: WorkerSelfModel;

beforeEach(async () => {
  fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)] });
  self = await makeSelfModel();
});
afterEach(async () => {
  await fake.close();
});

describe("poll-outage — pollOnce classifies transient failures", () => {
  it("maps throttled(429), internal_unavailable(503), socket, and timeout to transient outcomes", async () => {
    // One enrollment; the client carries a short poll timeout so a hang → timeout.
    const { session, key, client } = await enrollFixtureWorker(fake, CODE, { pollTimeoutMs: 60 });
    const capacity = measureCapacity({
      probes: fixtureProbes(),
      reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
      slots: { batch: 1, browser_session: 0, service: 0 },
      ceiling: fixtureCeiling(),
    });

    fake.enqueuePoll({ kind: "error", status: 429, code: "throttled", retryAfterMs: 1_000 });
    expect(await pollOnce({ client, session, capacity, key })).toMatchObject({ kind: "transient", label: "throttled", retryAfterMs: 1_000 });

    fake.enqueuePoll({ kind: "error", status: 503, code: "internal_unavailable", retryAfterMs: 1_000 });
    expect(await pollOnce({ client, session, capacity, key })).toMatchObject({ kind: "transient", label: "internal_unavailable" });

    fake.enqueuePoll({ kind: "socket" });
    expect(await pollOnce({ client, session, capacity, key })).toMatchObject({ kind: "transient", label: "socket_error" });

    fake.enqueuePoll({ kind: "hang" });
    expect(await pollOnce({ client, session, capacity, key })).toMatchObject({ kind: "transient", label: "timeout" });
  });
});

describe("poll-outage — the loop backs off (bounded, jittered) and never busy-spins or crashes", () => {
  it("applies one bounded backoff per transient failure, then stops on a drain", async () => {
    // Enrollment for the loop's client uses a short poll timeout so a hang → timeout.
    const { session, key, client } = await enrollFixtureWorker(fake, CODE, { pollTimeoutMs: 60 });
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const metrics = createMetrics();
    const sleeps: number[] = [];
    const staticSession: SessionProvider = {
      get: async () => session,
      recover: async () => {
        throw new Error("recover must not be called in the outage test");
      },
    };

    fake.enqueuePoll({ kind: "error", status: 429, code: "throttled", retryAfterMs: 1_000 });
    fake.enqueuePoll({ kind: "error", status: 503, code: "internal_unavailable", retryAfterMs: 1_000 });
    fake.enqueuePoll({ kind: "socket" });
    fake.enqueuePoll({ kind: "hang" });
    fake.enqueuePoll({ kind: "drain" });

    const loop = createPollLoop({
      client,
      self,
      key,
      session: staticSession,
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
      rng: () => 0,
    });

    const reason = await loop.run();
    expect(reason).toBe("drained");
    expect(fake.pollCount()).toBe(5);

    // Exactly one backoff sleep per transient failure (4) — never a zero-spin.
    expect(sleeps).toHaveLength(4);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeGreaterThanOrEqual(BACKOFF.baseMs);
      expect(ms).toBeLessThanOrEqual(BACKOFF.maxMs);
    }

    const prom = metrics.renderPrometheus();
    expect(prom).toContain('poll_outcome{outcome="throttled"} 1');
    expect(prom).toContain('poll_outcome{outcome="internal_unavailable"} 1');
    expect(prom).toContain('poll_outcome{outcome="socket_error"} 1');
    expect(prom).toContain('poll_outcome{outcome="timeout"} 1');
    expect(prom).toContain('poll_outcome{outcome="drain"} 1');
    expect(prom).toMatch(/backoff_sleep_ms\{bucket="/);
  });

  it("floors a transient retryAfterMs:0 at min(baseMs,maxMs) — a hostile 429/503 can never zero-spin", async () => {
    // A buggy/overloaded/hostile server can 429 (or 503) with retryAfterMs:0. The
    // frozen schema permits it; the loop must NOT honor a 0-delay re-poll flood.
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const sleeps: number[] = [];
    const staticSession: SessionProvider = {
      get: async () => session,
      recover: async () => {
        throw new Error("recover must not be called in the zero-spin test");
      },
    };

    fake.enqueuePoll({ kind: "error", status: 429, code: "throttled", retryAfterMs: 0 });
    fake.enqueuePoll({ kind: "error", status: 503, code: "internal_unavailable", retryAfterMs: 0 });
    fake.enqueuePoll({ kind: "drain" });

    const loop = createPollLoop({
      client,
      self,
      key,
      session: staticSession,
      limiter,
      measure: () =>
        measureCapacity({
          probes: fixtureProbes(),
          reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
          slots: limiter.snapshot(),
          ceiling: fixtureCeiling(),
        }),
      supervisor: { accept: () => {} },
      metrics: createMetrics(),
      backoff: BACKOFF,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      rng: () => 0,
    });

    const reason = await loop.run();
    expect(reason).toBe("drained");
    // Two transient failures, each with retryAfterMs:0 → each floored, never 0.
    expect(sleeps).toHaveLength(2);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(Math.min(BACKOFF.baseMs, BACKOFF.maxMs));
      expect(ms).toBeGreaterThan(0);
    }
  });
});
