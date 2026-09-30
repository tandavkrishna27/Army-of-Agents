import { describe, expect, it, vi } from "vitest";

import { createHeartbeatLoop } from "../poll/heartbeat-loop.js";
import { SessionTerminalError, type SessionProvider } from "../poll/poll-loop.js";
import { createMetrics } from "../metrics/metrics.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import type { DeviceKey } from "../identity/device-key.js";
import type { ControlPlaneClient } from "../transport/client.js";

const SESSION: WorkerSession = {
  token: "t",
  workerId: "w",
  targetId: "tgt",
  deviceGeneration: 1,
  obtainedAtMs: 0,
  ttlMs: 900_000,
  expiresAtMs: 900_000,
};

const liveProvider = (): SessionProvider => ({
  get: async () => SESSION,
  recover: async () => SESSION,
});

const terminalProvider = (): SessionProvider => ({
  get: async () => {
    throw new SessionTerminalError();
  },
  recover: async () => {
    throw new SessionTerminalError();
  },
});

/** get() throws a NON-terminal error once (session_unavailable), then returns a live session. */
const unavailableThenLive = (): SessionProvider => {
  let n = 0;
  return {
    get: async () => {
      if (n++ === 0) throw new Error("transient network");
      return SESSION;
    },
    recover: async () => SESSION,
  };
};

/** get() returns a live session first, then goes terminal on the next call. */
const liveThenTerminal = (): SessionProvider => {
  let n = 0;
  return {
    get: async () => {
      if (n++ === 0) return SESSION;
      throw new SessionTerminalError();
    },
    recover: async () => SESSION,
  };
};

/** A manual clock: each sleep() parks until advance() releases the oldest waiter. */
function manualClock() {
  const waiters: Array<() => void> = [];
  return {
    sleep: (_ms: number) => new Promise<void>((resolve) => waiters.push(resolve)),
    advance: () => {
      const w = waiters.shift();
      if (w) w();
    },
    pending: () => waiters.length,
  };
}

const stubKey = {} as unknown as DeviceKey;
const stubClient = {} as unknown as ControlPlaneClient;

describe("createHeartbeatLoop", () => {
  it("beats immediately and resolves firstBeat=ok", async () => {
    const send = vi.fn(async () => "ok" as const);
    const loop = createHeartbeatLoop({
      session: liveProvider(),
      key: stubKey,
      client: stubClient,
      intervalMs: 1000,
      sleep: manualClock().sleep,
      send,
    });
    loop.start();
    await expect(loop.firstBeat).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("beats again after the interval elapses", async () => {
    const send = vi.fn(async () => "ok" as const);
    const clock = manualClock();
    const loop = createHeartbeatLoop({
      session: liveProvider(),
      key: stubKey,
      client: stubClient,
      intervalMs: 1000,
      sleep: clock.sleep,
      send,
    });
    loop.start();
    await loop.firstBeat;
    expect(send).toHaveBeenCalledTimes(1);
    clock.advance(); // release the interval sleep after the first ok beat
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    loop.stop();
  });

  it("resolves firstBeat=terminal and never beats when the session is terminal", async () => {
    const send = vi.fn(async () => "ok" as const);
    const loop = createHeartbeatLoop({
      session: terminalProvider(),
      key: stubKey,
      client: stubClient,
      intervalMs: 1000,
      sleep: manualClock().sleep,
      send,
    });
    loop.start();
    await expect(loop.firstBeat).resolves.toBe("terminal");
    expect(send).not.toHaveBeenCalled();
    loop.stop();
  });

  it("a transient failure does not resolve firstBeat, then a later success does", async () => {
    const send = vi.fn(async (): Promise<"ok" | "failed"> => "ok");
    send.mockResolvedValueOnce("failed");
    const clock = manualClock();
    const loop = createHeartbeatLoop({
      session: liveProvider(),
      key: stubKey,
      client: stubClient,
      intervalMs: 1000,
      retryDelayMs: 100,
      sleep: clock.sleep,
      send,
    });
    loop.start();
    // First beat failed -> loop parked on the retry sleep, firstBeat NOT resolved yet.
    await vi.waitFor(() => expect(clock.pending()).toBe(1));
    clock.advance(); // release the retry sleep -> second beat succeeds
    await expect(loop.firstBeat).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  // ★★★ Regression guard for the Wave-4 metrics-allow-list defect: `outcome` is a CLOSED label in
  // metrics.ts, and "ok"/"terminal"/"session_unavailable" were originally unregistered, so a REAL
  // metrics instance made `inc` throw on the happy path — stranding firstBeat and the poll loop.
  // These tests run the loop WITH a real createMetrics() (the earlier tests passed no metrics, so
  // the emit path was entirely unrun) and assert the counters are actually RECORDED — which fails if
  // a token is unregistered (the swallowing recordOutcome would drop it) as surely as if it threw.
  it("records ok + terminal heartbeat_outcome under the real closed metrics allow-list", async () => {
    const metrics = createMetrics();

    const okLoop = createHeartbeatLoop({
      session: liveProvider(),
      key: stubKey,
      client: stubClient,
      intervalMs: 1000,
      sleep: manualClock().sleep,
      send: vi.fn(async () => "ok" as const),
      metrics,
    });
    okLoop.start();
    await expect(okLoop.firstBeat).resolves.toBe("ok");
    okLoop.stop();

    const termLoop = createHeartbeatLoop({
      session: terminalProvider(),
      key: stubKey,
      client: stubClient,
      intervalMs: 1000,
      sleep: manualClock().sleep,
      send: vi.fn(async () => "ok" as const),
      metrics,
    });
    termLoop.start();
    await expect(termLoop.firstBeat).resolves.toBe("terminal");
    termLoop.stop();

    const text = metrics.renderPrometheus();
    expect(text).toContain('heartbeat_outcome{outcome="ok"}');
    expect(text).toContain('heartbeat_outcome{outcome="terminal"}');
  });

  it("a non-terminal session error records session_unavailable, retries, then succeeds", async () => {
    const metrics = createMetrics();
    const clock = manualClock();
    const send = vi.fn(async () => "ok" as const);
    const loop = createHeartbeatLoop({
      session: unavailableThenLive(),
      key: stubKey,
      client: stubClient,
      intervalMs: 1000,
      retryDelayMs: 50,
      sleep: clock.sleep,
      send,
      metrics,
    });
    loop.start();
    // First get() threw a non-terminal error -> parked on the retry sleep; send NOT yet called.
    await vi.waitFor(() => expect(clock.pending()).toBe(1));
    expect(send).not.toHaveBeenCalled();
    clock.advance(); // release retry -> second get() returns a live session -> beat ok
    await expect(loop.firstBeat).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
    loop.stop();
    const text = metrics.renderPrometheus();
    expect(text).toContain('heartbeat_outcome{outcome="session_unavailable"}');
    expect(text).toContain('heartbeat_outcome{outcome="ok"}');
  });

  it("stops beating once the session goes terminal after a successful first beat", async () => {
    const clock = manualClock();
    const send = vi.fn(async () => "ok" as const);
    const loop = createHeartbeatLoop({
      session: liveThenTerminal(),
      key: stubKey,
      client: stubClient,
      intervalMs: 1000,
      sleep: clock.sleep,
      send,
    });
    loop.start();
    await expect(loop.firstBeat).resolves.toBe("ok"); // first get()=live, send ok
    expect(send).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(1); // parked on the interval sleep after the ok beat
    clock.advance(); // wake -> second get() throws terminal -> loop returns without re-sleeping
    await vi.waitFor(() => expect(clock.pending()).toBe(0));
    expect(send).toHaveBeenCalledTimes(1); // never beat again
    loop.stop();
  });
});
