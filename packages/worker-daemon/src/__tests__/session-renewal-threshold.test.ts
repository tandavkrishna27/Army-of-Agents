import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SESSION_TTL_MS, type WorkerSession } from "../enrollment/enroll.js";
import { SessionStore, RENEWAL_HEADROOM_MS } from "../identity/session.js";

// WRK-010 slice 2 — the near-expiry threshold (§4) and forceRefresh's presence
// routing (renew(current) vs bootstrap). These use DISTINCT spies for renew and
// bootstrap so the ROUTING DECISION is asserted directly — the migrated existing
// suites wire both to one body and prove the STOP behaviour, not which is called.

const TTL = DEFAULT_SESSION_TTL_MS; // 15 min

function session(overrides: Partial<WorkerSession> = {}): WorkerSession {
  const obtainedAtMs = overrides.obtainedAtMs ?? 0;
  return {
    token: "t0",
    workerId: randomUUID(),
    targetId: randomUUID(),
    deviceGeneration: 1,
    obtainedAtMs,
    ttlMs: TTL,
    expiresAtMs: obtainedAtMs + TTL,
    ...overrides,
  };
}

/** A renew spy that returns a distinguishable NEW session, recording the argument. */
function renewSpy() {
  const calls: WorkerSession[] = [];
  const fn = vi.fn(async (current: WorkerSession): Promise<WorkerSession> => {
    calls.push(current);
    return session({ token: "renewed", deviceGeneration: current.deviceGeneration, obtainedAtMs: current.expiresAtMs });
  });
  return { fn, calls };
}
function bootstrapSpy() {
  const fn = vi.fn(async (): Promise<WorkerSession> => session({ token: "bootstrapped" }));
  return { fn };
}

describe("session near-expiry threshold + presence routing (WRK-010 slice 2)", () => {
  // ★ POSITIVE CONTROL, first (E1-F008): a renew that always throws must redden the
  // suite, proving forceRefresh actually reaches renew on a live session.
  it("POSITIVE CONTROL: a throwing renew reddens a live-session forceRefresh", async () => {
    const store = new SessionStore(
      { now: () => 0, renew: async () => { throw new Error("boom"); }, bootstrap: async () => session() },
      session(),
    );
    await expect(store.forceRefresh()).rejects.toThrow("boom");
  });

  it("ensureFresh returns the LIVE session when MORE than the headroom remains (6 min)", async () => {
    const renew = renewSpy();
    const boot = bootstrapSpy();
    // now = expiry - 6 min ⇒ 6 min remaining, one minute clear of the 5-min headroom.
    const now = TTL - 6 * 60_000;
    const store = new SessionStore({ now: () => now, renew: renew.fn, bootstrap: boot.fn }, session());
    const got = await store.ensureFresh();
    expect(got.token).toBe("t0");
    expect(renew.fn).not.toHaveBeenCalled();
    expect(boot.fn).not.toHaveBeenCalled();
  });

  it("ensureFresh RENEWS when exactly the headroom (5 min) remains — the boundary", async () => {
    const renew = renewSpy();
    const boot = bootstrapSpy();
    // now = expiry - 5 min ⇒ now === expiresAtMs - RENEWAL_HEADROOM_MS, so the
    // `now < expiresAtMs - HEADROOM` guard is FALSE and forceRefresh fires.
    const now = TTL - RENEWAL_HEADROOM_MS;
    const store = new SessionStore({ now: () => now, renew: renew.fn, bootstrap: boot.fn }, session());
    const got = await store.ensureFresh();
    expect(got.token).toBe("renewed");
    expect(renew.fn).toHaveBeenCalledTimes(1);
    expect(boot.fn).not.toHaveBeenCalled();
  });

  it("ensureFresh RENEWS when inside the headroom (4 min remaining)", async () => {
    const renew = renewSpy();
    const boot = bootstrapSpy();
    const now = TTL - 4 * 60_000;
    const store = new SessionStore({ now: () => now, renew: renew.fn, bootstrap: boot.fn }, session());
    await store.ensureFresh();
    expect(renew.fn).toHaveBeenCalledTimes(1);
    expect(boot.fn).not.toHaveBeenCalled();
  });

  it("forceRefresh routes a LIVE current session to renew(current), NOT bootstrap", async () => {
    const renew = renewSpy();
    const boot = bootstrapSpy();
    const current = session({ token: "live" });
    const store = new SessionStore({ now: () => 0, renew: renew.fn, bootstrap: boot.fn }, current);
    await store.forceRefresh();
    expect(renew.fn).toHaveBeenCalledTimes(1);
    expect(renew.calls[0]).toBe(current); // the exact session it is renewing
    expect(boot.fn).not.toHaveBeenCalled();
  });

  it("forceRefresh routes an ABSENT session to bootstrap(), NOT renew", async () => {
    const renew = renewSpy();
    const boot = bootstrapSpy();
    const store = new SessionStore({ now: () => 0, renew: renew.fn, bootstrap: boot.fn }, null);
    const got = await store.forceRefresh();
    expect(got.token).toBe("bootstrapped");
    expect(boot.fn).toHaveBeenCalledTimes(1);
    expect(renew.fn).not.toHaveBeenCalled();
  });

  it("RENEWAL_HEADROOM_MS is at least 5 minutes and below the session TTL (§3.5(i) floor)", () => {
    expect(RENEWAL_HEADROOM_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(RENEWAL_HEADROOM_MS).toBeLessThan(DEFAULT_SESSION_TTL_MS);
  });
});
