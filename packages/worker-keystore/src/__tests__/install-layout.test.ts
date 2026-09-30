/**
 * DSK-004 Lane C — the side-by-side layout, the pointer, and the swap.
 *
 * The design's D1 says replacement is a POINTER SWAP over versions that live side by
 * side, and that this is what makes clause (5) — "power loss recovers to one valid
 * version" — an invariant rather than recovery logic. This suite holds that claim to
 * account:
 *
 *   I5  the pointer is only ever one of the versions that exist
 *   I6  health failure leaves the pointer untouched
 *   I7  rollback POINTS BACK; it never reconstructs
 *   I8  the vault is never inside the install root
 *
 * Plus one surface the design did not name. A version string arrives from an update
 * manifest and is used as a DIRECTORY NAME. `..` in that string is a path traversal
 * into whatever sits beside the install root, and the swap runs with the installer's
 * privileges. Validated here as its own boundary rather than trusted because the
 * manifest was signed — a signature proves origin, not that a field is safe to
 * concatenate into a path.
 */

import { describe, expect, it } from "vitest";

import {
  assertVaultOutsideInstallRoot,
  isPathInside,
  isSafeVersionSegment,
  normalizePathForComparison,
  planRollback,
  planUpdateSwap,
  resolveInstallLayout,
} from "../install-layout.js";

const ROOT = "C:\\Program Files\\AoA\\worker";

describe("DSK-004/I5 — layout", () => {
  it("puts every version under its own directory beneath the root", () => {
    const layout = resolveInstallLayout(ROOT);
    expect(layout.versionsDir).toBe(`${ROOT}\\versions`);
    expect(layout.pointerPath).toBe(`${ROOT}\\current.v1.json`);
    expect(layout.versionDir("0.1.1")).toBe(`${ROOT}\\versions\\0.1.1`);
  });

  it("refuses a version that would escape the versions directory", () => {
    // A signature authenticates the publisher; it does not make every field safe to
    // paste into a path.
    const traversals = ["..", "../0.1.0", "..\\..\\Startup", "a/b", "a\\b", "C:\\evil", "", ".", "a\u0000b"];
    for (const bad of traversals) {
      expect(isSafeVersionSegment(bad), JSON.stringify(bad)).toBe(false);
      expect(() => resolveInstallLayout(ROOT).versionDir(bad), JSON.stringify(bad)).toThrow(/version/i);
    }
  });

  it("accepts ordinary release and prerelease versions", () => {
    for (const good of ["0.1.0", "1.2.3-rc.1", "1.2.3+build.5", "2026_08_22"]) {
      expect(isSafeVersionSegment(good), good).toBe(true);
    }
  });

  it("refuses Windows reserved device names, including with a suffix", () => {
    // MEASURED, because my first guess was wrong. Node's fs uses the \\?\ prefix, so it
    // creates a directory literally named "NUL.1.0" and reads back from it happily. The
    // hazard is not Node — it is the BOUNDARY. DSK-003 writes the install path into an
    // autostart manifest that Task Scheduler consumes, and Win32 path normalization does
    // apply there: it matches a reserved device on the name up to the first dot, so
    // `versions\NUL.1.0\worker.exe` resolves to the null device for the launcher while
    // Node sees a perfectly ordinary directory. Refusing the name costs nothing and
    // removes the whole class of divergence.
    for (const bad of ["NUL", "nul", "CON", "com1", "LPT9", "NUL.1.0", "aux.2"]) {
      expect(isSafeVersionSegment(bad), bad).toBe(false);
    }
    // Not reserved merely for containing the letters.
    for (const good of ["nullify", "console-1", "auxiliary", "com10"]) {
      expect(isSafeVersionSegment(good), good).toBe(true);
    }
  });

  it("refuses a trailing dot, which Win32 silently strips", () => {
    // Same boundary, same divergence: Node creates "0.1.0." literally, Win32 consumers
    // resolve it to "0.1.0". The pointer would record one string while the launcher
    // opened another, and a rollback comparing the two would report the previous version
    // absent when it is sitting right there.
    expect(isSafeVersionSegment("0.1.0.")).toBe(false);
    expect(isSafeVersionSegment("0.1.0")).toBe(true);
  });

  it("refuses an absurdly long version segment", () => {
    // Windows MAX_PATH is 260 and this package is win32-only, so an unbounded segment
    // is a way to make the install path unusable rather than merely ugly. 64 is the
    // cap; the boundary is asserted on both sides so the check cannot be off by one.
    expect(isSafeVersionSegment("9".repeat(64))).toBe(true);
    expect(isSafeVersionSegment("9".repeat(65))).toBe(false);
  });
});

describe("DSK-004/I8 — the vault is never inside the install root", () => {
  it("normalizes separators, case and traversal before comparing", () => {
    expect(normalizePathForComparison("C:\\Program Files\\AoA\\..\\AoA\\worker\\")).toBe(
      normalizePathForComparison("c:/program files/aoa/worker"),
    );
  });

  it("does not mistake a SIBLING with a shared prefix for a child", () => {
    // The classic startsWith defect: `C:\AoA2` is not inside `C:\AoA`, and reporting
    // that it is would make the assertion below fire on a perfectly legal layout.
    expect(isPathInside("C:\\AoA", "C:\\AoA2\\vault")).toBe(false);
    expect(isPathInside("C:\\AoA", "C:\\AoA\\vault")).toBe(true);
    expect(isPathInside("C:\\AoA", "C:\\AoA")).toBe(true);
  });

  it("throws when the vault sits under the install root", () => {
    // Stated as an assertion because the design's clause (3) — identity and outbox
    // survive an update — is satisfied BY LAYOUT. If someone "tidies up" by moving the
    // vault under the install root, a version swap starts deleting the device identity
    // and nothing would notice until a device could not reconnect.
    expect(() => assertVaultOutsideInstallRoot(ROOT, `${ROOT}\\vault\\identity.blob`)).toThrow(
      /install root/i,
    );
  });

  it("passes for the real DSK-003 layout, where the vault is under LOCALAPPDATA", () => {
    expect(() =>
      assertVaultOutsideInstallRoot(ROOT, "C:\\Users\\t\\AppData\\Local\\AoA\\worker\\identity.blob"),
    ).not.toThrow();
  });

  it("THROWS on a malformed root or vault rather than reporting them unrelated", () => {
    // The failure mode this closes is the one this programme keeps producing: a guard
    // that passes because it could not evaluate anything. `isPathInside` answers false
    // for an empty path, which is the right answer to "is A inside B" and the WRONG
    // basis for "I have verified the vault is safe". An installer that computed an empty
    // root would be told the layout was checked when nothing was compared.
    for (const bad of [undefined, null, "", "   ", 0]) {
      expect(() => assertVaultOutsideInstallRoot(bad as never, "C:\\v\\id.blob"), String(bad)).toThrow(
        /install root/i,
      );
      expect(() => assertVaultOutsideInstallRoot(ROOT, bad as never), String(bad)).toThrow(/vault/i);
    }
  });
});

const OK = {
  currentVersion: "0.1.0",
  candidateVersion: "0.1.1",
  admitted: true,
  compatible: true,
  healthConfirmed: true,
} as const;

describe("DSK-004/I5+I6 — the swap", () => {
  it("moves the pointer only when admission, compatibility AND health all hold", () => {
    expect(planUpdateSwap(OK)).toEqual({ action: "swap", pointerTarget: "0.1.1" });
  });

  it("I6: a failed health check leaves the pointer on the CURRENT version", () => {
    // Clause (4) "failed health confirmation rolls back" is a no-op here rather than a
    // compensating action, which is the whole point of gating the swap on health
    // instead of gating the unpack.
    expect(planUpdateSwap({ ...OK, healthConfirmed: false })).toEqual({
      action: "refuse",
      pointerTarget: "0.1.0",
      reason: "health_unconfirmed",
    });
  });

  it("refuses on failed admission or compatibility, naming which", () => {
    expect(planUpdateSwap({ ...OK, admitted: false }).reason).toBe("not_admitted");
    expect(planUpdateSwap({ ...OK, compatible: false }).reason).toBe("incompatible");
  });

  it("checks admission BEFORE compatibility and health", () => {
    // An unsigned build must be reported as unsigned. Running the cheap checks first
    // would report an attacker-supplied build as merely "incompatible" and send an
    // operator looking at protocol ranges.
    expect(
      planUpdateSwap({ ...OK, admitted: false, compatible: false, healthConfirmed: false }).reason,
    ).toBe("not_admitted");
    expect(planUpdateSwap({ ...OK, compatible: false, healthConfirmed: false }).reason).toBe(
      "incompatible",
    );
  });

  it("treats ONLY the boolean true as a passed gate", () => {
    // `!flag` would accept every truthy value, and the truthy values include the STRING
    // "false" — a caller that serialized a verdict through JSON, a query parameter or a
    // shell argument would swap onto a build whose health check had failed. Each gate is
    // an explicit `=== true` for that reason, so the strictness is pinned here.
    for (const truthy of ["false", "no", 1, {}, []] as unknown as boolean[]) {
      const label = JSON.stringify(truthy) ?? String(truthy);
      expect(planUpdateSwap({ ...OK, healthConfirmed: truthy }).reason, label).toBe(
        "health_unconfirmed",
      );
      expect(planUpdateSwap({ ...OK, admitted: truthy }).reason, label).toBe("not_admitted");
      expect(planUpdateSwap({ ...OK, compatible: truthy }).reason, label).toBe("incompatible");
    }
  });

  it("I5: the target is ALWAYS one of the two versions, never absent or invented", () => {
    for (const input of [
      OK,
      { ...OK, healthConfirmed: false },
      { ...OK, admitted: false },
      { ...OK, compatible: false },
    ]) {
      const plan = planUpdateSwap(input);
      expect([input.currentVersion, input.candidateVersion]).toContain(plan.pointerTarget);
    }
  });

  it("refuses a no-op swap onto the version already running", () => {
    expect(planUpdateSwap({ ...OK, candidateVersion: "0.1.0" }).reason).toBe("already_current");
  });

  it("refuses an unsafe version segment even when everything else holds", () => {
    expect(planUpdateSwap({ ...OK, candidateVersion: "../evil" }).reason).toBe("unsafe_version");
    expect(planUpdateSwap({ ...OK, currentVersion: "../evil" }).reason).toBe("unsafe_version");
  });
});

describe("DSK-004/I7 — rollback points back, it does not reconstruct", () => {
  it("points at the previous version when it is still on disk", () => {
    expect(
      planRollback({
        currentVersion: "0.1.1",
        previousVersion: "0.1.0",
        installedVersions: ["0.1.0", "0.1.1"],
      }),
    ).toEqual({ action: "swap", pointerTarget: "0.1.0" });
  });

  it("REFUSES when the previous version is gone, rather than trying to rebuild it", () => {
    // The property that makes rollback trustworthy is that it has nothing to do but
    // move a pointer. A rollback that reconstructs is a rollback that can fail, at the
    // exact moment the operator most needs it not to.
    expect(
      planRollback({
        currentVersion: "0.1.1",
        previousVersion: "0.1.0",
        installedVersions: ["0.1.1"],
      }),
    ).toEqual({ action: "refuse", pointerTarget: "0.1.1", reason: "previous_version_absent" });
  });

  it("refuses when there is no previous version at all", () => {
    expect(
      planRollback({ currentVersion: "0.1.0", previousVersion: null, installedVersions: ["0.1.0"] })
        .reason,
    ).toBe("no_previous_version");
  });

  it("refuses an unsafe previous-version segment", () => {
    expect(
      planRollback({
        currentVersion: "0.1.1",
        previousVersion: "../x",
        installedVersions: ["../x", "0.1.1"],
      }).reason,
    ).toBe("unsafe_version");
  });
});

describe("DSK-004 — caller-supplied garbage is refused, never guessed", () => {
  it("never throws from either planner", () => {
    for (const bad of [undefined, null, 0, "", [], { currentVersion: 7 }]) {
      expect(planUpdateSwap(bad as never).action, JSON.stringify(bad) ?? "undefined").toBe("refuse");
      expect(planRollback(bad as never).action, JSON.stringify(bad) ?? "undefined").toBe("refuse");
    }
  });

  it("refuses a non-absolute install root rather than resolving it against a cwd", () => {
    for (const bad of ["worker", "\\\\share\\aoa", "", "/etc/aoa"]) {
      expect(() => resolveInstallLayout(bad), JSON.stringify(bad)).toThrow(/install root/i);
    }
  });
});
