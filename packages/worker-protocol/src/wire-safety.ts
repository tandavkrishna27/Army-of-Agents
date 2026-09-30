import { z } from "zod";

// -----------------------------------------------------------------------------
// Wire safety: recursive rejection of plaintext-credential-bearing keys, plus a
// pure producer-side secret-canary scanner. Runtime source imports only zod and
// relative modules and touches no Node API (TextEncoder is a standard global).
// -----------------------------------------------------------------------------

/**
 * The locked set of forbidden wire keys, already normalized (lowercased, with
 * punctuation and underscores stripped). A key on any envelope whose normalized
 * form is a member of this set is a plaintext-credential channel and is rejected
 * recursively. camelCase, snake_case, and kebab-case spellings all normalize to
 * the same member (so `accessToken`, `access_token`, and `Access-Token` are all
 * caught). The known opaque-handle key `secretHandleIds` normalizes to
 * `secrethandleids`, which is deliberately NOT in this set.
 */
export const FORBIDDEN_WIRE_KEYS: ReadonlySet<string> = new Set([
  "env",
  "environment",
  "apikey",
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "cookie",
  "authorization",
  "credential",
  "credentials",
  "secretvalue",
]);

/** Normalize a key for forbidden-key comparison: lowercase, then strip every
 * character that is not an ASCII letter or digit (punctuation + underscores). */
export function normalizeWireKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect the segment-path of every forbidden key, sorting object keys at each
 * level so output is deterministic. Array indices become numeric segments. */
function collectForbiddenKeyPaths(value: unknown, prefix: Array<string | number>, out: Array<Array<string | number>>): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectForbiddenKeyPaths(value[index], [...prefix, index], out);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value).sort()) {
      const path = [...prefix, key];
      if (FORBIDDEN_WIRE_KEYS.has(normalizeWireKey(key))) out.push(path);
      collectForbiddenKeyPaths(value[key], path, out);
    }
  }
}

/**
 * Recursively find plaintext-credential-bearing keys in a plain-object/array
 * structure. Returns deterministic sorted dotted paths such as
 * `oauth.accessToken` or `rows.0.password`. The known opaque key
 * `secretHandleIds` is never reported.
 */
export function findForbiddenWireKeys(value: unknown): string[] {
  const paths: Array<Array<string | number>> = [];
  collectForbiddenKeyPaths(value, [], paths);
  return paths.map((segments) => segments.join("."));
}

/** Add a `custom` Zod issue at every forbidden-key path found under `value`. */
export function addForbiddenWireKeyIssues(value: unknown, ctx: z.RefinementCtx): void {
  const paths: Array<Array<string | number>> = [];
  collectForbiddenKeyPaths(value, [], paths);
  for (const segments of paths) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: segments,
      message: `forbidden credential-bearing key at ${segments.join(".")}`,
    });
  }
}

// -----------------------------------------------------------------------------
// Pure recursive string visitor + secret-canary scanning.
//
// The wire schema cannot prove that an arbitrary user-provided string never
// embeds a secret. Control-plane producers therefore scan every string value
// against registered secret canaries before persistence/dispatch. These helpers
// are dependency-free so a producer can call them anywhere.
// -----------------------------------------------------------------------------

const registeredSecretCanaries = new Set<string>();

/** Register non-empty secret canaries. Empty strings are ignored so a canary
 * can never match every string. */
export function registerSecretCanaries(canaries: Iterable<string>): void {
  for (const canary of canaries) {
    if (typeof canary === "string" && canary.length > 0) registeredSecretCanaries.add(canary);
  }
}

/** Remove all registered secret canaries. */
export function clearRegisteredSecretCanaries(): void {
  registeredSecretCanaries.clear();
}

/** A read-only snapshot of the registered secret canaries. */
export function getRegisteredSecretCanaries(): ReadonlySet<string> {
  return new Set(registeredSecretCanaries);
}

/** Pure recursive visitor: invoke `visit(stringValue, dottedPath)` for every
 * string value in a plain-object/array structure. */
export function visitWireStrings(value: unknown, visit: (value: string, path: string) => void): void {
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      visit(node, path);
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        walk(node[index], path === "" ? String(index) : `${path}.${index}`);
      }
      return;
    }
    if (isPlainObject(node)) {
      for (const key of Object.keys(node).sort()) {
        walk(node[key], path === "" ? key : `${path}.${key}`);
      }
    }
  };
  walk(value, "");
}

/**
 * Return the deterministic sorted dotted paths of every string value that
 * contains a registered (or supplied) secret canary as a substring.
 */
export function findSecretCanaryStringMatches(value: unknown, canaries?: Iterable<string>): string[] {
  const needles = canaries ? [...canaries].filter((c) => typeof c === "string" && c.length > 0) : [...registeredSecretCanaries];
  if (needles.length === 0) return [];
  const hits: string[] = [];
  visitWireStrings(value, (stringValue, path) => {
    if (needles.some((needle) => stringValue.includes(needle))) hits.push(path);
  });
  return hits.sort();
}

// -----------------------------------------------------------------------------
// Dependency-free seeded deterministic generator — the producer secret-scan
// corpus source. It emits nested structures spanning argv, URLs, headers,
// nested arrays, and extensions so a test can inspect every string value across
// many recursive cases and prove registered canaries always match.
// -----------------------------------------------------------------------------

/** A sample produced by {@link generateWireStringSample}. */
export interface WireStringSample {
  readonly sample: unknown;
  readonly canaryPath: string | null;
}

/** Deterministic mulberry32 PRNG. Same seed yields the same [0,1) sequence. */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CORPUS_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomToken(rng: () => number, minLen: number, maxLen: number): string {
  const length = minLen + Math.floor(rng() * (maxLen - minLen + 1));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CORPUS_ALPHABET[Math.floor(rng() * CORPUS_ALPHABET.length)];
  }
  return out;
}

function setAtDottedPath(root: unknown, path: string, next: string): void {
  const segments = path.split(".");
  let cursor = root as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i += 1) {
    cursor = cursor[segments[i] as string] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = next;
}

/**
 * Generate one deterministic wire-shaped sample from `rng`, spanning argv, URLs,
 * headers, nested arrays, and an extensions container. When `embedCanary` is
 * supplied, exactly one string leaf is rewritten to contain it, and its dotted
 * path is returned so a test can assert the scanner finds it.
 */
export function generateWireStringSample(rng: () => number, embedCanary?: string): WireStringSample {
  const argCount = 1 + Math.floor(rng() * 4);
  const urlCount = 1 + Math.floor(rng() * 3);
  const sample = {
    workload: {
      command: randomToken(rng, 3, 10),
      args: Array.from({ length: argCount }, () => `--${randomToken(rng, 2, 8)}=${randomToken(rng, 2, 12)}`),
    },
    urls: Array.from({ length: urlCount }, () => `https://${randomToken(rng, 3, 8)}.example.com/${randomToken(rng, 2, 10)}`),
    headers: { "x-a": randomToken(rng, 3, 12), "x-b": randomToken(rng, 3, 12) },
    nested: [[randomToken(rng, 3, 6), randomToken(rng, 3, 6)], { deep: randomToken(rng, 3, 10) }],
    extensions: [
      { namespace: "com.armyofagents.corpus", value: { note: randomToken(rng, 3, 12), list: [randomToken(rng, 2, 6), randomToken(rng, 2, 6)] } },
    ],
  };

  if (embedCanary === undefined) return { sample, canaryPath: null };

  const leafPaths: string[] = [];
  visitWireStrings(sample, (_value, path) => {
    leafPaths.push(path);
  });
  const chosen = leafPaths[Math.floor(rng() * leafPaths.length)] as string;
  setAtDottedPath(sample, chosen, `pre-${embedCanary}-post`);
  return { sample, canaryPath: chosen };
}
