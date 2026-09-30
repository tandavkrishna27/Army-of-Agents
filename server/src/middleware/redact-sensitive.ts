/**
 * Sensitive-field redaction for request bodies, query, and params before logging.
 *
 * Used by error-handler and the request logger to scrub secrets out of any
 * payload that lands in pino logs. The single source of truth for which keys
 * count as sensitive is `SENSITIVE_KEY_PATTERNS`.
 */

const REDACTED = "[REDACTED]";
const DEPTH_EXCEEDED = "[redacted: depth exceeded]";
const MAX_DEPTH = 8;
const MAX_ARRAY_LENGTH = 100;
// Cap individual string values so an oversized payload field (e.g. a rejected
// multi-MB request body) cannot become a multi-MB log line. A single 4 MB string
// serialized through the vitest fork IPC as one stdout line stalled a worker past
// the birpc timeout and hung the whole shard (CI run 33019158926). Logs never need
// more than a few KB of any one field; anything above this is truncated with a
// marker, exactly like the array cap above.
const MAX_STRING_LENGTH = 8192;

/**
 * Single source of truth for which keys are redacted.
 * Patterns are matched case-insensitively against the literal key name.
 */
export const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^password$/i,
  /^pat$/i,
  /^pat[_-]?value$/i,
  /^secret$/i,
  /^secrets$/i,
  /^token$/i,
  /^api[_-]?key$/i,
  /^private[_-]?key$/i,
  /^client[_-]?secret$/i,
  /^refresh[_-]?token$/i,
  /^access[_-]?token$/i,
  /^bearer$/i,
  /^authorization$/i,
  // Generic "value" only flagged when used as a payload field for credentials —
  // we redact common parents below by name-matching, but a bare `value` key
  // alongside a sibling like `secret_id` is also a strong signal.
  /^encryption[_-]?key$/i,
];

function isSensitiveKey(key: string): boolean {
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

function redactInternal(value: unknown, depth: number): unknown {
  // Cap oversized strings FIRST, at ANY depth. A string is a leaf, so the
  // object-depth cutoff below must never reach it — if the `depth >= MAX_DEPTH`
  // branch's `return value` fired for a deeply-nested multi-MB string it would be
  // logged verbatim, reproducing the exact log/fork-IPC stall this cap prevents.
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}[redacted: ${value.length - MAX_STRING_LENGTH} more chars truncated]`
      : value;
  }
  if (depth >= MAX_DEPTH) {
    // Only mark as truncated if we'd actually be descending into something.
    if (value !== null && typeof value === "object") {
      return DEPTH_EXCEEDED;
    }
    return value;
  }
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_ARRAY_LENGTH);
    const out: unknown[] = new Array(limit);
    for (let i = 0; i < limit; i++) {
      out[i] = redactInternal(value[i], depth + 1);
    }
    if (value.length > MAX_ARRAY_LENGTH) {
      out.push(`[redacted: ${value.length - MAX_ARRAY_LENGTH} more array items truncated]`);
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactInternal(nested, depth + 1);
  }
  return out;
}

/**
 * Returns a deep copy of `body` with sensitive fields replaced by "[REDACTED]".
 *
 * - Non-object inputs (string/number/boolean/null/undefined) are returned as-is.
 * - Recursion is bounded at depth {@link MAX_DEPTH}; deeper values become
 *   the literal string "[redacted: depth exceeded]".
 * - Arrays are capped at {@link MAX_ARRAY_LENGTH} items; truncation is
 *   marked with a trailing string entry naming the number of dropped items.
 * - Individual string values are capped at {@link MAX_STRING_LENGTH} chars;
 *   the overflow is replaced with a "[redacted: N more chars truncated]" marker
 *   so an oversized body field cannot become a multi-MB log line.
 * - Input is never mutated.
 */
export function redactSensitiveBodyFields(body: unknown): unknown {
  return redactInternal(body, 0);
}
