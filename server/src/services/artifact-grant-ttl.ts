/**
 * artifact-grant-ttl.ts — DAT-009 slice 2 §4.1. The artifact-transfer grant TTL band, pure.
 *
 * ★ WHY A CEILING AT ALL. The TTL is the ONLY revocation mechanism this system has. The
 * issued grant carries no fence material (frozen schema,
 * `worker-protocol/src/artifacts.ts:409-428`, `.strict()`), nothing re-checks the fence
 * between mint and commit, and there is no grant-revocation concept anywhere in the repo —
 * a presigned URL cannot be recalled without rotating the signing credential. So the TTL
 * is exactly the length of the window in which a dead fence's PUT still lands.
 *
 * Measured before this module existed: `Math.max(30, input.grantTtlSeconds ?? 300)` — a
 * floor, a default, and NO upper clamp. No caller passed the parameter, so the effective
 * TTL was always 300s and the knob was dead configuration. The frozen schema would have
 * accepted a SEVEN-DAY ordinary upload grant: `addOrdinaryGrantIssues` asserts only
 * `expiresAt > issuedAt`.
 *
 * ★ THE CEILING IS NOT A NEW NUMBER. The quarantine grant is already capped at five
 * minutes in two places (`artifacts.ts:541,567` and `quarantine-grant.ts:37`), and 300s is
 * what the ordinary path already produced in every deployment. This makes the existing
 * behaviour the ENFORCED maximum rather than an accident — it changes nothing observable
 * today and removes the ability to configure a longer window tomorrow.
 *
 * Mirroring the cap into the FROZEN schema is the stronger fix and is an E4-D02 STOP;
 * it is recorded as a follow-up rather than taken here.
 */

/** Floor, unchanged from the pre-existing `Math.max(30, …)`. */
export const MIN_GRANT_TTL_SECONDS = 30;

/** Ceiling, matching the quarantine grant's frozen five-minute cap. */
export const MAX_GRANT_TTL_SECONDS = 300;

/**
 * Clamp a requested grant TTL into `[MIN, MAX]`.
 *
 * A non-finite request falls back to the default rather than propagating: `issuedAt +
 * NaN * 1000` yields an Invalid Date, and the frozen schema's only temporal assertion
 * (`expiresAt > issuedAt`) is false for NaN — so an unguarded NaN would surface as an
 * opaque parse failure far from its cause.
 */
export function resolveGrantTtlSeconds(requested: number | undefined): number {
  if (requested === undefined || Number.isNaN(requested)) return MAX_GRANT_TTL_SECONDS;
  return Math.min(MAX_GRANT_TTL_SECONDS, Math.max(MIN_GRANT_TTL_SECONDS, requested));
}
