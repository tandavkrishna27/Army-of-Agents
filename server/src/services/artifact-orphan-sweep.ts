/**
 * artifact-orphan-sweep.ts — DAT-009 slice 2. The sweep-eligibility DECISION, pure.
 *
 * WHY THIS EXISTS. The artifact-transfer fence is checked ONLY at mint
 * (`artifact-transfer-grant.ts:86`, `lockActiveFence`) and the issued grant carries no
 * fence material (frozen schema, `worker-protocol/src/artifacts.ts:409-428`). So a lease
 * lost mid-flight still lets the presigned PUT succeed — S3 knows nothing about fences —
 * landing bytes in the ORDINARY attempt prefix, after which commit refuses `stale_fence`.
 * The result is an uncommitted object that nothing collects: `deleteObject` has two call
 * sites in the whole repo, both task attachments, and no S3 lifecycle rule exists.
 *
 * ★★ THE TRAP THIS MODULE GUARDS (design §5). A sweeper that deletes an IN-FLIGHT upload
 * is worse than the orphan it removes. There is NO "upload in progress" marker and S3
 * offers no visibility into an incomplete PUT, so the only honest signal is AGE — and
 * specifically the one age that proves nothing can still land: **the grant's own
 * `expiresAt` has passed**, therefore the presigned URL is dead.
 *
 * Eligibility is therefore keyed STRICTLY on `expiresAt`, and never on lease state,
 * attempt supersession, or "the job looks finished". Each of those can be true while an
 * honest PUT is still in flight.
 *
 * Pure by construction: no database, no clock, no storage. The caller supplies `now`.
 */

/** The subset of a `job_artifacts` row this decision needs. */
export interface ArtifactSweepCandidate {
  /** `'committed'` | `'quarantined'` | an intent status such as `'granted'` | null. */
  readonly status: string | null;
  readonly objectKey: string | null;
  /** ISO-8601 grant expiry recorded at mint. Null on rows predating the intent record. */
  readonly expiresAt: string | null;
  /**
   * ★ Whether a COMMITTED row exists for this row's natural key
   * (organization_id, job_id, attempt, identifier).
   *
   * Load-bearing, and the reason this field exists at all: the granted and committed
   * partial-unique keys are DISJOINT, so a successful commit inserts a SECOND row rather
   * than transitioning the first. The `granted` intent therefore SURVIVES commit, and
   * both rows point at the SAME `objectKey`. Without this check the sweeper would wait
   * for the intent to expire and then delete the object out from under a COMMITTED,
   * immutable artifact that readers still trust — destroying data instead of collecting
   * litter.
   */
  readonly hasCommittedSibling: boolean;
}

export type SweepRefusal =
  | "grant_still_redeemable"
  | "committed"
  | "committed_sibling_exists"
  | "quarantined"
  | "no_expiry_recorded"
  | "no_object_key";

export type SweepDecision = { eligible: true } | { eligible: false; reason: SweepRefusal };

/**
 * ★ Whether a refusal needs a human rather than simply waiting.
 *
 * This classifier exists because I have shipped a DISCARDED refusal reason twice in this
 * programme — a decision function that computed exactly why it said no, and a caller that
 * threw the answer away. Forcing every reason through here means a new one cannot be added
 * without deciding what the caller should DO about it.
 *
 * `grant_still_redeemable` and `committed` are ordinary, expected outcomes of scanning:
 * the first becomes eligible on its own, the second never should be swept. The other three
 * describe rows that can NEVER become eligible, so they accumulate silently unless someone
 * is told.
 */
export function sweepRefusalIsActionable(reason: SweepRefusal): boolean {
  // `committed_sibling_exists` is an ordinary, expected outcome — the happy path leaves
  // exactly this shape — so it is not actionable. The two below describe rows that can
  // NEVER become eligible and would otherwise accumulate in silence.
  return reason === "no_expiry_recorded" || reason === "no_object_key";
}

export function isSweepEligible(candidate: ArtifactSweepCandidate, now: Date): SweepDecision {
  // Terminal states first: neither is an orphan, and DAT-006 owns quarantine.
  if (candidate.status === "committed") return { eligible: false, reason: "committed" };
  if (candidate.status === "quarantined") return { eligible: false, reason: "quarantined" };
  // ★ The intent SURVIVES its own commit (disjoint partial-unique keys), and both rows
  // name the same object. Sweeping here would delete a committed artifact's bytes.
  if (candidate.hasCommittedSibling) return { eligible: false, reason: "committed_sibling_exists" };

  if (!candidate.objectKey) return { eligible: false, reason: "no_object_key" };

  const expiresAt = candidate.expiresAt ? Date.parse(candidate.expiresAt) : Number.NaN;
  // An absent OR unparseable expiry is the same refusal, stated rather than inferred:
  // `now > NaN` is false, so a naive comparison would refuse by accident. Refusing for a
  // named reason keeps the behaviour when this is next rewritten.
  if (!Number.isFinite(expiresAt)) return { eligible: false, reason: "no_expiry_recorded" };

  // ★ STRICTLY after. At `expiresAt === now` the store may still honour the URL, so
  // equality is NOT eligible. Do not relax this to `>=`.
  if (!(now.getTime() > expiresAt)) return { eligible: false, reason: "grant_still_redeemable" };

  return { eligible: true };
}
