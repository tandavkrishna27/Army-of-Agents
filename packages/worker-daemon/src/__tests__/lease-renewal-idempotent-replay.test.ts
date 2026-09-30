import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renewLeaseOnce } from "../lease/lease-renewal.js";

import type { FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import {
  FakeScheduler,
  RENEWAL_CODE,
  makeRenewalHandoff,
  startRenewalPlane,
} from "./support/renewal-fixtures.js";

let scheduler: FakeScheduler;
let fake: FakeControlPlane;

// Two distinct, valid v4 idempotency keys.
const KEY_A = "00000000-0000-4000-8000-0000000000f5";
const KEY_B = "00000000-0000-4000-8000-0000000000f6";

beforeEach(async () => {
  scheduler = new FakeScheduler();
  fake = await startRenewalPlane(scheduler);
});
afterEach(async () => {
  await fake.close();
});

describe("lease-renewal-idempotent-replay — a same-key retry never double-extends", () => {
  it("a replayed key returns the recorded expiry even after the clock moves; a fresh key extends", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    const offer = makeRenewalHandoff().offer;

    const a1 = await renewLeaseOnce({ client, session, offer, key, idempotencyKey: KEY_A });
    // Advance the clock BEFORE the replay: if the plane re-extended, the expiry
    // would move; idempotency pins it to the first-recorded value.
    scheduler.advanceClock(5_000);
    const a2 = await renewLeaseOnce({ client, session, offer, key, idempotencyKey: KEY_A });

    expect(a1.kind).toBe("renewed");
    expect(a2.kind).toBe("renewed");
    if (a1.kind !== "renewed" || a2.kind !== "renewed") throw new Error("expected renewed");
    expect(a2.expiresAt).toBe(a1.expiresAt); // no double-extend
    expect(fake.renewCount()).toBe(2); // two REQUESTS
    expect(fake.renewKeys()).toEqual([KEY_A]); // ONE logical key

    // A NEW interval mints a fresh key → a genuine (later) extension at the moved clock.
    const a3 = await renewLeaseOnce({ client, session, offer, key, idempotencyKey: KEY_B });
    expect(a3.kind).toBe("renewed");
    if (a3.kind !== "renewed") throw new Error("expected renewed");
    expect(Date.parse(a3.expiresAt)).toBeGreaterThan(Date.parse(a1.expiresAt));
    expect(fake.renewKeys()).toEqual([KEY_A, KEY_B]);
  });
});
