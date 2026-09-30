// DSK-001 / D5 — `classifyStoreOutcome`, the pure decision that decides whether a
// device key store said "there is no key" or "I could not open the key".
//
// This is the single most dangerous function in the package, and it is pure and
// OS-free precisely so the invariant that causes the catastrophic bug is gatable
// on the required Linux lane rather than an advisory weekly one.
//
// THE BUG IT EXISTS TO PREVENT. `DeviceKeyStore.load()` is contractually
// `DeviceKey | null` where `null` means *never enrolled*
// (worker-daemon/src/identity/key-store.ts:33-34). A store that maps a FAULT to
// `null` hands `loadOrCreateKey` a "no key" verdict; it mints a fresh key and
// enrols a NEW device identity. The server then denies that identity permanently
// (`worker_transfer_denied`), and `findWorkerForBinding` filters on
// scope/target/organization/owner with NO status predicate — so even the revoked
// row keeps matching and blocks re-enrolment forever, with no reset route.
//
// WHY EXIT CODE AND EMPTINESS ARE BOTH UNUSABLE AS THE ORACLE. Controller-measured
// on Windows PowerShell 5.1, tampering the HMAC region of a DPAPI blob so
// `Unprotect` raises a genuine CryptographicException:
//
//     powershell -EncodedCommand  ->  exit 1, EMPTY stdout
//     powershell -File            ->  exit 0, EMPTY stdout
//
// Same exception, opposite exit codes, identical empty stdout. So absence must
// come from an explicit per-platform channel, never from inference.

import { describe, expect, it } from "vitest";
import { classifyStoreOutcome, type StoreCommandResult } from "../outcome.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

const result = (over: Partial<StoreCommandResult> = {}): StoreCommandResult => ({
  exitCode: 0,
  signal: null,
  stdout: new Uint8Array(),
  stderr: "",
  absenceSignalled: false,
  ...over,
});

describe("DSK-001/D5 — absence is a positive signal, never an inference", () => {
  it("reports absent ONLY when the platform explicitly signalled absence", () => {
    const out = classifyStoreOutcome(result({ absenceSignalled: true }));
    expect(out.kind).toBe("absent");
  });

  it("does NOT infer absence from empty stdout with a zero exit — the -File fail-open", () => {
    // This is the measured shape: a genuine CryptographicException surfaced as
    // exit 0 with empty stdout. Treating it as `absent` is the lockout bug.
    const out = classifyStoreOutcome(result({ exitCode: 0, stdout: new Uint8Array() }));
    expect(out.kind).not.toBe("absent");
    expect(out.kind).toBe("corrupt");
  });

  it("does NOT infer absence from a generic non-zero exit — the -EncodedCommand shape", () => {
    const out = classifyStoreOutcome(result({ exitCode: 1, stderr: "The data is invalid." }));
    expect(out.kind).not.toBe("absent");
  });

  it("never returns absent for ANY combination that lacks the explicit signal", () => {
    // Exhaustive over the axes that a caller might be tempted to infer from.
    for (const exitCode of [0, 1, 2, 3, 44, null]) {
      for (const stdout of [new Uint8Array(), utf8("x")]) {
        for (const stderr of ["", "boom"]) {
          const out = classifyStoreOutcome(result({ exitCode, stdout, stderr }));
          expect(out.kind, `exit=${exitCode} stdoutLen=${stdout.length} stderr="${stderr}"`).not.toBe(
            "absent",
          );
        }
      }
    }
  });
});

describe("DSK-001/D5 — every fault maps to a distinct, non-null outcome", () => {
  it("maps the hardened denial exit to locked", () => {
    expect(classifyStoreOutcome(result({ exitCode: 3, stderr: "keychain is locked" })).kind).toBe(
      "locked",
    );
  });

  it("maps an access denial to denied", () => {
    expect(
      classifyStoreOutcome(result({ exitCode: 5, stderr: "Access is denied." })).kind,
    ).toBe("denied");
  });

  it("maps a spawn failure (null exit, no signal) to unavailable", () => {
    const out = classifyStoreOutcome(result({ exitCode: null, stderr: "spawn ENOENT" }));
    expect(out.kind).toBe("unavailable");
  });

  it("maps a killed child to unavailable, not to corrupt", () => {
    // A signal says nothing about the stored bytes.
    const out = classifyStoreOutcome(result({ exitCode: null, signal: "SIGKILL" }));
    expect(out.kind).toBe("unavailable");
  });

  it("carries detail on the outcomes that have it, for the operator log", () => {
    const out = classifyStoreOutcome(result({ exitCode: null, stderr: "spawn ENOENT" }));
    expect(out.kind === "unavailable" && out.detail).toContain("ENOENT");
  });
});

describe("DSK-001/D5 — a present envelope must be genuinely present", () => {
  it("returns the envelope bytes on a clean success", () => {
    const out = classifyStoreOutcome(result({ exitCode: 0, stdout: utf8("ZW52ZWxvcGU=") }));
    expect(out.kind).toBe("present");
    expect(out.kind === "present" && new TextDecoder().decode(out.envelope)).toBe("ZW52ZWxvcGU=");
  });

  it("treats a zero exit with output but ALSO an absence signal as absent", () => {
    // The explicit channel wins: a platform that says "no entry" is authoritative
    // even if the child happened to print something.
    const out = classifyStoreOutcome(result({ exitCode: 0, stdout: utf8("noise"), absenceSignalled: true }));
    expect(out.kind).toBe("absent");
  });

  it("does not treat whitespace-only stdout as an envelope", () => {
    const out = classifyStoreOutcome(result({ exitCode: 0, stdout: utf8("  \r\n ") }));
    expect(out.kind).toBe("corrupt");
  });
});

describe("DSK-001/D5 — the outcome union is total and closed", () => {
  it("returns one of exactly six kinds for every input shape tried", () => {
    const kinds = new Set<string>();
    for (const exitCode of [0, 1, 3, 5, 44, null]) {
      for (const signal of [null, "SIGKILL"]) {
        for (const stdout of [new Uint8Array(), utf8("QQ==")]) {
          for (const absenceSignalled of [true, false]) {
            kinds.add(classifyStoreOutcome(result({ exitCode, signal, stdout, absenceSignalled })).kind);
          }
        }
      }
    }
    for (const k of kinds) {
      expect(["present", "absent", "locked", "denied", "corrupt", "unavailable"]).toContain(k);
    }
  });
});

// -- found by running the real Windows probe ---------------------------------
//
// PowerShell writes CLIXML progress noise to STDERR on a SUCCESSFUL run
// ("Preparing modules for first use."). An earlier version of the classifier
// consulted the stderr markers BEFORE checking the exit code, so a successful
// load whose incidental stderr happened to contain a marker word would be
// misclassified as `unavailable` or `denied` — discarding a perfectly good key
// and, because the daemon treats a fault as fatal, refusing to start.
//
// A zero exit with real envelope bytes is a success. Nothing on stderr may
// override it.

describe("DSK-001 — incidental stderr never overrides a successful exit", () => {
  const utf8b = (s: string) => new TextEncoder().encode(s);

  it("returns present despite CLIXML progress noise on stderr", () => {
    const out = classifyStoreOutcome({
      exitCode: 0,
      signal: null,
      stdout: utf8b("ZW52ZWxvcGU="),
      stderr: '#< CLIXML <Objs Version="1.1.0.1"><AV>Preparing modules for first use.</AV></Objs>',
      absenceSignalled: false,
    });
    expect(out.kind).toBe("present");
  });

  it("returns present even when stderr contains a marker word, on a zero exit", () => {
    // Deliberately adversarial: the noise contains words the fault matchers look
    // for. The exit code is the authority for success.
    for (const noise of ["spawn helper ready", "ENOENT while probing modules", "access is denied (advisory)"]) {
      const out = classifyStoreOutcome({
        exitCode: 0,
        signal: null,
        stdout: utf8b("ZW52ZWxvcGU="),
        stderr: noise,
        absenceSignalled: false,
      });
      expect(out.kind, noise).toBe("present");
    }
  });

  it("still classifies those markers as faults when the exit code is NOT zero", () => {
    expect(
      classifyStoreOutcome({
        exitCode: 9, signal: null, stdout: new Uint8Array(),
        stderr: "spawn ENOENT", absenceSignalled: false,
      }).kind,
    ).toBe("unavailable");
    expect(
      classifyStoreOutcome({
        exitCode: 9, signal: null, stdout: new Uint8Array(),
        stderr: "Access is denied.", absenceSignalled: false,
      }).kind,
    ).toBe("denied");
  });
});
