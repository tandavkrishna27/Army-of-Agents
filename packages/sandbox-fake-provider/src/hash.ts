// -----------------------------------------------------------------------------
// Deterministic hashing helpers (Node built-in crypto only).
//
// `sha256Hex` is the injected SHA-256 the shared worker-protocol digest helpers
// (`canonicalEventDigestInputV1` / `verifyWorkerEventDigestV1`) are driven with,
// so a recomputed `eventDigest` is byte-identical to the FND-004 fixture's stored
// digest. `stableStringify` produces a deterministic, key-sorted serialization
// for the provider-neutral invocation-argument digest.
// -----------------------------------------------------------------------------

import { createHash } from "node:crypto";

/** Lowercase-hex SHA-256 over raw bytes (Uint8Array) or a UTF-8 string. */
export function sha256Hex(input: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input));
  return hash.digest("hex");
}

/** Deterministic, key-sorted JSON serialization (arrays keep order). Used only
 * for the invocation-argument digest, never for the wire event digest. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    sorted[key] = sortValue(source[key]);
  }
  return sorted;
}
