import { z } from "zod";
import { canonicalizeJsonV1 } from "./canonical-json.js";

// -----------------------------------------------------------------------------
// The ONE bounded namespaced extension container for every V1 wire envelope
// (job, lease, and worker events). Safe additive data travels only through
// `{ namespace, schemaVersion, critical, value }`; every unknown `critical: true`
// extension fails closed. This module is the single source of truth for the
// container's array schema AND its full refiner — job/lease/events all import
// `addWireExtensionArrayIssues` so the identical value-structure walk + byte
// budgets are enforced everywhere the bounded extension field appears (E1-F005:
// the event schema previously under-enforced this container).
//
// This is the EXISTING, reviewed-correct job refiner relocated verbatim (no
// logic change), so job/lease behavior is byte-identical. Recursive
// plaintext-credential rejection is applied by each consumer's envelope-level
// `addForbiddenWireKeyIssues` (which recursively covers extension values); it is
// deliberately not duplicated inside this refiner, preserving the reviewed
// topology. Runtime source imports only `zod` + the shared canonicalizer and
// uses `TextEncoder`, never `Buffer` or any `node:*`.
// -----------------------------------------------------------------------------

const encoder = new TextEncoder();
const utf8ByteLength = (value: string): number => encoder.encode(value).length;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** V1 recognizes NO critical extension namespaces, so every `critical: true`
 * extension is unknown and fails closed. */
export const KNOWN_CRITICAL_EXTENSION_NAMESPACES: ReadonlySet<string> = new Set<string>();

/** The exact locked bounded-extension limits (bytes are post-UTF-8, never JS
 * code-unit length). */
export const WIRE_EXTENSION_LIMITS = {
  maxCount: 16,
  namespaceMaxBytes: 100,
  valueMaxContainerDepth: 8,
  valueMaxArrayItems: 128,
  valueMaxObjectKeys: 64,
  valueMaxKeyBytes: 100,
  valueMaxCanonicalBytes: 16_384,
  combinedMaxCanonicalBytes: 65_536,
} as const;

const namespaceLabel = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const namespaceName = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
const namespaceRegex = new RegExp(`^${namespaceLabel}(?:\\.${namespaceLabel})+(?:/${namespaceName})?$`);

export const wireExtensionSchema = z
  .object({
    namespace: z
      .string()
      .regex(namespaceRegex, "namespace must be lowercase reverse-DNS with an optional /name")
      .refine((value) => utf8ByteLength(value) <= WIRE_EXTENSION_LIMITS.namespaceMaxBytes, {
        message: `namespace exceeds ${WIRE_EXTENSION_LIMITS.namespaceMaxBytes} UTF-8 bytes`,
      }),
    schemaVersion: z.number().int().min(1).max(1_000_000),
    critical: z.boolean(),
    value: z.unknown(),
  })
  .strict();
export type WireExtension = z.infer<typeof wireExtensionSchema>;

/** The shared bounded-extension array field (an empty array is valid). Its
 * bounds — count, per-value structure, and byte budgets — are enforced by
 * {@link addWireExtensionArrayIssues} in the owning envelope's `superRefine`. */
export const wireExtensionsArraySchema = z.array(wireExtensionSchema);

// Extension values are sized against the RFC 8785 subset via the shared
// `canonicalizeJsonV1` (byte-for-byte the frozen E0 authority). It THROWS on a
// value with no RFC 8785-subset canonical form (floats, unsafe integers,
// lone/broken UTF-16 surrogates); the caller's try/catch converts that throw
// into a fail-closed "not canonicalizable" issue at the extension value path, so
// an out-of-subset value never bypasses the byte budget.
function canonicalByteLength(value: unknown): number {
  return utf8ByteLength(canonicalizeJsonV1(value));
}

/** Recursively validate a single extension value's structural bounds. */
function addExtensionValueStructureIssues(value: unknown, ctx: z.RefinementCtx, base: Array<string | number>): void {
  const walk = (node: unknown, containerDepth: number, path: Array<string | number>): void => {
    if (node === null || typeof node === "boolean" || typeof node === "string") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "extension value numbers must be finite" });
      }
      return;
    }
    if (Array.isArray(node)) {
      const level = containerDepth + 1;
      if (level > WIRE_EXTENSION_LIMITS.valueMaxContainerDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `extension value exceeds ${WIRE_EXTENSION_LIMITS.valueMaxContainerDepth} container levels` });
        return;
      }
      if (node.length > WIRE_EXTENSION_LIMITS.valueMaxArrayItems) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `extension value array exceeds ${WIRE_EXTENSION_LIMITS.valueMaxArrayItems} items` });
      }
      node.forEach((item, index) => walk(item, level, [...path, index]));
      return;
    }
    if (isPlainObject(node)) {
      const level = containerDepth + 1;
      if (level > WIRE_EXTENSION_LIMITS.valueMaxContainerDepth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `extension value exceeds ${WIRE_EXTENSION_LIMITS.valueMaxContainerDepth} container levels` });
        return;
      }
      const keys = Object.keys(node);
      if (keys.length > WIRE_EXTENSION_LIMITS.valueMaxObjectKeys) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `extension value object exceeds ${WIRE_EXTENSION_LIMITS.valueMaxObjectKeys} keys` });
      }
      for (const key of keys) {
        if (utf8ByteLength(key) > WIRE_EXTENSION_LIMITS.valueMaxKeyBytes) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, key], message: `extension value key exceeds ${WIRE_EXTENSION_LIMITS.valueMaxKeyBytes} UTF-8 bytes` });
        }
        walk(node[key], level, [...path, key]);
      }
      return;
    }
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "extension value must be JSON (string/number/boolean/null/array/object)" });
  };
  walk(value, 0, base);
}

/** Enforce every bounded-extension invariant across an extensions array: count
 * ≤16, unique namespace, unknown-critical fail-closed, per-value structural
 * bounds (≤8 levels, ≤128 items, ≤64 keys, ≤100 UTF-8 key bytes), per-value
 * ≤16,384 canonical UTF-8 bytes (fail-closed on non-canonicalizable), and a
 * combined ≤65,536-byte value budget. Shared by job, lease, and event envelopes. */
export function addWireExtensionArrayIssues(extensions: readonly WireExtension[], ctx: z.RefinementCtx, base: Array<string | number>): void {
  if (extensions.length > WIRE_EXTENSION_LIMITS.maxCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: base, message: `at most ${WIRE_EXTENSION_LIMITS.maxCount} extensions are permitted` });
  }
  const seenNamespaces = new Set<string>();
  let combinedBytes = 0;
  extensions.forEach((extension, index) => {
    const path = [...base, index];
    if (seenNamespaces.has(extension.namespace)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "namespace"], message: "duplicate extension namespace" });
    }
    seenNamespaces.add(extension.namespace);
    if (extension.critical === true && !KNOWN_CRITICAL_EXTENSION_NAMESPACES.has(extension.namespace)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "critical"], message: "unknown critical extension fails closed" });
    }
    if (extension.value === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "value"], message: "extension value is required" });
      return;
    }
    addExtensionValueStructureIssues(extension.value, ctx, [...path, "value"]);
    try {
      const bytes = canonicalByteLength(extension.value);
      combinedBytes += bytes;
      if (bytes > WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "value"], message: `extension value exceeds ${WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes} canonical UTF-8 bytes` });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "value"], message: "extension value is not canonicalizable" });
    }
  });
  if (combinedBytes > WIRE_EXTENSION_LIMITS.combinedMaxCanonicalBytes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: base, message: `combined extension value budget exceeds ${WIRE_EXTENSION_LIMITS.combinedMaxCanonicalBytes} canonical UTF-8 bytes` });
  }
}
