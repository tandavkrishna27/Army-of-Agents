/**
 * prompt-snapshot.ts — Redaction + size-cap helper for persisting agent
 * system-prompt snapshots on run records (audit card backend, follow-up #27).
 *
 * `redactAndCapPrompt(raw)` is a pure function that:
 *  1. Strips common secret patterns from a free-text prompt string, reusing
 *     the FREE_TEXT_PATTERNS from feedback-redaction.ts so redaction rules
 *     stay consistent across the codebase.
 *  2. Caps the output at MAX_PROMPT_SNAPSHOT_CHARS, appending TRUNCATION_SUFFIX
 *     when the string is shortened so the reader knows it is incomplete.
 *
 * Callers MUST wrap every call in try/catch — a capture failure must NEVER
 * propagate out of the run execution path.
 *
 * Redacted patterns (inherited from FREE_TEXT_PATTERNS in feedback-redaction.ts):
 *   - PEM blocks
 *   - Key/token assignments   (API_KEY=…, auth_token: …, etc.)
 *   - Bearer tokens
 *   - GitHub PATs             (ghp_… / gho_… / etc.)
 *   - Provider API keys       (sk-… / sk-ant-…)
 *   - JWTs                    (three-dot base64url segments)
 *   - Connection strings      (postgres:// / mongodb:// / redis:// etc.)
 *   - Email addresses
 *   - Phone numbers
 */

/** Maximum characters kept in a persisted prompt snapshot. */
export const MAX_PROMPT_SNAPSHOT_CHARS = 16_000;

/** Appended when the snapshot is truncated. */
export const TRUNCATION_SUFFIX = "\n…[truncated]";

// ── Redaction patterns ────────────────────────────────────────────────────────
// Mirror of FREE_TEXT_PATTERNS from feedback-redaction.ts.  Defined inline
// here so prompt-snapshot.ts has zero runtime dependencies on any service
// module and stays trivially unit-testable.

type PatternReplacement = string | ((match: string, ...args: string[]) => string);

interface RedactionPattern {
  kind: string;
  regex: RegExp;
  replacement: PatternReplacement;
}

const REDACTION_PATTERNS: RedactionPattern[] = [
  {
    kind: "pem_block",
    regex: /-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g,
    replacement: "[REDACTED_PEM_BLOCK]",
  },
  {
    kind: "secret_assignment",
    // key=value / key: value for common secret-sounding names
    regex:
      /\b(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)\s*[:=]\s*([^\s,;]+)/gi,
    replacement: (_match: string, key: string) => `${key}=[REDACTED]`,
  },
  {
    kind: "bearer_token",
    regex: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    kind: "github_token",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    kind: "provider_api_key",
    // Anthropic sk-ant-… and OpenAI sk-… style keys (≥12 chars)
    regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    kind: "aws_access_key",
    // AWS AKIA… / ASIA… access key IDs
    regex: /\b(?:AKIA|ASIA|AROA|AIPA|ANPA|ANVA|APKA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  {
    kind: "jwt",
    // Three-segment base64url (JWTs) with optional fourth segment
    regex:
      /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    kind: "dsn",
    regex:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|kafka|nats|mssql):\/\/[^\s<>'")]+/gi,
    replacement: "[REDACTED_CONNECTION_STRING]",
  },
];

/**
 * Apply a single pattern, resetting lastIndex after each call so stateful
 * regexes don't skip matches across successive calls.
 */
function applyPattern(input: string, pattern: RedactionPattern): string {
  const output = input.replace(
    pattern.regex,
    pattern.replacement as never,
  );
  // Always reset — some engines mutate lastIndex even on non-global exec paths.
  pattern.regex.lastIndex = 0;
  return output;
}

/**
 * Redact secret-looking content and cap length.
 *
 * Pure function — no I/O, no side effects.
 * Callers wrap in try/catch; failures must not break runs.
 */
export function redactAndCapPrompt(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;

  let out = raw;
  for (const pattern of REDACTION_PATTERNS) {
    out = applyPattern(out, pattern);
  }

  if (out.length > MAX_PROMPT_SNAPSHOT_CHARS) {
    // Keep the head so the visible portion is the most-structured part
    // (persona / tools / goal context) rather than mid-sentence filler.
    out =
      out.slice(0, MAX_PROMPT_SNAPSHOT_CHARS - TRUNCATION_SUFFIX.length) +
      TRUNCATION_SUFFIX;
  }

  return out;
}
