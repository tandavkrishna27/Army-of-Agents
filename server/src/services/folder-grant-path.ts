// server/src/services/folder-grant-path.ts
//
// DAT-006 — PURE path-admission helpers for local-folder grants. A folder grant admits
// reads/staging of a DECLARED base; a captured path is admissible only when it is a safe
// relative POSIX path WITHIN that base, is not a symlink/special file, does not
// case-collide with a sibling, and is not a likely secret. These are pure + fully
// unit-testable (no DB, no fs) — the frozen worker-protocol path primitives are the
// authority on relative-path safety (absolute / `..` / drive / NUL / control all reject).

import { isSafeWorkspacePath, WORKSPACE_ENTRY_KINDS } from "@armyofagents/worker-protocol";

/** The frozen relative-path safety predicate (absolute, `..`, `\\`, `:`, NUL/control,
 * empty/`.`/`..` segments, over-long all reject). Re-exported so callers gate on the
 * SAME rule the frozen manifest schema enforces. */
export { isSafeWorkspacePath };

/**
 * True iff `path` is a safe relative path strictly WITHIN the safe relative `base`
 * directory — i.e. `base/<non-empty suffix>`. A path equal to the bare base (the
 * directory itself), a sibling that merely shares a name prefix (`srcx` vs `src`), or
 * any unsafe path is NOT within. `..`/absolute escapes are already rejected by
 * `isSafeWorkspacePath`; the `base + "/"` guard enforces the segment boundary.
 */
export function isPathWithinBase(base: string, path: string): boolean {
  if (!isSafeWorkspacePath(base) || !isSafeWorkspacePath(path)) return false;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return path.startsWith(prefix) && path.length > prefix.length;
}

/**
 * True iff `path` looks like a credential/secret that must be excluded from staging even
 * when it is inside the declared base (defense in depth — a grant is permission to stage
 * source, never to exfiltrate secrets). Case-insensitive over the final segment + a few
 * whole-path markers. Deliberately conservative: a real deny-list lives in the ignore
 * policy; this is the always-on floor.
 */
export function isLikelySecretPath(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (segments.some((seg) => seg === ".ssh" || seg === ".aws" || seg === ".gnupg")) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === ".netrc" || base === ".npmrc" || base === ".pgpass" || base === "credentials") return true;
  if (base === "id_rsa" || base === "id_dsa" || base === "id_ecdsa" || base === "id_ed25519") return true;
  if (/\.(pem|key|pfx|p12|keystore|jks)$/.test(base)) return true;
  return false;
}

/** A single captured workspace entry to admit against a declared base. `kind` uses the
 * frozen `WORKSPACE_ENTRY_KINDS` vocabulary plus `symlink` (which is NOT representable in
 * v1 and is always rejected — the frozen manifest has no symlink kind). */
export interface CapturedEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | string;
}

export type PathAdmissionReason =
  | "unsafe_path"
  | "out_of_base"
  | "symlink_unrepresentable"
  | "special_file"
  | "case_collision"
  | "likely_secret";

export interface PathAdmissionResult {
  admitted: string[];
  rejected: Array<{ path: string; reason: PathAdmissionReason }>;
}

const REPRESENTABLE_KINDS: ReadonlySet<string> = new Set(WORKSPACE_ENTRY_KINDS);

/**
 * Admit a set of captured entries against a declared base. An entry is admitted only when
 * it is a safe relative path, is within the base, is a representable kind (`file`/
 * `directory` — a `symlink` is unrepresentable; anything else is a special file), does not
 * case-collide with another admitted path, and is not a likely secret. Order-stable; the
 * first path in a case-collision set is admitted and the later collider is rejected
 * (mirroring the frozen `addPathCollisionIssues` convention).
 */
export function admitCapturedPaths(declaredBasePath: string, entries: readonly CapturedEntry[]): PathAdmissionResult {
  const admitted: string[] = [];
  const rejected: Array<{ path: string; reason: PathAdmissionReason }> = [];
  const seenLower = new Set<string>();
  for (const entry of entries) {
    const { path, kind } = entry;
    if (kind === "symlink") { rejected.push({ path, reason: "symlink_unrepresentable" }); continue; }
    if (!isSafeWorkspacePath(path)) { rejected.push({ path, reason: "unsafe_path" }); continue; }
    if (!REPRESENTABLE_KINDS.has(kind)) { rejected.push({ path, reason: "special_file" }); continue; }
    if (!isPathWithinBase(declaredBasePath, path)) { rejected.push({ path, reason: "out_of_base" }); continue; }
    if (isLikelySecretPath(path)) { rejected.push({ path, reason: "likely_secret" }); continue; }
    const lower = path.toLowerCase();
    if (seenLower.has(lower)) { rejected.push({ path, reason: "case_collision" }); continue; }
    seenLower.add(lower);
    admitted.push(path);
  }
  return { admitted, rejected };
}
