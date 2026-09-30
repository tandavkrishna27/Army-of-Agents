/**
 * Ignore-policy evaluation + digest attribution (DAT-001-D4).
 *
 *   - `git_commit` base → `gitignore_plus_aoa`. GIT is the ignore engine (the
 *     producer enumerates with `--exclude-standard` and does NOT re-implement
 *     gitignore semantics). The digest attributes the ACTUAL rules in force: the
 *     ordered (by UTF-8 path) list of every `.gitignore` present in the tree
 *     (`{path, sha256}`) plus the pinned AOA built-in rule set.
 *   - `content_manifest` base → `explicit`. The caller supplies an ordered rule
 *     list; the producer applies a PINNED MINIMAL matcher — each rule is one of:
 *     an exact relative path, a `dir/` path-prefix, or a `*.ext` suffix — NOT
 *     full gitignore semantics (richer semantics are a documented §8 residual).
 *     Ignored files are dropped before entry-building (leakage fail-closed); an
 *     empty rule list includes all non-special entries.
 */

import { canonicalizeJsonV1 } from "@armyofagents/worker-protocol";

import type { Sha256Fn } from "./hashing.js";

/** The ignore policy the caller declares; the kind must match the base kind. */
export type IgnorePolicyInput =
  | { readonly kind: "gitignore_plus_aoa" }
  | { readonly kind: "explicit"; readonly rules: readonly string[] };

/**
 * The PINNED AOA built-in ignore rule set. It is BOTH folded into the digest
 * (attribution) AND independently APPLIED during enumeration: these rules are the
 * overlay that keeps the `.aoa/` keystore dir out of a snapshot and makes the
 * attested policy match what was applied.
 *
 * IT APPLIES TO BOTH BASES. On `gitignore_plus_aoa`, git's `--exclude-standard`
 * covers `.gitignore` only, so `captureGitBase` drops matching paths (Finding B).
 * On `content_manifest` the rules arrive from the CALLER, and a caller who passes
 * an empty list is not thereby asking to snapshot the keystore — so
 * `resolveEffectiveExplicitRules` puts this set underneath every explicit policy.
 * That asymmetry was a live key-material leak: `build-manifest.ts` walked
 * `input.ignore.rules` directly, so `rules: []` captured `.aoa/` byte-for-byte.
 *
 * `.git/` is a no-op on the git base (git never lists it) kept for an explicit,
 * versioned marker; on the content base it does real work. Changing this constant
 * changes every ignore digest of both kinds and their frozen vectors.
 */
export const AOA_BUILTIN_IGNORE_RULES: readonly string[] = [".git/", ".aoa/"];

/** A discovered `.gitignore` source, attributed into the git-base digest. */
export interface GitignoreSource {
  readonly path: string;
  readonly sha256: string;
}

type ExplicitRule =
  | { readonly type: "exact"; readonly value: string }
  | { readonly type: "dir"; readonly value: string }
  | { readonly type: "ext"; readonly value: string };

/** Classify one explicit rule string into the pinned minimal grammar. */
export function classifyExplicitRule(rule: string): ExplicitRule {
  if (rule.endsWith("/")) {
    return { type: "dir", value: rule.slice(0, -1) };
  }
  if (rule.startsWith("*.")) {
    return { type: "ext", value: rule.slice(1) }; // ".ext"
  }
  return { type: "exact", value: rule };
}

/**
 * True iff the normalized relative path is ignored by the explicit rule list.
 * `dir/` matches the directory itself and everything below it; `*.ext` matches by
 * suffix; an exact rule matches the whole path.
 */
export function isIgnoredByExplicit(relPath: string, rules: readonly string[]): boolean {
  for (const rule of rules) {
    const classified = classifyExplicitRule(rule);
    if (classified.type === "exact") {
      if (relPath === classified.value) return true;
    } else if (classified.type === "dir") {
      if (relPath === classified.value || relPath.startsWith(`${classified.value}/`)) return true;
    } else if (relPath.endsWith(classified.value)) {
      return true;
    }
  }
  return false;
}

/**
 * The rule list an `explicit` policy ACTUALLY enforces: the pinned AOA built-ins
 * underneath the caller's own rules, in the caller's order.
 *
 * ONE resolved value feeds BOTH the walk and the digest, which is the invariant
 * that matters — `git-base.ts` states it as "makes the attested policy match what
 * was applied", and the content base broke it by deriving the digest from one list
 * and walking another.
 *
 * A caller who redundantly restates a built-in is deduplicated rather than given a
 * forked digest, so the digest is a function of the effective POLICY and not of how
 * it was spelled. That also makes this IDEMPOTENT — `resolve(resolve(x))` equals
 * `resolve(x)` — which is what lets `computeExplicitIgnoreDigest` call it
 * unconditionally without double-prepending for callers who pass a resolved list.
 */
export function resolveEffectiveExplicitRules(rules: readonly string[]): readonly string[] {
  const builtins = new Set(AOA_BUILTIN_IGNORE_RULES);
  return [...AOA_BUILTIN_IGNORE_RULES, ...rules.filter((rule) => !builtins.has(rule))];
}

/**
 * Compute the `explicit` ignore-policy digest (order-preserving over rules).
 *
 * Digests the EFFECTIVE rules, never the caller's raw list: a digest over the raw
 * list would attest a weaker policy than the one enforced, which is the same class
 * of dishonesty as the leak it guards against.
 */
export function computeExplicitIgnoreDigest(rules: readonly string[], sha256: Sha256Fn): string {
  return sha256(canonicalizeJsonV1({ kind: "explicit", rules: [...resolveEffectiveExplicitRules(rules)] }));
}

/**
 * Compute the `gitignore_plus_aoa` ignore-policy digest over the AOA built-in
 * rule set plus the discovered `.gitignore` sources (sorted by UTF-8 path).
 */
export function computeGitignoreDigest(sources: readonly GitignoreSource[], sha256: Sha256Fn): string {
  const encoder = new TextEncoder();
  const sorted = [...sources].sort((a, b) => {
    const ba = encoder.encode(a.path);
    const bb = encoder.encode(b.path);
    const len = Math.min(ba.length, bb.length);
    for (let i = 0; i < len; i += 1) {
      if (ba[i] !== bb[i]) return ba[i] < bb[i] ? -1 : 1;
    }
    return ba.length - bb.length;
  });
  return sha256(
    canonicalizeJsonV1({
      kind: "gitignore_plus_aoa",
      aoaBuiltinRules: [...AOA_BUILTIN_IGNORE_RULES],
      sources: sorted.map((source) => ({ path: source.path, sha256: source.sha256 })),
    }),
  );
}
