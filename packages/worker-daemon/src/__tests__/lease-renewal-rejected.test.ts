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

async function fireOneRenewal(): Promise<void> {
  const next = scheduler.setTimerLog[scheduler.setTimerLog.length - 1]!.targetMs;
  await scheduler.advanceTo(next);
}

describe("lease-renewal-rejected — a terminal renew outcome is a lease loss", () => {
  it("a 200 rejected(stale_fence) closes the fence proxy FIRST, then onLeaseLost", async () => {
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
    fake.enqueueRenew({ kind: "rejected", reason: "stale_fence" });
    void driver.accept(handoff);
    await fireOneRenewal();

    expect(log).toEqual([
      `accept:${handoff.leaseId}`,
      `close:${handoff.leaseId}:lease_lost`,
      `onLeaseLost:${handoff.leaseId}`,
    ]);
    expect(driver.activeRenewalCount()).toBe(0);
  });

  it("a 409 target_revoked is likewise a terminal lease loss", async () => {
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
    fake.enqueueRenew({ kind: "error", status: 409, code: "target_revoked" });
    void driver.accept(handoff);
    await fireOneRenewal();

    expect(log).toContain(`close:${handoff.leaseId}:lease_lost`);
    expect(log).toContain(`onLeaseLost:${handoff.leaseId}`);
    expect(log.indexOf(`close:${handoff.leaseId}:lease_lost`)).toBeLessThan(
      log.indexOf(`onLeaseLost:${handoff.leaseId}`),
    );
  });

  it("an attempt_terminal rejection is a terminal lease loss", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    const log: string[] = [];
    const sup = recordingSupervisor(log);
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
    fake.enqueueRenew({ kind: "rejected", reason: "attempt_terminal" });
    void driver.accept(handoff);
    await fireOneRenewal();

    expect(log).toContain(`onLeaseLost:${handoff.leaseId}`);
    // A lost grant is never resurrected: no reschedule after loss.
    expect(driver.activeRenewalCount()).toBe(0);
  });
});
