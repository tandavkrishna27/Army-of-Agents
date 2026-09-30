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

describe("lease-renewal-deadline-lapse — renew keeps timing out past expiresAt → fail-closed loss", () => {
  it("declares a local lease loss once the deadline lapses; no later renew is trusted", async () => {
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
      // First renewal fires 1s into a 10s window; each transient retry advances 1s.
      tuning: { leadMs: 9_000, retryFloorMs: 1_000 },
    });

    const handoff = makeRenewalHandoff({ windowMs: 10_000 });
    // Every renew times out (503). A trailing `renewed` proves it is NEVER trusted
    // once the deadline has lapsed.
    for (let i = 0; i < 12; i += 1) fake.enqueueRenew({ kind: "error", status: 503, code: "internal_unavailable" });
    fake.enqueueRenew({ kind: "renewed" });

    void driver.accept(handoff);
    const next = scheduler.setTimerLog[scheduler.setTimerLog.length - 1]!.targetMs;
    await scheduler.advanceTo(next);

    // Local fail-closed loss: fence closed (deadline_lapse) then onLeaseLost.
    expect(proxies.byLease.get(handoff.leaseId)!.closes).toContain("deadline_lapse");
    expect(log).toContain(`close:${handoff.leaseId}:deadline_lapse`);
    expect(log).toContain(`onLeaseLost:${handoff.leaseId}`);
    // No renewal ever succeeded — the trailing `renewed` was not consumed.
    expect(fake.renews()).toHaveLength(0);
    expect(driver.activeRenewalCount()).toBe(0);
  });
});
