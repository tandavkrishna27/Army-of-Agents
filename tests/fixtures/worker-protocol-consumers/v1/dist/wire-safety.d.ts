import { z } from "zod";
/**
 * The locked set of forbidden wire keys, already normalized (lowercased, with
 * punctuation and underscores stripped). A key on any envelope whose normalized
 * form is a member of this set is a plaintext-credential channel and is rejected
 * recursively. camelCase, snake_case, and kebab-case spellings all normalize to
 * the same member (so `accessToken`, `access_token`, and `Access-Token` are all
 * caught). The known opaque-handle key `secretHandleIds` normalizes to
 * `secrethandleids`, which is deliberately NOT in this set.
 */
export declare const FORBIDDEN_WIRE_KEYS: ReadonlySet<string>;
/** Normalize a key for forbidden-key comparison: lowercase, then strip every
 * character that is not an ASCII letter or digit (punctuation + underscores). */
export declare function normalizeWireKey(key: string): string;
/**
 * Recursively find plaintext-credential-bearing keys in a plain-object/array
 * structure. Returns deterministic sorted dotted paths such as
 * `oauth.accessToken` or `rows.0.password`. The known opaque key
 * `secretHandleIds` is never reported.
 */
export declare function findForbiddenWireKeys(value: unknown): string[];
/** Add a `custom` Zod issue at every forbidden-key path found under `value`. */
export declare function addForbiddenWireKeyIssues(value: unknown, ctx: z.RefinementCtx): void;
/** Register non-empty secret canaries. Empty strings are ignored so a canary
 * can never match every string. */
export declare function registerSecretCanaries(canaries: Iterable<string>): void;
/** Remove all registered secret canaries. */
export declare function clearRegisteredSecretCanaries(): void;
/** A read-only snapshot of the registered secret canaries. */
export declare function getRegisteredSecretCanaries(): ReadonlySet<string>;
/** Pure recursive visitor: invoke `visit(stringValue, dottedPath)` for every
 * string value in a plain-object/array structure. */
export declare function visitWireStrings(value: unknown, visit: (value: string, path: string) => void): void;
/**
 * Return the deterministic sorted dotted paths of every string value that
 * contains a registered (or supplied) secret canary as a substring.
 */
export declare function findSecretCanaryStringMatches(value: unknown, canaries?: Iterable<string>): string[];
/** A sample produced by {@link generateWireStringSample}. */
export interface WireStringSample {
    readonly sample: unknown;
    readonly canaryPath: string | null;
}
/** Deterministic mulberry32 PRNG. Same seed yields the same [0,1) sequence. */
export declare function createSeededRng(seed: number): () => number;
/**
 * Generate one deterministic wire-shaped sample from `rng`, spanning argv, URLs,
 * headers, nested arrays, and an extensions container. When `embedCanary` is
 * supplied, exactly one string leaf is rewritten to contain it, and its dotted
 * path is returned so a test can assert the scanner finds it.
 */
export declare function generateWireStringSample(rng: () => number, embedCanary?: string): WireStringSample;
