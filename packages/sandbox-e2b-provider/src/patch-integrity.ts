// packages/sandbox-e2b-provider/src/patch-integrity.ts
//
// Provider-leg patch-integrity predicate for the keyed real-E2B artifact-commit
// case (D2-02 class "artifact commit"; D2-06 "patches reproduce the declared
// base/result hashes and never auto-apply on base mismatch"). It models ONLY the
// property a provider-layer run can observe: a patch produced inside the sandbox
// reproduces its declared result hash, and a foreign base tree is distinguishable
// from the declared base (the precondition the server relies on to refuse a
// mismatched apply). The SERVER-side fenced apply decision — conflict_quarantine,
// tenant/fence-guarded — lives in `server/src/services/patch-apply.ts` and is NEVER
// re-implemented here. Pure: no `e2b` import, no credential (boundary-checker safe).

export interface PatchIntegrityFacts {
  /** sha256 of the staged base tree, declared by the patch. */
  declaredBaseHash: string;
  /** sha256 of the post-edit tree, declared by the patch. */
  declaredResultHash: string;
  /** sha256 of a re-application of the same edit to the (same, declared) base —
   *  proves the patch's declared result hash is reproducible/deterministic (D2-06),
   *  not that a DIFFERENT base was used. */
  reproducedResultHash: string;
  /** sha256 of a DIFFERENT base tree the patch was not authored against. */
  foreignBaseHash: string;
}

export interface PatchIntegrityVerdict {
  /** The patch is a real edit: the result differs from the base. */
  isRealEdit: boolean;
  /** The declared result hash is reproduced by re-applying the edit (D2-06). */
  reproducesResult: boolean;
  /** A mismatched base is DETECTABLE — its hash differs from the declared base —
   *  the precondition the server's never-auto-apply-on-mismatch guard needs. */
  baseMismatchIsDetectable: boolean;
  /** All three hold. */
  ok: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function evaluatePatchIntegrity(facts: PatchIntegrityFacts): PatchIntegrityVerdict {
  const wellFormed =
    HEX64.test(facts.declaredBaseHash) &&
    HEX64.test(facts.declaredResultHash) &&
    HEX64.test(facts.reproducedResultHash) &&
    HEX64.test(facts.foreignBaseHash);

  const isRealEdit = wellFormed && facts.declaredResultHash !== facts.declaredBaseHash;
  const reproducesResult = wellFormed && facts.reproducedResultHash === facts.declaredResultHash;
  const baseMismatchIsDetectable = wellFormed && facts.foreignBaseHash !== facts.declaredBaseHash;

  return {
    isRealEdit,
    reproducesResult,
    baseMismatchIsDetectable,
    ok: isRealEdit && reproducesResult && baseMismatchIsDetectable,
  };
}
