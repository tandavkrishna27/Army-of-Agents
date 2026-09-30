// packages/worker-keystore/src/install-layout.ts
//
// DSK-004 Lane C — the side-by-side layout, the `current` pointer, and the swap plan.
//
// The ticket's clause (5) is "power loss recovers to one valid version". The usual
// answer is crash-recovery machinery: a journal, resume-from-step, a repair pass. Design
// D1 takes the cheaper and stronger route instead — versions install SIDE BY SIDE under
// their own directories and a single pointer names the live one — because then there is
// no state in which half a version is live. The pointer holds the old value or the new
// one. Clause (5) stops being recovery logic and becomes an invariant.
//
// Two consequences worth stating, since they are why this file is mostly pure:
//
//   ROLLBACK IS NOT AN UNDO. The previous version is still on disk, so rolling back is
//   pointing back. `planRollback` therefore REFUSES when the previous version is absent
//   rather than attempting to reconstruct it — a rollback that has to rebuild something
//   is a rollback that can itself fail, at the moment an operator least wants that.
//
//   HEALTH GATES THE SWAP, NOT THE UNPACK. Unpack, verify, start the new version,
//   confirm health, and only then move the pointer. Clause (4)'s "failed health
//   confirmation rolls back" is a no-op here instead of a compensating action.
//
// A VERSION STRING IS A DIRECTORY NAME. It arrives from an update manifest, and the
// design did not call this out: `..` in that field is a path traversal executed with the
// installer's privileges. A signature proves who published the manifest; it does not
// make a field safe to concatenate into a path. Validated here as its own boundary.
//
// Pure: no filesystem access, no `process`. The caller does the IO, which keeps every
// rule provable on the ubuntu-only required lane — the same decomposition the rest of
// this package uses.

/** Fixed, versioned names. A bump is a deliberate migration, never an accident. */
const VERSIONS_DIR_NAME = "versions";
const POINTER_FILE_NAME = "current.v1.json";

/**
 * Windows MAX_PATH is 260 and this package is win32-only, so an absurd version name is
 * a way to make the install path unusable rather than merely ugly.
 */
const MAX_VERSION_SEGMENT_LENGTH = 64;

/**
 * Must begin with an alphanumeric, which is what excludes `.`, `..` and any leading
 * separator; the body admits exactly the punctuation semver uses. `/`, `\`, `:` and
 * control characters are absent from the class, so traversal, drive-relative paths and
 * NUL injection are all refused by the same rule rather than by a list of special cases.
 */
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Windows reserved device names, matched on the segment up to the FIRST dot.
 *
 * Measured rather than assumed: Node's `fs` uses the `\\?\` prefix, so it creates a
 * directory literally named `NUL.1.0` and reads back from it without complaint. The
 * hazard lives at the BOUNDARY. DSK-003 writes the install path into an autostart
 * manifest that Task Scheduler consumes, and Win32 normalization does apply there —
 * `versions\NUL.1.0\worker.exe` resolves to the null device for the launcher while Node
 * sees an ordinary directory. Refusing the name costs nothing and removes the entire
 * class of divergence between "the directory we created" and "the path the launcher
 * opens".
 */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Drive-letter absolute only. A UNC root would put the install on a share. */
const DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;

export type SwapRefusalReason =
  | "malformed_input"
  | "unsafe_version"
  | "not_admitted"
  | "incompatible"
  | "already_current"
  | "health_unconfirmed"
  | "no_previous_version"
  | "previous_version_absent";

export type SwapPlan =
  | { readonly action: "swap"; readonly pointerTarget: string }
  | {
      readonly action: "refuse";
      readonly pointerTarget: string | null;
      readonly reason: SwapRefusalReason;
    };

export interface InstallLayout {
  /** The directory holding one subdirectory per installed version. */
  readonly versionsDir: string;
  /** The single file naming the live version. */
  readonly pointerPath: string;
  /** The directory for one version. Throws on a segment that would escape. */
  versionDir(version: string): string;
}

export function isSafeVersionSegment(version: unknown): boolean {
  if (typeof version !== "string") return false;
  if (version.length > MAX_VERSION_SEGMENT_LENGTH) return false;
  if (!SAFE_VERSION_PATTERN.test(version)) return false;
  // Win32 strips a trailing dot, so `0.1.0.` and `0.1.0` name the same directory to a
  // launcher while remaining different strings to us — the pointer would record one and
  // the launcher open the other, and a rollback comparing them would call a version that
  // is sitting right there absent.
  if (version.endsWith(".")) return false;
  return !WINDOWS_RESERVED_DEVICE_NAMES.has(version.split(".")[0]!.toLowerCase());
}

/**
 * Fold a path to a form two paths can be compared in: separators unified, case dropped
 * (win32 is case-insensitive), `.`/`..` collapsed, trailing separators removed.
 *
 * The traversal collapse is the part that matters. Without it `C:\AoA\..\Other` compares
 * as a child of `C:\AoA`, and the containment assertion below would pass for a vault that
 * is in fact somewhere else entirely.
 */
export function normalizePathForComparison(candidate: unknown): string {
  const unified = String(candidate ?? "").replaceAll("\\", "/").toLowerCase();
  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Nothing a containment question can be asked about.
 *
 * The whitespace case is the one worth spelling out: `"   "` survives normalization as a
 * segment, because a path segment may legitimately contain spaces (`Program Files`). It
 * is still not a path, and my first version of this guard let it through — the trimmed
 * test is what makes the refusal cover it.
 */
function isUnusablePath(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.trim() === "") return true;
  return normalizePathForComparison(candidate) === "";
}

/**
 * Containment, with the prefix trap closed.
 *
 * `child.startsWith(parent)` reports `C:\AoA2` as living inside `C:\AoA`, because string
 * prefixes do not respect path boundaries. The separator in the comparison is what makes
 * this a path question rather than a text one.
 */
export function isPathInside(parent: unknown, child: unknown): boolean {
  const normalizedParent = normalizePathForComparison(parent);
  const normalizedChild = normalizePathForComparison(child);
  if (normalizedParent === "" || normalizedChild === "") return false;
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

/**
 * Clause (3) — device identity and outbox survive an update — is satisfied by LAYOUT, not
 * by code: the vault lives under `%LOCALAPPDATA%` (`resolveControlPaths`), which a version
 * swap never goes near. This states that dependency out loud so a later tidy-up that moves
 * the vault under the install root fails here instead of silently deleting a device
 * identity on the next update.
 */
export function assertVaultOutsideInstallRoot(installRoot: unknown, vaultPath: unknown): void {
  // REFUSE TO ANSWER RATHER THAN ANSWER "SAFE". `isPathInside` returns false for an empty
  // path, which is the correct answer to "is A inside B" and the wrong basis for "I have
  // verified the vault is safe" — an installer that computed an empty root would be told
  // the layout had been checked when nothing was compared. This programme has produced
  // that failure — a guard passing because it could not evaluate anything — often enough
  // to be worth two explicit lines.
  if (isUnusablePath(installRoot)) {
    throw new Error(
      `worker-keystore: cannot check vault containment against install root ${JSON.stringify(installRoot)}`,
    );
  }
  if (isUnusablePath(vaultPath)) {
    throw new Error(
      `worker-keystore: cannot check containment of vault path ${JSON.stringify(vaultPath)}`,
    );
  }
  if (isPathInside(installRoot, vaultPath)) {
    throw new Error(
      `worker-keystore: the device vault (${String(vaultPath)}) is inside the install root ` +
        `(${String(installRoot)}); a version swap would destroy the device identity`,
    );
  }
}

export function resolveInstallLayout(installRoot: unknown): InstallLayout {
  if (typeof installRoot !== "string" || !DRIVE_ABSOLUTE_PATTERN.test(installRoot)) {
    throw new Error(
      `worker-keystore: install root must be a drive-letter absolute path, got ${JSON.stringify(installRoot)}`,
    );
  }
  const root = installRoot.replace(/[\\/]+$/, "");
  const versionsDir = `${root}\\${VERSIONS_DIR_NAME}`;
  return {
    versionsDir,
    pointerPath: `${root}\\${POINTER_FILE_NAME}`,
    versionDir(version: string): string {
      if (!isSafeVersionSegment(version)) {
        throw new Error(`worker-keystore: unsafe version segment ${JSON.stringify(version)}`);
      }
      return `${versionsDir}\\${version}`;
    },
  };
}

export interface UpdateSwapInput {
  readonly currentVersion: string;
  readonly candidateVersion: string;
  readonly admitted: boolean;
  readonly compatible: boolean;
  readonly healthConfirmed: boolean;
}

function refuse(pointerTarget: string | null, reason: SwapRefusalReason): SwapPlan {
  return { action: "refuse", pointerTarget, reason };
}

/**
 * Decide whether the pointer moves.
 *
 * ORDER IS PART OF THE CONTRACT. Shape and path-safety come first, because they are
 * statements about whether the input can be used at all. Admission comes next so an
 * unsigned or revoked build is REPORTED as unsigned — running the cheaper protocol check
 * first would describe an attacker-supplied build as merely "incompatible" and send an
 * operator to look at version ranges. Health is last because it is the only check that
 * costs a process start.
 *
 * On every refusal the pointer target is the CURRENT version: the plan says explicitly
 * where the pointer ends up, so a caller cannot mistake "refused" for "undefined".
 */
export function planUpdateSwap(input: UpdateSwapInput): SwapPlan {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return refuse(null, "malformed_input");
  }
  const { currentVersion, candidateVersion, admitted, compatible, healthConfirmed } = input;
  if (typeof currentVersion !== "string" || typeof candidateVersion !== "string") {
    return refuse(null, "malformed_input");
  }
  if (!isSafeVersionSegment(currentVersion) || !isSafeVersionSegment(candidateVersion)) {
    return refuse(currentVersion, "unsafe_version");
  }
  if (admitted !== true) return refuse(currentVersion, "not_admitted");
  if (compatible !== true) return refuse(currentVersion, "incompatible");
  if (candidateVersion === currentVersion) return refuse(currentVersion, "already_current");
  if (healthConfirmed !== true) return refuse(currentVersion, "health_unconfirmed");
  return { action: "swap", pointerTarget: candidateVersion };
}

export interface RollbackInput {
  readonly currentVersion: string;
  readonly previousVersion: string | null;
  readonly installedVersions: readonly string[];
}

/**
 * Roll back by pointing at a version that is already on disk.
 *
 * The refusal when it is absent is the point, not an omission: reconstructing is the one
 * thing a rollback must never have to do.
 */
export function planRollback(input: RollbackInput): SwapPlan {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return refuse(null, "malformed_input");
  }
  const { currentVersion, previousVersion, installedVersions } = input;
  if (typeof currentVersion !== "string" || !Array.isArray(installedVersions)) {
    return refuse(null, "malformed_input");
  }
  // Before the safety check, so "there is nothing to roll back to" is never reported as
  // "the version name is malformed".
  if (previousVersion === null || previousVersion === undefined) {
    return refuse(currentVersion, "no_previous_version");
  }
  if (!isSafeVersionSegment(currentVersion) || !isSafeVersionSegment(previousVersion)) {
    return refuse(currentVersion, "unsafe_version");
  }
  if (!installedVersions.includes(previousVersion)) {
    return refuse(currentVersion, "previous_version_absent");
  }
  return { action: "swap", pointerTarget: previousVersion };
}
