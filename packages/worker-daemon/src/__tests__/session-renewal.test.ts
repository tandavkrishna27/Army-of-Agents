import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryKeyStore } from "../identity/key-store.js";
import { createEnroller, EnrollmentError, type WorkerSession } from "../enrollment/enroll.js";
import { SessionStore, SessionStoppedError } from "../identity/session.js";
import { createControlPlaneClient } from "../transport/client.js";
import { createMetrics } from "../metrics/metrics.js";
import type { Logger } from "../logging/logger.js";

import {
  startFakeControlPlane,
  DEFAULT_CODE_TTL_MS,
  type FakeControlPlane,
} from "./support/fake-control-plane.js";
import { buildHello, sampleProviderConstraints } from "./support/enroll-fixtures.js";

// Recovery semantics (E4-D11): the replay path is a LOST-RESPONSE idempotent
// recovery mechanism, live only while the enrollment code route is (≤10 min).
// It is NOT sustained session renewal — a replay attempted AFTER the code route
// expires is what the real server rejects with HTTP 401, so the fake models the
// code-route TTL and the worker treats that 401 as terminal (stop + back off +
// signal that operator re-enrollment is required). The old "refresh a near-expiry
// session via replay and assert it SUCCEEDS at ~14.5 min" case asserted a request
// the real server 401s, and has been removed.
const CODE = "renew-code";
const ISSUE_TIME = Date.UTC(2026, 7, 12, 0, 0, 0);

let fake: FakeControlPlane;
let targetId: string;
let clock: number;

beforeEach(async () => {
  targetId = randomUUID();
  clock = ISSUE_TIME;
  // The fake shares the worker's clock, so the code route is issued at ISSUE_TIME
  // and expires at ISSUE_TIME + DEFAULT_CODE_TTL_MS — the test controls the window.
  fake = await startFakeControlPlane({
    now: () => clock,
    enrollments: [{ code: CODE, targetId, deviceGeneration: 1, providerConstraints: sampleProviderConstraints() }],
  });
});
afterEach(async () => {
  await fake.close();
});

function wire() {
  const keyStore = new InMemoryKeyStore();
  const client = createControlPlaneClient({ baseUrl: fake.baseUrl, path: fake.enrollPath });
  const enroller = createEnroller({ keyStore, client, now: () => clock });
  const hello = buildHello({ targetId, deviceGeneration: 1 });
  return { keyStore, enroller, hello };
}

/** A spy logger + a real metrics instance to observe the reenrollment signal. */
function makeSignals(): {
  logger: Logger;
  metrics: ReturnType<typeof createMetrics>;
  warns: Array<{ bindings: Record<string, unknown>; message: string }>;
} {
  const warns: Array<{ bindings: Record<string, unknown>; message: string }> = [];
  const logger: Logger = {
    info() {},
    warn(a: string | Record<string, unknown>, b?: string) {
      if (typeof a === "string") warns.push({ bindings: {}, message: a });
      else warns.push({ bindings: a, message: b ?? "" });
    },
    error() {},
    flush: async () => {},
  };
  return { logger, metrics: createMetrics(), warns };
}

describe("session recovery — lost-response replay within the code window", () => {
  it("recovers a lost enroll response via a replay (same identity, new session, no double-consume)", async () => {
    const { enroller, hello } = wire();
    const { logger, metrics, warns } = makeSignals();

    // The enroll SUCCEEDED server-side (code consumed, session issued) but the
    // RESPONSE was dropped in transit — the worker holds no session.
    const first = await enroller.enroll({ hello, code: CODE });

    const store = new SessionStore(
      {
        now: () => clock,
        logger,
        metrics,
        // WRK-010 slice 2: the code replay is now `bootstrap` (first-session
        // acquisition). `renew` (the device-proof route) is wired to the same body
        // here so these pre-slice-2 STOP/recovery cases keep their behaviour under
        // `forceRefresh`'s presence routing — a distinct-spy test proves the routing.
        renew: async () => (await enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey })).session,
        bootstrap: async () => (await enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey })).session,
      },
      null, // lost response: no session persisted
    );

    // Still within the 10-min code route (clock unchanged since issuance).
    const recovered = await store.recover();

    expect(recovered.token).not.toBe(first.session.token);
    expect(recovered.workerId).toBe(first.workerId);
    expect(store.current()?.token).toBe(recovered.token);
    expect(store.isStopped()).toBe(false);

    // Recovery replays the stored identity — it must NOT re-consume the code.
    expect(fake.consumeCountFor(CODE)).toBe(1);
    expect(fake.sessionsIssuedFor(CODE)).toBe(2); // initial + recovery
    expect(fake.usedProofIdCount()).toBe(2); // two distinct FRESH proofs

    // A successful recovery emits NO re-enrollment signal.
    expect(metrics.renderPrometheus()).not.toContain("session_reenrollment_required_total");
    expect(warns).toHaveLength(0);
  });

  it("a repeated lost-response replay never double-consumes the code", async () => {
    const { enroller, hello } = wire();
    const first = await enroller.enroll({ hello, code: CODE });

    // Two independent replays with the SAME idempotency key (repeated
    // lost-response retries). Each carries a fresh proof; each replays the
    // stored identity while the code route is still live.
    const second = await enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey });
    const third = await enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey });

    expect(second.session.token).not.toBe(first.session.token);
    expect(third.session.token).not.toBe(second.session.token);
    expect(second.workerId).toBe(first.workerId);
    expect(third.workerId).toBe(first.workerId);

    // Consumed exactly once across the initial enroll + both replays.
    expect(fake.consumeCountFor(CODE)).toBe(1);
    expect(fake.sessionsIssuedFor(CODE)).toBe(3);
    expect(fake.usedProofIdCount()).toBe(3);
  });

  it("a replay that changes the semantic digest is rejected as malformed", async () => {
    const { enroller, hello } = wire();
    const first = await enroller.enroll({ hello, code: CODE });

    // Reuse the idempotency key but change the hello (agentVersion) → the server
    // semantic digest no longer matches the consumed record → malformed.
    const changedHello = buildHello({ targetId, deviceGeneration: 1, agentVersion: "9.9.9" });
    await expect(
      enroller.renew({ hello: changedHello, code: CODE, idempotencyKey: first.idempotencyKey }),
    ).rejects.toMatchObject({ kind: "malformed", terminalForRequest: true, stopAndBackoff: false });
    expect(fake.consumeCountFor(CODE)).toBe(1);
  });
});

describe("session recovery — code route expiry is terminal (re-enrollment required)", () => {
  it("after the code route expires, a replay is 401 → store stops and signals reenrollment_required", async () => {
    const { enroller, hello } = wire();
    const { logger, metrics, warns } = makeSignals();
    const first = await enroller.enroll({ hello, code: CODE });

    const store = new SessionStore(
      {
        now: () => clock,
        logger,
        metrics,
        // WRK-010 slice 2: the code replay is now `bootstrap` (first-session
        // acquisition). `renew` (the device-proof route) is wired to the same body
        // here so these pre-slice-2 STOP/recovery cases keep their behaviour under
        // `forceRefresh`'s presence routing — a distinct-spy test proves the routing.
        renew: async () => (await enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey })).session,
        bootstrap: async () => (await enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey })).session,
      },
      first.session,
    );

    // Advance PAST the 10-min code route (the 15-min session may still look
    // live). A replay here is exactly what the REAL server rejects with 401; the
    // faithful fake mirrors that (a fake that accepts it would itself be the
    // defect — remove the fake's code-TTL rejection and this test goes RED).
    clock = ISSUE_TIME + DEFAULT_CODE_TTL_MS + 1_000;

    await expect(store.recover()).rejects.toMatchObject({
      kind: "unauthorized",
      terminalForRequest: true,
      stopAndBackoff: true,
      httpStatus: 401,
    });

    // Terminal: the store drops the dead identity and fails closed — it does NOT
    // spin retrying a dead identity.
    expect(store.isStopped()).toBe(true);
    expect(store.current()).toBeNull();
    await expect(store.recover()).rejects.toBeInstanceOf(SessionStoppedError);
    await expect(store.ensureFresh()).rejects.toBeInstanceOf(SessionStoppedError);

    // It never re-consumed the code trying to recover a dead identity.
    expect(fake.consumeCountFor(CODE)).toBe(1);

    // The re-enrollment signal fired exactly once: metric + warn log line.
    expect(metrics.renderPrometheus()).toContain(
      'session_reenrollment_required_total{reason="enroll_unauthorized"} 1',
    );
    expect(warns.filter((w) => w.message.includes("re-enrollment"))).toHaveLength(1);
  });
});

describe("session store — rotation detection", () => {
  it("flags a refresh whose device generation changed as a rotation", async () => {
    const base: WorkerSession = {
      token: "t0",
      workerId: randomUUID(),
      targetId,
      deviceGeneration: 1,
      obtainedAtMs: clock,
      ttlMs: 900_000,
      expiresAtMs: clock + 900_000,
    };
    let generation = 1;
    const store = new SessionStore(
      {
        now: () => clock,
        renew: async () => ({ ...base, token: `t${generation}`, deviceGeneration: generation }),
        // #current stays live here, so forceRefresh always routes to renew; bootstrap
        // is required by the type and never reached on this path.
        bootstrap: async () => ({ ...base, token: `t${generation}`, deviceGeneration: generation }),
      },
      base,
    );

    generation = 1;
    await store.forceRefresh();
    expect(store.lastRefreshRotated()).toBe(false);

    generation = 2;
    const rotated = await store.forceRefresh();
    expect(rotated.deviceGeneration).toBe(2);
    expect(store.lastRefreshRotated()).toBe(true);
  });

  it("propagates a non-stop enrollment error without stopping the store", async () => {
    const base: WorkerSession = {
      token: "t0",
      workerId: randomUUID(),
      targetId,
      deviceGeneration: 1,
      obtainedAtMs: clock,
      ttlMs: 900_000,
      expiresAtMs: clock + 900_000,
    };
    const store = new SessionStore(
      {
        now: () => clock,
        renew: async () => {
          throw new EnrollmentError("internal_unavailable", false, false, "temporary");
        },
        bootstrap: async () => {
          throw new EnrollmentError("internal_unavailable", false, false, "temporary");
        },
      },
      base,
    );
    await expect(store.forceRefresh()).rejects.toMatchObject({ kind: "internal_unavailable" });
    expect(store.isStopped()).toBe(false);
    expect(store.current()?.token).toBe("t0");
  });
});
