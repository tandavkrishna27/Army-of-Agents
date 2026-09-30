import { z } from "zod";
/** V1 recognizes NO critical extension namespaces, so every `critical: true`
 * extension is unknown and fails closed. */
export declare const KNOWN_CRITICAL_EXTENSION_NAMESPACES: ReadonlySet<string>;
/** The exact locked bounded-extension limits (bytes are post-UTF-8, never JS
 * code-unit length). */
export declare const WIRE_EXTENSION_LIMITS: {
    readonly maxCount: 16;
    readonly namespaceMaxBytes: 100;
    readonly valueMaxContainerDepth: 8;
    readonly valueMaxArrayItems: 128;
    readonly valueMaxObjectKeys: 64;
    readonly valueMaxKeyBytes: 100;
    readonly valueMaxCanonicalBytes: 16384;
    readonly combinedMaxCanonicalBytes: 65536;
};
export declare const wireExtensionSchema: z.ZodObject<{
    namespace: z.ZodEffects<z.ZodString, string, string>;
    schemaVersion: z.ZodNumber;
    critical: z.ZodBoolean;
    value: z.ZodUnknown;
}, "strict", z.ZodTypeAny, {
    namespace: string;
    schemaVersion: number;
    critical: boolean;
    value?: unknown;
}, {
    namespace: string;
    schemaVersion: number;
    critical: boolean;
    value?: unknown;
}>;
export type WireExtension = z.infer<typeof wireExtensionSchema>;
/** The shared bounded-extension array field (an empty array is valid). Its
 * bounds — count, per-value structure, and byte budgets — are enforced by
 * {@link addWireExtensionArrayIssues} in the owning envelope's `superRefine`. */
export declare const wireExtensionsArraySchema: z.ZodArray<z.ZodObject<{
    namespace: z.ZodEffects<z.ZodString, string, string>;
    schemaVersion: z.ZodNumber;
    critical: z.ZodBoolean;
    value: z.ZodUnknown;
}, "strict", z.ZodTypeAny, {
    namespace: string;
    schemaVersion: number;
    critical: boolean;
    value?: unknown;
}, {
    namespace: string;
    schemaVersion: number;
    critical: boolean;
    value?: unknown;
}>, "many">;
/** Enforce every bounded-extension invariant across an extensions array: count
 * ≤16, unique namespace, unknown-critical fail-closed, per-value structural
 * bounds (≤8 levels, ≤128 items, ≤64 keys, ≤100 UTF-8 key bytes), per-value
 * ≤16,384 canonical UTF-8 bytes (fail-closed on non-canonicalizable), and a
 * combined ≤65,536-byte value budget. Shared by job, lease, and event envelopes. */
export declare function addWireExtensionArrayIssues(extensions: readonly WireExtension[], ctx: z.RefinementCtx, base: Array<string | number>): void;
