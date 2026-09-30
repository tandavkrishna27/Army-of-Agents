// server/src/__tests__/worker-admission-rate-limit.integration.test.ts
//
// DEP-009 — the PG-backed SHARED worker-poll rate limiter, against real embedded Postgres
// under the aoa_app RLS role. Proves:
//   * over the per-org window cap the limiter DENIES (reason "over_cap");
//   * a later fixed window RESETS the counter (fresh row, count back to 1);
//   * the atomic upsert-increment is a SINGLE shared row — N concurrent admits get distinct
//     counts 1..N with no lost updates and exactly ONE window row (idempotent under races);
//   * two SEPARATE limiter instances (simulating two control-plane replicas) over the SAME
//     store share ONE counter — no process-local admission state;
//   * a shared-store error FAILS CLOSED (reason "unavailable"), never a silent admit.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@armyofagents/db";
import {
  createWorkerAdmissionRateLimiter,
  windowStartFor,
} from "../services/worker-admission-rate-limit.js";
import { ORG, setupJobControlFixture, type JobControlFixture } from "./helpers/job-control-fixture.js";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

integration("DEP-009 shared worker-poll rate limiter", () => {
  let fx: JobControlFixture | null = null;
  let setupError: unknown = null;

  function ctx(): JobControlFixture {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!fx) throw new Error("fixture not initialized");
    return fx;
  }

  async function clearWindows(): Promise<void> {
    await ctx().admin`DELETE FROM worker_admission_rate_limits`;
  }

  async function windowRows(): Promise<Array<{ window_start: Date; request_count: number }>> {
    return ctx().admin<{ window_start: Date; request_count: number }[]>`
      SELECT window_start, request_count FROM worker_admission_rate_limits
      WHERE organization_id = ${ORG} ORDER BY window_start`;
  }

  // A fixed clock pinned to a known window so the test controls the bucket boundary.
  const WINDOW_MS = 60_000;
  const clockAt = (ms: number) => () => new Date(ms);
  // DE-27 — `admit` now takes the refused worker's id (recorded as the over_cap actor).
  // This suite proves the counter mechanics, not the audit row, so any stable id serves.
  const WORKER = "d7000000-0000-4000-8000-0000000000a1";

  beforeAll(async () => {
    try {
      fx = await setupJobControlFixture("worker-admission-rl");
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await fx?.teardown();
  }, 60_000);

  it("denies over the per-org window cap", async () => {
    await clearWindows();
    const limiter = createWorkerAdmissionRateLimiter({
      appDb: ctx().app.db,
      config: { windowMs: WINDOW_MS, max: 2 },
      now: clockAt(120_000),
    });
    const first = await limiter.admit(ORG, WORKER);
    const second = await limiter.admit(ORG, WORKER);
    const third = await limiter.admit(ORG, WORKER);
    expect(first).toEqual({ allowed: true, count: 1, limit: 2 });
    expect(second).toEqual({ allowed: true, count: 2, limit: 2 });
    expect(third).toEqual({ allowed: false, reason: "over_cap", count: 3, limit: 2 });

    const rows = await windowRows();
    expect(rows).toHaveLength(1); // one shared window row
    expect(rows[0]!.request_count).toBe(3);
  }, 60_000);

  it("resets the counter in a later fixed window", async () => {
    await clearWindows();
    const capHit = createWorkerAdmissionRateLimiter({
      appDb: ctx().app.db,
      config: { windowMs: WINDOW_MS, max: 1 },
      now: clockAt(120_000),
    });
    expect((await capHit.admit(ORG, WORKER)).allowed).toBe(true);
    expect((await capHit.admit(ORG, WORKER)).allowed).toBe(false); // over cap in window @120000

    // A limiter whose clock is in the NEXT window mints a fresh row and admits again.
    const nextWindow = createWorkerAdmissionRateLimiter({
      appDb: ctx().app.db,
      config: { windowMs: WINDOW_MS, max: 1 },
      now: clockAt(120_000 + WINDOW_MS),
    });
    const admitted = await nextWindow.admit(ORG, WORKER);
    expect(admitted).toEqual({ allowed: true, count: 1, limit: 1 });

    const rows = await windowRows();
    expect(rows).toHaveLength(2); // two distinct window rows
    expect(rows.map((r) => r.request_count)).toEqual([2, 1]);
    expect(rows[0]!.window_start.getTime()).toBe(windowStartFor(new Date(120_000), WINDOW_MS).getTime());
    expect(rows[1]!.window_start.getTime()).toBe(windowStartFor(new Date(120_000 + WINDOW_MS), WINDOW_MS).getTime());
  }, 60_000);

  it("serializes concurrent admits into one shared row with no lost updates", async () => {
    await clearWindows();
    const limiter = createWorkerAdmissionRateLimiter({
      appDb: ctx().app.db,
      config: { windowMs: WINDOW_MS, max: 1_000 },
      now: clockAt(120_000),
    });
    const N = 12;
    const decisions = await Promise.all(Array.from({ length: N }, () => limiter.admit(ORG, WORKER)));
    const counts = decisions
      .map((d) => (d.allowed || d.reason === "over_cap" ? d.count : NaN))
      .sort((a, b) => a - b);
    // Distinct, contiguous 1..N — the atomic RETURNING gives every caller a unique count
    // (no read-then-write lost update).
    expect(counts).toEqual(Array.from({ length: N }, (_v, i) => i + 1));
    const rows = await windowRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.request_count).toBe(N);
  }, 60_000);

  it("shares ONE counter across two limiter instances (two replicas, no process-local state)", async () => {
    await clearWindows();
    const replicaA = createWorkerAdmissionRateLimiter({
      appDb: ctx().app.db,
      config: { windowMs: WINDOW_MS, max: 3 },
      now: clockAt(120_000),
    });
    const replicaB = createWorkerAdmissionRateLimiter({
      appDb: ctx().app.db,
      config: { windowMs: WINDOW_MS, max: 3 },
      now: clockAt(120_000),
    });
    // A+A+B = 3 (all admitted); the 4th (B) trips the SHARED cap even though it is B's first.
    expect((await replicaA.admit(ORG, WORKER)).count).toBe(1);
    expect((await replicaA.admit(ORG, WORKER)).count).toBe(2);
    expect((await replicaB.admit(ORG, WORKER)).count).toBe(3);
    const overflow = await replicaB.admit(ORG, WORKER);
    expect(overflow).toEqual({ allowed: false, reason: "over_cap", count: 4, limit: 3 });

    const rows = await windowRows();
    expect(rows).toHaveLength(1); // ONE shared counter, not one per replica
    expect(rows[0]!.request_count).toBe(4);
  }, 60_000);

  it("fails CLOSED on a shared-store error (denies, never a silent admit)", async () => {
    // A broken store: db.transaction throws. The limiter must NOT fall back to a per-process
    // admit — it returns { allowed:false, reason:"unavailable" }.
    const brokenDb = {
      transaction() {
        throw new Error("shared admission store is down");
      },
    } as unknown as Db;
    const limiter = createWorkerAdmissionRateLimiter({
      appDb: brokenDb,
      config: { windowMs: WINDOW_MS, max: 100 },
      now: clockAt(120_000),
    });
    const decision = await limiter.admit(ORG, WORKER);
    expect(decision).toEqual({ allowed: false, reason: "unavailable", limit: 100 });
  }, 60_000);
});
