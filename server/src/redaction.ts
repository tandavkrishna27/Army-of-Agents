const SECRET_PAYLOAD_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth|bearer|secret|passwd|password|credential|jwt|private|cookie|signing|webhook|npm|connection)/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
// Free-form JWT matcher (UNanchored). A JWT adjacent to punctuation
// (`token=eyJ…`, `Authorization:eyJ…`) is missed by the whitespace-tokenized
// anchored pass, leaking the raw token (Codex P2). Anchor on the `eyJ` header
// prefix — every JWT header is a JSON object starting with `{"`, which
// base64url-encodes to `eyJ` — so this stays precise (no semver / a.b.c false
// positives) while catching JWTs anywhere in the string.
const JWT_IN_CONTEXT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g;
// H4: redact string VALUES that look like a secret even when the key name is
// innocuous (DATABASE_URL, STRIPE_LIVE, DSN, …). Previously only JWT-shaped
// values were caught, so a connection string / provider key bound to a
// non-secret-named field survived this second-pass read redaction. Mirrors the
// value patterns in adapter-utils redactEnvForLogs + prompt-snapshot.ts.
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|kafka|nats|mssql|sqlserver):\/\/[^\s<>'")]+/i,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/,
  /\b[sprSPR]k_(?:live|test)_[A-Za-z0-9]{8,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  // Generic "<prefix>_<long-random>" tokens — whsec_…, npm_…, vendor keys.
  /\b[A-Za-z][A-Za-z0-9]{1,}_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/,
];
// Whole PEM private-key block: the header-only pattern above leaves the base64
// body + footer in free-form output. Redact the FULL block (header → footer).
// [\s\S] spans newlines; non-greedy stops at the first END marker.
const PEM_PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g;
function looksLikeSecretValue(value: string): boolean {
  return JWT_VALUE_RE.test(value) || SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    if (typeof value === "string" && looksLikeSecretValue(value)) {
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeValue(value);
  }
  return redacted;
}

/**
 * Redact secret-looking substrings from a FREE-FORM string (probe stdout/stderr,
 * error details). Reuses the same value patterns as the object-level redactor so
 * there is a single source of truth. Used to scrub adapter test-connection output
 * before returning it to a client (Unit D — provider-switching).
 * Note: JWTs are redacted both in context (the `eyJ…` matcher catches tokens
 * embedded in punctuation, e.g. "Authorization:eyJ...") and token-wise (any
 * JWT-shaped whitespace-delimited token). API-key-style secrets use word-boundary
 * patterns and are caught in context.
 */
export function redactSecretsInString(value: string): string {
  // Redact whole PEM private-key blocks first — the generic header-only pattern
  // would otherwise leave the key body + footer in the output (Codex P2).
  let out = value.replace(PEM_PRIVATE_KEY_BLOCK_RE, REDACTED_EVENT_VALUE);
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), REDACTED_EVENT_VALUE);
  }
  // Redact JWTs embedded in punctuation (token=eyJ…, Authorization:eyJ…) that the
  // anchored token-wise pass below misses (Codex P2).
  out = out.replace(JWT_IN_CONTEXT_RE, REDACTED_EVENT_VALUE);
  // JWT_VALUE_RE is anchored (^...$) for whole-value matching; apply it token-wise
  // to also catch non-eyJ JWT-shaped whole tokens.
  out = out
    .split(/(\s+)/)
    .map((tok) => (JWT_VALUE_RE.test(tok) ? REDACTED_EVENT_VALUE : tok))
    .join("");
  return out;
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}
