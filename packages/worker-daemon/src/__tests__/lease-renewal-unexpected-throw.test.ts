import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLeaseRenewalDriver } from "../lease/lease-renewal.js";
import type { ControlPlaneClient } from "../transport/client.js";

import type { FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import {
  FakeScheduler,
  RENEWAL_CODE,
  RENEWAL_IDENTITY,
  controllableSessionProvider,
  makeRenewalHandoff,
  recordingSupervisor,
  spyProxyFactory,
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

describe("lease-renewal unexpected throw — a non-transport throw fails closed to lease loss (never a silent hang)", () => {
  it("closes the fence proxy and escalates onLeaseLost when leaseRenew throws unexpectedly", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    const provider = controllableSessionProvider(session);
    // recordingSupervisor + spyProxyFactory share ONE log so the assertion can prove the
    // proxy closed BEFORE the supervisor was escalated.
    const log: string[] = [];
    const sup = recordingSupervisor(log);
    const proxies = spyProxyFactory(log);

    // A renew that throws a NON-transport error (e.g. a mid-body-stream read failure surfaced
    // as a plain TypeError, a signing fault, or a schema throw). `renewLeaseOnce` only maps
    // `ControlPlaneTransportError` to a transient outcome — everything else is re-thrown, so
    // this reaches `driveRenewal` as an unclassified throw.
    const throwingClient: ControlPlaneClient = {
      ...client,
      leaseRenew: async () => {
        throw new Error("body stream reset mid-read");
      },
    };

    const driver = createLeaseRenewalDriver({
      client: throwingClient,
      session: provider,
      key,
      identity: RENEWAL_IDENTITY,
      supervisor: sup.supervisor,
      schedule: scheduler,
      tuning: { leadMs: 20_000 },
      makeFenceProxy: proxies.factory,
    });

    const handoff = makeRenewalHandoff({ windowMs: 100_000 });
    void driver.accept(handoff);
    await fireOneRenewal();

    // Fail-closed: the fence proxy is CLOSED (defense in depth) and the lease loss is
    // escalated — NOT left silently renewing with an open fence and an unhandled rejection.
    expect(log).toContain(`close:${handoff.leaseId}:lease_lost`);
    expect(sup.calls).toContain(`onLeaseLost:${handoff.leaseId}`);
    // Ordering: close precedes escalation (worker denies local effects before cleanup runs).
    expect(log.indexOf(`close:${handoff.leaseId}:lease_lost`)).toBeLessThan(
      log.indexOf(`onLeaseLost:${handoff.leaseId}`),
    );
    expect(driver.activeRenewalCount()).toBe(0);
  });
});
