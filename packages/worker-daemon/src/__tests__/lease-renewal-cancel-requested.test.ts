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

describe("lease-renewal-cancel-requested — a renewed{cancelRequested:true} stops cooperatively", () => {
  it("closes the fence proxy and calls supervisor.cancel(reason) — not onLeaseLost", async () => {
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
    // The server extends the lease but orders a cooperative cancel.
    fake.enqueueRenew({ kind: "renewed", cancelRequested: true, cancelReason: "operator_cancel" });
    void driver.accept(handoff);

    const next = scheduler.setTimerLog[scheduler.setTimerLog.length - 1]!.targetMs;
    await scheduler.advanceTo(next);

    // The fence proxy closed (cancel_requested) BEFORE cancel was escalated.
    expect(log).toEqual([
      `accept:${handoff.leaseId}`,
      `close:${handoff.leaseId}:cancel_requested`,
      `cancel:${handoff.leaseId}:operator_cancel`,
    ]);
    expect(proxies.byLease.get(handoff.leaseId)!.isActive()).toBe(false);
    // A cooperative cancel is NOT a lease loss.
    expect(log).not.toContain(`onLeaseLost:${handoff.leaseId}`);
    expect(driver.activeRenewalCount()).toBe(0);
  });
});
