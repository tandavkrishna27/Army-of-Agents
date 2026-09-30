/**
 * Shared auth-failure classifier for CLI adapters.
 *
 * Every adapter previously carried its own regex, and all of them matched only
 * NEVER-SIGNED-IN phrasing ("not logged in", "please run `x login`"). The
 * expired/revoked class — which is the common case in practice, since tokens
 * expire on their own — was missed by all of them. A missed auth signal makes
 * the probe report a generic failure, which the server classifies as `failed`,
 * which leaves the founder with no recovery offer at all.
 *
 * Separating `expired` from `signed_out` is what lets the UI say "your session
 * was revoked" instead of the false "you are not signed in".
 *
 * Pure and synchronous: no process spawning, so it is exhaustively testable
 * against a table of real error strings.
 *
 * Input contract: feed this ONLY process failure output (stdout/stderr, or
 * parsed CLI error fields), never transcript or agent-authored content —
 * prose discussing auth will classify as an auth failure.
 */

import { extractVerificationUrl } from "./login-url-detector.js";

export type AuthFailureKind = "none" | "signed_out" | "expired" | "invalid_key";

export interface AuthFailureDetection {
  kind: AuthFailureKind;
  /** Verification URL when the CLI printed one, else null. */
  loginUrl: string | null;
}

/** Credentials are absent — the user has never signed in (or signed out). */
const SIGNED_OUT_PATTERNS = [
  String.raw`not\s+logged\s+in`,
  String.raw`please\s+log\s+in`,
  String.raw`log\s*in\s+required`,
  String.raw`login\s+required`,
  String.raw`requires\s+login`,
  String.raw`not\s+authenticated`,
  String.raw`please\s+authenticate`,
  "please\\s+run\\s+`?\\w+\\s+login`?",
  "run\\s+`?\\w+\\s+auth(?:\\s+login)?`?\\s+first",
];
const SIGNED_OUT_RE = new RegExp(`(?:${SIGNED_OUT_PATTERNS.join("|")})`, "i");

/**
 * Credentials exist but the server rejected them. `authentication_error` and
 * `token has been revoked` are the shapes Anthropic returns; the bare status
 * codes cover CLIs that surface only the HTTP status.
 */
const EXPIRED_PATTERNS = [
  String.raw`revoked`,
  String.raw`expired`,
  String.raw`authentication_error`,
  String.raw`failed\s+to\s+authenticate`,
  String.raw`\b401\b`,
  String.raw`\b403\b`,
  String.raw`unauthorized`,
  String.raw`authentication\s+required`,
  String.raw`invalid\s+credentials`,
];
const EXPIRED_RE = new RegExp(`(?:${EXPIRED_PATTERNS.join("|")})`, "i");

/** A key was supplied and is wrong or absent. */
const INVALID_KEY_PATTERNS = [
  String.raw`invalid(?:\s+or\s+missing)?\s+api[_\s-]?key`,
  String.raw`api[_\s-]?key\s+(?:is\s+)?(?:required|missing|invalid)`,
  String.raw`(?:openai|anthropic)[_\s-]?api[_\s-]?key\s+(?:is\s+)?(?:not\s+set|missing|required|invalid)`,
];
const INVALID_KEY_RE = new RegExp(`(?:${INVALID_KEY_PATTERNS.join("|")})`, "i");

/**
 * Noise that can sit next to a real auth word without being one: "429 rate
 * limit" or "500 internal server error" must never route the founder to a
 * sign-in screen just because "unauthorized" also shows up in the same dump.
 * Stripped from the haystack (globally — every occurrence) before
 * classification, rather than used as a short-circuit escape, so a message
 * that ALSO carries a real auth signal ("Login timed out. Please run `claude
 * login`.") still classifies correctly. The 5xx alternative is anchored to an
 * error/status/HTTP marker so it doesn't match arbitrary 3-digit numbers like
 * a token count ("Used 512 tokens").
 */
const NOT_AUTH_STRIP_PATTERNS = [
  String.raw`\b429\b`,
  String.raw`rate\s*limit`,
  String.raw`max(?:imum)?\s+turns?`,
  String.raw`timed?\s*out`,
  String.raw`(?:error|status|HTTP)\D{0,10}\b5\d{2}\b`,
];
const NOT_AUTH_STRIP = new RegExp(`(?:${NOT_AUTH_STRIP_PATTERNS.join("|")})`, "gi");

export function detectAuthFailure(text: string | null | undefined): AuthFailureDetection {
  const haystack = (text ?? "").trim();
  if (!haystack) return { kind: "none", loginUrl: null };

  const loginUrl = extractVerificationUrl(haystack);

  // Strip non-auth noise once, then classify what's left. `/g` is required so
  // EVERY occurrence is stripped, not just the first.
  const residual = haystack.replace(NOT_AUTH_STRIP, " ");

  // invalid_key before signed_out: "OPENAI_API_KEY is missing" is a key problem,
  // and its remedy (set a key) differs from signing in.
  if (INVALID_KEY_RE.test(residual)) return { kind: "invalid_key", loginUrl };

  // signed_out before expired: an explicit "not logged in" is unambiguous, and
  // such messages often also carry the word "unauthorized".
  if (SIGNED_OUT_RE.test(residual)) return { kind: "signed_out", loginUrl };

  if (EXPIRED_RE.test(residual)) return { kind: "expired", loginUrl };

  return { kind: "none", loginUrl: null };
}

/** True when the failure is any kind of auth problem. */
export function isAuthFailure(kind: AuthFailureKind): boolean {
  return kind !== "none";
}
