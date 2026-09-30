// Browser-safe single source of truth for env secret redaction patterns +
// helpers. Both the Node-only server adapter-utils package
// (packages/adapter-utils/src/server-utils.ts) and the browser UI
// (ui/src/lib/env-redaction.ts) import these — keeping the key regex and the
// value patterns from drifting apart. Pure data + pure functions, no Node deps.
//
// H4 (Codex P1): widened beyond the original key|token|secret|… set to also
// catch common secret-bearing env-name fragments whose VALUES are
// provider-specific opaque strings the value patterns below can't all enumerate
// — e.g. WEBHOOK_SIGNING (whsec_…), NPM_AUTH (npm tokens), *_CREDENTIAL, *_DSN,
// *_CONNECTION, *_BEARER, *_PAT. Over-redacting a log value is safe.
export const SENSITIVE_ENV_KEY =
  /(key|token|secret|password|passwd|auth|cookie|credential|bearer|signing|webhook|npm|private|connection)/i;

// H4: key-name matching alone leaked secrets bound (via secret_ref) to env vars
// whose NAME does not contain one of the words above — DATABASE_URL, STRIPE_LIVE,
// NPM_AUTH, DSN, WEBHOOK_SIGNING, CONNECTION, PAT, … — in plaintext into the
// persisted heartbeat_run_events row and the SSE broadcast. So ALSO redact a
// value (regardless of key name) when it LOOKS like a secret. Over-redacting a
// log value is safe; leaking one is not. (These mirror the
// connection-string/provider-key/JWT/PEM rules in
// server/src/services/prompt-snapshot.ts.)
export const SENSITIVE_ENV_VALUE_PATTERNS: RegExp[] = [
  // Connection strings / DSNs (postgres://user:pass@host, mongodb+srv://, redis://, …)
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|kafka|nats|mssql|sqlserver):\/\/[^\s<>'")]+/i,
  // Anthropic / OpenAI-style provider keys (sk-… / sk-ant-…)
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/,
  // Stripe-style keys (sk_live_…, pk_test_…, rk_live_…)
  /\b[sprSPR]k_(?:live|test)_[A-Za-z0-9]{8,}\b/,
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/,
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  // H4 (Codex P1): generic "<prefix>_<long-random>" token shape — catches
  // Stripe webhook signing (whsec_…), npm tokens (npm_…), and most vendor
  // "prefix_<base62>" keys regardless of the prefix.
  /\b[A-Za-z][A-Za-z0-9]{1,}_[A-Za-z0-9]{20,}\b/,
  // JWTs (three base64url segments)
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  // PEM private-key blocks
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecretValue(value: string): boolean {
  return SENSITIVE_ENV_VALUE_PATTERNS.some((re) => re.test(value));
}

/**
 * True when an env entry should be redacted: its KEY name looks sensitive,
 * or (for string values) its VALUE looks like a secret. Non-string values
 * with a benign key are not redacted here (callers handle secret_ref objects
 * upstream).
 */
export function shouldRedactSecretValue(key: string, value: unknown): boolean {
  if (SENSITIVE_ENV_KEY.test(key)) return true;
  if (typeof value !== "string") return false;
  return SENSITIVE_ENV_VALUE_PATTERNS.some((re) => re.test(value));
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] =
      SENSITIVE_ENV_KEY.test(key) || (typeof value === "string" && looksLikeSecretValue(value))
        ? "***REDACTED***"
        : value;
  }
  return redacted;
}
