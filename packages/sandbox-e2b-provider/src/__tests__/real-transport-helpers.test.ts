import { describe, expect, it } from "vitest";

import { isE2bNotFound, shSingleQuote, shellJoin } from "../real-transport-helpers.js";

// -----------------------------------------------------------------------------
// No-key regression coverage for the two RealE2bTransport decisions the FIRST
// keyed real-E2B run exposed (8/18 failures): argv-serialization and not-found
// classification. `real-transport.ts` imports the `e2b` SDK (keyed-only), so these
// pure helpers are the ONLY no-key-reachable proof of the contract. The mock
// transport is directive-driven and never execs a shell, so it could not have
// caught either bug — these tests can.
// -----------------------------------------------------------------------------

function e2bErr(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe("shSingleQuote — POSIX single-quote escaping", () => {
  it("wraps a plain token", () => {
    expect(shSingleQuote("abc")).toBe("'abc'");
  });

  it("escapes an embedded single quote as '\\''", () => {
    // a'b  ->  'a'\''b'
    expect(shSingleQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe("shellJoin — argv preserved across the collapse into e2b's command STRING", () => {
  it("keeps a space-containing arg as ONE quoted token (the bug: naive join splits it)", () => {
    const joined = shellJoin("sh", ["-c", "x y"]);
    expect(joined).toBe("'sh' '-c' 'x y'");
    // The space-containing arg survives as a single quoted token...
    expect(joined).toContain("'x y'");
    // ...unlike the naive space-join that silently broke `sh -c "<script>"`.
    expect(joined).not.toBe(["sh", "-c", "x y"].join(" "));
  });

  it("preserves an embedded-quote script (the real CLI-002 `printf 'x' > f` case)", () => {
    // Exactly the shape that failed against real E2B: the inner sh must receive the
    // WHOLE `printf '...' > f` as its -c argument, not just `printf`.
    expect(shellJoin("sh", ["-c", "printf 'MUTATED' > f"])).toBe("'sh' '-c' 'printf '\\''MUTATED'\\'' > f'");
  });
});

describe("isE2bNotFound — an absent/foreign target is not-found (no existence oracle)", () => {
  it("matches the named not-found / bad-target classes", () => {
    expect(isE2bNotFound(e2bErr("NotFoundError", "sandbox x not found"))).toBe(true);
    expect(isE2bNotFound(e2bErr("SandboxNotFoundError", "sandbox was not found."))).toBe(true);
    expect(isE2bNotFound(e2bErr("FileNotFoundError", "Path p not found"))).toBe(true);
    expect(isE2bNotFound(e2bErr("InvalidArgumentError", "bad id"))).toBe(true);
  });

  it("matches a base `SandboxError` carrying a 4xx status (the real absent-sandbox shape)", () => {
    expect(isE2bNotFound(e2bErr("SandboxError", "403: Forbidden"))).toBe(true);
    expect(isE2bNotFound(e2bErr("SandboxError", "409: Conflict"))).toBe(true);
    expect(isE2bNotFound(e2bErr("SandboxError", "410: Gone"))).toBe(true);
  });

  it("does NOT match transient (5xx) or command-result / rate-limit errors", () => {
    expect(isE2bNotFound(e2bErr("SandboxError", "500: Internal Server Error"))).toBe(false);
    expect(isE2bNotFound(e2bErr("SandboxError", "503: Service Unavailable"))).toBe(false);
    // A 127 command exit must NOT read as a sandbox-not-found — its message is the
    // exit status; the "command not found" text lives in stderr, never in `.message`.
    expect(isE2bNotFound(e2bErr("CommandExitError", "exit status 127"))).toBe(false);
    expect(isE2bNotFound(e2bErr("TimeoutError", "timed out"))).toBe(false);
    expect(isE2bNotFound(e2bErr("RateLimitError", "429: rate limited"))).toBe(false);
    expect(isE2bNotFound(undefined)).toBe(false);
    expect(isE2bNotFound(new Error("plain"))).toBe(false);
  });
});
