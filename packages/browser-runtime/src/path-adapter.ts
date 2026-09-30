// packages/browser-runtime/src/path-adapter.ts
//
// BRW-002 — confine a browser download to the per-job root.
//
// TWO THINGS PLAN REVIEW ESTABLISHED, and both shape this module:
//
//  1. THE CHECK MUST ASK THE FILESYSTEM. A string function cannot see a symlink, and a page
//     that can cause a directory to be created can plant one. So the deepest EXISTING
//     ancestor of the target is resolved with `realpath` and compared against the resolved
//     root. This mirrors the host-side `assertCaptureRoot`, which is a filesystem check for
//     exactly this reason.
//
//  2. THE ESCAPABLE SURFACE IS `download.saveAs(path)`, NOT the suggested filename. Chromium
//     pre-sanitises `suggestedFilename` (measured: `../../escape.txt` arrives as
//     `_.._escape.txt`) and stages the bytes under a GUID, so a test that feeds hostile
//     Content-Disposition names proves nothing. `saveAs` takes a caller-supplied path, and
//     that is what this guards.
//
// The target of a download does NOT exist when it is checked — that is the normal case, not
// an edge case — so resolving the candidate itself would throw on every legitimate download.
// The deepest existing ancestor is resolved instead.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export type PathRefusal = "unusable_name" | "outside_root" | "root_missing";

export type ResolvedUnderRoot =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: PathRefusal; readonly detail: string };

/** Most filesystems cap a single component at 255 bytes. */
const MAX_NAME_LENGTH = 255;

/** True if the string contains a C0 control character, DEL, or NUL. */
function hasControlByte(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reduce an attacker-influenced suggested filename to a safe basename, or `null` if nothing
 * usable remains.
 *
 * Directory components are STRIPPED (the name is advisory, so keeping the basename is the
 * useful behaviour), but control bytes are REFUSED rather than stripped: silently rewriting
 * a name hides that the input was hostile, and a NUL truncates a path in any C-based syscall
 * layer beneath us.
 */
export function safeDownloadName(suggested: string): string | null {
  if (typeof suggested !== "string" || suggested === "") return null;
  if (hasControlByte(suggested)) return null;

  // Split on BOTH separators regardless of platform: a name arriving from a website is not
  // bound by the host's convention, and `path.basename` would keep `a\b.exe` whole on POSIX.
  const segments = suggested.split(/[/\\]+/);
  const last = segments[segments.length - 1] ?? "";
  if (last === "" || last === "." || last === "..") return null;
  // A leading dot would turn a download into a dotfile (`.bashrc`, `.npmrc`).
  if (last.startsWith(".")) return null;

  if (last.length <= MAX_NAME_LENGTH) return last;
  // Truncate from the STEM so the extension survives — the extension is what decides how the
  // artifact is later interpreted.
  const { name, ext } = parse(last);
  const room = Math.max(1, MAX_NAME_LENGTH - ext.length);
  return `${name.slice(0, room)}${ext}`.slice(0, MAX_NAME_LENGTH);
}

/** Resolve the deepest ancestor of `target` that exists on disk. */
function resolveDeepestExistingAncestor(target: string): string | null {
  let current = target;
  // Bounded by the path depth; `dirname` is idempotent at the root, which ends the loop.
  for (let depth = 0; depth < 4096; depth += 1) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

/**
 * Resolve `candidate` against `root` and confirm the result really is inside it.
 *
 * `candidate` may be a bare name, a relative path, or an absolute path — an absolute path
 * that lands outside the root is refused rather than silently re-rooted, because silently
 * re-rooting would make the caller believe a destination they did not choose.
 */
export function resolveUnderRoot(root: string, candidate: string): ResolvedUnderRoot {
  if (typeof candidate !== "string" || candidate === "" || hasControlByte(candidate)) {
    return { ok: false, reason: "unusable_name", detail: "candidate is empty or contains a control byte" };
  }

  let resolvedRoot: string;
  try {
    // Resolve the root itself: it may be reached through a symlink, and comparing against an
    // unresolved root would make every path under it look foreign.
    resolvedRoot = realpathSync(resolve(root));
  } catch {
    // Fail CLOSED. Creating the root here would let a typo silently relocate every download.
    return { ok: false, reason: "root_missing", detail: `download root ${root} does not exist` };
  }

  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(resolvedRoot, candidate);

  const existingAncestor = resolveDeepestExistingAncestor(target);
  if (existingAncestor === null) {
    return { ok: false, reason: "outside_root", detail: "no existing ancestor could be resolved" };
  }

  // The resolved ancestor must BE the root or sit under it. The `+ sep` guard stops
  // `/job-root-evil` from passing a naive prefix test against `/job-root`.
  const withinRoot =
    existingAncestor === resolvedRoot || existingAncestor.startsWith(resolvedRoot + sep);
  if (!withinRoot) {
    return {
      ok: false,
      reason: "outside_root",
      detail: `${target} resolves outside ${resolvedRoot} (via ${existingAncestor})`,
    };
  }

  // Re-anchor the unresolved remainder onto the resolved ancestor so the returned path
  // carries no unresolved symlink component.
  const remainder = target.slice(existingAncestor.length).replace(/^[\\/]+/, "");
  return { ok: true, path: remainder === "" ? existingAncestor : join(existingAncestor, remainder) };
}
