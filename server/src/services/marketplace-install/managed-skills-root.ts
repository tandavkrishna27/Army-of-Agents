/**
 * @fileoverview The managed marketplace-skills root, and the containment check
 * that jails it (plan task T2.8c(b)).
 *
 * `managedCatalogSkillDir(...)` materializes every catalog skill bundle under
 * the selected fixed managed root at `<company>/<item>/<version>`. The catalog
 * installer is the ONLY writer that tree is meant to have: a re-materialize
 * stages-and-renames a fresh copy of the upstream tree, and `trustLevel` /
 * `fileInventory` on the row describe exactly those bytes. Anything else
 * writing there would make the row's description of what an agent executes a
 * lie.
 *
 * Two founder-reachable chains could otherwise get a differently-typed row —
 * one whose editability is gated on its `sourceType`, not on its path — to name
 * a directory inside this root and then write into it:
 *
 *   - `POST /companies/:cid/skills/import` with `source` set to a bundle dir
 *     produces a `local_path` row, after which `PATCH /skills/:id/files` writes
 *     inside it.
 *   - `PATCH /agents/:id/instructions-bundle` with `mode: "external"` accepts
 *     any absolute `rootPath`, then both writes and `fs.rm`s inside it.
 *
 * {@link isInsideManagedMarketplaceSkillsRoot} lets both chains reject such a
 * path with one shared check rather than two divergent copies.
 *
 * Containment is `path.resolve`-based, matching the rest of the server's jails
 * (`resolvePathWithinRoot` in `agent-instructions.ts`,
 * `validatePackageFileKey`). When the backing filesystem is case-insensitive
 * (detected by probing the managed root's nearest existing ancestor, not guessed
 * from the OS) the compared paths are lower-cased first, so a case-variant like
 * `.AOA\Marketplace-Skills\…`
 * — which names the SAME directory the OS would open — cannot slip past a
 * case-sensitive string compare and defeat the jail. It does NOT resolve
 * symlinks, 8.3 short names
 * (`MARKET~1`), or UNC/`\\?\` prefixes; the threat model is an authenticated
 * founder holding an invariant, not an anonymous escape, and those vectors are
 * consistent with the rest of the codebase's `path.resolve` jails.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { resolveAoaInstanceRoot } from "../../home-paths.js";

const cachedCaseInsensitiveByRoot = new Map<string, boolean>();

/**
 * Whether the filesystem backing the managed root treats differently-cased
 * paths as the same directory. Probed by case-flipping an existing entry inside
 * **the managed root's nearest existing ancestor** — so the lookup happens on
 * the filesystem the managed tree actually lives on, even when `.aoa` is a
 * separate mount from `process.cwd()` — rather than guessed from
 * `process.platform`. So a case-insensitive mount on Linux, or a case-sensitive
 * volume on macOS, is classified correctly instead of by a brittle OS default.
 *
 * Cached after the first *conclusive* probe, i.e. one taken at or below `.aoa`
 * (the managed area). If `.aoa` does not exist yet the probe walks up to cwd,
 * whose filesystem may differ from the mount `.aoa` will later live on, so that
 * result is used but NOT cached — the next call re-probes once the tree exists.
 * Exported so the containment test observes the same signal instead of
 * re-deriving (and drifting from) it.
 */
export function isCaseInsensitiveFilesystem(
  managedRoot = managedMarketplaceSkillsRoot(),
): boolean {
  const cacheKey = path.resolve(managedRoot);
  const cached = cachedCaseInsensitiveByRoot.get(cacheKey);
  if (cached !== undefined) return cached;
  const { value, cacheable } = probeCaseInsensitive(cacheKey);
  if (cacheable) cachedCaseInsensitiveByRoot.set(cacheKey, value);
  return value;
}

function probeCaseInsensitive(
  managedRoot: string,
): { value: boolean; cacheable: boolean } {
  const platformDefault = process.platform === "win32" || process.platform === "darwin";
  try {
    const managedParent = path.dirname(managedRoot); // `<cwd>/.aoa`
    // Walk up from the managed root to the nearest EXISTING directory — the root
    // may not exist yet. Probing here (not cwd) tests the filesystem the managed
    // tree actually lives on even when `.aoa` is a separate mount.
    let dir = managedRoot;
    while (!existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) return { value: platformDefault, cacheable: false }; // hit fs root
      dir = parent;
    }
    // Trust (and cache) only a probe taken at or below `.aoa`; a probe forced up
    // to cwd because `.aoa` is absent may read a different mount than `.aoa`.
    const cacheable = dir === managedRoot || dir === managedParent;
    for (const entry of readdirSync(dir)) {
      const flipped = entry === entry.toLowerCase() ? entry.toUpperCase() : entry.toLowerCase();
      if (flipped === entry) continue; // no letters to flip
      // A case-flipped CHILD that still resolves within `dir` ⇒ case-insensitive.
      return { value: existsSync(path.join(dir, flipped)), cacheable };
    }
    // `dir` is empty or has no alphabetic child, so readdir alone can't classify
    // it — e.g. a freshly-mounted, empty case-insensitive `.aoa`. Create a
    // mixed-case probe entry on THIS filesystem and measure it. Only when we are
    // measuring the managed area itself (cacheable): cwd is never empty, so the
    // cwd fallback never reaches here, and this keeps the write off the hot path.
    if (cacheable) {
      const measured = measureCaseSensitivityByTempEntry(dir);
      if (measured !== undefined) return { value: measured, cacheable: true };
    }
  } catch {
    // fall through to the platform default
  }
  return { value: platformDefault, cacheable: false };
}

/**
 * Conclusively measure whether `dir`'s filesystem is case-insensitive by
 * creating a probe directory and testing whether a case-flipped spelling
 * resolves to it. Returns undefined (inconclusive → caller uses the platform
 * default) if the entry cannot be created — e.g. a read-only mount. Best-effort
 * cleanup; the pid-scoped name is cleared first so a crash-stranded prior probe
 * cannot make this inconclusive.
 */
function measureCaseSensitivityByTempEntry(dir: string): boolean | undefined {
  const lower = path.join(dir, `.aoa-fscase-probe-${process.pid}a`);
  const upper = path.join(dir, `.aoa-fscase-probe-${process.pid}A`);
  try {
    rmSync(lower, { recursive: true, force: true });
    mkdirSync(lower);
  } catch {
    return undefined;
  }
  try {
    return existsSync(upper);
  } finally {
    try {
      rmSync(lower, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** Resolve to absolute, then fold case using the parent root's filesystem. */
function normalizeForContainment(
  candidatePath: string,
  caseInsensitive: boolean,
): string {
  const resolved = path.resolve(candidatePath);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

/** True when `childPath` equals `parentPath` or is nested inside it. */
function contains(parentPath: string, childPath: string): boolean {
  const caseInsensitive = isCaseInsensitiveFilesystem(parentPath);
  const parent = normalizeForContainment(parentPath, caseInsensitive);
  const child = normalizeForContainment(childPath, caseInsensitive);
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  // A different drive/root yields an absolute rel — not contained.
  if (path.isAbsolute(rel)) return false;
  // `rel` escapes upward only when its FIRST segment is exactly "..". A plain
  // `rel.startsWith("..")` would wrongly reject a genuinely-contained child
  // whose first segment merely begins with two dots, e.g. "..shadow/file.md".
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * The selected parent of every {@link managedCatalogSkillDir}. A1 defaults to
 * the legacy cwd-relative root; A2 can select the fixed instance root without
 * changing the containment jail, which always recognizes both.
 */
export function managedMarketplaceSkillsRoot(): string {
  const selector =
    process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT?.trim().toLowerCase() ||
    "legacy";
  if (selector === "legacy") return legacyMarketplaceSkillsRoot();
  if (selector === "persistent") return persistentMarketplaceSkillsRoot();
  throw new Error(
    "AOA_MARKETPLACE_SKILLS_WRITE_ROOT must be either legacy or persistent",
  );
}

export function legacyMarketplaceSkillsRoot(): string {
  return path.join(process.cwd(), ".aoa", "marketplace-skills");
}

export function persistentMarketplaceSkillsRoot(): string {
  return path.join(resolveAoaInstanceRoot(), "marketplace-skills");
}

/** Both fixed roots are always recognized, regardless of the write selector. */
export function managedMarketplaceSkillsRoots(): readonly string[] {
  return [
    ...new Set([
      path.resolve(legacyMarketplaceSkillsRoot()),
      path.resolve(persistentMarketplaceSkillsRoot()),
    ]),
  ];
}

/**
 * True when `candidatePath` resolves to the managed marketplace-skills root or
 * anything nested inside it. A path equal to either root is contained; a path
 * on a different drive or above/beside both roots is not.
 */
export function isInsideManagedMarketplaceSkillsRoot(candidatePath: string): boolean {
  return managedMarketplaceSkillsRoots().some((root) =>
    contains(root, candidatePath),
  );
}

/**
 * True when `candidatePath` OVERLAPS the managed root in EITHER direction: it is
 * inside the root, OR it is an ANCESTOR of the root (a root from which a
 * relative path can still resolve *into* the managed tree).
 *
 * Use this for a founder-supplied ROOT (an external instructions root, a skill
 * import source) whose later writes resolve paths *under* it — rejecting an
 * ancestor closes the "root = `.aoa`, write `marketplace-skills/…`" bypass at
 * set time. For an already-resolved file TARGET, use
 * {@link isInsideManagedMarketplaceSkillsRoot} instead.
 */
export function overlapsManagedMarketplaceSkillsRoot(candidatePath: string): boolean {
  return managedMarketplaceSkillsRoots().some(
    (root) => contains(root, candidatePath) || contains(candidatePath, root),
  );
}
