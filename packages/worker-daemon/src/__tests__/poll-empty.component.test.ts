import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { measureCapacity } from "../poll/capacity.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";
import { pollOnce } from "../poll/poll-loop.js";

import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import {
  enrollFixtureWorker,
  enrollmentCodeConfig,
  fixtureCeiling,
  fixtureProbes,
} from "./support/poll-fixtures.js";

const CODE = "poll-empty-code";
let fake: FakeControlPlane;

beforeEach(async () => {
  fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)] });
});
afterEach(async () => {
  await fake.close();
});

describe("poll-empty.component — no_work → re-poll after retryAfterMs", () => {
  it("an empty poll returns no_work with the server's retryAfterMs", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueuePoll({ kind: "no_work", retryAfterMs: 2_500 });

    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const capacity = measureCapacity({
      probes: fixtureProbes(),
      reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
      slots: limiter.snapshot(),
      ceiling: fixtureCeiling(),
    });

    const outcome = await pollOnce({ client, session, capacity, key });
    expect(outcome).toEqual({ kind: "no_work", retryAfterMs: 2_500 });
    expect(fake.pollCount()).toBe(1);
    // A no_work poll never records an ACK.
    expect(fake.acks()).toHaveLength(0);
  });

  it("the poll authenticated with BOTH the Bearer session and a fresh device proof", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueuePoll({ kind: "no_work", retryAfterMs: 1_000 });
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    const capacity = measureCapacity({
      probes: fixtureProbes(),
      reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
      slots: limiter.snapshot(),
    });

    const outcome = await pollOnce({ client, session, capacity, key });
    expect(outcome.kind).toBe("no_work");
    // The fake independently verified the proof and bound it to the session; a
    // recorded 200 poll proves both credentials were accepted.
    const pollRecord = fake.requests.find((r) => r.url === fake.pollPath);
    expect(pollRecord?.status).toBe(200);
    expect(pollRecord?.deviceThumbprint).toBe(key.deviceThumbprint);
  });

  it("re-poll after a no_work returns the next queued no_work (bounded cadence)", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, CODE);
    fake.enqueuePoll({ kind: "no_work", retryAfterMs: 1_000 });
    fake.enqueuePoll({ kind: "no_work", retryAfterMs: 5_000 });
    const capacity = measureCapacity({
      probes: fixtureProbes(),
      reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
      slots: { batch: 1, browser_session: 0, service: 0 },
    });

    const first = await pollOnce({ client, session, capacity, key });
    const second = await pollOnce({ client, session, capacity, key });
    expect(first).toEqual({ kind: "no_work", retryAfterMs: 1_000 });
    expect(second).toEqual({ kind: "no_work", retryAfterMs: 5_000 });
    expect(fake.pollCount()).toBe(2);
  });
});
