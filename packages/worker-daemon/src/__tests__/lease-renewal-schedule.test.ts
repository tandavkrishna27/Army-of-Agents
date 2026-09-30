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

describe("lease-renewal-schedule — capture offer.expiresAt at handoff, schedule at expiresAt − leadMs", () => {
  it("schedules the first renewal at exactly expiresAt − leadMs", async () => {
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

    void driver.accept(makeRenewalHandoff({ windowMs: 100_000 }));

    // window (100_000) − leadMs (20_000) = 80_000; the timer targets that instant.
    expect(scheduler.setTimerLog).toHaveLength(1);
    expect(scheduler.setTimerLog[0]!.delayMs).toBe(80_000);
    expect(driver.activeRenewalCount()).toBe(1);
  });

  it("uses a FRESH idempotency key for each renewal interval", async () => {
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
    void driver.accept(makeRenewalHandoff({ windowMs: 100_000 }));

    // Fire two successive renewal intervals.
    for (let i = 0; i < 2; i += 1) {
      const next = scheduler.setTimerLog[scheduler.setTimerLog.length - 1]!.targetMs;
      await scheduler.advanceTo(next);
    }

    const keys = fake.renewKeys();
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});
