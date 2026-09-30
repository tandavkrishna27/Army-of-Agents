// -----------------------------------------------------------------------------
// Shared RFC 8785 (subset) canonical JSON + worker-event digest helpers.
//
// This is the SINGLE canonicalizer for the package. It is dependency-free — no
// zod, no `node:*` imports, and no forbidden runtime global (NEVER `Buffer`);
// UTF-8 encoding uses the standard `TextEncoder` global. It reproduces the
// frozen E0 authority `scripts/check-distributed-execution-foundation.mjs`
// (`canonicalizeJson` / `computeEventDigest`, the `(c1)` RFC 8785 subset)
// BYTE-FOR-BYTE — `events.test.ts` proves that against the committed
// `eventDigest` of every FND-004 golden fixture, closing the two-canonicalizer
// seam.
//
// The locked v1 subset is: null, booleans, strings, arrays, plain objects, and
// finite SAFE integers. Floats, unsafe integers, lone/broken UTF-16 surrogates,
// and any other value are REJECTED (throw). Object keys sort by UTF-16 code
// units (default `.sort()`); integers print with no exponent and no leading
// zeros; `-0` normalizes to `"0"`; strings use the exact ECMAScript/RFC 8785
// escapes with NO added Unicode normalization.
// -----------------------------------------------------------------------------

/** Thrown when a value has no RFC 8785 (subset) canonical form, or an event is
 * not a plain object. */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 8785 string serialization. Rejects lone/broken UTF-16 surrogates. */
function canonicalizeString(str: string): string {
  let out = '"';
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    // High surrogate: must be immediately followed by a low surrogate.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalJsonError("lone high surrogate in string");
      }
      out += str[i] + str[i + 1];
      i += 1;
      continue;
    }
    // Low surrogate with no preceding high surrogate is lone/broken.
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError("lone low surrogate in string");
    }
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += "\\\\";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0c) out += "\\f";
    else if (code === 0x0d) out += "\\r";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += str[i];
  }
  return `${out}"`;
}

/** RFC 8785 number serialization for the integer-only v1 subset. */
function canonicalizeNumber(num: number): string {
  if (!Number.isFinite(num)) {
    throw new CanonicalJsonError("non-finite number is not allowed");
  }
  if (!Number.isInteger(num)) {
    throw new CanonicalJsonError("float is not allowed in the v1 subset");
  }
  if (!Number.isSafeInteger(num)) {
    throw new CanonicalJsonError("unsafe integer is not allowed");
  }
  if (Object.is(num, -0)) return "0";
  return String(num);
}

/**
 * Canonicalize a JSON value to its RFC 8785 (subset) string form. THROWS a
 * {@link CanonicalJsonError} on non-integer numbers, non-safe integers,
 * lone/broken surrogates, and unsupported value types (`undefined`, bigint,
 * function, symbol). Object keys are sorted by UTF-16 code units.
 */
export function canonicalizeJsonV1(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return canonicalizeNumber(value as number);
  if (t === "string") return canonicalizeString(value as string);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJsonV1(item)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    // Sort keys by UTF-16 code units (JS default string comparison).
    const keys = Object.keys(obj).sort();
    const members = keys.map((key) => `${canonicalizeString(key)}:${canonicalizeJsonV1(obj[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new CanonicalJsonError(`unsupported value of type ${t}`);
}

/**
 * The UTF-8 canonical bytes a worker `eventDigest` is computed over: the
 * complete immutable event object with ONLY `eventDigest` removed, canonicalized
 * per {@link canonicalizeJsonV1}. Requires a plain object; an already-stringified
 * or non-object input is rejected so an unvalidated event never enters digest
 * handling.
 */
export function canonicalEventDigestInputV1(event: unknown): Uint8Array {
  if (!isPlainObject(event)) {
    throw new CanonicalJsonError("event must be a plain object");
  }
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(event)) {
    if (key === "eventDigest") continue;
    rest[key] = event[key];
  }
  return new TextEncoder().encode(canonicalizeJsonV1(rest));
}

/**
 * Verify a worker event's supplied `eventDigest` by recomputing over
 * {@link canonicalEventDigestInputV1}. The SHA-256 provider is injected (sync or
 * async, lowercase hex), keeping the package hash-provider neutral. Returns
 * `false` on any supplied/recomputed mismatch, a missing/non-string
 * `eventDigest`, or a non-canonicalizable event — never throws.
 */
export async function verifyWorkerEventDigestV1(
  event: unknown,
  sha256Fn: (bytes: Uint8Array) => string | Promise<string>,
): Promise<boolean> {
  if (!isPlainObject(event)) return false;
  const supplied = event.eventDigest;
  if (typeof supplied !== "string") return false;
  let input: Uint8Array;
  try {
    input = canonicalEventDigestInputV1(event);
  } catch {
    return false;
  }
  const recomputed = await sha256Fn(input);
  return typeof recomputed === "string" && recomputed === supplied;
}
