// WRK-010 slice 2 (go-book Sprint 2.5) — the boot root composes the session lifecycle, wires
// the enrolment sink, and eagerly acquires the first session. These prove the WIRING (which is
// what makes "the route has a production caller" genuinely reachable); the end-to-end route
// round trip is the embedded-PG integration test. Mutant S2-M9 lives here.

import { describe, expect, it, vi } from "vitest";

import { bootstrapWorkerDaemon, type ProcessLike, type BootstrapDeps } from "../bin/worker-daemon.js";
import type { Env } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import type { HealthServerHandle } from "../health/health-server.js";
import type { SandboxProvider } from "../supervisor/provider.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import type { WorkerSessionLifecycle } from "../identity/worker-session-lifecycle.js";
import type { DeviceEnrollmentReceipt, DeviceIdentityRecord, DeviceRecordStore } from "../identity/device-identity-store.js";

const WORKER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TARGET_ID = "a3000000-0000-4000-8000-000000000003";
const CODE = "aoa_enr_abcdefgh12345678.0123456789abcdef0123456789abcdef";

const OUTCOME = {
  enrolled: true, minted: true, skipped: false,
  workerId: WORKER_ID, targetId: TARGET_ID, deviceGeneration: 1, deviceThumbprint: "tp-1",
};

function baseEnv(over: Env = {}): Env {
  return {
    AOA_WORKER_CONTROL_PLANE_URL: "https://control.example.com",
    AOA_WORKER_ENROLLMENT_CODE_ENV: "AOA_TICKET",
    AOA_TICKET: CODE,
    AOA_WORKER_KEY_STORE_MODE: "os_keychain",
    AOA_WORKER_TARGET_SCOPE: "organization",
    ...over,
  };
}

function recordingLogger(lines: string[]): () => Logger {
  const push = (a: unknown, b?: string) => {
    lines.push(typeof a === "string" ? a : JSON.stringify(a) + " " + String(b));
  };
  return () => ({ info: push as Logger["info"], warn: push as Logger["warn"], error: push as Logger["error"], flush: async () => {} });
}

function emptyStore<T>(): DeviceRecordStore<T> {
  return { load: () => null, saveIfAbsent: () => "stored", clear: () => {} };
}

function session(): WorkerSession {
  return { token: "t", workerId: WORKER_ID, targetId: TARGET_ID, deviceGeneration: 1, obtainedAtMs: 0, ttlMs: 900_000, expiresAtMs: 900_000 };
}

/** A fake lifecycle recording the sink identity and the eager ensureFresh call. */
function fakeLifecycle(over: { ensureFresh?: () => Promise<WorkerSession>; isStopped?: () => boolean } = {}) {
  const ensureFresh = vi.fn(over.ensureFresh ?? (async () => session()));
  const isStopped = vi.fn(over.isStopped ?? (() => false));
  const onSessionMinted = vi.fn();
  const lifecycle = { store: { ensureFresh, isStopped }, onSessionMinted } as unknown as WorkerSessionLifecycle;
  return { lifecycle, ensureFresh, isStopped, onSessionMinted };
}

function run(over: Partial<BootstrapDeps> = {}, lines: string[] = []) {
  const exitCodes: number[] = [];
  const proc: ProcessLike = { once: () => {}, exit: (c) => exitCodes.push(c) };
  const handle = { close: async () => {} } as unknown as HealthServerHandle;
  const enrollOnceFn = vi.fn(async () => OUTCOME);
  const createLifecycleFn = vi.fn();
  const args: BootstrapDeps = {
    env: baseEnv(),
    proc,
    identityStore: emptyStore<DeviceIdentityRecord>(),
    receiptStore: emptyStore<DeviceEnrollmentReceipt>(),
    startHealth: (async () => handle) as never,
    createClient: (() => ({}) as never) as never,
    readFileText: () => { throw new Error("no fs"); },
    enrollOnceFn: enrollOnceFn as never,
    createLifecycleFn: createLifecycleFn as never,
    createLogger: recordingLogger(lines),
    ...over,
  };
  return { args, proc, exitCodes, enrollOnceFn, createLifecycleFn };
}

describe("WRK-010 slice 2 — boot root session-lifecycle wiring", () => {
  it("with a provider AND the flag on: composes the lifecycle, passes the sink, eager-acquires", async () => {
    const fl = fakeLifecycle();
    const h = run({
      env: baseEnv({ AOA_WORKER_DISPATCH_ENABLED: "1" }),
      provider: {} as SandboxProvider,
      createLifecycleFn: (() => fl.lifecycle) as never,
    });
    const result = await bootstrapWorkerDaemon(h.args);
    expect(result.ok).toBe(true);
    expect(h.enrollOnceFn).toHaveBeenCalledTimes(1);
    // The sink handed to enrolment is the lifecycle's own — the enrolling boot's first session.
    expect(h.enrollOnceFn.mock.calls[0][0].onSessionMinted).toBe(fl.onSessionMinted);
    // First-session acquisition genuinely runs in production at boot.
    expect(fl.ensureFresh).toHaveBeenCalledTimes(1);
    expect(h.exitCodes).toEqual([]);
  });

  it("S2-M9: with NO provider, composes NO lifecycle and passes NO sink (shipped default)", async () => {
    const h = run({ env: baseEnv({ AOA_WORKER_DISPATCH_ENABLED: "1" }), provider: undefined });
    const result = await bootstrapWorkerDaemon(h.args);
    expect(result.ok).toBe(true);
    expect(h.createLifecycleFn).not.toHaveBeenCalled();
    expect(h.enrollOnceFn.mock.calls[0][0].onSessionMinted).toBeUndefined();
  });

  it("with a provider but the flag OFF: composes NO lifecycle (dispatch is opt-in)", async () => {
    const h = run({ provider: {} as SandboxProvider }); // AOA_WORKER_DISPATCH_ENABLED unset
    await bootstrapWorkerDaemon(h.args);
    expect(h.createLifecycleFn).not.toHaveBeenCalled();
    expect(h.enrollOnceFn.mock.calls[0][0].onSessionMinted).toBeUndefined();
  });

  it("a terminal eager acquisition runs idle (does NOT exit) and logs re-enrollment (§3.4.1)", async () => {
    const lines: string[] = [];
    const fl = fakeLifecycle({ ensureFresh: async () => { throw new Error("stopped"); }, isStopped: () => true });
    const h = run({
      env: baseEnv({ AOA_WORKER_DISPATCH_ENABLED: "1" }),
      provider: {} as SandboxProvider,
      createLifecycleFn: (() => fl.lifecycle) as never,
    }, lines);
    const result = await bootstrapWorkerDaemon(h.args);
    expect(result.ok).toBe(true);
    expect(h.exitCodes).toEqual([]); // fail-soft — never crashes the daemon
    expect(lines.some((l) => l.includes("re-enrollment required"))).toBe(true);
  });
});
