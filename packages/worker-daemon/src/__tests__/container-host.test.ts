// WRK-014 §6.3/§6.4 — the container host.
//
// `runContainerHost` is to a container what `runDesktopHost` is to the desktop: a
// composition host that constructs custody and injects it into the pure
// `bootstrapWorkerDaemon` sink. It reads `AOA_WORKER_STATE_DIR` from the env
// DIRECTLY (default `/worker`), builds the two `FileRecordStore`s, asserts the
// state dir is writable BEFORE any socket opens (fail-closed — a bad volume is a
// loud exit, never a silent re-mint), and hands the stores to the daemon.
//
// ★ INERT. WRK-014 does NOT repoint the Dockerfile CMD (still `worker-daemon.js`)
// and does NOT switch any compose's mode. These tests exercise the host + the new
// `file_record` custody directly. WRK-015 shipped the POSIX enrolment-input fix;
// WRK-017 wires the container path on d1 via a compose `command:` override (NOT a
// CMD repoint — per Correction 1, that would crash-loop still-`mounted_secret`
// containers).

import { existsSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runContainerHost,
  resolveStateDir,
  redactEnrollmentCodes,
  IDENTITY_RECORD_FILE,
  RECEIPT_RECORD_FILE,
  type ProcessLike,
} from "../bin/container-host.js";
import { enrollOnce } from "../enrollment/enroll-once.js";
import { FileRecordStore } from "../identity/file-record-store.js";
import { identityRecordCodec, receiptRecordCodec } from "../identity/record-codec.js";
import { generateDeviceKey, exportDevicePrivateKeyPkcs8Der } from "../identity/device-key.js";
import type {
  DeviceEnrollmentReceipt,
  DeviceIdentityRecord,
} from "../identity/device-identity-store.js";

const WORKER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TARGET_ID = "a3000000-0000-4000-8000-000000000003";
const CODE = "aoa_enr_" + "A".repeat(22) + "." + "B".repeat(43);

const realKey = generateDeviceKey();
const realDer = exportDevicePrivateKeyPkcs8Der(realKey);

function fakeProc() {
  const exitCodes: number[] = [];
  const proc: ProcessLike = { once: () => {}, exit: (code) => { exitCodes.push(code); } };
  return { exitCodes, proc };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wrk014-host-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function baseEnv(over: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    AOA_WORKER_CONTROL_PLANE_URL: "https://control.example.com",
    AOA_WORKER_ENROLLMENT_CODE_ENV: "AOA_TICKET",
    AOA_TICKET: CODE,
    AOA_WORKER_KEY_STORE_MODE: "file_record",
    AOA_WORKER_TARGET_SCOPE: "organization",
    AOA_WORKER_STATE_DIR: dir,
    ...over,
  };
}

describe("WRK-014/§1.2 — the state dir is read from AOA_WORKER_STATE_DIR (default /worker)", () => {
  it("defaults to /worker when unset, empty, or whitespace", () => {
    expect(resolveStateDir({})).toBe("/worker");
    expect(resolveStateDir({ AOA_WORKER_STATE_DIR: "" })).toBe("/worker");
    expect(resolveStateDir({ AOA_WORKER_STATE_DIR: "   " })).toBe("/worker");
  });

  it("uses the configured value when present", () => {
    expect(resolveStateDir({ AOA_WORKER_STATE_DIR: "/mnt/worker-state" })).toBe("/mnt/worker-state");
  });
});

describe("WRK-014/§2 — the host builds file_record stores rooted at the state dir and injects them", () => {
  it("hands bootstrap BOTH stores, and they persist under AOA_WORKER_STATE_DIR", async () => {
    const seen: Record<string, unknown> = {};
    const bootstrap = vi.fn(async (deps: Record<string, unknown>) => {
      Object.assign(seen, deps);
      // Prove the injected identity store is rooted at the state dir by writing
      // through it and observing the file land there.
      (deps.identityStore as FileRecordStore<DeviceIdentityRecord>).saveIfAbsent({
        v: 1, workerId: WORKER_ID, targetId: TARGET_ID, deviceGeneration: 1, privateKeyPkcs8Der: realDer,
      });
      (deps.receiptStore as FileRecordStore<DeviceEnrollmentReceipt>).saveIfAbsent({
        v: 1, workerId: WORKER_ID, targetId: TARGET_ID, deviceGeneration: 1, deviceThumbprint: realKey.deviceThumbprint,
      });
      return { ok: true };
    });
    const { proc, exitCodes } = fakeProc();

    const result = await runContainerHost({ env: baseEnv(), proc, bootstrap: bootstrap as never });

    expect(result.ok).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(seen.identityStore).toBeInstanceOf(FileRecordStore);
    expect(seen.receiptStore).toBeInstanceOf(FileRecordStore);
    // The stores are the daemon's — the env is passed through so it resolves the
    // file_record mode itself (the host does not set the mode).
    expect((seen.env as Record<string, string>).AOA_WORKER_KEY_STORE_MODE).toBe("file_record");
    expect(existsSync(join(dir, IDENTITY_RECORD_FILE))).toBe(true);
    expect(existsSync(join(dir, RECEIPT_RECORD_FILE))).toBe(true);
  });

  it("does NOT inject a provider — the shipped container cannot construct one (E4-D01)", async () => {
    const seen: Record<string, unknown> = {};
    const bootstrap = vi.fn(async (deps: Record<string, unknown>) => { Object.assign(seen, deps); return { ok: true }; });
    const { proc } = fakeProc();
    await runContainerHost({ env: baseEnv(), proc, bootstrap: bootstrap as never });
    expect(seen.provider).toBeUndefined();
  });
});

describe("WRK-014/§4 — the writable-state-dir assert fails closed BEFORE any socket", () => {
  it("exits non-zero and NEVER calls bootstrap on a non-writable state dir", async () => {
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const { proc, exitCodes } = fakeProc();
    const result = await runContainerHost({
      env: baseEnv(),
      proc,
      bootstrap: bootstrap as never,
      assertStateDirWritable: () => ({ ok: false, reason: "EACCES" }),
    });
    expect(result.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("proceeds to bootstrap when the state dir is writable (positive control)", async () => {
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const { proc } = fakeProc();
    await runContainerHost({
      env: baseEnv(),
      proc,
      bootstrap: bootstrap as never,
      assertStateDirWritable: () => ({ ok: true }),
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("the REAL assert passes for a writable tmp dir and fails for a read-only one (POSIX)", async () => {
    // The default assert is a real probe write. A writable dir passes.
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const { proc, exitCodes } = fakeProc();
    await runContainerHost({ env: baseEnv(), proc, bootstrap: bootstrap as never });
    expect(exitCodes).toEqual([]);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")(
    "the REAL assert fails closed on a chmod 0500 state dir",
    async () => {
      const ro = mkdtempSync(join(tmpdir(), "wrk014-ro-"));
      chmodSync(ro, 0o500);
      try {
        const bootstrap = vi.fn(async () => ({ ok: true }));
        const { proc, exitCodes } = fakeProc();
        const result = await runContainerHost({
          env: baseEnv({ AOA_WORKER_STATE_DIR: ro }),
          proc,
          bootstrap: bootstrap as never,
        });
        expect(result.ok).toBe(false);
        expect(exitCodes).toEqual([1]);
        expect(bootstrap).not.toHaveBeenCalled();
      } finally {
        chmodSync(ro, 0o700);
        rmSync(ro, { recursive: true, force: true });
      }
    },
  );
});

describe("WRK-014/§6.3 — the container custody path: real enrollOnce persists, re-boot short-circuits", () => {
  // The persistence + short-circuit logic lives in enrollOnce + FileRecordStore
  // (both REAL here), driven through the sanctioned `createEnrollerFn` seam so no
  // fake HTTP control plane is needed. The gate that CALLS enrollOnce under
  // file_record is proven separately in enrollment-bootstrap.test.ts.
  function stores() {
    return {
      identityStore: new FileRecordStore<DeviceIdentityRecord>({
        path: join(dir, IDENTITY_RECORD_FILE), codec: identityRecordCodec,
      }),
      receiptStore: new FileRecordStore<DeviceEnrollmentReceipt>({
        path: join(dir, RECEIPT_RECORD_FILE), codec: receiptRecordCodec,
      }),
    };
  }

  function fakeEnroller(renewSpy: ReturnType<typeof vi.fn>) {
    return () => ({
      enroll: async () => { throw new Error("enrollOnce must call renew(), never enroll()"); },
      renew: renewSpy,
    });
  }

  const enrollResult = {
    outcome: "enrolled" as const,
    workerId: WORKER_ID,
    targetId: TARGET_ID,
    deviceGeneration: 1,
    providerConstraints: null,
    session: { token: "SESSION-TOKEN-MUST-NOT-ESCAPE", expiresAt: "2026-01-01T00:00:00.000Z" },
    deviceThumbprint: "tp-1",
    replay: false,
  };

  it("first boot persists identity+receipt to the state dir; a second boot short-circuits", async () => {
    const renew1 = vi.fn(async () => enrollResult);
    const first = await enrollOnce({
      ...stores(),
      client: {} as never,
      input: { targetId: TARGET_ID, enrollmentCode: CODE },
      createEnrollerFn: fakeEnroller(renew1) as never,
      randomWorkerId: () => WORKER_ID,
      generateKey: () => realKey,
      platform: "linux",
      arch: "x64",
    });
    expect(first.skipped).toBe(false);
    expect(renew1).toHaveBeenCalledTimes(1);
    // Persisted to disk, as one artifact each.
    expect(existsSync(join(dir, IDENTITY_RECORD_FILE))).toBe(true);
    expect(existsSync(join(dir, RECEIPT_RECORD_FILE))).toBe(true);

    // A fresh pair of stores over the SAME dir = a re-boot. enrollOnce must NOT
    // reach the network again (steady state).
    const renew2 = vi.fn(async () => enrollResult);
    const second = await enrollOnce({
      ...stores(),
      client: {} as never,
      input: { targetId: TARGET_ID, enrollmentCode: CODE },
      createEnrollerFn: fakeEnroller(renew2) as never,
      randomWorkerId: () => WORKER_ID,
      generateKey: () => realKey,
      platform: "linux",
      arch: "x64",
    });
    expect(second.skipped).toBe(true);
    expect(renew2).not.toHaveBeenCalled();
  });

  it("I13 — the minted session never appears in the outcome nor on disk", async () => {
    const first = await enrollOnce({
      ...stores(),
      client: {} as never,
      input: { targetId: TARGET_ID, enrollmentCode: CODE },
      createEnrollerFn: fakeEnroller(vi.fn(async () => enrollResult)) as never,
      randomWorkerId: () => WORKER_ID,
      generateKey: () => realKey,
      platform: "linux",
      arch: "x64",
    });
    // The outcome carries no session/token key (frozen allowlist).
    expect(JSON.stringify(first)).not.toContain("SESSION-TOKEN-MUST-NOT-ESCAPE");
    expect(Object.keys(first)).not.toContain("session");
    // Neither does the persisted identity file (it holds the key, not the session).
    const onDisk = (await import("node:fs")).readFileSync(join(dir, IDENTITY_RECORD_FILE), "utf8");
    expect(onDisk).not.toContain("SESSION-TOKEN-MUST-NOT-ESCAPE");
  });
});

describe("WRK-014/§1.3 — the last-line-of-defence enrolment-code redactor", () => {
  it("masks anything shaped like an enrolment code (parity with the desktop host)", () => {
    const masked = redactEnrollmentCodes(`boom while handling ${CODE} at line 1`);
    expect(masked).not.toContain(CODE);
    expect(masked).toContain("aoa_enr_[redacted]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactEnrollmentCodes("worker enrolled; targetId=abc")).toBe("worker enrolled; targetId=abc");
  });
});
