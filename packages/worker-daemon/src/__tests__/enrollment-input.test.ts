// DSK-001 — reading the enrollment ticket, without reaching off-machine and
// without ever putting a live credential where it can be read later.
//
// `config.enrollmentCodeSource` is parsed today and has ZERO readers. This is the
// reader, and three of its properties are security properties.
//
//   THE FIELD IS NAMED `enrollmentCode`, NOT `code`. The daemon logger redacts by
//   substring against SENSITIVE_SUBSTRINGS, which contains "enrollmentcode" and
//   does NOT contain "code" (logging/logger.ts:37-49, verified). So an object
//   logged with a `code` field prints the credential in full while the same value
//   under `enrollmentCode` prints `[redacted]`. The name IS the mitigation.
//
//   A PATH SOURCE MUST BE LOCAL, CHECKED BEFORE THE READ. `parseEnrollmentCodeSource`
//   validates only non-emptiness and mutual exclusion (config.ts, verified) — it
//   does no locality check. Reading a UNC path is an authenticated SMB round trip
//   to a host someone else chose, which both leaks the fact of enrolment and
//   invites a hostile file.
//
//   AN ERROR NEVER ECHOES THE CONTENTS. A malformed ticket file must not put its
//   bytes into an exception that then lands in a log or a crash report.

import { describe, expect, it, vi } from "vitest";
import { EnrollmentInputError, readEnrollmentInput } from "../enrollment/enrollment-input.js";
import { encodeEnrollmentTicket } from "../enrollment/ticket.js";

const TARGET_ID = "a3000000-0000-4000-8000-000000000003";
const CODE = "aoa_enr_" + "A".repeat(22) + "." + "B".repeat(43);
const TICKET = encodeEnrollmentTicket({ v: 1, targetId: TARGET_ID, code: CODE });

describe("DSK-001 — the reader resolves both source kinds", () => {
  it("reads a ticket from an environment variable", () => {
    const out = readEnrollmentInput(
      { kind: "env", envVar: "AOA_TICKET" },
      { AOA_TICKET: TICKET },
      () => { throw new Error("must not read a file"); },
    );
    expect(out).toEqual({ targetId: TARGET_ID, enrollmentCode: CODE });
  });

  it("reads a ticket from a local absolute path", () => {
    const readFileText = vi.fn(() => TICKET);
    const out = readEnrollmentInput({ kind: "path", path: "C:\\AoA\\ticket.txt" }, {}, readFileText, "win32");
    expect(out.targetId).toBe(TARGET_ID);
    expect(readFileText).toHaveBeenCalledWith("C:\\AoA\\ticket.txt");
  });

  it("tolerates exactly one trailing newline, as every text editor adds", () => {
    for (const suffix of ["\n", "\r\n", ""]) {
      const out = readEnrollmentInput({ kind: "path", path: "C:\\t.txt" }, {}, () => TICKET + suffix, "win32");
      expect(out.targetId, JSON.stringify(suffix)).toBe(TARGET_ID);
    }
  });
});

describe("DSK-001 — the field name is the redaction mitigation", () => {
  it("returns `enrollmentCode`, a name the daemon logger redacts", () => {
    const out = readEnrollmentInput({ kind: "env", envVar: "T" }, { T: TICKET }, () => "");
    expect(Object.keys(out).sort()).toEqual(["enrollmentCode", "targetId"]);
    // `code` would print in full: the logger's substring list has
    // "enrollmentcode" but not "code".
    expect(Object.keys(out)).not.toContain("code");
  });
});

describe("DSK-001 — a path source must be local, rejected BEFORE the read (win32 arm)", () => {
  const hostile = [
    ["UNC share", "\\\\attacker\\share\\ticket.txt"],
    ["UNC long path", "\\\\?\\UNC\\attacker\\share\\ticket.txt"],
    ["forward-slash UNC", "//attacker/share/ticket.txt"],
    ["device namespace", "\\\\.\\pipe\\ticket"],
  ];

  for (const [name, path] of hostile) {
    it(`rejects a ${name} without reading it`, () => {
      const readFileText = vi.fn(() => TICKET);
      expect(() => readEnrollmentInput({ kind: "path", path }, {}, readFileText, "win32")).toThrow();
      // The REAL assertion: the read never happened. A rejection after the read
      // has already leaked the enrolment attempt to the remote host.
      expect(readFileText, name).not.toHaveBeenCalled();
    });
  }

  it("rejects a relative path, which resolves against an unpredictable cwd", () => {
    const readFileText = vi.fn(() => TICKET);
    expect(() => readEnrollmentInput({ kind: "path", path: "ticket.txt" }, {}, readFileText, "win32")).toThrow();
    expect(readFileText).not.toHaveBeenCalled();
  });
});

describe("DSK-001 — failures never expose the credential", () => {
  it("throws when the environment variable is absent, naming the variable only", () => {
    expect(() => readEnrollmentInput({ kind: "env", envVar: "MISSING" }, {}, () => "")).toThrow(/MISSING/);
  });

  it("never puts the file contents into the error", () => {
    const secretish = "aoa_enr_" + "S".repeat(22) + "." + "T".repeat(43);
    const badTicket = "aoa_tkt_" + Buffer.from(
      JSON.stringify({ v: 9, targetId: TARGET_ID, code: secretish }),
    ).toString("base64url");
    try {
      readEnrollmentInput({ kind: "path", path: "C:\\t.txt" }, {}, () => badTicket, "win32");
      throw new Error("expected a rejection");
    } catch (err) {
      const text = `${(err as Error).message} ${(err as Error).stack ?? ""}`;
      expect(text).not.toContain(secretish);
      expect(text).not.toContain(badTicket);
      expect(text).not.toContain("S".repeat(22));
    }
  });

  it("never puts the raw file text into the error when it is not a ticket at all", () => {
    const junk = "this file actually contains a password: hunter2";
    try {
      readEnrollmentInput({ kind: "path", path: "C:\\t.txt" }, {}, () => junk, "win32");
      throw new Error("expected a rejection");
    } catch (err) {
      expect(`${(err as Error).message}`).not.toContain("hunter2");
    }
  });
});

// WRK-015 — the POSIX arm. On a container (`platform !== "win32"`) a `/`-rooted
// absolute path is the accepted shape. The arm mirrors `isSandboxSecretFilePath`'s
// SHAPE (worker-protocol/policy.ts) MINUS the fixed sandbox root, PLUS an explicit
// leading-`/` check — because that function's `startsWith(ROOT)` line did DOUBLE
// DUTY (confinement AND absoluteness), so "minus the root" naively ACCEPTS a
// relative path. The three DSK-001 security properties survive on this arm too:
// locality is decided BEFORE the read (a rejected path is never read), the fault
// is the same content-free `EnrollmentInputError`, and the returned field stays
// `enrollmentCode`.
describe("WRK-015 — the POSIX arm accepts a rooted absolute path, rejects the rest BEFORE the read", () => {
  const POSIX_CODE_PATH = "/run/secrets/worker-enrollment-code";

  // §5.2 — the `readEnrollmentInput` POSIX round-trip: a valid ticket at a rooted
  // path resolves to the two fields.
  it("accepts a `/`-rooted absolute path and reads the ticket", () => {
    const readFileText = vi.fn(() => TICKET);
    const out = readEnrollmentInput({ kind: "path", path: POSIX_CODE_PATH }, {}, readFileText, "linux");
    expect(out).toEqual({ targetId: TARGET_ID, enrollmentCode: CODE });
    expect(readFileText).toHaveBeenCalledWith(POSIX_CODE_PATH);
  });

  // Pins the boundary against the over-1024 reject below: 1024 is the inclusive
  // max (the check is `> 1024`), so an off-by-one to `>= 1024` would reject this.
  it("accepts a path exactly at the 1024-char boundary", () => {
    const maxPath = "/" + "a".repeat(1023); // total length 1024
    const readFileText = vi.fn(() => TICKET);
    const out = readEnrollmentInput({ kind: "path", path: maxPath }, {}, readFileText, "linux");
    expect(out.targetId).toBe(TARGET_ID);
    expect(readFileText).toHaveBeenCalledWith(maxPath);
  });

  // Each of these must be rejected BEFORE the read (the injected reader proves it),
  // and content-free (no path bytes in the message/stack). The relative case is the
  // MED-1 leading-`/` proof: a naive "isSandboxSecretFilePath minus the root" would
  // ACCEPT `ticket.txt` (`"ticket.txt".slice(1).split("/")` → ["icket.txt"], a
  // non-empty non-dot segment) and READ it — the leading-`/` check is what makes it
  // a rejection, asserted by the read never happening.
  const rejected: Array<readonly [string, string]> = [
    ["a relative path (MED-1 leading-/)", "ticket.txt"],
    ["a `..` traversal segment", "/a/../b"],
    ["a `.` segment", "/a/./b"],
    ["a `//` empty segment", "//x"],
    ["a trailing `/` empty segment", "/run/secrets/"],
    ["a backslash", "/a\\b"],
    ["a control byte", "/a\x01b"],
    ["a NUL byte", "/a\x00b"],
    // The DEL byte pins the SECOND arm of `c < 0x20 || c === 0x7f`: deleting the
    // whole clause is killed by the < 0x20 cases above, but dropping ONLY the
    // `|| c === 0x7f` arm survives without this case ("mutate each ARM").
    ["a DEL byte (0x7f)", "/a\x7fb"],
    ["an over-1024 path", "/" + "a".repeat(1024)],
    ["the bare root `/`", "/"],
  ];
  for (const [name, path] of rejected) {
    it(`rejects ${name} without reading it, content-free`, () => {
      const readFileText = vi.fn(() => TICKET);
      let thrown: unknown;
      try {
        readEnrollmentInput({ kind: "path", path }, {}, readFileText, "linux");
      } catch (err) {
        thrown = err;
      }
      expect(thrown, name).toBeInstanceOf(EnrollmentInputError);
      // Content-free: the message names the CONSTRAINT, never the input path.
      // (Scoped to `message`, not the stack — the stack legitimately carries the
      // SOURCE file paths, and a one-char path like `/` appears in every stack's
      // file URLs, which is not an echo of the input.)
      expect((thrown as Error).message, name).not.toContain(path);
      // The load-bearing property: a rejected path is NEVER read.
      expect(readFileText, name).not.toHaveBeenCalled();
    });
  }
});

// WRK-015 (review LOW-3) — the Windows codec-no-echo tests above use `C:\…` paths,
// which SHORT-CIRCUIT before the read on a POSIX platform (the win32 arm rejects
// them at locality), leaving the POSIX read→codec no-echo path uncovered. These
// twins drive it on `linux`: a rooted path that passes locality, is read, and then
// fails the strict codec — the message must still echo none of the bytes.
describe("WRK-015 — the POSIX read→codec path also never echoes the credential", () => {
  it("never echoes the credential when the codec rejects the code SHAPE (linux path)", () => {
    // v:1 + a valid targetId passes the version + targetId checks and reaches the
    // CODE-shape branch (`ticket.ts` CODE_RE) — the ONLY codec branch that inspects
    // the credential value — so this covers no-echo exactly where it matters most.
    // The code is secret-looking but malformed (second part < 32 chars → fails CODE_RE).
    const secretish = "aoa_enr_" + "S".repeat(22) + "." + "T".repeat(20);
    const badTicket = "aoa_tkt_" + Buffer.from(
      JSON.stringify({ v: 1, targetId: TARGET_ID, code: secretish }),
    ).toString("base64url");
    const readFileText = vi.fn(() => badTicket);
    try {
      readEnrollmentInput({ kind: "path", path: "/run/secrets/code" }, {}, readFileText, "linux");
      throw new Error("expected a rejection");
    } catch (err) {
      const text = `${(err as Error).message} ${(err as Error).stack ?? ""}`;
      expect(text).not.toContain(secretish);
      expect(text).not.toContain(badTicket);
      expect(text).not.toContain("S".repeat(22));
    }
    // The read DID happen here — this is the read→codec path, not a locality reject.
    expect(readFileText).toHaveBeenCalledWith("/run/secrets/code");
  });

  it("never puts the raw file text into the error when it is not a ticket at all (linux path)", () => {
    const junk = "this file actually contains a password: hunter2";
    try {
      readEnrollmentInput({ kind: "path", path: "/run/secrets/code" }, {}, () => junk, "linux");
      throw new Error("expected a rejection");
    } catch (err) {
      expect(`${(err as Error).message}`).not.toContain("hunter2");
    }
  });
});
