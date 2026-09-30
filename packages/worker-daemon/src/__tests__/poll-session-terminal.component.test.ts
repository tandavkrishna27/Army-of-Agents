/**
 * A long-running poll loop WILL outlive its 15-min session (E4-D11/E4-F007: the
 * as-built server offers NO session renewal on poll/ack, and the 10-min code
 * route is shorter than the 15-min session). This proves the loop treats a
 * session-expiry 401 as TERMINAL: it attempts a within-window recovery and, when
 * the code route has lapsed, STOPS and surfaces `reenrollment_required` via the
 * reused WRK-002 SessionStore terminal path — it does NOT busy-spin re-polling a
 * dead session.
 *
 * ★ WRK-010 slice 2 / SPRINT 3 RE-BASELINING NOTE. This suite wires BOTH SessionStore
 * seams (`renew` and `bootstrap`) to the enrolment CODE REPLAY, so `forceRefresh`'s
 * presence routing recovers via the replay regardless of which arm it takes — that is
 * the PRE-slice-2 `recover()` semantics, preserved here on purpose. In the composed
 * PRODUCTION daemon Sprint 3 builds, `renew` is the device-proof RENEWAL ROUTE
 * (`createSessionRenewer`), which REFUSES a server-rejected session (401 → stop) rather
 * than replaying a code. The two agree in every reachable case (a truly-expired session
 * always has an already-lapsed code, so both stop — CODE_TTL 10m < SESSION_TTL 15m), but
 * the `outcome="recovered"` case below models the replay body, not the route body. When
 * Sprint 3 threads the real renewer into `createPollLoop`, RE-BASELINE these recovery
 * cases against a fake that models the renewal route (the go-book's D1 re-baselining).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMetrics } from "../metrics/metrics.js";
import { createWorkerLogger } from "../logging/logger.js";
import { InMemoryKeyStore } from "../identity/key-store.js";
import { SessionStore, REENROLLMENT_REQUIRED_METRIC } from "../identity/session.js";
import { createEnroller } from "../enrollment/enroll.js";
import { createControlPlaneClient, type ControlPlaneClient } from "../transport/client.js";
import { measureCapacity, type WorkerSelfModel } from "../poll/capacity.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";
import { createPollLoop, createSessionProvider } from "../poll/poll-loop.js";

import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import {
  buildWorkerHello,
  enrollmentCodeConfig,
  fixtureCeiling,
  fixtureProbes,
  makeSelfModel,
} from "./support/poll-fixtures.js";

const CODE = "poll-terminal-code";
const BACKOFF = { baseMs: 1_000, maxMs: 30_000, jitter: 0 };
let fake: FakeControlPlane;
let self: WorkerSelfModel;

beforeEach(async () => {
  fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)] });
  self = await makeSelfModel();
});
afterEach(async () => {
  await fake.close();
});

interface Harness {
  store: SessionStore;
  metrics: ReturnType<typeof createMetrics>;
  clock: { t: number };
  loop: ReturnType<typeof createPollLoop>;
  discardSleep: number[];
}

async function buildHarness(
  opts: { wrapClient?: (client: ControlPlaneClient) => ControlPlaneClient } = {},
): Promise<Harness> {
  const keyStore = new InMemoryKeyStore();
  const client = createControlPlaneClient({ baseUrl: fake.baseUrl, path: fake.enrollPath });
  const enroller = createEnroller({ keyStore, client });
  const hello = buildWorkerHello();
  const first = await enroller.enroll({ hello, code: CODE });
  const key = keyStore.load();
  if (key === null) throw new Error("key missing");

  const metrics = createMetrics();
  const logger = createWorkerLogger();
  const clock = { t: first.session.obtainedAtMs + 1_000 };
  const store = new SessionStore(
    {
      now: () => clock.t,
      renew: () => enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey }).then((r) => r.session),
      bootstrap: () => enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey }).then((r) => r.session),
      metrics,
      logger,
    },
    first.session,
  );
  const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
  const discardSleep: number[] = [];
  const loopClient = opts.wrapClient ? opts.wrapClient(client) : client;
  const loop = createPollLoop({
    client: loopClient,
    self,
    key,
    session: createSessionProvider(store),
    limiter,
    measure: () =>
      measureCapacity({
        probes: fixtureProbes(),
        reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
        slots: limiter.snapshot(),
        ceiling: fixtureCeiling(),
      }),
    supervisor: { accept: () => {} },
    metrics,
    backoff: BACKOFF,
    sleep: async (ms) => {
      discardSleep.push(ms);
    },
  });
  return { store, metrics, clock, loop, discardSleep };
}

describe("poll-session-terminal — a session-expiry 401 during the loop is TERMINAL", () => {
  it("stops with reenrollment_required (no busy-spin) when a poll 401 cannot be recovered (code route lapsed)", async () => {
    const h = await buildHarness();
    // The store still believes its session is live (clock < 15-min expiry), but the
    // server has expired it: the NEXT poll 401s. The code route has also lapsed, so
    // the loop's recovery replay 401s → terminal.
    const token = fake.lastSessionToken();
    expect(token).not.toBeNull();
    fake.expireSession(token!);
    fake.expireCode(CODE);

    const reason = await h.loop.run();
    expect(reason).toBe("reenrollment_required");

    // Exactly ONE poll happened, then the failed recovery, then a full stop — the
    // loop never re-polled with the dead session (no busy-spin).
    expect(fake.pollCount()).toBe(1);
    expect(h.store.isStopped()).toBe(true);
    // The reused WRK-002 SessionStore terminal signal fired.
    expect(h.metrics.renderPrometheus()).toContain(REENROLLMENT_REQUIRED_METRIC);
  });

  it("stops with reenrollment_required when the store detects expiry before polling (recovery impossible)", async () => {
    const h = await buildHarness();
    // Advance the store's own clock past the 15-min session expiry AND lapse the
    // code route: ensureFresh() triggers a recovery replay that 401s → terminal,
    // BEFORE the first poll is ever sent.
    h.clock.t += 20 * 60_000;
    fake.expireCode(CODE);

    const reason = await h.loop.run();
    expect(reason).toBe("reenrollment_required");
    expect(fake.pollCount()).toBe(0);
    expect(h.store.isStopped()).toBe(true);
    expect(h.metrics.renderPrometheus()).toContain(REENROLLMENT_REQUIRED_METRIC);
  });

  it("bounds a persistent recover-then-poll-401 cycle: stops with reenrollment_required, no unbounded flood", async () => {
    // A guarded client trips on a poll flood so the OLD (unbounded) behavior fails
    // FAST with a clear error instead of hanging the suite.
    let pollCalls = 0;
    const h = await buildHarness({
      wrapClient: (c) => ({
        ...c,
        poll: async (req) => {
          pollCalls += 1;
          if (pollCalls > 10) {
            throw new Error(`poll flood: ${pollCalls} calls — the recover→poll→recover cycle is unbounded`);
          }
          return c.poll(req);
        },
      }),
    });
    // Every poll 401s (audience/clock desync) but the code route stays live, so
    // every recover (enroll replay) SUCCEEDS — the classic recover→poll→recover spin.
    fake.forcePollUnauthorized(true);

    const reason = await h.loop.run();
    expect(reason).toBe("reenrollment_required");
    // Bounded: exactly MAX_CONSECUTIVE_RECOVERIES (3) poll attempts, then terminate.
    expect(fake.pollCount()).toBe(3);
    expect(pollCalls).toBe(3);
    // The store itself never went terminal (recover succeeded each time) — the LOOP
    // bounded the spin, distinct from a lapsed-code-route store terminal.
    expect(h.store.isStopped()).toBe(false);
    expect(h.metrics.renderPrometheus()).toContain('poll_outcome{outcome="reenrollment_required"} 1');
  });

  it("recovers and keeps polling when the session lapses but the code route is still live", async () => {
    const h = await buildHarness();
    // The server expired the session, but the code route is STILL live → the loop's
    // recovery replay mints a fresh session and continues. A subsequent drain stops it.
    const token = fake.lastSessionToken();
    fake.expireSession(token!);
    fake.enqueuePoll({ kind: "drain" });

    const reason = await h.loop.run();
    // First poll 401 → recover (succeeds within window) → re-poll → drain.
    expect(reason).toBe("drained");
    expect(fake.pollCount()).toBe(2);
    expect(h.store.isStopped()).toBe(false);
    expect(h.metrics.renderPrometheus()).toContain('poll_outcome{outcome="recovered"} 1');
  });
});
