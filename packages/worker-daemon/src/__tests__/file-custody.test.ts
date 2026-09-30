/**
 * DSK-003 Lane A / I2 — owner-only file custody, extracted once.
 *
 * The check existed TWICE before this — `identity/key-store.ts` and
 * `events/event-outbox-kek.ts` each carried their own `STRICT_FILE_MODE` /
 * `GROUP_OTHER_MASK` pair, the same win32 early return, and the same
 * `statSync(path).mode & 0o777` comparison. Verified behaviourally identical before
 * extracting; they differ only in which error type they throw, which is preserved.
 *
 * DSK-003 needs the same rule for the control token that gates every MUTATING desktop
 * control, and a third copy is a third thing to drift.
 *
 * WHY THE PREDICATE TAKES A MODE NUMBER. Both existing tests are written as
 * `if (process.platform === "win32") return;`, so on Windows they are no-ops and the
 * rule is only ever exercised on Linux CI. Splitting the pure comparison out — and
 * injecting `platform`/`stat` into the file-level wrapper — makes BOTH branches
 * testable on EITHER OS, which is how the win32 branch gets its first real test.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GROUP_OTHER_MASK,
  isOwnerOnlyMode,
  ownerOnlyViolation,
} from "../identity/file-custody.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "aoa-custody-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("DSK-003/I2 — the pure mode predicate", () => {
  it("accepts owner-only modes", () => {
    for (const mode of [0o600, 0o400, 0o700, 0o000]) {
      expect(isOwnerOnlyMode(mode), mode.toString(8)).toBe(true);
    }
  });

  it("rejects every group or other bit, individually", () => {
    // Enumerated rather than sampled: a mask typo that dropped one bit would pass a
    // test that only ever tried 0o644.
    for (const bit of [0o040, 0o020, 0o010, 0o004, 0o002, 0o001]) {
      expect(isOwnerOnlyMode(0o600 | bit), bit.toString(8)).toBe(false);
    }
  });

  it("rejects the common real-world mistakes", () => {
    for (const mode of [0o644, 0o666, 0o777, 0o640, 0o604]) {
      expect(isOwnerOnlyMode(mode), mode.toString(8)).toBe(false);
    }
  });

  it("is unaffected by the file-type bits a statSync mode carries", () => {
    // Corrected after mutation: the first version of this test claimed the `& 0o777`
    // pre-mask was what protected against these bits. It is not — `GROUP_OTHER_MASK`
    // is 0o077 and already selects only the low six bits, so the pre-mask could not
    // change the result for any input, and a mutant deleting it survived. The pre-mask
    // is gone; the property below is the one that is actually true.
    expect(isOwnerOnlyMode(0o100600)).toBe(true);
    expect(isOwnerOnlyMode(0o100644)).toBe(false);
    expect(isOwnerOnlyMode(0o40700)).toBe(true); // directory bits, owner-only perms
  });

  it("masks group/other specifically, not the owner bits", () => {
    // The mutant this replaces G3 with: 0o077 -> 0o770 would invert the whole rule.
    expect(isOwnerOnlyMode(0o700)).toBe(true);
    expect(isOwnerOnlyMode(0o007)).toBe(false);
  });

  it("exports the mask the two prior copies used, unchanged", () => {
    expect(GROUP_OTHER_MASK).toBe(0o077);
  });
});

describe("DSK-003/I2 — the file-level wrapper, both branches on either OS", () => {
  it("reports a violation for a group-readable file on POSIX", () => {
    const file = path.join(dir, "token");
    writeFileSync(file, "x");
    expect(ownerOnlyViolation(file, { platform: "linux", stat: () => ({ mode: 0o644 }) }))
      .toBe("insecure_permissions");
  });

  it("reports no violation for an owner-only file on POSIX", () => {
    const file = path.join(dir, "token");
    writeFileSync(file, "x");
    expect(ownerOnlyViolation(file, { platform: "linux", stat: () => ({ mode: 0o600 }) }))
      .toBeNull();
  });

  it("skips the POSIX bit check on win32, where chmod cannot represent it", () => {
    // This branch had NO test before: on Windows the old tests returned early, and on
    // Linux the branch was unreachable. Injecting the platform makes it reachable here.
    const file = path.join(dir, "token");
    writeFileSync(file, "x");
    expect(ownerOnlyViolation(file, { platform: "win32", stat: () => ({ mode: 0o777 }) }))
      .toBeNull();
  });

  it("fails closed when the file cannot be stat'ed at all", () => {
    // An unreadable or missing token must not read as "no violation found".
    expect(ownerOnlyViolation(path.join(dir, "absent"), { platform: "linux" }))
      .toBe("unreadable");
  });

  it("uses the real fs by default — non-vacuity for the injected cases above", () => {
    const file = path.join(dir, "real");
    writeFileSync(file, "x", { mode: 0o600 });
    // On win32 this is null via the skip; on POSIX via a genuine 0o600. Either way a
    // wrapper that always returned "unreadable" would fail here.
    expect(ownerOnlyViolation(file)).toBeNull();
  });
});

describe("DSK-003/I2 — both prior copies now DELEGATE, provably on any OS", () => {
  // The behavioural tests for each store open with `if (process.platform === "win32")
  // return;`, so on Windows they prove nothing and a mutant that no-ops either check
  // would survive locally for a PLATFORM reason rather than a coverage one. Reading the
  // source is the cross-platform pin: it fails if a call site stops delegating, or if
  // anyone reintroduces an inline copy of the comparison.
  const read = (rel: string) =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", rel), "utf8");

  for (const rel of ["identity/key-store.ts", "events/event-outbox-kek.ts"]) {
    it(`${rel} delegates to ownerOnlyViolation`, () => {
      const src = read(rel);
      expect(src).toContain("ownerOnlyViolation(this.path)");
      // …and keeps its OWN error type, because the classification is the caller's.
      expect(src).toMatch(/throw new \w+Error\(/);
    });

    it(`${rel} keeps no inline copy of the comparison`, () => {
      // The exact duplication this extraction removed. If it comes back, the two can
      // drift again while every test stays green.
      const src = read(rel);
      expect(src).not.toContain("GROUP_OTHER_MASK");
      expect(src).not.toMatch(/statSync\(this\.path\)\.mode/);
    });
  }
});
