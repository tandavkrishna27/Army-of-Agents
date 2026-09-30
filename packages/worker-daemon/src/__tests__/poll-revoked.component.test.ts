/**
 * A 409 `target_revoked` is a poll/ack-only TERMINAL signal (E4-D11): the target
 * was revoked out from under a live session. This proves the COMPOSED loop stops
 * immediately (no spin) on a 409 from EITHER the poll path or the ACK path, and
 * emits the bounded `target_revoked` outcome.
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

const CODE = "poll-revoked-code";
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

interface LoopArgs {
  readonly session: SessionProvider;
  readonly limiter: ConcurrencyLimiter;
  readonly metrics: ReturnType<typeof createMetrics>;
  readonly client: Awaited<ReturnType<typeof enrollFixtureWorker>>["client"];
  readonly key: Awaited<ReturnType<typeof enrollFixtureWorker>>["key"];
}

function buildLoop(args: LoopArgs) {
  return createPollLoop({
    client: args.client,
    self,
    key: args.key,
    session: args.session,
    limiter: args.limiter,
    measure: () =>
      measureCapacity({
        probes: fixtureProbes(),
        reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
        slots: args.limiter.snapshot(),
        ceiling: fixtureCeiling(),
      }),
    supervisor: { accept: () => {} },
    metrics: args.metrics,
    backoff: BACKOFF,
    sleep: async () => {},
  });
}

describe("poll-revoked.component — a 409 target_revoked is terminal (no spin)", () => {
  it("stops with target_revoked on a POLL 409, exactly one poll", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const metrics = createMetrics();
    fake.revokeTarget();

    const loop = buildLoop({
      session: { get: async () => session, recover: async () => { throw new Error("no recover"); } },
      limiter,
      metrics,
      client,
      key,
    });

    const reason = await loop.run();
    expect(reason).toBe("target_revoked");
    // Terminal on the first poll — the loop never re-polls a revoked target.
    expect(fake.pollCount()).toBe(1);
    expect(fake.acks()).toHaveLength(0);
    expect(metrics.renderPrometheus()).toContain('poll_outcome{outcome="target_revoked"} 1');
  });

  it("stops with target_revoked when the target is revoked BETWEEN the offer poll and the ACK (409 on ACK)", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const metrics = createMetrics();

    // The poll succeeds with an offer; the ACK then 409s (target revoked in between).
    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });
    fake.enqueueAck({ kind: "error", status: 409, code: "target_revoked" });

    const loop = buildLoop({
      session: { get: async () => session, recover: async () => { throw new Error("no recover"); } },
      limiter,
      metrics,
      client,
      key,
    });

    const reason = await loop.run();
    expect(reason).toBe("target_revoked");
    // The offered lease was never recorded as ACKed, and the slot it briefly took
    // was released (no leak) before the terminal stop.
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(0);
    expect(limiter.freeSlots("batch")).toBe(1);
    expect(fake.pollCount()).toBe(1);
    const prom = metrics.renderPrometheus();
    expect(prom).toContain('lease_ack{outcome="target_revoked"} 1');
    expect(prom).toContain('poll_outcome{outcome="target_revoked"} 1');
  });
});
