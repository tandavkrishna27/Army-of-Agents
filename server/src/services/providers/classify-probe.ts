import type { AdapterEnvironmentTestResult, ProbeOutcome } from "@armyofagents/shared";

// `ProbeOutcome` and the non-blocking set live in @armyofagents/shared so the
// verify route and the onboarding UI cannot drift apart. See
// packages/shared/src/probe-outcome.ts for the semantics of each member.
export type { ProbeOutcome };

/**
 * Classify a probe result into a recovery outcome.
 *
 * Matching is on explicit code SUFFIXES rather than loose substrings: the old
 * `includes("install")` also matched `pi_package_install_failed`, and missing-key
 * codes matched nothing at all so they silently classified as verified.
 *
 * Semantic precedence, NOT flat suffix matching.
 *
 * Critical: several adapters emit a missing-key HINT even when the provider is
 * genuinely authenticated by another mechanism. Gemini emits
 * `gemini_api_key_missing` at info level while OAuth works; Cursor emits
 * `cursor_api_key_missing` while a CLI login works; Claude treats a missing key
 * as compatible with subscription auth. In all three the SAME result also
 * carries a live `*_hello_probe_passed`.
 *
 * So authoritative execution evidence must outrank credential-presence hints.
 * Ordering them the other way tells a working founder "Needs sign-in" forever —
 * worse than the bug this feature exists to fix.
 */

/**
 * A live end-to-end run. `_hello_probe_passed` means the CLI actually executed a
 * turn, so it is authoritative and outranks everything except a real auth
 * failure. `_models_probe_passed` is deliberately NOT here: grok emits it
 * whenever `grok models` exits zero, even when `parsedModels.authenticated` is
 * false (`packages/adapters/grok-local/src/server/test.ts:185-214`).
 */
const LIVE_RUN_SUCCESS_SUFFIXES = ["_hello_probe_passed"];
/**
 * Credential-validity-only success. `_auth_ok` covers cursor-cloud, whose only
 * success signal is an API auth check rather than a live run
 * (`cursor-cloud/src/server/test.ts:121`). This is WEAKER than a live run: a
 * valid key does NOT prove the agent can run. The same probe can emit `_auth_ok`
 * (info) alongside hard config errors — e.g. `cursor_cloud_repo_missing` /
 * `cursor_cloud_repo_invalid` (error), overall `status: "fail"`
 * (`cursor-cloud/src/server/test.ts:85-98`). So `_auth_ok` is only honoured
 * AFTER the hard-failure guard — a failing configuration must not read Ready.
 */
const AUTH_ONLY_SUCCESS_SUFFIXES = ["_auth_ok"];
/**
 * Two distinct runtime auth failures, both recoverable in-app:
 *   `_auth_required` — never signed in; there is no session at all.
 *   `_auth_expired`  — signed in previously, but the session was revoked or
 *                      lapsed. Without this suffix an expired session falls
 *                      through to `status === "fail"` and reads as `failed`,
 *                      telling the founder the CLI broke and offering no
 *                      recovery, when the true fix is simply signing in again.
 *
 * Both therefore classify as `needs_auth`. Matching stays on the code SUFFIX,
 * not a substring: a loose `includes("auth_expired")` would also swallow
 * unrelated codes that merely mention an expiry (e.g. a cache-expiry warning)
 * and send an authenticated founder to a sign-in screen.
 */
const AUTH_FAILURE_SUFFIXES = ["_auth_required", "_auth_expired"];
const MISSING_BINARY_SUFFIXES = ["_command_unresolvable", "_not_installed"];
/** Non-authoritative: only meaningful when there is NO live success signal. */
const CREDENTIAL_HINT_SUFFIXES = ["_api_key_missing", "_credentials_missing"];
/**
 * The probe could not reach a conclusion — never claim this is authenticated.
 * These need no branch of their own: `unknown` is already the DEFAULT, so they
 * land there by falling through. Exported as the documented inventory of what
 * "inconclusive" means (consumed by the readiness copy in later tasks); do NOT
 * turn this into a branch above the `fail` check, which would silently reclassify
 * hard failures that also happen to carry a timeout code.
 */
export const INCONCLUSIVE_SUFFIXES = [
  "_hello_probe_timed_out",
  "_hello_probe_unexpected_output",
  "_hello_probe_model_unavailable",
  "_quota_exhausted",
];

/**
 * The live probe was deliberately SKIPPED because the operator configured a
 * custom `command`. This is a legitimate, user-chosen setup — we simply cannot
 * verify it. It must be distinguished from `unknown` (a transient/inconclusive
 * result): treating it as unknown would permanently block onboarding for
 * configurations that worked before this feature existed.
 * Real codes, verified against the adapters:
 *   packages/adapters/claude-local/src/server/test.ts:175
 *   packages/adapters/codex-local/src/server/test.ts:176
 *   packages/adapters/gemini-local/src/server/test.ts:153
 *   packages/adapters/cursor-local/src/server/test.ts:150
 */
const SKIPPED_BY_DESIGN_SUFFIXES = ["_hello_probe_skipped_custom_command"];

export function classifyProbeOutcome(
  result: AdapterEnvironmentTestResult,
): { outcome: ProbeOutcome; result: AdapterEnvironmentTestResult } {
  const codes = result.checks.map((c) => c.code);
  const endsWithAny = (suffixes: string[]) =>
    codes.some((code) => suffixes.some((s) => code.endsWith(s)));

  // 1. A real runtime auth failure is authoritative and always wins.
  if (endsWithAny(AUTH_FAILURE_SUFFIXES)) return { outcome: "needs_auth", result };

  // 2. A live end-to-end run proves the provider actually runs. This outranks
  //    credential-presence hints (OAuth / subscription / CLI login) and, unlike
  //    `_auth_ok` below, a hard failure — because the run itself succeeded.
  if (endsWithAny(LIVE_RUN_SUCCESS_SUFFIXES)) return { outcome: "verified", result };

  // 3. No binary at all.
  if (endsWithAny(MISSING_BINARY_SUFFIXES)) return { outcome: "not_installed", result };

  // 4. Deliberately unprobeable (operator configured a custom command). This MUST
  //    come BEFORE credential hints: a custom-command setup routinely ALSO emits
  //    `*_api_key_missing` (it authenticates by other means and the live probe
  //    never ran). Checking hints first would classify it needs_auth and
  //    reintroduce the permanent onboarding block this outcome exists to fix.
  if (endsWithAny(SKIPPED_BY_DESIGN_SUFFIXES)) return { outcome: "unverifiable", result };

  // 5. Credential hints count only when nothing proved the provider works and
  //    nothing explained why we couldn't check (catches acpx, whose
  //    missing-credential checks are info level).
  if (endsWithAny(CREDENTIAL_HINT_SUFFIXES)) return { outcome: "needs_auth", result };

  // 6. Hard failure. This MUST come before `_auth_ok`: cursor-cloud emits
  //    `cursor_cloud_auth_ok` (valid key) alongside `cursor_cloud_repo_missing`
  //    (error, status "fail") when the agent has no usable repo. A valid key is
  //    not a runnable agent, so the failing config wins.
  if (result.status === "fail") return { outcome: "failed", result };

  // 7. Credential-validity-only success (cursor-cloud). Reached only when no hard
  //    failure blocked it, so a verified key with a usable config reads Ready.
  if (endsWithAny(AUTH_ONLY_SUCCESS_SUFFIXES)) return { outcome: "verified", result };

  // 8. DEFAULT IS NOT "verified". A timeout, a models-only success, or any bare
  //    pass/warn means we never observed a working run. Claiming "Ready" here is
  //    exactly the false-green this feature exists to prevent.
  //    (`INCONCLUSIVE_SUFFIXES` documents the codes that land here.)
  return { outcome: "unknown", result };
}
