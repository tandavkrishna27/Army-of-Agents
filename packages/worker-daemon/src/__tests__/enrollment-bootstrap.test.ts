// DSK-001 / D4 (amended by A1) — the daemon actually ENROLS.
//
// Before this, `enrollOnce` had zero callers outside its own tests: the daemon
// loaded config, checked custody, started a health server, and never enrolled.
// The ticket's central deliverable was built and wired to nothing.
//
// Three properties carry the weight here, and none of them is about the happy
// path:
//
//   ORDERING. Enrolment runs AFTER the health server is up, so the compose
//   healthcheck can answer while a device is enrolling (D14), and AFTER the
//   pre-socket custody gate, so a CONFIGURATION fault still dies before any
//   socket opens (I11). Those two pull in opposite directions and the split
//   between them is the whole shape of the block.
//
//   THE FATAL/NON-FATAL SPLIT. A fresh device that could not enrol should exit;
//   a device whose identity is intact should not. Exiting in the second case
//   would turn a survivable state into a restart loop, and a restart loop is
//   what pressures an operator toward `--reset-identity` — which on the same
//   target IS the permanent lockout. See amendment A1.
//
//   THE CREDENTIAL NEVER LEAKS. It is read through a thunk so it materializes
//   only when a ticket is actually needed, and it must never reach a log line.

import { describe, expect, it, vi } from "vitest";

import { bootstrapWorkerDaemon, type ProcessLike } from "../bin/worker-daemon.js";
import { EnrollOnceError, EnrollmentAuthorityError } from "../enrollment/enroll-once.js";
import type { Env } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import type { HealthServerHandle } from "../health/health-server.js";
import type {
  DeviceEnrollmentReceipt,
  DeviceIdentityRecord,
  DeviceRecordStore,
} from "../identity/device-identity-store.js";

const WORKER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TARGET_ID = "a3000000-0000-4000-8000-000000000003";
const CODE = "aoa_enr_abcdefgh12345678.0123456789abcdef0123456789abcdef";

function baseEnv(overrides: Env = {}): Env {
  return {
    AOA_WORKER_CONTROL_PLANE_URL: "https://control.example.com",
    AOA_WORKER_ENROLLMENT_CODE_ENV: "AOA_TICKET",
    AOA_TICKET: CODE,
    AOA_WORKER_KEY_STORE_MODE: "os_keychain",
    AOA_WORKER_TARGET_SCOPE: "organization",
    ...overrides,
  };
}

function recordingLogger(lines: string[]): () => Logger {
  const push = (a: unknown, b?: string) => {
    lines.push(typeof a === "string" ? a : JSON.stringify(a) + " " + String(b));
  };
  return () => ({
    info: push as Logger["info"],
    warn: push as Logger["warn"],
    error: push as Logger["error"],
    flush: async () => {},
  });
}

function fakeProc() {
  const exitCodes: number[] = [];
  const proc: ProcessLike = { once: () => {}, exit: (code) => { exitCodes.push(code); } };
  return { exitCodes, proc };
}

function emptyStore<T>(): DeviceRecordStore<T> {
  return { load: () => null, saveIfAbsent: () => "stored", clear: () => {} };
}

const OUTCOME = {
  enrolled: true,
  minted: true,
  skipped: false,
  workerId: WORKER_ID,
  targetId: TARGET_ID,
  deviceGeneration: 1,
  deviceThumbprint: "tp-1",
};

/** Everything a bootstrap needs to reach the enrolment block, with no network. */
function deps(over: Record<string, unknown> = {}) {
  const events: string[] = [];
  const handle = {
    close: async () => { events.push("health-close"); },
  } as unknown as HealthServerHandle;
  return {
    events,
    args: {
      env: baseEnv(),
      identityStore: emptyStore<DeviceIdentityRecord>(),
      receiptStore: emptyStore<DeviceEnrollmentReceipt>(),
      startHealth: (async () => { events.push("health-start"); return handle; }) as never,
      createClient: (() => ({}) as never) as never,
      readFileText: () => { throw new Error("no filesystem in this test"); },
      enrollOnceFn: (async () => { events.push("enroll"); return OUTCOME; }) as never,
      ...over,
    },
  };
}

describe("DSK-001/D4 — the daemon enrols, and only when it has custody", () => {
  it("calls enrollOnce exactly once under os_keychain", async () => {
    const enrollOnceFn = vi.fn(async () => OUTCOME);
    const { proc, exitCodes } = fakeProc();
    const d = deps({ enrollOnceFn: enrollOnceFn as never });
    const result = await bootstrapWorkerDaemon({
      ...d.args, proc, createLogger: recordingLogger([]),
    } as never);
    expect(result.ok).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(enrollOnceFn).toHaveBeenCalledTimes(1);
  });

  it("calls enrollOnce exactly once under file_record (WRK-014 — the container enrol path)", async () => {
    // WRK-014: a `file_record` container with both stores enters the SAME enrol
    // block as `os_keychain`. This is the gate arm the ticket adds.
    const enrollOnceFn = vi.fn(async () => OUTCOME);
    const { proc, exitCodes } = fakeProc();
    const d = deps({
      env: baseEnv({ AOA_WORKER_KEY_STORE_MODE: "file_record" }),
      enrollOnceFn: enrollOnceFn as never,
    });
    const result = await bootstrapWorkerDaemon({
      ...d.args, proc, createLogger: recordingLogger([]),
    } as never);
    expect(result.ok).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(enrollOnceFn).toHaveBeenCalledTimes(1);
  });

  it("does NOT enrol under mounted_secret — shipped-container behaviour is unchanged", async () => {
    // Row 3 of the I11 truth table. Every deployed compose file uses this mode,
    // so an enrolment attempt here would be a live behaviour change to running
    // containers rather than a new capability.
    const enrollOnceFn = vi.fn(async () => OUTCOME);
    const { proc, exitCodes } = fakeProc();
    const d = deps({
      env: baseEnv({ AOA_WORKER_KEY_STORE_MODE: "mounted_secret" }),
      identityStore: undefined,
      receiptStore: undefined,
      enrollOnceFn: enrollOnceFn as never,
    });
    const result = await bootstrapWorkerDaemon({
      ...d.args, proc, createLogger: recordingLogger([]),
    } as never);
    expect(result.ok).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(enrollOnceFn).not.toHaveBeenCalled();
  });

  it("enrols AFTER the health server is up, so the healthcheck answers during enrolment", async () => {
    const d = deps();
    const { proc } = fakeProc();
    await bootstrapWorkerDaemon({ ...d.args, proc, createLogger: recordingLogger([]) } as never);
    expect(d.events).toEqual(["health-start", "enroll"]);
  });
});

describe("DSK-001/A1 — the fatal/non-fatal split", () => {
  function authorityFailure(minted: boolean) {
    return async () => {
      throw new EnrollmentAuthorityError({
        minted, workerId: WORKER_ID, targetId: TARGET_ID, cause: new Error("503"),
      });
    };
  }

  it("EXITS when a freshly minted device could not enrol", async () => {
    // A fresh device that never reached authority is useless. The loop is
    // bounded: the next boot loads the persisted record instead of minting.
    const { proc, exitCodes } = fakeProc();
    const d = deps({ enrollOnceFn: authorityFailure(true) as never });
    const result = await bootstrapWorkerDaemon({
      ...d.args, proc, createLogger: recordingLogger([]),
    } as never);
    expect(result.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
    // And it must not leave a bound socket behind claiming readiness.
    expect(d.events).toContain("health-close");
  });

  it("RUNS IDLE when the identity is intact and only authority failed", async () => {
    // Exiting here would restart-loop a device that is fine, and a restart loop
    // is what walks an operator into `--reset-identity` — the permanent lockout.
    const { proc, exitCodes } = fakeProc();
    const d = deps({ enrollOnceFn: authorityFailure(false) as never });
    const result = await bootstrapWorkerDaemon({
      ...d.args, proc, createLogger: recordingLogger([]),
    } as never);
    expect(result.ok).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(d.events).not.toContain("health-close");
  });

  it("EXITS on a store fault, no matter what — a store that cannot open is never survivable", async () => {
    // The narrowness of the survivable branch is the point. If it widened to
    // "any enrolment error", I3 would be silently regressed: a locked store
    // would look like a transient network problem.
    const { proc, exitCodes } = fakeProc();
    const d = deps({
      enrollOnceFn: (async () => {
        throw new EnrollOnceError("device identity store unusable (locked)");
      }) as never,
    });
    const result = await bootstrapWorkerDaemon({
      ...d.args, proc, createLogger: recordingLogger([]),
    } as never);
    expect(result.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
  });

  it("survives a health-server close that REJECTS, rather than escaping bootstrap", async () => {
    // An escaped rejection reaches the entry guard's `console.error(err.stack)`,
    // which bypasses the redactor entirely (I13).
    const { proc, exitCodes } = fakeProc();
    const handle = {
      close: async () => { throw new Error("close failed"); },
    } as unknown as HealthServerHandle;
    const d = deps({
      startHealth: (async () => handle) as never,
      enrollOnceFn: authorityFailure(true) as never,
    });
    const result = await bootstrapWorkerDaemon({
      ...d.args, proc, createLogger: recordingLogger([]),
    } as never);
    expect(result.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
  });
});

describe("DSK-001/I13 — the credential never reaches a log line", () => {
  it("logs no enrollment code on the success path", async () => {
    const lines: string[] = [];
    const { proc } = fakeProc();
    const d = deps();
    await bootstrapWorkerDaemon({ ...d.args, proc, createLogger: recordingLogger(lines) } as never);
    expect(lines.join("\n")).not.toContain(CODE);
    expect(lines.join("\n")).not.toContain("aoa_enr_");
  });

  it("logs no enrollment code on the failure path", async () => {
    const lines: string[] = [];
    const { proc } = fakeProc();
    const d = deps({
      enrollOnceFn: (async () => { throw new Error(`rejected code ${CODE}`); }) as never,
    });
    await bootstrapWorkerDaemon({ ...d.args, proc, createLogger: recordingLogger(lines) } as never);
    // The message is logged through the `err` binding, which the real logger
    // redacts; this test guards the bootstrap's own interpolation, which must
    // never build a message out of the error's text.
    const own = lines.filter((l) => !l.includes('"err"'));
    expect(own.join("\n")).not.toContain(CODE);
  });

  it("passes a THUNK, so the credential is not read on the steady-state path", async () => {
    // `readEnrollmentInput` is invoked by the coordinator only when a ticket is
    // actually needed. If the bootstrap resolved it eagerly, an already-enrolled
    // device would materialize a live credential on every boot for nothing.
    const readFileText = vi.fn(() => CODE);
    const { proc } = fakeProc();
    const d = deps({ readFileText });
    await bootstrapWorkerDaemon({ ...d.args, proc, createLogger: recordingLogger([]) } as never);
    expect(readFileText).not.toHaveBeenCalled();
  });
});

describe("DSK-001/D4 — an unreadable ticket is fatal, not a silent no-op", () => {
  it("EXITS when os_keychain is configured but the enrollment code cannot be read", async () => {
    // This is the behaviour the old custody-gate test was accidentally covering
    // before enrolment existed: a device configured for OS custody, with no
    // identity and no readable ticket, cannot enrol. Running on would leave a
    // worker reporting itself healthy with no way to obtain authority.
    //
    // Uses the REAL enrollOnce and the REAL reader, with a file path that does
    // not exist — so the failure comes from the wiring rather than from a stub.
    const { proc, exitCodes } = fakeProc();
    const store = emptyStore<DeviceIdentityRecord>();
    const result = await bootstrapWorkerDaemon({
      env: {
        AOA_WORKER_CONTROL_PLANE_URL: "https://control.example.com",
        AOA_WORKER_ENROLLMENT_CODE_FILE: "/nonexistent/enrollment-code",
        AOA_WORKER_KEY_STORE_MODE: "os_keychain",
        AOA_WORKER_TARGET_SCOPE: "organization",
      },
      proc,
      createLogger: recordingLogger([]),
      startHealth: (async () => ({ close: async () => {} })) as never,
      identityStore: store,
      receiptStore: store as never,
    } as never);
    expect(result.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
  });
});
