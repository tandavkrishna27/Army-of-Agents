import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryKeyStore } from "../identity/key-store.js";
import { createEnroller } from "../enrollment/enroll.js";
import { SessionStore, SessionStoppedError } from "../identity/session.js";
import { createControlPlaneClient } from "../transport/client.js";

import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import { buildHello, sampleProviderConstraints } from "./support/enroll-fixtures.js";

const CODE = "revoke-code";

let fake: FakeControlPlane;
let targetId: string;
let clock: number;

beforeEach(async () => {
  targetId = randomUUID();
  clock = Date.UTC(2026, 7, 12, 0, 0, 0);
  // The fake shares the worker's clock; revocation is exercised WITHIN the 10-min
  // code-route window so the observed 401 is caused by REVOCATION, not code-route
  // expiry (both collapse to 401 `unauthorized` on the enroll route — E4-D11).
  fake = await startFakeControlPlane({
    now: () => clock,
    enrollments: [{ code: CODE, targetId, deviceGeneration: 1, providerConstraints: sampleProviderConstraints() }],
  });
});
afterEach(async () => {
  await fake.close();
});

function wireStore() {
  const keyStore = new InMemoryKeyStore();
  const client = createControlPlaneClient({ baseUrl: fake.baseUrl, path: fake.enrollPath });
  const enroller = createEnroller({ keyStore, client, now: () => clock });
  const hello = buildHello({ targetId, deviceGeneration: 1 });
  return { enroller, hello };
}

describe("session-revocation — stop + backoff on a revoked/replaced generation", () => {
  it("stops the store when a renewal hits a revoked generation (as-built: unauthorized)", async () => {
    const { enroller, hello } = wireStore();
    const first = await enroller.enroll({ hello, code: CODE });
    const store = new SessionStore(
      {
        now: () => clock,
        renew: async () => (await enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey })).session,
        bootstrap: async () => (await enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey })).session,
      },
      first.session,
    );

    // The control plane revokes the enrolled identity/generation. Advance only
    // WITHIN the code-route window so revocation (not code expiry) is the cause.
    fake.revoke(CODE);
    clock = first.session.obtainedAtMs + 60_000;

    // Enroll-path revocation surfaces as HTTP 401 `unauthorized` (E4-D11), NOT
    // 409 `target_revoked` (a poll/ack-only signal); the worker treats it as
    // terminal-for-request AND stop-and-backoff.
    await expect(store.forceRefresh()).rejects.toMatchObject({
      kind: "unauthorized",
      terminalForRequest: true,
      stopAndBackoff: true,
    });

    expect(store.isStopped()).toBe(true);
    expect(store.current()).toBeNull();
    // The worker did not re-consume the code trying to recover.
    expect(fake.consumeCountFor(CODE)).toBe(1);

    // A stopped store fails closed on every further call (worker backs off — it
    // never keeps hammering the control plane with a revoked identity).
    await expect(store.ensureFresh()).rejects.toBeInstanceOf(SessionStoppedError);
    await expect(store.forceRefresh()).rejects.toBeInstanceOf(SessionStoppedError);
  });

  it("stops the store when the generation is replaced by another worker", async () => {
    const { enroller, hello } = wireStore();
    const first = await enroller.enroll({ hello, code: CODE });
    const store = new SessionStore(
      {
        now: () => clock,
        renew: async () => (await enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey })).session,
        bootstrap: async () => (await enroller.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey })).session,
      },
      first.session,
    );

    fake.replaceGeneration(CODE, 2);
    await expect(store.forceRefresh()).rejects.toMatchObject({ kind: "unauthorized", stopAndBackoff: true });
    expect(store.isStopped()).toBe(true);
    expect(store.current()).toBeNull();
  });
});
