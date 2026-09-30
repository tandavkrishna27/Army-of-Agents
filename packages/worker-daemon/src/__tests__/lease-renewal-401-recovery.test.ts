import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLeaseRenewalDriver } from "../lease/lease-renewal.js";

import type { FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import {
  FakeScheduler,
  RENEWAL_CODE,
  RENEWAL_IDENTITY,
  controllableSessionProvider,
  makeRenewalHandoff,
  recordingSupervisor,
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

describe("lease-renewal-401-recovery — a renew 401 recovers via session.recover() and retries the SAME key", () => {
  it("recovers once then succeeds; the retry replays the same idempotency key", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    const provider = controllableSessionProvider(session);
    const sup = recordingSupervisor();
    const driver = createLeaseRenewalDriver({
      client,
      session: provider,
      key,
      identity: RENEWAL_IDENTITY,
      supervisor: sup.supervisor,
      schedule: scheduler,
      tuning: { leadMs: 20_000 },
    });

    const handoff = makeRenewalHandoff({ windowMs: 100_000 });
    // First renew: 401. Second (after recover, same key): default renewed.
    fake.enqueueRenew({ kind: "error", status: 401, code: "unauthorized" });
    void driver.accept(handoff);
    await fireOneRenewal();

    expect(provider.recoverCount()).toBe(1);
    // Two renew ATTEMPTS, but only ONE recorded (the successful one).
    expect(fake.renewCount()).toBe(2);
    expect(fake.renews()).toHaveLength(1);
    expect(sup.calls).not.toContain(`onLeaseLost:${handoff.leaseId}`);
    expect(driver.activeRenewalCount()).toBe(1);
  });

  it("a persistent 401 trips the recovery cap → SessionTerminal-equivalent lease loss", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    const provider = controllableSessionProvider(session);
    const sup = recordingSupervisor();
    const driver = createLeaseRenewalDriver({
      client,
      session: provider,
      key,
      identity: RENEWAL_IDENTITY,
      supervisor: sup.supervisor,
      schedule: scheduler,
      tuning: { leadMs: 20_000 },
      maxConsecutiveRecoveries: 3,
    });

    const handoff = makeRenewalHandoff({ windowMs: 100_000 });
    fake.forceRenewUnauthorized(true); // every renew 401s; recovery can't clear it
    void driver.accept(handoff);
    await fireOneRenewal();

    // Recovered up to the cap (3), then declared loss rather than busy-spin.
    expect(provider.recoverCount()).toBe(3);
    expect(sup.calls).toContain(`onLeaseLost:${handoff.leaseId}`);
    expect(driver.activeRenewalCount()).toBe(0);
  });
});
