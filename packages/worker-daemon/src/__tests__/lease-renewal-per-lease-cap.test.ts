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

const LEASE_A = "aaaaaaaa-0000-4000-8000-000000000001";
const LEASE_B = "bbbbbbbb-0000-4000-8000-000000000002";

describe("lease-renewal per-lease recovery cap — one lease's recoveries never contaminate another's cap", () => {
  it("a lease that caps does NOT push a concurrent lease over its own recovery cap", async () => {
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

    // Lease A: persistent 401 → recovers up to the cap (3) → declares loss. A driver-GLOBAL
    // counter would be left at 3 here (declareLoss does not reset it).
    const handoffA = makeRenewalHandoff({ windowMs: 100_000, leaseId: LEASE_A });
    fake.forceRenewUnauthorized(true);
    void driver.accept(handoffA);
    await fireOneRenewal();
    expect(sup.calls).toContain(`onLeaseLost:${LEASE_A}`);

    // Lease B: exactly ONE 401 then renewed. With a PER-LEASE counter, B recovers once
    // (1 < 3) and renews → still alive. A driver-global counter would already be at 3 from A,
    // so B's single recovery would trip the cap and SPURIOUSLY lose a healthy lease.
    fake.forceRenewUnauthorized(false);
    fake.enqueueRenew({ kind: "error", status: 401, code: "unauthorized" });
    const handoffB = makeRenewalHandoff({ windowMs: 100_000, leaseId: LEASE_B });
    void driver.accept(handoffB);
    await fireOneRenewal();

    expect(sup.calls).not.toContain(`onLeaseLost:${LEASE_B}`);
    expect(driver.activeRenewalCount()).toBe(1); // B is still renewing
  });
});
