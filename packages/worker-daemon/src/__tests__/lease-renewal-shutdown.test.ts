import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLeaseRenewalDriver } from "../lease/lease-renewal.js";
import { createLeaseLifecycleSteps, createShutdownHandler } from "../lifecycle/shutdown.js";

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

describe("lease-renewal-shutdown — renewal-stop is ordered between lease-stop and lease-drain", () => {
  it("registers renewal-stop between lease-stop and lease-drain and runs them in order", async () => {
    const order: string[] = [];
    const steps = createLeaseLifecycleSteps(
      {
        stopLeasing: () => order.push("lease-stop"),
        drain: async () => {
          order.push("drain");
        },
      },
      { stop: () => order.push("renewal-stop") },
    );
    expect(steps.map((s) => s.name)).toEqual(["lease-stop", "renewal-stop", "lease-drain"]);

    const handler = createShutdownHandler({
      steps: [...steps, { name: "health-server", stop: () => order.push("health") }],
      logger: { info: () => {}, error: () => {} },
      exit: () => {},
    });
    await handler("SIGTERM");
    expect(order).toEqual(["lease-stop", "renewal-stop", "drain", "health"]);
  });

  it("driver.stop() cancels renewal timers so no renew fires during drain", async () => {
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
    const renewalTarget = scheduler.setTimerLog[scheduler.setTimerLog.length - 1]!.targetMs;

    // Shutdown: stop the renewal driver, THEN advance past the renewal instant.
    driver.stop();
    await scheduler.advanceTo(renewalTarget + 10_000);

    expect(fake.renewCount()).toBe(0);
    expect(driver.activeRenewalCount()).toBe(0);
  });
});
