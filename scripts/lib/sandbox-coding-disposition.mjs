/**
 * sandbox-coding-disposition.mjs — pure, dependency-free policy logic for the
 * CLI-002 per-adapter-TYPE disposition matrix.
 *
 * The runtime source of truth is `server/src/services/sandbox-coding-disposition.ts`
 * (the typed `CODING_ADAPTER_DISPOSITIONS` matrix) + the registry set
 * `server/src/adapters/builtin-adapter-types.ts`. This module extracts the adapter
 * type strings + buckets from those sources lexically and evaluates coverage:
 *   - every REGISTERED adapter type has a disposition (fail-closed on drift);
 *   - no disposition is stale (a type not in the registry);
 *   - every bucket value is valid;
 *   - every non-v1 bucket carries an attributable reason.
 *
 * It parses only simple string-literal + flat-object shapes, mirroring how the
 * sibling boundary checkers read package.json + import specifiers. The `.check`
 * script is the filesystem layer; this module makes every decision.
 */

export const VALID_BUCKETS = ["v1", "follow_up", "out_of_scope", "infra"];

/** Extract the adapter type strings from `builtin-adapter-types.ts`'s `new Set([...])`. */
export function extractRegisteredTypes(source) {
  const setMatch = source.match(/new Set\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!setMatch) return [];
  const body = setMatch[1];
  const types = [];
  for (const m of body.matchAll(/["']([a-zA-Z0-9_]+)["']/g)) types.push(m[1]);
  return types;
}

/**
 * Extract the dispositions from `sandbox-coding-disposition.ts`'s
 * `CODING_ADAPTER_DISPOSITIONS` object. Returns
 * `[{ type, bucket, hasReason }]`. Entries are flat objects (no nested braces).
 */
export function extractDispositions(source) {
  const objMatch = source.match(/CODING_ADAPTER_DISPOSITIONS\s*(?::[^=]*)?=\s*\{([\s\S]*?)\n\};/);
  if (!objMatch) return [];
  const body = objMatch[1];
  const out = [];
  for (const entry of body.matchAll(/([a-zA-Z0-9_]+)\s*:\s*\{([^}]*)\}/g)) {
    const type = entry[1];
    const inner = entry[2];
    const bucketMatch = inner.match(/bucket\s*:\s*["']([a-zA-Z0-9_]+)["']/);
    const bucket = bucketMatch ? bucketMatch[1] : null;
    const hasReason = /reason\s*:\s*["']/.test(inner) || /reason\s*:\s*`/.test(inner);
    out.push({ type, bucket, hasReason });
  }
  return out;
}

/**
 * Evaluate disposition coverage. Returns an array of violation strings (empty ⇒ OK).
 * @param {{ registeredTypes: string[], dispositions: {type:string,bucket:string|null,hasReason:boolean}[] }} input
 */
export function evaluateDispositionCoverage({ registeredTypes, dispositions }) {
  const errors = [];
  const registered = new Set(registeredTypes);
  const dispByType = new Map(dispositions.map((d) => [d.type, d]));

  if (registeredTypes.length === 0) {
    errors.push("no registered adapter types extracted (registry parse failed)");
  }
  if (dispositions.length === 0) {
    errors.push("no dispositions extracted (matrix parse failed)");
  }

  for (const type of registered) {
    if (!dispByType.has(type)) {
      errors.push(`registered adapter "${type}" has NO disposition (fail-closed drift)`);
    }
  }
  for (const d of dispositions) {
    if (!registered.has(d.type)) {
      errors.push(`disposition "${d.type}" is not a registered adapter type (stale)`);
    }
    if (!d.bucket || !VALID_BUCKETS.includes(d.bucket)) {
      errors.push(`disposition "${d.type}" has invalid bucket ${JSON.stringify(d.bucket)}`);
    }
    if (d.bucket && d.bucket !== "v1" && !d.hasReason) {
      errors.push(`disposition "${d.type}" (bucket "${d.bucket}") lacks an attributable reason`);
    }
  }
  return errors;
}
