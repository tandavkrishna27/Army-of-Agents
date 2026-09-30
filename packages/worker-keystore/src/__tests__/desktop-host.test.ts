// DSK-001 — the composition host.
//
// The only file in the repo that names both packages, and the only caller of
// `clear()`. Two properties are worth more than the wiring:
//
//   AN UNRESOLVABLE LOCATION IS A REFUSAL, NEVER A GUESS. Guessing is how a
//   device ends up with a second identity in a second place — and the server
//   denies a re-minted identity permanently.
//
//   THE RESET ORDER IS RECEIPT-FIRST, IDENTITY-SECOND. If the process dies
//   between the two, receipt-first leaves an identity with no receipt, which the
//   coordinator treats as "enrolled but unconfirmed" and can retry. The reverse
//   leaves a RECEIPT WITH NO IDENTITY — a device claiming an enrolment whose key
//   is gone, which nothing can recover.

import { describe, expect, it, vi } from "vitest";
import {
  runDesktopHost,
  RESET_IDENTITY_FLAG,
  RESET_ACKNOWLEDGEMENT_FLAG,
} from "../bin/desktop-host.js";
import { encodeIdentityEnvelope, type DeviceIdentityRecord } from "../envelope.js";

const LOCAL = "C:\\Users\\t\\AppData\\Local";

function fakeProc() {
  const exitCodes: number[] = [];
  return { exitCodes, proc: { once: () => {}, exit: (c: number) => { exitCodes.push(c); } } };
}

const okRunner = () => ({ run: () => ({
  exitCode: 0, signal: null, stdout: new Uint8Array(), stderr: "", absenceSignalled: true,
}) });

const WORKER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TARGET_ID = "a3000000-0000-4000-8000-000000000003";
const RECORD: DeviceIdentityRecord = {
  v: 1,
  workerId: WORKER_ID,
  targetId: TARGET_ID,
  deviceGeneration: 1,
  privateKeyPkcs8Der: new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00]),
};

/** What the load script actually writes on stdout: base64 of the envelope. */
function loadStdout(record: DeviceIdentityRecord): Uint8Array {
  let binary = "";
  for (const byte of encodeIdentityEnvelope(record)) binary += String.fromCharCode(byte);
  return new TextEncoder().encode(btoa(binary));
}

/**
 * A runner that answers load and delete plans separately, so a test can put the
 * identity slot in a chosen state and still observe the wipe.
 *
 * Load and delete are distinguished by the SCRIPT, not by `plan.stdin` — both are
 * `stdin: "none"`, so keying on that would silently conflate them.
 */
function vaultRunner(opts: {
  identity: "present" | "absent" | "unreadable";
  deleted: string[];
  deleteFails?: boolean;
}) {
  const absent = { exitCode: 0, signal: null, stdout: new Uint8Array(), stderr: "", absenceSignalled: true };
  return () => ({
    run: (plan: { blobPath: string; scriptText: string }) => {
      if (plan.scriptText.includes("::Delete(")) {
        if (opts.deleteFails) {
          return { exitCode: 5, signal: null, stdout: new Uint8Array(), stderr: "Access is denied.", absenceSignalled: false };
        }
        opts.deleted.push(plan.blobPath);
        return absent;
      }
      // Only the identity slot is stateful here; the receipt reads as absent.
      if (!plan.blobPath.includes("device-identity")) return absent;
      if (opts.identity === "absent") return absent;
      if (opts.identity === "unreadable") {
        // Exit 3 is the hardened script's deliberate fault exit.
        return { exitCode: 3, signal: null, stdout: new Uint8Array(), stderr: "The data is invalid.", absenceSignalled: false };
      }
      return { exitCode: 0, signal: null, stdout: loadStdout(RECORD), stderr: "", absenceSignalled: false };
    },
  });
}

describe("DSK-001 — an unresolvable location is a refusal", () => {
  it("exits non-zero and NEVER bootstraps when LOCALAPPDATA is absent", async () => {
    const { exitCodes, proc } = fakeProc();
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const out = await runDesktopHost({
      env: {}, proc: proc as never, platform: "win32", argv: [],
      createRunner: okRunner as never, bootstrap: bootstrap as never, log: () => {},
    });
    expect(out.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("exits non-zero on a non-Windows platform rather than inventing a path", async () => {
    const { exitCodes, proc } = fakeProc();
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const out = await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "linux", argv: [],
      createRunner: okRunner as never, bootstrap: bootstrap as never, log: () => {},
    });
    expect(out.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(bootstrap).not.toHaveBeenCalled();
  });
});

describe("DSK-001 — the host injects BOTH stores into the daemon", () => {
  it("passes an identity store and a receipt store", async () => {
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const { proc } = fakeProc();
    await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32", argv: [],
      createRunner: okRunner as never, bootstrap: bootstrap as never, log: () => {},
    });
    const passed = bootstrap.mock.calls[0]![0] as Record<string, unknown>;
    expect(passed.identityStore).toBeDefined();
    expect(passed.receiptStore).toBeDefined();
    // Two DISTINCT stores — sharing one would make the receipt overwrite the key.
    expect(passed.identityStore).not.toBe(passed.receiptStore);
  });
});

describe("DSK-001 — reset is deliberate, ordered, and honest about failure", () => {
  it("does NOT clear anything on a normal boot", async () => {
    const cleared: string[] = [];
    const runner = { run: (plan: { blobPath: string; stdin: string }) => {
      if (plan.stdin === "none") cleared.push(plan.blobPath);
      return { exitCode: 0, signal: null, stdout: new Uint8Array(), stderr: "", absenceSignalled: true };
    } };
    const { proc } = fakeProc();
    await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32", argv: [],
      createRunner: (() => runner) as never, bootstrap: (async () => ({ ok: true })) as never, log: () => {},
    });
    // A normal boot must never reach a delete plan.
    expect(cleared).toEqual([]);
  });

  it("clears the RECEIPT before the IDENTITY", async () => {
    // The order is the recoverability property. Identity-first would leave a
    // receipt with no key — an unrecoverable claim of an enrolment.
    //
    // Observed through the REAL stores via the runner's delete plans rather than
    // through injected fakes: the two blobs have distinct paths, so the order is
    // visible without inventing a test-only seam, and this proves the actual
    // constructed stores are cleared in order.
    const deleted: string[] = [];
    const { proc } = fakeProc();
    const out = await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32",
      argv: [RESET_IDENTITY_FLAG, RESET_ACKNOWLEDGEMENT_FLAG],
      createRunner: vaultRunner({ identity: "present", deleted }) as never,
      bootstrap: (async () => ({ ok: true })) as never,
      log: () => {},
    });
    expect(out.ok).toBe(true);
    expect(deleted).toHaveLength(2);
    expect(deleted[0]).toContain("device-enrollment");
    expect(deleted[1]).toContain("device-identity");
  });

  it("does not bootstrap when resetting", async () => {
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const { proc } = fakeProc();
    await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32",
      argv: [RESET_IDENTITY_FLAG, RESET_ACKNOWLEDGEMENT_FLAG],
      createRunner: okRunner as never, bootstrap: bootstrap as never, log: () => {},
    });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("reports a FAILED wipe as a failure, never as success", async () => {
    // A half-wiped device reporting "reset" is worse than one reporting an error
    // an operator can act on.
    const { exitCodes, proc } = fakeProc();
    const out = await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32",
      argv: [RESET_IDENTITY_FLAG, RESET_ACKNOWLEDGEMENT_FLAG],
      createRunner: vaultRunner({ identity: "present", deleted: [], deleteFails: true }) as never,
      bootstrap: (async () => ({ ok: true })) as never,
      log: () => {},
    });
    expect(out.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
  });
});

describe("DSK-001/I7 — the wipe is GUARDED, because it is the permanent lockout", () => {
  // Plan §3/I7 point 4. `--reset-identity` is what an operator reaches for when a
  // start fails, and on the same target it lands in `worker_transfer_denied`
  // (`worker-enrollment.ts:418-423`) with `findWorkerForBinding` carrying no
  // status predicate — so the stale row matches forever and there is no reset
  // route. An unguarded wipe is therefore the very failure this ticket exists to
  // prevent, reachable by a single argument.

  it("REFUSES to wipe without the acknowledgement, and destroys nothing", async () => {
    const deleted: string[] = [];
    const lines: string[] = [];
    const { exitCodes, proc } = fakeProc();
    const out = await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32",
      argv: [RESET_IDENTITY_FLAG],
      createRunner: vaultRunner({ identity: "present", deleted }) as never,
      bootstrap: (async () => ({ ok: true })) as never,
      log: (m) => lines.push(m),
    });
    expect(out.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
    // The teeth: zero delete plans reached the OS.
    expect(deleted).toEqual([]);
  });

  it("NAMES the workerId and targetId it would destroy, and says it is permanent", async () => {
    // A warning an operator cannot check against reality is a warning they skip.
    const lines: string[] = [];
    const { proc } = fakeProc();
    await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32",
      argv: [RESET_IDENTITY_FLAG],
      createRunner: vaultRunner({ identity: "present", deleted: [] }) as never,
      bootstrap: (async () => ({ ok: true })) as never,
      log: (m) => lines.push(m),
    });
    const text = lines.join("\n");
    expect(text).toContain(WORKER_ID);
    expect(text).toContain(TARGET_ID);
    expect(text.toLowerCase()).toContain("permanent");
    // It must also name the way out, or the operator guesses.
    expect(text).toContain(RESET_ACKNOWLEDGEMENT_FLAG);
  });

  it("proceeds once acknowledged", async () => {
    const deleted: string[] = [];
    const { proc } = fakeProc();
    const out = await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32",
      argv: [RESET_IDENTITY_FLAG, RESET_ACKNOWLEDGEMENT_FLAG],
      createRunner: vaultRunner({ identity: "present", deleted }) as never,
      bootstrap: (async () => ({ ok: true })) as never,
      log: () => {},
    });
    expect(out.ok).toBe(true);
    expect(deleted).toHaveLength(2);
  });

  it("still requires the acknowledgement when the identity is UNREADABLE", async () => {
    // The most dangerous state, and the one an operator is most likely to be in
    // when they reach for reset: the slot may hold a perfectly good enrolment
    // that is merely locked or ACL-denied right now. Wiping it is unrecoverable.
    const deleted: string[] = [];
    const lines: string[] = [];
    const { exitCodes, proc } = fakeProc();
    const out = await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32",
      argv: [RESET_IDENTITY_FLAG],
      createRunner: vaultRunner({ identity: "unreadable", deleted }) as never,
      bootstrap: (async () => ({ ok: true })) as never,
      log: (m) => lines.push(m),
    });
    expect(out.ok).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(deleted).toEqual([]);
    // And it must say WHY it cannot name the identity, rather than implying none.
    expect(lines.join("\n").toLowerCase()).toContain("could not be read");
  });

  it("does NOT require the acknowledgement when the identity is provably ABSENT", async () => {
    // Absence is the one signal this package trusts — it arrives only through the
    // platform's own ENOENT oracle, never by inference. With no identity stored
    // there is provably nothing to make unenrollable, so demanding a scary
    // acknowledgement here would train operators to paste it every time.
    const deleted: string[] = [];
    const lines: string[] = [];
    const { exitCodes, proc } = fakeProc();
    const out = await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32",
      argv: [RESET_IDENTITY_FLAG],
      createRunner: vaultRunner({ identity: "absent", deleted }) as never,
      bootstrap: (async () => ({ ok: true })) as never,
      log: (m) => lines.push(m),
    });
    expect(out.ok).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(deleted).toHaveLength(2);
    expect(lines.join("\n").toLowerCase()).not.toContain("permanent");
  });

  it("does nothing when the acknowledgement is passed WITHOUT --reset-identity", async () => {
    // The acknowledgement must never be the thing that triggers a wipe.
    const deleted: string[] = [];
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const { proc } = fakeProc();
    await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32",
      argv: [RESET_ACKNOWLEDGEMENT_FLAG],
      createRunner: vaultRunner({ identity: "present", deleted }) as never,
      bootstrap: bootstrap as never, log: () => {},
    });
    expect(deleted).toEqual([]);
    expect(bootstrap).toHaveBeenCalled();
  });

  it("tells the operator NOT to reset when a start is failing with an identity present", async () => {
    // Plan §3/I7 point 4. Without this the guard reads as a formality to click
    // through; the diagnosis is the part that changes what the operator does.
    const lines: string[] = [];
    const { proc } = fakeProc();
    await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL }, proc: proc as never, platform: "win32",
      argv: [RESET_IDENTITY_FLAG],
      createRunner: vaultRunner({ identity: "present", deleted: [] }) as never,
      bootstrap: (async () => ({ ok: true })) as never,
      log: (m) => lines.push(m),
    });
    expect(lines.join("\n")).toMatch(/do NOT reset/);
  });
});
