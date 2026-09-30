import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { bootstrapWorkerDaemon, type BootstrapDeps } from "../bin/worker-daemon.js";
import { generateDeviceKey, exportDevicePrivateKeyPkcs8Der } from "../identity/device-key.js";
import type { DeviceIdentityRecord } from "../identity/device-identity-store.js";
import type { DispatchRuntime } from "../lifecycle/dispatch-runtime.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../tests/fixtures/worker-provisioned-target.json", import.meta.url)),
    "utf8",
  ),
) as { registeredProfile: Record<string, unknown>; providerConstraintProfile: Record<string, unknown> };

const TARGET = fixture.registeredProfile.targetId as string;

function record(): DeviceIdentityRecord {
  return { v: 1, workerId: "00000000-0000-4000-8000-000000000001", targetId: TARGET, deviceGeneration: 1, privateKeyPkcs8Der: exportDevicePrivateKeyPkcs8Der(generateDeviceKey()) };
}

const SESSION = { token: "sess-live", workerId: "00000000-0000-4000-8000-000000000001", targetId: TARGET, deviceGeneration: 1, obtainedAtMs: 0, ttlMs: 900_000, expiresAtMs: 900_000 };

/** A minimal fake session store the composition threads through. */
function fakeStore(over: Record<string, unknown> = {}) {
  let cur: unknown = SESSION;
  return {
    current: () => cur,
    ensureFresh: async () => cur,
    forceRefresh: async () => cur,
    recover: async () => cur,
    isStopped: () => false,
    isExpired: () => false,
    lastRefreshRotated: () => false,
    set: (s: unknown) => { cur = s; },
    ...over,
  } as never;
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    baseUrl: "http://fake",
    selfModelReadPath: "/api/execution-targets/self/placement-profile",
    selfHelloRefreshPath: "/api/execution-targets/self/hello",
    sessionRenewPath: "/api/worker-control/session/renew",
    selfModelRead: async () => ({ status: 200, body: { registeredProfile: fixture.registeredProfile, providerConstraintProfile: fixture.providerConstraintProfile } }),
    selfHelloRefresh: async () => ({ status: 200, body: {}, sessionHeader: "sess-refreshed" }),
    // Wave-4 — the boot now seeds a heartbeat; a 204 lets the driver's first beat succeed so the
    // lazy poll-loop start fires (override to a non-204 to exercise the never-seeded branch).
    heartbeatPath: "/api/execution-targets/heartbeat",
    heartbeat: async () => ({ status: 204 }),
    ...over,
  } as never;
}

function captureLog() {
  const records: Array<{ fields: Record<string, unknown>; message?: unknown }> = [];
  const logger = { info: (f: Record<string, unknown>, m?: unknown) => records.push({ fields: f, message: m }), warn: () => {}, error: (f: Record<string, unknown>, m?: unknown) => records.push({ fields: f, message: m }), flush: async () => {} } as never;
  const reasons = () => records.map((r) => (r.fields as { reason?: string }).reason).filter((r): r is string => typeof r === "string");
  return { records, logger, reasons };
}

function fakeRuntime(over: Partial<DispatchRuntime> = {}): DispatchRuntime {
  return {
    leasing: { stopLeasing: () => {}, drain: async () => {} },
    renewal: { stop: () => {} },
    eventOutbox: { stopDrain: () => {}, flush: async () => {}, closeStore: () => {} },
    self: {} as never,
    measure: () => ({}) as never,
    loopSupervisorSeam: { accept: () => {} },
    limiter: {} as never,
    start: () => {},
    pollLoop: { run: async () => ({ kind: "stopped" }), stopLeasing: () => {}, drain: async () => {}, activeLeaseCount: () => 0 } as never,
    ...over,
  };
}

/** Boot with all six gates satisfiable; overrides tweak individual pieces. */
async function boot(overrides: Partial<BootstrapDeps> = {}, envOver: Record<string, string> = {}) {
  const cap = captureLog();
  const exitCodes: number[] = [];
  const composeDispatch = vi.fn(async () => fakeRuntime());
  const result = await bootstrapWorkerDaemon({
    env: {
      AOA_WORKER_CONTROL_PLANE_URL: "https://cp.example",
      AOA_WORKER_ENROLLMENT_CODE_ENV: "CODE",
      CODE: "abc",
      AOA_WORKER_KEY_STORE_MODE: "os_keychain",
      AOA_WORKER_TARGET_SCOPE: "organization",
      AOA_WORKER_DISPATCH_ENABLED: "1",
      AOA_WORKER_EVENT_OUTBOX_PATH: "/tmp/outbox.db",
      ...envOver,
    },
    proc: { once: () => {}, exit: (c: number) => exitCodes.push(c) } as never,
    provider: createFakeSandboxProvider({}),
    identityStore: { load: () => record(), save: () => {}, clear: () => {} } as never,
    receiptStore: { load: () => null, save: () => {}, clear: () => {} } as never,
    createLogger: () => cap.logger,
    startHealth: (async () => ({ port: 1, close: async () => {} })) as never,
    createClient: () => fakeClient(),
    enrollOnceFn: (async () => ({ skipped: true, workerId: "00000000-0000-4000-8000-000000000001", targetId: TARGET, deviceGeneration: 1, deviceThumbprint: "tp" })) as never,
    createLifecycleFn: (() => ({ store: fakeStore(), onSessionMinted: () => {} })) as never,
    composeDispatch,
    ...overrides,
  } as never);
  return { result, composeDispatch, reasons: cap.reasons(), exitCodes };
}

describe("dispatch-composition-2b — the boot wiring", () => {
  it("★ all six gates satisfied + a live self-model ⇒ COMPOSES (composeDispatch called once)", async () => {
    const { result, composeDispatch } = await boot();
    expect(composeDispatch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    // The composed self is the PROVISIONED self-model (report swapped to the provisioned hello).
    const arg = composeDispatch.mock.calls[0]![0] as { self: { report: { reportedCapabilities: string[] } } };
    expect(arg.self.report.reportedCapabilities).toContain("workload.batch");
  });

  it("★ the SHIPPED default (no provider) REFUSES — composeDispatch at 0 calls, ZERO residue (no key derived)", async () => {
    // Zero residue: the record load + device-key derivation live INSIDE the compose branch, so a
    // no_provider boot touches neither. The stub enrollOnceFn never loads, so `load` at >0 means the
    // identity was constructed above the branch — the mutant §10 exists to catch.
    const load = vi.fn(() => record());
    const { composeDispatch, reasons } = await boot({
      provider: undefined,
      identityStore: { load, save: () => {}, clear: () => {} } as never,
    });
    expect(composeDispatch).not.toHaveBeenCalled();
    expect(reasons).toContain("no_provider");
    expect(load).not.toHaveBeenCalled();
  });

  it("★ a dead session (read session_terminal) reports no_session, NOT no_self_model, and does not compose", async () => {
    // A TERMINAL store: ensureFresh throws AND isStopped()→true, so createSessionProvider maps it
    // to SessionTerminalError, which readWorkerSelfModel maps to refused{session_terminal}, which
    // Step 4 maps to no_session — never no_self_model (§3.2: the most likely refusal in practice).
    const terminalStore = fakeStore({
      ensureFresh: async () => { throw new Error("terminal"); },
      forceRefresh: async () => { throw new Error("terminal"); },
      isStopped: () => true,
    });
    const { composeDispatch, reasons } = await boot({
      createLifecycleFn: (() => ({ store: terminalStore, onSessionMinted: () => {} })) as never,
    });
    expect(composeDispatch).not.toHaveBeenCalled();
    expect(reasons).toContain("no_session");
    expect(reasons).not.toContain("no_self_model");
  });

  it("★ a failed read (unassemblable) leaves the daemon HEALTHY and inert (no compose, ok:true)", async () => {
    const { result, composeDispatch, reasons } = await boot({
      createClient: () => fakeClient({ selfModelRead: async () => ({ status: 200, body: { garbage: true } }) }),
    });
    expect(composeDispatch).not.toHaveBeenCalled();
    expect(reasons).toContain("no_self_model");
    expect(result.ok).toBe(true); // healthy and inert, never a crash
  });

  it("★ refuses to run TWO leasing lifecycles (a composed runtime + an injected leasing seam)", async () => {
    const { result, exitCodes } = await boot({ leasing: { stopLeasing: () => {}, drain: async () => {} } });
    expect(result.ok).toBe(false);
    expect(exitCodes).toContain(1);
  });

  it("★ bootstrap RESOLVES while the poll loop's run() is still pending (the loop is NOT awaited)", async () => {
    const never = new Promise<never>(() => {}); // never settles
    const runtime = fakeRuntime({ start: () => { void never; }, pollLoop: { run: () => never, stopLeasing: () => {}, drain: async () => {}, activeLeaseCount: () => 0 } as never });
    const bootPromise = boot({ composeDispatch: (async () => runtime) as never });
    const winner = await Promise.race([
      bootPromise.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("hung"), 1000)),
    ]);
    expect(winner).toBe("resolved");
  });

  it("★ Wave-4: the poll loop starts ONLY AFTER the first successful heartbeat (firstBeat ok ⇒ start)", async () => {
    // The core of the fix: a poll issued before the heartbeat seeds worker.lastSeenAt is denied
    // target_revoked (terminal). The default fakeClient returns 204, so the driver's first beat
    // succeeds and the LAZY start callback fires runtime.start() — after boot has returned.
    const startSpy = vi.fn();
    const runtime = fakeRuntime({ start: startSpy });
    const { result } = await boot({ composeDispatch: (async () => runtime) as never });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
    await result.shutdown?.("SIGTERM");
  });

  it("★ Wave-4: a heartbeat that never seeds leaves the poll loop UNSTARTED (healthy and inert), ok:true", async () => {
    // A non-204 heartbeat never lets firstBeat resolve "ok", so the poll loop must never start —
    // a regression to an unconditional runtime.start() (the original bug) would fail here.
    const startSpy = vi.fn();
    const runtime = fakeRuntime({ start: startSpy });
    const { result } = await boot({
      composeDispatch: (async () => runtime) as never,
      createClient: () => fakeClient({ heartbeat: async () => ({ status: 500 }) }),
    });
    expect(result.ok).toBe(true); // healthy and inert, never a crash
    // Let the driver run its first (failing) beat and settle into retry backoff.
    await new Promise((r) => setTimeout(r, 50));
    expect(startSpy).not.toHaveBeenCalled();
    await result.shutdown?.("SIGTERM");
  });
});
