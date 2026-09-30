import { describe, expect, it } from "vitest";

import { evaluatePatchIntegrity } from "../patch-integrity.js";

// No-key pure-logic regression for the keyed real-E2B artifact-commit case
// (`keyed-real-e2b.test.ts` → "CLI-006/D2 — real E2B — artifact commit / patch
// integrity"). The keyed case produces a REAL patch in a REAL E2B sandbox and feeds
// the four content digests it observes into `evaluatePatchIntegrity`; this suite
// pins the predicate so it cannot silently regress without the key (the
// `real-transport-helpers.test.ts` precedent). It models the PROVIDER-leg property
// only — the server-side fenced apply decision stays in `server/src/services/
// patch-apply.ts` and is NOT re-implemented here.

const H = (n: number): string => n.toString(16).padStart(64, "0");
const BASE = H(1);
const RESULT = H(2);
const FOREIGN = H(3);

describe("evaluatePatchIntegrity", () => {
  it("ok when the edit is real, the result hash reproduces, and a foreign base is detectable", () => {
    const v = evaluatePatchIntegrity({
      declaredBaseHash: BASE,
      declaredResultHash: RESULT,
      reproducedResultHash: RESULT,
      foreignBaseHash: FOREIGN,
    });
    expect(v).toEqual({
      isRealEdit: true,
      reproducesResult: true,
      baseMismatchIsDetectable: true,
      ok: true,
    });
  });

  it("NOT ok when a re-application does not reproduce the declared result hash (D2-06)", () => {
    const v = evaluatePatchIntegrity({
      declaredBaseHash: BASE,
      declaredResultHash: RESULT,
      reproducedResultHash: H(9), // drifted re-application
      foreignBaseHash: FOREIGN,
    });
    expect(v.reproducesResult).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("NOT ok when a mismatched base is INDISTINGUISHABLE from the declared base", () => {
    // If the foreign base hashes equal to the declared base, the server's
    // never-auto-apply-on-mismatch guard would have nothing to discriminate on.
    const v = evaluatePatchIntegrity({
      declaredBaseHash: BASE,
      declaredResultHash: RESULT,
      reproducedResultHash: RESULT,
      foreignBaseHash: BASE,
    });
    expect(v.baseMismatchIsDetectable).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("NOT ok (not a real edit) when result equals base", () => {
    const v = evaluatePatchIntegrity({
      declaredBaseHash: BASE,
      declaredResultHash: BASE,
      reproducedResultHash: BASE,
      foreignBaseHash: FOREIGN,
    });
    expect(v.isRealEdit).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("rejects malformed (non-sha256) digests without throwing", () => {
    const v = evaluatePatchIntegrity({
      declaredBaseHash: "not-a-hash",
      declaredResultHash: RESULT,
      reproducedResultHash: RESULT,
      foreignBaseHash: FOREIGN,
    });
    expect(v.ok).toBe(false);
    // Every sub-check must fail closed on a malformed digest — otherwise a
    // non-sha256 value could satisfy `isRealEdit`/`baseMismatchIsDetectable` by mere
    // string-inequality. Asserting all three kills the `wellFormed &&` guard on each.
    expect(v.reproducesResult).toBe(false);
    expect(v.isRealEdit).toBe(false);
    expect(v.baseMismatchIsDetectable).toBe(false);
  });
});
