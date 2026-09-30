// DEP-011 Slice 2b-i — the CONTAINER `makeRunProvider` factory is threaded through the BIN.
//
// Slice 2a wired `makeRunProvider` through the DEEP layers (`SupervisorDeps`,
// `ComposeDispatchRuntimeDeps`, the gate FUNCTIONS) but NOT through `bootstrapWorkerDaemon`:
// the four bin sites passed only `deps.provider`. So a container injecting ONLY
// `makeRunProvider` was refused `no_provider` at the FIRST bin gate, and 2a's tests never
// caught it because they drove `composeDispatchRuntime` / `createSupervisor` DIRECTLY,
// bypassing the bin (`dep-011-slice-2a.component.test.ts`). This file is the missing bin-level
// proof: a `makeRunProvider`-ONLY boot (no `provider`) passes the provider gate and reaches
// composition, and all four sites now carry the factory in LOCKSTEP.
//
// ★ WHY THE FULL-GATE TEST PROVES ALL FOUR SITES. `shouldComposeSession` (:334) gates whether
// a session lifecycle is constructed — omit `makeRunProvider` there and, with a live provider
// path, the `no_self_model` invariant at :472 THROWS on a half-built daemon. The two
// `decideDispatchComposition` calls (:454/:495) gate reaching compose at all. `composeRuntime`
// (:529) forwards it. So a boot that composes WITH `provider: undefined` in the composeDispatch
// args is only reachable if every site threaded the factory. Ships INERT: nothing runs a real
// server; the factory is a fake.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { bootstrapWorkerDaemon, type BootstrapDeps } from "../bin/worker-daemon.js";
import { generateDeviceKey, exportDevicePrivateKeyPkcs8Der } from "../identity/device-key.js";
import type { DeviceIdentityRecord } from "../identity/device-identity-store.js";
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
    // Wave-4 — the boot seeds a heartbeat before the poll loop; a 204 lets the first beat succeed.
    heartbeatPath: "/api/execution-targets/heartbeat",
    heartbeat: async () => ({ status: 204 }),
    ...over,
  } as never;
}

function captureLog() {
  const records: Array<{ fields: Record<string, unknown> }> = [];
  const logger = { info: (f: Record<string, unknown>) => records.push({ fields: f }), warn: () => {}, error: (f: Record<string, unknown>) => records.push({ fields: f }), flush: async () => {} } as never;
  const reasons = () => records.map((r) => (r.fields as { reason?: string }).reason).filter((r): r is string => typeof r === "string");
  return { logger, reasons };
}

function fakeRuntime() {
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
  };
}

/** Boot with all six gates satisfiable through the CONTAINER path (makeRunProvider, no provider);
 * overrides tweak individual pieces. Full-gate env by default (os_keychain + stores + flag + outbox). */
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
    // ★ THE CONTAINER PATH: makeRunProvider is set, provider is NOT.
    makeRunProvider: () => createFakeSandboxProvider({}),
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

describe("dep-011-slice-2b-bin — the container makeRunProvider factory threaded through the bin", () => {
  it("★ a makeRunProvider-ONLY boot with every gate satisfied COMPOSES (all four sites in lockstep)", async () => {
    const factory = vi.fn(() => createFakeSandboxProvider({}));
    const { result, composeDispatch } = await boot({ makeRunProvider: factory as never });
    expect(result.ok).toBe(true);
    expect(composeDispatch).toHaveBeenCalledTimes(1);
    // ★ composeRuntime (:529) forwards EXACTLY the container path — makeRunProvider present, the
    // desktop provider absent (the `!` at :529 is gone; provider is legitimately undefined here).
    const arg = composeDispatch.mock.calls[0]![0] as { provider: unknown; makeRunProvider: unknown };
    expect(arg.provider).toBeUndefined();
    expect(arg.makeRunProvider).toBe(factory);
  });

  it("★ makeRunProvider-only satisfies the provider gate: mounted_secret (no stores) refuses no_worker_identity, NOT no_provider", async () => {
    // The shipped container shape: mounted_secret with NO custody stores (injecting stores in
    // mounted_secret is a pre-socket resolveCustody refusal, not what a real container does). The
    // enrol/session block is skipped (workerIdentityPresent stays false), so the FIRST
    // decideDispatchComposition (:454) is the only gate reached. It threads makeRunProvider ⟹ the
    // provider gate passes ⟹ the deeper no_worker_identity surfaces. Omit the thread and this
    // reddens with no_provider.
    const { composeDispatch, reasons } = await boot(
      { identityStore: undefined, receiptStore: undefined },
      { AOA_WORKER_KEY_STORE_MODE: "mounted_secret" },
    );
    expect(composeDispatch).not.toHaveBeenCalled();
    expect(reasons).toContain("no_worker_identity");
    expect(reasons).not.toContain("no_provider");
  });

  it("★ makeRunProvider-only with the flag OFF refuses dispatch_disabled, NOT no_provider", async () => {
    // `no_provider` is the deepest gate; `dispatch_disabled` sits just beneath it. A container that
    // supplies the factory but leaves the flag off must get dispatch_disabled — proof the provider
    // gate was satisfied by makeRunProvider alone (else the deeper no_provider would win).
    const { composeDispatch, reasons } = await boot(
      { identityStore: undefined, receiptStore: undefined },
      { AOA_WORKER_KEY_STORE_MODE: "mounted_secret", AOA_WORKER_DISPATCH_ENABLED: "0" },
    );
    expect(composeDispatch).not.toHaveBeenCalled();
    expect(reasons).toContain("dispatch_disabled");
    expect(reasons).not.toContain("no_provider");
  });

  it("★ NEITHER provider NOR makeRunProvider ⇒ the shipped-default no_provider (the container control)", async () => {
    const { composeDispatch, reasons } = await boot({ makeRunProvider: undefined, provider: undefined });
    expect(composeDispatch).not.toHaveBeenCalled();
    expect(reasons).toContain("no_provider");
  });
});
