import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { measureCapacity, offerSatisfiesWorker, deriveJobRequirements, type WorkerSelfModel } from "../poll/capacity.js";
import { leaseOfferV1Schema } from "@armyofagents/worker-protocol";
import { ackLease, createPollLoop, pollOnce, type SessionProvider } from "../poll/poll-loop.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";
import { createMetrics } from "../metrics/metrics.js";

import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import {
  compatibleOffer,
  enrollFixtureWorker,
  enrollmentCodeConfig,
  fixtureCeiling,
  fixtureProbes,
  incompatibleOffer,
  makeSelfModel,
  POLL_FIXTURE_IDS,
} from "./support/poll-fixtures.js";

const CODE = "poll-incompat-code";
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

function currentCapacity() {
  return measureCapacity({
    probes: fixtureProbes(),
    reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
    slots: { batch: 1, browser_session: 0, service: 0 },
    ceiling: fixtureCeiling(),
  });
}

describe("poll-incompatible — an offer exceeding the worker's branded intersection is NOT ACKed", () => {
  it("the capability self-check rejects an offer requiring a capability the worker did not report", async () => {
    const offer = leaseOfferV1Schema.parse(incompatibleOffer());
    // secret.proxy is in the target ceiling but NOT in the worker's report, so the
    // intersection (ceiling ∩ reported) excludes it — the offer is unsatisfiable.
    expect(offerSatisfiesWorker(self, currentCapacity(), offer)).toBe(false);
    // The compatible offer, by contrast, IS satisfiable — proving the check is not
    // vacuously false.
    expect(offerSatisfiesWorker(self, currentCapacity(), leaseOfferV1Schema.parse(compatibleOffer()))).toBe(true);
  });

  it("a job whose requiredCapabilities exit the closed vocabulary fails the derivation (fail closed)", () => {
    const offer = leaseOfferV1Schema.parse(compatibleOffer());
    const rogueJob = { ...offer.job, requiredCapabilities: ["workload.gpu"] } as typeof offer.job;
    // workload.gpu is outside the closed provider-neutral vocabulary → no valid
    // requirements object can be derived → self-check fails closed.
    expect(deriveJobRequirements(rogueJob)).toBeNull();
  });

  it("the loop does not ACK an incompatible offer (no ACK recorded)", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueuePoll({ kind: "offer", offer: incompatibleOffer() });
    const capacity = currentCapacity();
    const outcome = await pollOnce({ client, session, capacity, key });
    expect(outcome.kind).toBe("offer");
    if (outcome.kind !== "offer") throw new Error("expected an offer");

    // The worker self-checks BEFORE ACKing; an unsatisfiable offer is dropped.
    if (offerSatisfiesWorker(self, capacity, outcome.offer)) {
      await ackLease({ client, session, offer: outcome.offer, key });
    }
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(0);
    expect(fake.acks()).toHaveLength(0);
  });

  it("the COMPOSED loop drops an incompatible offer un-ACKed and emits poll_outcome incompatible", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const metrics = createMetrics();
    let accepted = 0;

    // An incompatible offer, then a drain so the loop stops after dropping it.
    fake.enqueuePoll({ kind: "offer", offer: incompatibleOffer() });
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
      supervisor: { accept: () => { accepted += 1; } },
      metrics,
      backoff: BACKOFF,
      sleep: async () => {},
    });

    const reason = await loop.run();
    expect(reason).toBe("drained");
    // The loop self-checked and dropped the offer: no ACK, no handoff, slot intact.
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(0);
    expect(fake.acks()).toHaveLength(0);
    expect(accepted).toBe(0);
    expect(loop.activeLeaseCount()).toBe(0);
    expect(limiter.freeSlots("batch")).toBe(1);
    expect(metrics.renderPrometheus()).toContain('poll_outcome{outcome="incompatible"} 1');
  });
});
