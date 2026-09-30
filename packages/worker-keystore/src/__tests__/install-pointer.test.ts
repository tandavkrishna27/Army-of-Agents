/**
 * DSK-004 Lane C — the pointer file itself (clause 5, I5).
 *
 * The planner decides WHETHER the pointer may move. This is the part that makes moving
 * it safe, and without it clause (5) — "power loss recovers to one valid version" — is
 * a design intention rather than a property. Side-by-side versions only help if the
 * pointer can never be observed half-written.
 *
 * So the invariant under test is not "the write succeeds". It is:
 *
 *   THE DESTINATION IS NEVER WRITTEN DIRECTLY. Content goes to a temporary file and is
 *   moved onto the destination by a rename, which the filesystem performs atomically. A
 *   reader therefore sees the whole old pointer or the whole new one, and a machine that
 *   loses power mid-update comes back to one of the two — never to a truncated file
 *   naming half a version.
 *
 * The IO is injected so the ordering is provable on the ubuntu-only required lane, and
 * so the test can assert the SEQUENCE of operations rather than merely the end state —
 * the end state of a direct write and of a rename are identical, and only one of them is
 * safe.
 */

import { describe, expect, it, vi } from "vitest";

import { POINTER_SCHEMA_VERSION, readVersionPointer, writeVersionPointer } from "../install-pointer.js";

const POINTER = "C:\\Program Files\\AoA\\worker\\current.v1.json";
const TEMP = `${POINTER}.tmp`;

function recordingIo(initial?: string) {
  const calls: Array<{ op: string; path: string; data?: string }> = [];
  let stored = initial;
  return {
    calls,
    get stored() {
      return stored;
    },
    io: {
      readFile: (path: string) => {
        calls.push({ op: "readFile", path });
        if (stored === undefined) {
          const error = new Error("ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return stored;
      },
      writeFile: (path: string, data: string) => {
        calls.push({ op: "writeFile", path, data });
      },
      rename: (from: string, to: string) => {
        calls.push({ op: "rename", path: `${from} -> ${to}` });
        const written = calls.find((c) => c.op === "writeFile" && c.path === from);
        stored = written?.data;
      },
      removeFile: (path: string) => {
        calls.push({ op: "removeFile", path });
      },
    },
  };
}

describe("DSK-004/I5 — the pointer is never written in place", () => {
  it("writes a temporary file and renames it onto the destination", () => {
    const { io, calls } = recordingIo();
    writeVersionPointer(io, POINTER, "0.1.1");
    expect(calls.map((c) => c.op)).toEqual(["writeFile", "rename"]);
    expect(calls[0]!.path).toBe(TEMP);
    expect(calls[1]!.path).toBe(`${TEMP} -> ${POINTER}`);
  });

  it("never names the destination in a write", () => {
    // The end state of a direct write and of a rename are identical; only one of them
    // survives losing power halfway. Asserting the end state would pass for both.
    const { io, calls } = recordingIo();
    writeVersionPointer(io, POINTER, "0.1.1");
    expect(calls.filter((c) => c.op === "writeFile").map((c) => c.path)).toEqual([TEMP]);
  });

  it("round-trips through the reader", () => {
    const r = recordingIo();
    writeVersionPointer(r.io, POINTER, "0.1.1");
    expect(readVersionPointer(r.io, POINTER)).toEqual({ ok: true, version: "0.1.1" });
  });

  it("records a schema version, so a future format change is detectable", () => {
    const { io, calls } = recordingIo();
    writeVersionPointer(io, POINTER, "0.1.1");
    expect(JSON.parse(calls[0]!.data!)).toEqual({ schema: POINTER_SCHEMA_VERSION, version: "0.1.1" });
  });

  it("cleans up the temporary file when the rename fails, and reports the failure", () => {
    const { io, calls } = recordingIo();
    const failing = { ...io, rename: () => { throw new Error("EPERM"); } };
    expect(() => writeVersionPointer(failing, POINTER, "0.1.1")).toThrow(/pointer/i);
    expect(calls.some((c) => c.op === "removeFile" && c.path === TEMP)).toBe(true);
  });

  it("refuses to write an unsafe version rather than creating the path", () => {
    const { io, calls } = recordingIo();
    for (const bad of ["../evil", "NUL", "0.1.0.", ""]) {
      expect(() => writeVersionPointer(io, POINTER, bad), JSON.stringify(bad)).toThrow(/version/i);
    }
    expect(calls).toEqual([]);
  });
});

describe("DSK-004 — a pointer that cannot be trusted is REFUSED, never guessed", () => {
  it("reports an absent pointer distinctly from a corrupt one", () => {
    // They need different operator responses: absent is a first install, corrupt is a
    // damaged one. Collapsing them into "no version" would make a damaged install look
    // like a fresh machine and silently reinstall over it.
    expect(readVersionPointer(recordingIo().io, POINTER)).toEqual({ ok: false, reason: "absent" });
    expect(readVersionPointer(recordingIo("{ not json").io, POINTER)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("reports a pointer that EXISTS but cannot be opened as unreadable, not absent", () => {
    // The case above never exercises the readFile catch, because malformed JSON is
    // returned successfully. This one does, and it is the one with teeth: a permission
    // error on the pointer reported as "absent" tells an installer the machine has no
    // install, and it would reinstall over a working one it simply could not read.
    for (const code of ["EACCES", "EBUSY", "EIO", undefined]) {
      const io = {
        ...recordingIo().io,
        readFile: () => {
          const error = new Error(code ?? "unknown") as NodeJS.ErrnoException;
          if (code !== undefined) error.code = code;
          throw error;
        },
      };
      expect(readVersionPointer(io, POINTER), String(code)).toEqual({
        ok: false,
        reason: "unreadable",
      });
    }
  });

  it("refuses a pointer naming an unsafe version", () => {
    // The pointer is a file on disk; anything that can write it can put a traversal in
    // it, and the value is used to build a path. Validated on the way OUT as well as in.
    for (const bad of ["../evil", "NUL.1.0", "0.1.0.", "", 7, null]) {
      const stored = JSON.stringify({ schema: POINTER_SCHEMA_VERSION, version: bad });
      expect(readVersionPointer(recordingIo(stored).io, POINTER), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: "unsafe_version",
      });
    }
  });

  it("refuses an unknown schema version instead of interpreting it", () => {
    const stored = JSON.stringify({ schema: POINTER_SCHEMA_VERSION + 1, version: "0.1.1" });
    expect(readVersionPointer(recordingIo(stored).io, POINTER)).toEqual({
      ok: false,
      reason: "unsupported_schema",
    });
  });

  it("refuses a JSON document of the wrong shape", () => {
    for (const stored of ["null", "[]", '"0.1.1"', "7", "{}"]) {
      expect(readVersionPointer(recordingIo(stored).io, POINTER).ok, stored).toBe(false);
    }
  });

  it("never throws, whatever the io does", () => {
    const exploding = {
      readFile: () => {
        throw new Error("EACCES");
      },
      writeFile: vi.fn(),
      rename: vi.fn(),
      removeFile: vi.fn(),
    };
    expect(readVersionPointer(exploding, POINTER).ok).toBe(false);
  });
});
