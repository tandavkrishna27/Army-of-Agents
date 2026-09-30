import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { measureCapacity, offerSatisfiesWorker, type WorkerSelfModel } from "../poll/capacity.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";
import { ackLease, pollOnce } from "../poll/poll-loop.js";

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

const CODE = "poll-offer-code";
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
  const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
  return measureCapacity({
    probes: fixtureProbes(),
    reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
    slots: limiter.snapshot(),
    ceiling: fixtureCeiling(),
  });
}

describe("poll-offer-ack.component — a compatible offer is validated, ACKed once, handed off", () => {
  it("self-checks the offer, ACKs with a matching leaseId, and the fake records exactly one ACK", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });

    const capacity = currentCapacity();
    const outcome = await pollOnce({ client, session, capacity, key });
    expect(outcome.kind).toBe("offer");
    if (outcome.kind !== "offer") throw new Error("expected an offer");

    // Defense-in-depth capability self-check passes for a compatible offer.
    expect(offerSatisfiesWorker(self, capacity, outcome.offer)).toBe(true);

    const ack = await ackLease({ client, session, offer: outcome.offer, key });
    expect(ack).toEqual({ kind: "acknowledged", leaseId: POLL_FIXTURE_IDS.lease });

    // Exactly one ACK, for the offered lease, with the URL param == body leaseId.
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(1);
    expect(fake.acks()).toHaveLength(1);
    expect(fake.acks()[0]).toMatchObject({
      leaseId: POLL_FIXTURE_IDS.lease,
      workerId: POLL_FIXTURE_IDS.worker,
      deviceThumbprint: key.deviceThumbprint,
    });
  });

  it("the ACK is dual-authenticated (Bearer session + fresh device proof over the ack path)", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueuePoll({ kind: "offer", offer: compatibleOffer() });
    const capacity = currentCapacity();
    const outcome = await pollOnce({ client, session, capacity, key });
    if (outcome.kind !== "offer") throw new Error("expected an offer");
    await ackLease({ client, session, offer: outcome.offer, key });

    const ackRecord = fake.requests.find((r) => r.url === client.leaseAckPath(POLL_FIXTURE_IDS.lease));
    expect(ackRecord?.status).toBe(200);
    expect(ackRecord?.deviceThumbprint).toBe(key.deviceThumbprint);
  });
});
