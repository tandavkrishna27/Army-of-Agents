/**
 * Deterministic snapshot hashing (DAT-001-D3).
 *
 * Two pinned digests, both over the SINGLE canonicalizer `canonicalizeJsonV1`
 * (imported from the frozen `@armyofagents/worker-protocol` — RFC-8785 subset,
 * dependency-free, runtime-safe for worker-daemon per DAT-001-D1). The SHA-256
 * provider is INJECTED (test seam; lowercase hex), mirroring the injected-hash
 * shape in `identity/device-proof.ts`.
 *
 *   - `contentRevision` — the repeatable CONTENT identity: excludes capture
 *     metadata (`snapshotProvenance`) and `dirty`, so the same tree yields the
 *     same value on every capture. Used as `base.revision` for a
 *     `content_manifest` base (git base uses the git HEAD sha instead).
 *   - `manifestHash` — over the FULLY-built manifest (includes capture metadata),
 *     so it identifies THIS capture. This is the value DAT-002 commits.
 *
 * Entry order is the SOLE ordering authority (canonicalizeJsonV1 PRESERVES array
 * order): ascending by the UTF-8 byte sequence of the normalized path. Paths are
 * unique post-collision-check, so the order is total and deterministic.
 */

import { canonicalizeJsonV1 } from "@armyofagents/worker-protocol";

/** Lowercase sha256-hex provider over utf8/bytes (the injected test seam). */
export type Sha256Fn = (bytes: Buffer | Uint8Array | string) => string;

/** A structurally-plain workspace entry (branded by the schema on `.parse()`). */
export interface SnapshotEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly provenance: "tracked" | "untracked" | "generated";
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly executable: boolean;
}

/** The ignore-policy record embedded in the base + hashed into `contentRevision`. */
export interface IgnorePolicyRecord {
  readonly kind: "gitignore_plus_aoa" | "explicit";
  readonly digest: string;
}

/** The inclusion record embedded in the base + hashed into `contentRevision`. */
export interface InclusionRecord {
  readonly tracked: true;
  readonly untracked: "include" | "exclude";
  readonly ignored: false;
}

/**
 * Compare two paths by their UTF-8 byte sequence (NOT JS's default UTF-16
 * code-unit order — the two diverge for supplementary-plane code points). This
 * is the pinned total order over the (unique) normalized entry paths.
 */
export function compareUtf8(a: string, b: string): number {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.min(ba.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    if (ba[i] !== bb[i]) return ba[i] < bb[i] ? -1 : 1;
  }
  if (ba.length === bb.length) return 0;
  return ba.length < bb.length ? -1 : 1;
}

/** Return a new array of entries sorted by the UTF-8 byte order of their path. */
export function sortSnapshotEntries(entries: readonly SnapshotEntry[]): SnapshotEntry[] {
  return [...entries].sort((x, y) => compareUtf8(x.path, y.path));
}

/**
 * The repeatable content-identity digest (DAT-001-D3). Excludes capture metadata
 * and `dirty`; `entries` MUST already be sorted by {@link sortSnapshotEntries}.
 */
export function computeContentRevision(
  input: {
    readonly caseMode: "sensitive" | "insensitive_preserving";
    readonly ignorePolicy: IgnorePolicyRecord;
    readonly inclusion: InclusionRecord;
    readonly entries: readonly SnapshotEntry[];
  },
  sha256: Sha256Fn,
): string {
  const canonical = canonicalizeJsonV1({
    v: 1,
    caseMode: input.caseMode,
    ignorePolicy: { kind: input.ignorePolicy.kind, digest: input.ignorePolicy.digest },
    inclusion: { tracked: input.inclusion.tracked, untracked: input.inclusion.untracked, ignored: input.inclusion.ignored },
    entries: input.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      provenance: entry.provenance,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      executable: entry.executable,
    })),
  });
  return sha256(canonical);
}

/**
 * The per-capture manifest digest (DAT-001-D3): sha256 over the canonicalized
 * fully-built manifest. `canonicalizeJsonV1` sorts object keys, so the digest is
 * key-order-independent but array-order-sensitive (entries are pre-sorted).
 */
export function computeManifestHash(manifest: unknown, sha256: Sha256Fn): string {
  return sha256(canonicalizeJsonV1(manifest));
}
