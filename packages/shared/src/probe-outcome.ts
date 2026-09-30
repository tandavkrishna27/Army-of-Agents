/**
 * The canonical, ordered list of outcomes from classifying an adapter
 * `testEnvironment` probe. `ProbeOutcome` is derived from this array.
 *
 * Governing invariant: **nothing may read "Ready" without an observed working
 * run.** A probe that did not prove the provider works must never be reported
 * as verified. The classifier that produces these lives at
 * `server/src/services/providers/classify-probe.ts`.
 *
 * `unknown`      — inconclusive (timeout, unexpected output, quota). Renders
 *                  "Not verified". Never Ready. BLOCKS.
 * `unverifiable` — a custom `command` deliberately skips the live probe, so we
 *                  cannot check it. Renders "Can't verify (custom command)".
 *                  NON-blocking: that setup was valid before the readiness
 *                  feature and must stay reachable, without silently being
 *                  recorded as verified.
 *
 * `unverifiable` != `unknown`: `unverifiable` means "we can't check this by
 * design" (waivable); `unknown` means "we checked and learned nothing".
 *
 * This is a runtime array (not just a type union) so that consumers needing the
 * values at runtime — notably the `provider_readiness_status.outcome` column in
 * `packages/db/src/schema/provider_readiness_status.ts` — derive them instead
 * of retyping the six strings.
 *
 * Note that drizzle's `text(..., { enum })` is a TypeScript-level constraint
 * only: it emits a plain `text` column with NO database CHECK, so the database
 * will happily store an outcome outside this list. Nothing but this shared
 * constant keeps the persisted values and the classifier in agreement — which
 * is precisely why retyping them elsewhere is banned.
 */
export const PROBE_OUTCOMES = [
  "verified",
  "needs_auth",
  "not_installed",
  "failed",
  "unknown",
  "unverifiable",
] as const;

/** The outcome of classifying an adapter `testEnvironment` probe. */
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/**
 * Outcomes that do NOT block: the verify route returns 200 for exactly these,
 * and the onboarding Verify step must render a branch for exactly these.
 *
 * NOT the same as "advances onboarding". `verified` advances by itself;
 * `unverifiable` advances only behind an explicit "Continue without verifying"
 * waiver, which the server re-validates against a fresh probe. Non-blocking
 * means "the probe is not an error", not "the setup is proven". The Verify step
 * maps this union to a disposition through a TOTAL Record
 * (`NON_BLOCKING_DISPOSITION`), so a third non-blocking outcome is a compile
 * error there until someone decides which of the two it is.
 *
 * This lives in shared ON PURPOSE. It was previously duplicated in
 * `server/src/routes/commander-verify.ts` and `ui/.../VerifyStep.tsx`, linked
 * only by a comment. Divergence reproduces the exact bug this feature exists to
 * fix, one level up: if the route treats an outcome as non-blocking and the UI
 * does not, `check()` takes the 200 path, sets the outcome, then neither
 * advances nor renders a branch — the founder is silently stuck with a "Check
 * again" button that can never change anything.
 *
 * Both sides import this. Do not re-inline it.
 */
export const NON_BLOCKING_PROBE_OUTCOMES = ["verified", "unverifiable"] as const;

export type NonBlockingProbeOutcome = (typeof NON_BLOCKING_PROBE_OUTCOMES)[number];

const NON_BLOCKING_SET: ReadonlySet<string> = new Set(NON_BLOCKING_PROBE_OUTCOMES);

/** True when `outcome` should return HTTP 200 / advance onboarding. */
export function isNonBlockingProbeOutcome(outcome: string): outcome is NonBlockingProbeOutcome {
  return NON_BLOCKING_SET.has(outcome);
}
