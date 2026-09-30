/** Thrown when a value has no RFC 8785 (subset) canonical form, or an event is
 * not a plain object. */
export declare class CanonicalJsonError extends Error {
    constructor(message: string);
}
/**
 * Canonicalize a JSON value to its RFC 8785 (subset) string form. THROWS a
 * {@link CanonicalJsonError} on non-integer numbers, non-safe integers,
 * lone/broken surrogates, and unsupported value types (`undefined`, bigint,
 * function, symbol). Object keys are sorted by UTF-16 code units.
 */
export declare function canonicalizeJsonV1(value: unknown): string;
/**
 * The UTF-8 canonical bytes a worker `eventDigest` is computed over: the
 * complete immutable event object with ONLY `eventDigest` removed, canonicalized
 * per {@link canonicalizeJsonV1}. Requires a plain object; an already-stringified
 * or non-object input is rejected so an unvalidated event never enters digest
 * handling.
 */
export declare function canonicalEventDigestInputV1(event: unknown): Uint8Array;
/**
 * Verify a worker event's supplied `eventDigest` by recomputing over
 * {@link canonicalEventDigestInputV1}. The SHA-256 provider is injected (sync or
 * async, lowercase hex), keeping the package hash-provider neutral. Returns
 * `false` on any supplied/recomputed mismatch, a missing/non-string
 * `eventDigest`, or a non-canonicalizable event — never throws.
 */
export declare function verifyWorkerEventDigestV1(event: unknown, sha256Fn: (bytes: Uint8Array) => string | Promise<string>): Promise<boolean>;
