import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLeaseRenewalDriver } from "../lease/lease-renewal.js";

import type { FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import {
  FakeScheduler,
  RENEWAL_CODE,
  RENEWAL_IDENTITY,
  START_MS,
  isoAt,
  makeRenewalHandoff,
  recordingSupervisor,
  spyProxyFactory,
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

describe("lease-renewal-clock-bounds — skew + late-timer expiry are caught", () => {
  it("a renewed{expiresAt} already in the past (clock skew) is treated as a loss", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    const log: string[] = [];
    const sup = recordingSupervisor(log);
    const proxies = spyProxyFactory(log);
    const driver = createLeaseRenewalDriver({
      client,
      session: staticSessionProvider(session),
      key,
      identity: RENEWAL_IDENTITY,
      supervisor: sup.supervisor,
      schedule: scheduler,
      makeFenceProxy: proxies.factory,
      tuning: { leadMs: 20_000 },
    });

    const handoff = makeRenewalHandoff({ windowMs: 100_000 });
    // The server returns a fresh expiry that is ALREADY in the past.
    fake.enqueueRenew({ kind: "renewed", expiresAt: isoAt(START_MS + 40_000) });
    void driver.accept(handoff);
    const next = scheduler.setTimerLog[scheduler.setTimerLog.length - 1]!.targetMs; // START + 80_000
    await scheduler.advanceTo(next);

    expect(proxies.byLease.get(handoff.leaseId)!.closes).toContain("clock_skew");
    expect(log).toContain(`onLeaseLost:${handoff.leaseId}`);
    expect(driver.activeRenewalCount()).toBe(0);
  });

  it("a late-firing timer (sleep/resume) is caught by the pre-POST expiry check — no renew is posted", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    const log: string[] = [];
    const sup = recordingSupervisor(log);
    const proxies = spyProxyFactory(log);
    const driver = createLeaseRenewalDriver({
      client,
      session: staticSessionProvider(session),
      key,
      identity: RENEWAL_IDENTITY,
      supervisor: sup.supervisor,
      schedule: scheduler,
      makeFenceProxy: proxies.factory,
      tuning: { leadMs: 20_000 },
    });

    const handoff = makeRenewalHandoff({ windowMs: 100_000 }); // expiresAt = START + 100_000
    void driver.accept(handoff);
    // The process slept past expiry; the timer fires LATE (now well past expiresAt).
    await scheduler.advanceTo(START_MS + 150_000);

    // Pre-POST monotonic check declared loss WITHOUT posting a renew.
    expect(fake.renewCount()).toBe(0);
    expect(proxies.byLease.get(handoff.leaseId)!.closes).toContain("deadline_lapse");
    expect(log).toContain(`onLeaseLost:${handoff.leaseId}`);
  });
});
