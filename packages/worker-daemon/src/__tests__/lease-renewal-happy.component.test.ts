import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLeaseRenewalDriver } from "../lease/lease-renewal.js";

import type { FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import {
  FakeScheduler,
  RENEWAL_CODE,
  RENEWAL_IDENTITY,
  makeRenewalHandoff,
  recordingSupervisor,
  staticSessionProvider,
  startRenewalPlane,
} from "./support/renewal-fixtures.js";

let scheduler: FakeScheduler;
let fake: FakeControlPlane;

beforeEach(async () => {
  scheduler = new FakeScheduler();
  fake = await startRenewalPlane(scheduler);
});
afterEach(async () => {
  await fake.close();
});

describe("lease-renewal-happy — N renewals extend the lease against the fake plane", () => {
  it("reschedules on each renewed{expiresAt}; the plane records N distinct keys with increasing expiry", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    const sup = recordingSupervisor();
    const driver = createLeaseRenewalDriver({
      client,
      session: staticSessionProvider(session),
      key,
      identity: RENEWAL_IDENTITY,
      supervisor: sup.supervisor,
      schedule: scheduler,
      tuning: { leadMs: 20_000 },
    });

    const handoff = makeRenewalHandoff({ windowMs: 100_000 });
    void driver.accept(handoff);

    const N = 3;
    for (let i = 0; i < N; i += 1) {
      const next = scheduler.setTimerLog[scheduler.setTimerLog.length - 1]!.targetMs;
      await scheduler.advanceTo(next);
    }

    const renews = fake.renews();
    expect(renews).toHaveLength(N);
    expect(fake.renewCountFor(handoff.leaseId)).toBe(N);

    // N distinct idempotency keys — one per interval.
    const keys = renews.map((r) => r.idempotencyKey);
    expect(new Set(keys).size).toBe(N);

    // Each renewal extends further into the future (strictly increasing expiry).
    const expiries = renews.map((r) => Date.parse(r.expiresAt));
    for (let i = 1; i < expiries.length; i += 1) {
      expect(expiries[i]!).toBeGreaterThan(expiries[i - 1]!);
    }

    // The lease is still live (renewal re-asserted the grant; no loss).
    expect(driver.activeRenewalCount()).toBe(1);
    expect(sup.calls).not.toContain(`onLeaseLost:${handoff.leaseId}`);
  });
});
