/**
 * Pure failure-mapping utilities for thread-participation-runner (Phase 1 / Unit E).
 *
 * `mapRunFailureToFriendlyReason` converts a raw AoaRunResult.errorMessage into
 * a user-safe, secret-redacted string suitable for structured error-level logging.
 *
 * Design constraints:
 *   1. Pure function — no I/O, no imports with side-effects. Fully unit-testable.
 *   2. The output is NEVER rendered as agent content. It is used exclusively in
 *      log.error() calls inside thread-participation-runner.ts. The friendly text
 *      is static; it never echoes back user-controlled or adapter-controlled
 *      substrings from the errorMessage. redactSecretsInString is applied to any
 *      raw detail appended to the message, ensuring no token leaks.
 *   3. Secret redaction is always applied — even though the friendly strings are
 *      fully static today, this future-proofs any decision to include a redacted
 *      excerpt from the raw errorMessage.
 *
 * Error class detection uses lowercased matching against the raw errorMessage.
 * Categories, in priority order:
 *   auth        — not logged in / login required / unauthorized / authentication /
 *                 api[_ ]?key / 401
 *   model       — model + (not supported / not found / invalid / 400 / unavailable / not available)
 *   cli-missing — command not found / enoent / not installed / is not executable
 *   generic     — everything else (including null / undefined / empty string)
 */

import { redactSecretsInString } from "../../../redaction.js";

/** Friendly messages per failure class. Fully static — no raw error text echoed. */
const MESSAGES = {
  auth: "This agent's provider isn't authenticated. Configure its login or API key and try again.",
  model: "The agent's configured model isn't available for its provider. Pick a supported model and retry.",
  cli: "The agent's CLI runtime isn't installed on this host.",
  generic: "The agent run did not complete successfully.",
} as const;

/** Pattern sets for each failure class. Applied to the lowercased errorMessage. */
const AUTH_PATTERNS: RegExp[] = [
  /not logged in/,
  /login required/,
  /unauthorized/,
  /authentication/,
  /api[_\s]?key/,
  /\b401\b/,
];

/**
 * Model class requires TWO signals: the word "model" AND a qualifier.
 * This avoids false-positives from messages that mention "model" in passing
 * (e.g. "loaded model context from cache").
 */
const MODEL_QUALIFIERS: RegExp[] = [
  /not supported/,
  /not found/,
  /invalid/,
  /\b400\b/,
  /unavailable/,
  /not available/,
];

const CLI_PATTERNS: RegExp[] = [
  /command not found/,
  /\benoent\b/,
  /not installed/,
  /is not executable/,
];

/**
 * Map a raw AoaRunResult.errorMessage to a friendly, secret-redacted reason.
 *
 * @param errorMessage - The raw errorMessage from AoaRunResult (may be
 *   null/undefined when the adapter did not produce an explicit message).
 * @returns A non-empty, user-safe string describing the failure class.
 *   Never contains the raw errorMessage text (fully static friendly strings).
 *   redactSecretsInString is applied defensively to ensure compliance even if
 *   future code changes introduce raw-message substrings.
 */
export function mapRunFailureToFriendlyReason(
  errorMessage: string | null | undefined,
): string {
  const lower = (errorMessage ?? "").toLowerCase();

  // Auth check (highest priority — a 401 from a model endpoint is an auth
  // failure, not a model-selection failure).
  if (AUTH_PATTERNS.some((re) => re.test(lower))) {
    return redactSecretsInString(MESSAGES.auth);
  }

  // Model check — requires "model" in the message AND at least one qualifier.
  if (lower.includes("model") && MODEL_QUALIFIERS.some((re) => re.test(lower))) {
    return redactSecretsInString(MESSAGES.model);
  }

  // CLI-missing check.
  if (CLI_PATTERNS.some((re) => re.test(lower))) {
    return redactSecretsInString(MESSAGES.cli);
  }

  // Generic fallback.
  return redactSecretsInString(MESSAGES.generic);
}
