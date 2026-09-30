// DSK-001 / I11 — a daemon configured for OS custody it does not have must exit
// non-zero BEFORE it opens a socket.
//
// `keyStoreMode` has been parsed since WRK-002 and read only to be LOGGED
// (`bin/worker-daemon.ts:121`). Nothing ever constructed a store from it. So a
// deployment configured for `os_keychain` with no store injected would start
// cleanly, bind its health listener, report itself up — and only discover it had
// no custody when something tried to enrol, by which point an operator has been
// told the worker is healthy.
//
// The assertion that matters is not "it exited" but "it exited BEFORE
// `startHealth` was called". A daemon that binds a port and then dies has already
// told the world it was ready.

import { describe, expect, it, vi } from "vitest";

import { bootstrapWorkerDaemon, type ProcessLike } from "../bin/worker-daemon.js";
import { resolveCustody } from "../identity/device-identity-store.js";
import type { Env } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import type { HealthServerHandle } from "../health/health-server.js";

function baseEnv(overrides: Env = {}): Env {
  return {
    AOA_WORKER_CONTROL_PLANE_URL: "https://control.example.com",
    AOA_WORKER_ENROLLMENT_CODE_FILE: "/run/secrets/enrollment-code",
    AOA_WORKER_KEY_STORE_MODE: "mounted_secret",
    AOA_WORKER_TARGET_SCOPE: "organization",
    ...overrides,
  };
}

function noopLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, flush: async () => {} };
}

function fakeProc() {
  const exitCodes: number[] = [];
  const proc: ProcessLike = {
    once: () => {},
    exit: (code) => { exitCodes.push(code); },
  };
  return { exitCodes, proc };
}

const handle = { close: async () => {} } as unknown as HealthServerHandle;

describe("DSK-001/I11 — os_keychain without a store never opens a socket", () => {
  it("exits non-zero and does NOT call startHealth", async () => {
    const startHealth = vi.fn(async () => handle);
    const { exitCodes, proc } = fakeProc();

    const result = await bootstrapWorkerDaemon({
      env: baseEnv({ AOA_WORKER_KEY_STORE_MODE: "os_keychain" }),
      proc,
      createLogger: noopLogger,
      startHealth: startHealth as never,
    });

    expect(result.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
    // The property that actually matters.
    expect(startHealth).not.toHaveBeenCalled();
  });

  it("starts normally in mounted_secret mode, which needs no injected store", async () => {
    // Non-vacuity: without this, a bootstrap that refused EVERYTHING would pass
    // the test above while breaking every existing deployment.
    const startHealth = vi.fn(async () => handle);
    const { exitCodes, proc } = fakeProc();

    const result = await bootstrapWorkerDaemon({
      env: baseEnv(),
      proc,
      createLogger: noopLogger,
      startHealth: startHealth as never,
    });

    expect(result.ok).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(startHealth).toHaveBeenCalledTimes(1);
  });

  it("starts in os_keychain mode when BOTH stores are injected", async () => {
    const startHealth = vi.fn(async () => handle);
    const { exitCodes, proc } = fakeProc();
    const store = { load: () => null, saveIfAbsent: () => "stored" as const, clear: () => {} };

    // Enrolment is STUBBED here on purpose. This test is about the custody GATE
    // — did the daemon get past the pre-socket verdict and bind its listener —
    // and since D4 the same configuration now goes on to enrol for real.
    //
    // It passed unstubbed only while `enrollOnce` had no caller. With the block
    // wired, `baseEnv`'s `/run/secrets/enrollment-code` does not exist, the read
    // throws, and the daemon correctly exits 1. That is right behaviour and a
    // wrong test: it would have been asserting "enrolment happens to succeed"
    // under the name of the gate. The exit-on-unreadable-ticket case is covered
    // directly in `enrollment-bootstrap.test.ts`.
    const result = await bootstrapWorkerDaemon({
      env: baseEnv({ AOA_WORKER_KEY_STORE_MODE: "os_keychain" }),
      proc,
      createLogger: noopLogger,
      startHealth: startHealth as never,
      identityStore: store,
      receiptStore: store,
      enrollOnceFn: (async () => ({
        enrolled: true, minted: true, skipped: false,
        workerId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        targetId: "a3000000-0000-4000-8000-000000000003",
        deviceGeneration: 1,
      })) as never,
    } as never);

    expect(result.ok).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(startHealth).toHaveBeenCalledTimes(1);
  });
});

describe("DSK-001/I11 — resolveCustody is pure and total", () => {
  const store = { load: () => null, saveIfAbsent: () => "stored" as const, clear: () => {} };

  it("refuses os_keychain when either store is missing", () => {
    expect(resolveCustody("os_keychain", undefined, store).kind).toBe("refuse");
    expect(resolveCustody("os_keychain", store, undefined).kind).toBe("refuse");
    expect(resolveCustody("os_keychain", undefined, undefined).kind).toBe("refuse");
  });

  it("accepts os_keychain when both are present", () => {
    expect(resolveCustody("os_keychain", store, store).kind).toBe("ok");
  });

  it("accepts mounted_secret with no stores at all", () => {
    expect(resolveCustody("mounted_secret", undefined, undefined).kind).toBe("ok");
  });

  it("FAILS CLOSED on an unknown mode rather than falling back", () => {
    // A future mode this build does not understand must not silently degrade to
    // a weaker custody model.
    for (const mode of ["", "tpm", "os_keychain_v2", "OS_KEYCHAIN"]) {
      expect(resolveCustody(mode, store, store).kind, mode).toBe("refuse");
    }
  });
});

describe("WRK-014/§3 — resolveCustody gains a distinct file_record arm", () => {
  const store = { load: () => null, saveIfAbsent: () => "stored" as const, clear: () => {} };

  it("accepts file_record when BOTH stores are present", () => {
    expect(resolveCustody("file_record", store, store).kind).toBe("ok");
  });

  it("REFUSES file_record with exactly one store (the torn-config hazard)", () => {
    expect(resolveCustody("file_record", store, undefined).kind).toBe("refuse");
    expect(resolveCustody("file_record", undefined, store).kind).toBe("refuse");
  });

  it("REFUSES file_record with no stores — unlike bare mounted_secret, this is a misconfiguration", () => {
    // A `file_record` container declares it WILL persist an identity; arriving
    // with no stores is a broken host, not the inert-ok that store-less
    // `mounted_secret` deliberately stays.
    expect(resolveCustody("file_record", undefined, undefined).kind).toBe("refuse");
  });

  it("leaves the mounted_secret arm UNCHANGED — store-less still ok, any store still refused", () => {
    // The three mutation-hardened mounted_secret cases must not move.
    expect(resolveCustody("mounted_secret", undefined, undefined).kind).toBe("ok");
    expect(resolveCustody("mounted_secret", store, undefined).kind).toBe("refuse");
    expect(resolveCustody("mounted_secret", undefined, store).kind).toBe("refuse");
  });
});

describe("DSK-001/I11 — a CONTRADICTORY custody configuration dies pre-socket", () => {
  // Plan §4/D3 row 2, which did not ship: `mounted_secret` returned `ok` no
  // matter what was injected. A mutation exposed it — removing the keyStoreMode
  // gate from the enrolment block left the whole suite green, because nothing
  // ever put a store and `mounted_secret` together.
  //
  // That combination is a real misconfiguration: `MountedSecretKeyStore`
  // persists PKCS8 DER with no workerId slot, so enrolling against it would ship
  // precisely the torn-identity hazard I6 exists to prevent. Refusing is better
  // than quietly not enrolling — the operator learns immediately, and before any
  // socket is bound.
  it("refuses mounted_secret when an identity store is injected", () => {
    const store = { load: () => null, saveIfAbsent: () => "stored" as const, clear: () => {} };
    const verdict = resolveCustody("mounted_secret", store, undefined);
    expect(verdict.kind).toBe("refuse");
  });

  it("refuses mounted_secret when a receipt store is injected", () => {
    const store = { load: () => null, saveIfAbsent: () => "stored" as const, clear: () => {} };
    const verdict = resolveCustody("mounted_secret", undefined, store as never);
    expect(verdict.kind).toBe("refuse");
  });

  it("never opens a socket for that configuration", async () => {
    const startHealth = vi.fn(async () => handle);
    const { exitCodes, proc } = fakeProc();
    const store = { load: () => null, saveIfAbsent: () => "stored" as const, clear: () => {} };
    const result = await bootstrapWorkerDaemon({
      env: baseEnv({ AOA_WORKER_KEY_STORE_MODE: "mounted_secret" }),
      proc,
      createLogger: noopLogger,
      startHealth: startHealth as never,
      identityStore: store,
      receiptStore: store,
    } as never);
    expect(result.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(startHealth).not.toHaveBeenCalled();
  });
});
