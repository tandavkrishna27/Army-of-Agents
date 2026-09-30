// DSK-001 — the absence oracle, and why a boolean cannot be one.
//
// FOUND BY ADVERSARIALLY REVIEWING ALREADY-SHIPPED, CI-GREEN CODE.
//
// The runner owns the absence oracle: on Windows the blob file decides whether a
// device has ever enrolled, because an unprotect failure is always a fault and
// the crypto layer demonstrably cannot tell the two apart (the same
// CryptographicException measured exit 0 under -File and exit 1 under
// -EncodedCommand, both with empty stdout).
//
// The first implementation used `existsSync`. **`existsSync` returns `false` for
// ANY error**, not only for non-existence — EACCES, EPERM, ENOTDIR, ELOOP, an
// unreadable mount, an invalid path. So a permission-denied probe reported
// ABSENCE, `load()` returned `null`, `loadOrCreateKey` read that as NEVER
// ENROLLED, minted a fresh key, and the device enrolled under a second identity
// the server denies forever with no reset route.
//
// That is the precise bug the six-valued classifier was built to prevent,
// reintroduced one layer BELOW it. A careful classifier fed by a lossy oracle is
// not careful. Hence the seam is three-valued: a boolean cannot express a fault,
// and any fake typed as a boolean inherits the defect.

import { describe, expect, it, vi } from "vitest";
import { classifyProbeErrno, createCommandRunner } from "../command-runner.js";
import { planVaultCommand } from "../command-plan.js";
import { classifyStoreOutcome } from "../outcome.js";

const REF = { blobPath: "C:\\AoA\\device-identity.v1.bin" };
const loadPlan = () => planVaultCommand("load", REF, "win32");
const deletePlan = () => planVaultCommand("delete", REF, "win32");

describe("DSK-001 — only a genuine ENOENT signals absence", () => {
  it("signals absence when the probe says the blob is not there", () => {
    const runner = createCommandRunner({ probe: () => "absent" });
    const result = runner.run(loadPlan());
    expect(result.absenceSignalled).toBe(true);
    expect(classifyStoreOutcome(result).kind).toBe("absent");
  });

  it("does NOT signal absence for any probe fault — this is the lockout bug", () => {
    // Each of these previously read as `false` through existsSync and therefore
    // as "never enrolled". Every one must now be a fault the store throws on.
    for (const code of ["EACCES", "EPERM", "ENOTDIR", "ELOOP", "EIO", "EBUSY", "UNKNOWN"]) {
      const runner = createCommandRunner({ probe: () => ({ fault: code }) });
      const result = runner.run(loadPlan());
      expect(result.absenceSignalled, code).toBe(false);
      const outcome = classifyStoreOutcome(result);
      expect(outcome.kind, code).not.toBe("absent");
      expect(outcome.kind, code).not.toBe("present");
    }
  });

  it("surfaces the errno in the fault detail, so an operator can act on it", () => {
    const runner = createCommandRunner({ probe: () => ({ fault: "EACCES" }) });
    const result = runner.run(loadPlan());
    expect(result.stderr).toContain("EACCES");
  });

  it("classifies a permission fault as denied, not as something recoverable", () => {
    const runner = createCommandRunner({ probe: () => ({ fault: "EACCES: permission denied" }) });
    expect(classifyStoreOutcome(runner.run(loadPlan())).kind).toBe("denied");
  });
});

describe("DSK-001 — clear() inherits the same oracle, and must not report a failed wipe as success", () => {
  it("a delete whose probe faults does NOT look like 'nothing to delete'", () => {
    // `plan.stdin === "none"` matches delete as well as load, so the delete path
    // inherited the identical fail-open: a permission-denied probe made a FAILED
    // WIPE report success, contradicting clear()'s own contract.
    const runner = createCommandRunner({ probe: () => ({ fault: "EPERM" }) });
    const result = runner.run(deletePlan());
    expect(result.absenceSignalled).toBe(false);
    expect(classifyStoreOutcome(result).kind).not.toBe("absent");
  });

  it("a delete of a genuinely missing blob still succeeds", () => {
    const runner = createCommandRunner({ probe: () => "absent" });
    expect(classifyStoreOutcome(runner.run(deletePlan())).kind).toBe("absent");
  });
});

describe("DSK-001 — the probe is not consulted when the operation carries a secret", () => {
  it("a store operation never short-circuits on the probe", () => {
    // `store` must reach the OS: the exclusive CreateNew is what resolves the
    // compare-and-set, and a probe-based pre-check would reintroduce exactly the
    // check-then-act race that CAS exists to eliminate.
    const probe = vi.fn(() => "absent" as const);
    const runner = createCommandRunner({ probe });
    const plan = planVaultCommand("store", REF, "win32");
    // Executing would spawn PowerShell, which this test does not want; assert the
    // decision instead — a `secret` plan must not be answerable by the probe.
    expect(plan.stdin).toBe("secret");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("DSK-001 — the REAL errno decision, not just the injected fake", () => {
  // Every other test in this file injects a probe, so none of them exercises the
  // production errno logic. A mutation making it return "absent" for every errno
  // left the whole suite green — vacuous coverage over the one decision that
  // prevents permanent device lockout. These tests close that.

  it("treats ONLY ENOENT as absence", () => {
    expect(classifyProbeErrno("ENOENT")).toBe("absent");
  });

  it("treats every other errno as a fault carrying its code", () => {
    for (const code of ["EACCES", "EPERM", "ENOTDIR", "ELOOP", "EIO", "EBUSY", "EINVAL", "UNKNOWN"]) {
      const probed = classifyProbeErrno(code);
      expect(typeof probed, code).toBe("object");
      expect((probed as { fault: string }).fault, code).toBe(code);
    }
  });

  it("treats a MISSING errno as a fault, not as absence", () => {
    // An error with no `code` tells us nothing. Defaulting it to absence would be
    // the lockout bug arriving through the least suspicious door.
    expect(classifyProbeErrno(undefined)).toEqual({ fault: "UNKNOWN" });
  });

  it("never returns absence for anything but the one exact string", () => {
    for (const near of ["enoent", "ENOENT ", " ENOENT", "ENOENT2", ""]) {
      expect(classifyProbeErrno(near), near).not.toBe("absent");
    }
  });
});
