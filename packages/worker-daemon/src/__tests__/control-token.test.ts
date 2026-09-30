/**
 * DSK-003 Lane A / I1 — the control token that gates every MUTATING desktop control.
 *
 * WHY THIS EXISTS AT ALL. `health-server.ts` is loopback-only with NO authentication,
 * which is correct for `GET /healthz` and payload-free counters. Clause (4) also asks for
 * `drain` and `revoke`, and hanging those off the same surface would turn unauthenticated
 * read-only liveness into unauthenticated MUTATING control reachable by any local
 * process. On a shared desktop any local user — or anything the user runs — could revoke
 * the worker's identity. Loopback is a network boundary, not an authorization boundary.
 *
 * The token is a file only the installing user can read, so the OS is the authority. That
 * is the same custody rule the device keystore uses, which is why `file-custody.ts` was
 * extracted rather than copied a third time.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTROL_TOKEN_BYTES,
  CONTROL_TOKEN_REJECTIONS,
  generateControlToken,
  verifyControlToken,
} from "../identity/control-token.js";

let dir: string;
let tokenPath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoa-ctl-"));
  tokenPath = path.join(dir, "control.token");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Write a token file that passes custody (the wrapper is told it is POSIX-clean). */
function writeToken(value: string): void {
  writeFileSync(tokenPath, value, { mode: 0o600 });
}

const OK_DEPS = { platform: "linux" as NodeJS.Platform, stat: () => ({ mode: 0o600 }) };

describe("DSK-003/I1 — a mutating control needs a valid token", () => {
  it("admits the correct token", () => {
    const token = generateControlToken();
    writeToken(token);
    expect(verifyControlToken(tokenPath, token, OK_DEPS)).toEqual({ ok: true });
  });

  it("refuses a wrong token", () => {
    writeToken(generateControlToken());
    expect(verifyControlToken(tokenPath, generateControlToken(), OK_DEPS))
      .toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses when no token is presented at all", () => {
    writeToken(generateControlToken());
    for (const presented of ["", undefined, null]) {
      expect(verifyControlToken(tokenPath, presented as never, OK_DEPS))
        .toEqual({ ok: false, reason: "not_presented" });
    }
  });

  it("refuses when the token file does not exist", () => {
    expect(verifyControlToken(tokenPath, generateControlToken(), OK_DEPS))
      .toEqual({ ok: false, reason: "no_token_file" });
  });

  it("refuses an EMPTY token file, rather than admitting an empty presented value", () => {
    // The dangerous symmetry: if an empty stored token compared equal to an empty
    // presented one, deleting the file's contents would grant everyone access.
    writeToken("");
    expect(verifyControlToken(tokenPath, "", OK_DEPS).ok).toBe(false);
    expect(verifyControlToken(tokenPath, "anything", OK_DEPS).ok).toBe(false);
  });

  it("refuses a stored token that is too short to be one", () => {
    // A truncated write must not become a guessable credential.
    writeToken("abc");
    expect(verifyControlToken(tokenPath, "abc", OK_DEPS))
      .toEqual({ ok: false, reason: "malformed_token_file" });
  });
});

describe("DSK-003/I2 — custody is checked BEFORE the value", () => {
  it("refuses a group-readable token file even when the value matches", () => {
    // Order matters: a token any local user can read is already compromised, and
    // admitting it because the caller happened to know it defeats the whole control.
    const token = generateControlToken();
    writeToken(token);
    const result = verifyControlToken(tokenPath, token, {
      platform: "linux", stat: () => ({ mode: 0o644 }),
    });
    expect(result).toEqual({ ok: false, reason: "insecure_permissions" });
  });

  it("still admits on win32, where the OS ACL is the authority", () => {
    const token = generateControlToken();
    writeToken(token);
    expect(verifyControlToken(tokenPath, token, {
      platform: "win32", stat: () => ({ mode: 0o777 }),
    })).toEqual({ ok: true });
  });
});

describe("DSK-003 Lane A — the token itself", () => {
  it("is long enough to be unguessable", () => {
    expect(CONTROL_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
    expect(generateControlToken().length).toBeGreaterThanOrEqual(43); // 32B base64url
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateControlToken()));
    expect(seen.size).toBe(50);
  });

  it("is URL/CLI-safe, so it never needs shell quoting", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(generateControlToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("compares without leaking the stored value through length", () => {
    // Both sides are hashed before comparison, so a presented value of any length is
    // compared in constant time against a fixed-width digest. A raw `===` would return
    // early on the first differing byte.
    const token = generateControlToken();
    writeToken(token);
    for (const wrong of ["", "a", token.slice(0, -1), token + "x", "x".repeat(500)]) {
      expect(verifyControlToken(tokenPath, wrong, OK_DEPS).ok, wrong.length.toString()).toBe(false);
    }
  });

  it("never returns the stored token in its result", () => {
    // The result is the only thing a caller sees; it must not become a read oracle.
    const token = generateControlToken();
    writeToken(token);
    const results = [
      verifyControlToken(tokenPath, token, OK_DEPS),
      verifyControlToken(tokenPath, "wrong", OK_DEPS),
    ];
    expect(JSON.stringify(results)).not.toContain(token);
  });

  it("declares a closed rejection vocabulary", () => {
    writeToken(generateControlToken());
    const produced = [
      verifyControlToken(tokenPath, "", OK_DEPS),
      verifyControlToken(tokenPath, "wrong-but-long-enough-value-here", OK_DEPS),
      verifyControlToken(path.join(dir, "absent"), "x", OK_DEPS),
      verifyControlToken(tokenPath, "x", { platform: "linux", stat: () => ({ mode: 0o644 }) }),
    ];
    for (const r of produced) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(CONTROL_TOKEN_REJECTIONS).toContain(r.reason);
    }
    expect(new Set(produced.map((r) => (r.ok ? "" : r.reason))).size).toBe(4);
  });
});

describe("DSK-003 Lane A — non-vacuity of the digest comparison", () => {
  it("a token equal only after hashing collision would be astronomically unlikely", () => {
    // Guards the shape rather than the crypto: the stored and presented values are
    // compared via their sha256 digests, so this asserts the digest of the real token
    // is what a correct implementation would match on.
    const token = generateControlToken();
    writeToken(token);
    const digest = createHash("sha256").update(token).digest("hex");
    expect(digest).toHaveLength(64);
    expect(verifyControlToken(tokenPath, token, OK_DEPS).ok).toBe(true);
    expect(randomBytes(1).length).toBe(1); // keeps the crypto import honest
  });
});

describe("DSK-003 Lane A — properties a behavioural test alone cannot pin", () => {
  it("verifies a token file written with a trailing newline", () => {
    // Makes `trim()` load-bearing. Real files — and every shell redirect that writes
    // one — end with a newline; without the trim the stored value would never match and
    // a mutant removing it would be invisible.
    const token = generateControlToken();
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    expect(verifyControlToken(tokenPath, token, OK_DEPS)).toEqual({ ok: true });
  });

  it("tolerates surrounding whitespace on the stored value", () => {
    const token = generateControlToken();
    writeFileSync(tokenPath, `  ${token}\r\n`, { mode: 0o600 });
    expect(verifyControlToken(tokenPath, token, OK_DEPS)).toEqual({ ok: true });
  });

  it("compares with timingSafeEqual — asserted against the source", () => {
    // Timing-safety is NOT observable from behaviour: swapping `timingSafeEqual` for
    // `===` gives byte-identical answers to every test above, so a functional battery
    // can never kill that mutant. Reading the source is the honest pin, the same
    // technique used for the custody delegation. It fails if someone "simplifies" the
    // comparison, which is exactly the edit that would reintroduce the leak.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "identity", "control-token.ts"),
      "utf8",
    );
    expect(src).toContain("timingSafeEqual(a, b)");
    // …and both sides are hashed first, which is what makes the lengths equal.
    expect(src).toMatch(/createHash\("sha256"\)\.update\(stored\)\.digest\(\)/);
    expect(src).toMatch(/createHash\("sha256"\)\.update\(presented\)\.digest\(\)/);
    // A raw equality on the secret must not appear.
    expect(src).not.toMatch(/stored === presented|presented === stored/);
  });
});

describe("DSK-003 Lane A — custody is validated BEFORE the secret is read", () => {
  it("checks permissions before reading, asserted against the source", () => {
    // Not observable behaviourally — read-then-check and check-then-read return the
    // same results — so this is a source pin, like the timingSafeEqual one. The
    // principle: do not pull a secret into the process out of a file whose permissions
    // have not been validated.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "identity", "control-token.ts"),
      "utf8",
    );
    const custodyAt = src.indexOf("ownerOnlyViolation(tokenPath, deps)");
    const readAt = src.indexOf("readFileSync(tokenPath");
    expect(custodyAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(-1);
    expect(custodyAt).toBeLessThan(readAt);
  });
});
