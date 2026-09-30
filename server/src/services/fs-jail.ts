import fs from "node:fs/promises";
import path from "node:path";

/**
 * WS0a jail-hardening utilities. Used ONLY when
 * `resolveCompanyWorkspaceRoot()` returns `jailed: true` (authenticated /
 * multi-tenant deployment mode). local_trusted mode does not call any of
 * these — the founder browses their real filesystem unjailed.
 *
 * Containment strategy (per the WS0a spec):
 *   1. Cheap lexical pre-check (path.resolve + separator/case-safe prefix
 *      compare) rejects the common `..` / absolute-outside cases before we
 *      touch the filesystem.
 *   2. realpath() both the jail base and the target, then re-run the same
 *      containment check on the REAL paths. This defeats a symlink placed
 *      inside the jail whose target escapes it (the lexical path looks
 *      contained; the real path does not).
 *   3. For mkdir (target doesn't exist yet), walk up to the nearest
 *      EXISTING ancestor, realpath *that*, and check containment on it —
 *      then re-check again after the actual mkdir() call as a best-effort
 *      guard against a symlink swapped in between the check and the
 *      filesystem operation (TOCTOU / "symlink-replace race").
 */

export type JailCheckResult =
  | { ok: true; resolvedPath: string }
  | { ok: false; reason: "outside_jail" | "not_found" };

const CASE_INSENSITIVE_PLATFORMS = new Set(["win32", "darwin"]);

function normalizeForCompare(p: string): string {
  const normalized = path.normalize(p);
  return CASE_INSENSITIVE_PLATFORMS.has(process.platform) ? normalized.toLowerCase() : normalized;
}

/**
 * Separator/case-safe containment check: true iff `candidate` is `base`
 * itself or a descendant of it. Uses `path.relative` rather than
 * `startsWith()` so a prefix-collision sibling like `/base/co2` is never
 * mistaken for a descendant of `/base/co`, and checks for a `..` path
 * SEGMENT (not just a `..`-prefixed string) so a real subdirectory literally
 * named e.g. `..foo` isn't wrongly rejected.
 */
export function isPathContained(base: string, candidate: string): boolean {
  const normBase = normalizeForCompare(path.resolve(base));
  const normCandidate = normalizeForCompare(path.resolve(candidate));
  if (normBase === normCandidate) return true;
  const rel = path.relative(normBase, normCandidate);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  // path.relative can return POSIX-style ".." segments on some platforms
  // regardless of path.sep; guard both forms defensively.
  if (rel.startsWith("../") || rel.startsWith("..\\")) return false;
  return true;
}

/**
 * Contains a BROWSE target (must already exist) inside `jailBaseDir`.
 *
 * Deliberate asymmetry with the mkdir path (which additionally runs
 * `verifyCreatedDirStillContained` AFTER the syscall): there is intentionally
 * no post-`readdir` re-check here. The residual TOCTOU — swapping the final
 * resolved component for an out-of-jail symlink between this realpath check and
 * the caller's `readdir` — requires WRITE access to the server-owned jail dir
 * mid-request, i.e. an already-compromised host that can read the target
 * directly and defeat the jail regardless. Browse is also read-only: the worst
 * case leaks out-of-jail directory ENTRY NAMES, not contents or any write.
 * mkdir is guarded because it WRITES (a redirected create could clobber files
 * outside the jail — an integrity stake browse doesn't carry). A post-read
 * re-check would only shrink, not close, that window while adding a syscall on
 * every browse. If the browse route ever starts reading file CONTENTS (not just
 * names), revisit this and add a symmetric post-read containment re-check.
 */
export async function containBrowsePath(
  jailBaseDir: string,
  requestedPath: string,
): Promise<JailCheckResult> {
  const lexicallyResolved = path.resolve(requestedPath);
  if (!isPathContained(jailBaseDir, lexicallyResolved)) {
    return { ok: false, reason: "outside_jail" };
  }

  let realBase: string;
  try {
    realBase = await fs.realpath(jailBaseDir);
  } catch {
    return { ok: false, reason: "not_found" };
  }

  let realTarget: string;
  try {
    realTarget = await fs.realpath(lexicallyResolved);
  } catch {
    return { ok: false, reason: "not_found" };
  }

  if (!isPathContained(realBase, realTarget)) {
    return { ok: false, reason: "outside_jail" };
  }

  return { ok: true, resolvedPath: realTarget };
}

/**
 * Contains an MKDIR target (does not exist yet, possibly several levels
 * deep — mkdir is called with `recursive: true`) inside `jailBaseDir`.
 * Walks up from the target to the nearest EXISTING ancestor and realpath's
 * *that*, so a symlink anywhere in the not-yet-existing chain — including
 * one placed at an intermediate segment — can't be used to escape the jail.
 */
export async function containMkdirPath(
  jailBaseDir: string,
  requestedPath: string,
): Promise<JailCheckResult> {
  const lexicallyResolved = path.resolve(requestedPath);
  if (!isPathContained(jailBaseDir, lexicallyResolved)) {
    return { ok: false, reason: "outside_jail" };
  }

  let realBase: string;
  try {
    realBase = await fs.realpath(jailBaseDir);
  } catch {
    return { ok: false, reason: "not_found" };
  }

  let probe = lexicallyResolved;
  let tail: string | null = null;
  // Bounded by path depth — cannot loop forever since dirname() strictly
  // shortens the path until it reaches the filesystem root.
  for (;;) {
    try {
      const realProbe = await fs.realpath(probe);
      if (!isPathContained(realBase, realProbe)) {
        return { ok: false, reason: "outside_jail" };
      }
      const resolvedTarget = tail ? path.join(realProbe, tail) : realProbe;
      // Re-run containment on the fully re-joined target too — defends
      // against a realpath'd ancestor whose case/separator form would
      // otherwise slip past a naive re-join.
      if (!isPathContained(realBase, resolvedTarget)) {
        return { ok: false, reason: "outside_jail" };
      }
      return { ok: true, resolvedPath: resolvedTarget };
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        // Reached filesystem root without finding an existing ancestor.
        return { ok: false, reason: "not_found" };
      }
      const segment = path.basename(probe);
      tail = tail ? path.join(segment, tail) : segment;
      probe = parent;
    }
  }
}

/**
 * Best-effort symlink-replace-race guard: after an mkdir has actually
 * happened, realpath the freshly-created directory and confirm it is STILL
 * contained in the jail. If a symlink was swapped in at any point in the
 * chain between the pre-check and the mkdir syscall, this catches it after
 * the fact so the caller can roll back (remove the directory) and reject.
 */
export async function verifyCreatedDirStillContained(
  jailBaseDir: string,
  createdPath: string,
): Promise<boolean> {
  try {
    const realBase = await fs.realpath(jailBaseDir);
    const realCreated = await fs.realpath(createdPath);
    return isPathContained(realBase, realCreated);
  } catch {
    return false;
  }
}
