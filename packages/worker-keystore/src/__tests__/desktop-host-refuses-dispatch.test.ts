// WRK-008 slice 2b Step 8b — the DESKTOP boot root still refuses.
//
// §1.1(b): there are TWO shipped boot roots, and they do not stand on the same number of
// gates. The container is proven by `shipped-binary-refuses.test.ts` (8a). The desktop root
// (`aoa-worker-desktop`) injects both OS-custody stores on every boot, so its identity gate is
// ALREADY satisfied — a fact this suite proves as an executable ladder rather than a citation.
//
// This test lives in the keystore package (not beside 8a) because the dependency arrow is
// keystore → daemon and never back: a daemon-side test importing `runDesktopHost` would be an
// undeclared dependency AND a workspace cycle (design §5). The keystore resolves
// `@armyofagents/worker-daemon` via its built dist, so REBUILD the daemon before running this.

import { describe, expect, it, vi } from "vitest";
import {
  bootstrapWorkerDaemon,
  type Env,
  type Logger,
  type HealthServerHandle,
  type ProcessLike,
} from "@armyofagents/worker-daemon";
import { runDesktopHost } from "../bin/desktop-host.js";

const LOCAL = "C:\\Users\\t\\AppData\\Local";
const okRunner = () => ({ run: () => ({ exitCode: 0, signal: null, stdout: new Uint8Array(), stderr: "", absenceSignalled: true }) });
function fakeProc() {
  const exitCodes: number[] = [];
  return { exitCodes, proc: { once: () => {}, exit: (c: number) => exitCodes.push(c) } };
}

// ── runDesktopHost: the root's own wiring ────────────────────────────────────────────────
describe("desktop-host-refuses-dispatch (8b) — runDesktopHost", () => {
  it("★ DOES pass BOTH custody stores (the fact §1.1(b) turns on)", async () => {
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const { proc } = fakeProc();
    await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32", argv: [],
      createRunner: okRunner as never, bootstrap: bootstrap as never, log: () => {},
    });
    const passed = bootstrap.mock.calls[0]![0] as Record<string, unknown>;
    expect(passed.identityStore).toBeDefined();
    expect(passed.receiptStore).toBeDefined();
  });

  it("★ its shipped default RESOLVES to no provider (call.provider === undefined)", async () => {
    // After Sprint 2 the `provider` KEY is present with value undefined (§0.1 item 1), so this is
    // a VALUE assertion, deliberately weaker than the pre-DEP-010 `"provider" in call === false`.
    // Env built explicitly with AOA_WORKER_SANDBOX_PROVIDER / AOA_WORKER_E2B_TEMPLATE removed.
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const { proc } = fakeProc();
    await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32", argv: [],
      createRunner: okRunner as never, bootstrap: bootstrap as never, log: () => {},
    });
    const passed = bootstrap.mock.calls[0]![0] as Record<string, unknown>;
    expect("provider" in passed).toBe(true);
    expect(passed.provider).toBeUndefined();
  });

  it("a control command (status) returns WITHOUT calling bootstrap", async () => {
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const { proc } = fakeProc();
    await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32", argv: ["status"],
      createRunner: okRunner as never, bootstrap: bootstrap as never, log: () => {},
    });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("--reset-identity returns WITHOUT calling bootstrap", async () => {
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const { proc } = fakeProc();
    await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32", argv: ["--reset-identity", "--i-understand-this-is-permanent"],
      createRunner: okRunner as never, bootstrap: bootstrap as never, log: () => {},
    });
    expect(bootstrap).not.toHaveBeenCalled();
  });
});

// ── the refusal-token ladder: the desktop's REAL custody, one variable at a time ──────────
function bootDaemon(env: Env, over: Record<string, unknown> = {}) {
  const records: Array<{ fields: Record<string, unknown> }> = [];
  const logger = { info: (f: Record<string, unknown>) => records.push({ fields: f }), warn: () => {}, error: (f: Record<string, unknown>) => records.push({ fields: f }), flush: async () => {} } as unknown as Logger;
  const health = { port: 1, close: async () => {} } as unknown as HealthServerHandle;
  const proc: ProcessLike = { once: () => {}, exit: () => {} };
  const composeDispatch = vi.fn(async () => { throw new Error("must not compose"); });
  const store = { current: () => null, ensureFresh: async () => { throw new Error("no session"); }, forceRefresh: async () => { throw new Error("no session"); }, isStopped: () => false, set: () => {} };
  return {
    run: () => bootstrapWorkerDaemon({
      env, proc,
      identityStore: { load: () => null, save: () => {}, clear: () => {} } as never,
      receiptStore: { load: () => null, save: () => {}, clear: () => {} } as never,
      createLogger: () => logger,
      startHealth: (async () => health) as never,
      enrollOnceFn: (async () => ({ skipped: true, workerId: "w", targetId: "t", deviceGeneration: 1, deviceThumbprint: "tp" })) as never,
      createLifecycleFn: (() => ({ store, onSessionMinted: () => {} })) as never,
      composeDispatch,
      ...over,
    } as never),
    reasons: () => records.map((r) => (r.fields as { reason?: string }).reason).filter((r): r is string => typeof r === "string"),
    composeDispatch,
  };
}

// A realistic desktop daemon env: os_keychain custody (the desktop root's mode).
const desktopEnv = (over: Record<string, string> = {}): Env => ({
  AOA_WORKER_CONTROL_PLANE_URL: "https://cp.example",
  AOA_WORKER_ENROLLMENT_CODE_ENV: "CODE",
  CODE: "abc",
  AOA_WORKER_KEY_STORE_MODE: "os_keychain",
  AOA_WORKER_TARGET_SCOPE: "organization",
  ...over,
});

describe("desktop-host-refuses-dispatch (8b) — the refusal-token ladder", () => {
  it("rung 1: the shipped desktop env (no provider) ⇒ EXACTLY no_provider", async () => {
    const b = bootDaemon(desktopEnv());
    await b.run();
    expect(b.reasons()).toEqual(["no_provider"]);
    expect(b.composeDispatch).not.toHaveBeenCalled();
  });

  it("★ rung 2: + a provider + the flag ⇒ EXACTLY no_event_outbox_path — proving gate 3 is ALREADY satisfied on the desktop", async () => {
    // Reaching gate 4 means gate 3 (device identity) did NOT refuse — the desktop root's custody
    // is present. This is §1.1(b)'s whole point as an executable fact, and it needs no control plane.
    const b = bootDaemon(desktopEnv({ AOA_WORKER_DISPATCH_ENABLED: "1" }), { provider: {} });
    await b.run();
    expect(b.reasons()).toEqual(["no_event_outbox_path"]);
    expect(b.composeDispatch).not.toHaveBeenCalled();
  });

  it("CONTAINER CONTRAST: a mounted_secret root (no custody) + provider + flag, no outbox ⇒ no_worker_identity — gate 3 BEFORE gate 4", async () => {
    // The killing case for the gate-3/gate-4 reorder at the ROOT level: here BOTH gate 3 (no
    // identity) and gate 4 (no outbox) refuse, so the ORDER decides which is reported. Gate 3
    // first ⇒ no_worker_identity; reordering gate 4 ahead would flip it to no_event_outbox_path.
    const records: Array<{ fields: Record<string, unknown> }> = [];
    const logger = { info: (f: Record<string, unknown>) => records.push({ fields: f }), warn: () => {}, error: () => {}, flush: async () => {} } as unknown as Logger;
    await bootstrapWorkerDaemon({
      env: { AOA_WORKER_CONTROL_PLANE_URL: "https://cp", AOA_WORKER_ENROLLMENT_CODE_FILE: "/c", AOA_WORKER_KEY_STORE_MODE: "mounted_secret", AOA_WORKER_TARGET_SCOPE: "organization", AOA_WORKER_DISPATCH_ENABLED: "1" },
      proc: { once: () => {}, exit: () => {} },
      provider: {} as never,
      createLogger: () => logger,
      startHealth: (async () => ({ port: 1, close: async () => {} })) as never,
    } as never);
    const reasons = records.map((r) => (r.fields as { reason?: string }).reason).filter((r): r is string => typeof r === "string");
    expect(reasons).toContain("no_worker_identity");
    expect(reasons).not.toContain("no_event_outbox_path");
  });
});
