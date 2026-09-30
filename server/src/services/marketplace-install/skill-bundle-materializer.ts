import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CompanySkillFileInventoryEntry,
  MarketplaceSkillBundle,
} from "@armyofagents/shared";
import { isMarketplaceGitHubRepo } from "@armyofagents/shared/marketplace";
import { managedMarketplaceSkillsRoot } from "./managed-skills-root.js";

const execFileAsync = promisify(execFile);

export interface MaterializeSkillBundleOptions {
  destination: string;
  repoUrl?: string;
  unsafeTestRepoUrl?: string;
  unsafeTestCheckoutRef?: string;
  overwrite?: boolean;
  /**
   * Optional caller deadline. Passed to every `git` subprocess, which is killed
   * when it aborts. Without it a clone is bounded only by git's own network
   * timeouts, which is minutes — too long for a caller running inside an
   * interactive request (the company-create crew bootstrap).
   */
  signal?: AbortSignal;
  /**
   * Optional per-install checkout cache. See {@link createBundleCheckoutCache}.
   * Absent = every call clones into its own temp tree and removes it, which is
   * the right behaviour for a single-bundle caller.
   */
  checkoutCache?: BundleCheckoutCache;
}

/** One cloned+checked-out repo, owned by a {@link BundleCheckoutCache}. */
interface CachedCheckout {
  tempRoot: string;
  checkoutDir: string;
}

/**
 * Clones shared by the bundles of ONE install, keyed `<repoUrl>@<ref>#<sha>`.
 *
 * **Why.** A team's bundles cluster heavily on a few repos: the published
 * `team:aoa-curated/default-crew` needs 17 bundles drawn from just 4 repos
 * (`obra/superpowers` ×7, `garrytan/gstack` ×6, `openai/skills` ×3,
 * `coderabbitai/skills` ×1), so 13 of 17 fetches are byte-for-byte redundant —
 * and at the bootstrap's fetch concurrency several run *concurrently against the
 * same repo*, the worst shape for both bandwidth and GitHub's per-IP throttling.
 *
 * Measured over those 17 real bundles at concurrency 6, against live GitHub
 * (2026-07-24, two runs each):
 *
 * | fetch strategy                     | no cache      | cache         |
 * |------------------------------------|---------------|---------------|
 * | `clone --no-checkout` (was)        | 67.5s / 69.3s | 18.2s / 23.9s |
 * | depth-1 (see {@link gitFetchCommit})| 16.1s / 12.9s | 5.6s / 5.2s   |
 *
 * The 30s company-create budget was NOT survivable at 68s. Both changes are
 * load-bearing, not polish.
 *
 * **Why memoizing on `(repo, ref, sha)` is safe by construction.** A commit sha
 * is a content hash over the whole tree, and {@link materializeSkillBundle}
 * already asserts `HEAD === bundle.commitSha` before copying — the cache key
 * *is* the invariant the code verifies. Two bundles sharing a key therefore
 * cannot disagree about the bytes. `destination` stays per-(company, item,
 * version) and is written by `cp` out of the checkout, so nothing shared leaks
 * into a company's directory.
 *
 * **Why per-install and not module-global.** A process-lifetime cache inherits
 * an eviction and disk-growth problem, and buys single-bundle callers
 * (`skill-auto-updater`) nothing. Create one, pass it to every
 * `materializeSkillBundle` in the install, and
 * {@link disposeBundleCheckoutCache} it in a `finally`.
 */
export type BundleCheckoutCache = Map<string, Promise<CachedCheckout>>;

export function createBundleCheckoutCache(): BundleCheckoutCache {
  return new Map();
}

/**
 * Remove every temp tree the cache owns. Safe to call twice, and never throws —
 * a failed cleanup must not mask the install's own error (see
 * {@link removeTempTree}).
 */
export async function disposeBundleCheckoutCache(cache: BundleCheckoutCache): Promise<void> {
  const entries = [...cache.values()];
  cache.clear();
  const settled = await Promise.allSettled(entries);
  await Promise.all(
    settled.map((outcome) =>
      outcome.status === "fulfilled" ? removeTempTree(outcome.value.tempRoot) : Promise.resolve(),
    ),
  );
}

export interface MaterializeSkillBundleResult {
  destination: string;
  markdown: string;
  fileInventory: CompanySkillFileInventoryEntry[];
  fileCount: number;
  byteCount: number;
}

export async function materializeSkillBundle(
  bundle: MarketplaceSkillBundle,
  options: MaterializeSkillBundleOptions,
): Promise<MaterializeSkillBundleResult> {
  const destination = path.resolve(options.destination);
  validateDestination(destination);
  const bundlePath = validateBundlePath(bundle.path);
  const repoUrl = repoUrlForBundle(bundle, options);
  const checkoutRef = unsafeTestValue(options.unsafeTestCheckoutRef, "unsafeTestCheckoutRef") ?? bundle.commitSha;

  const replacing = await prepareDestination(destination, options.overwrite ?? false);

  // Staging: when we are REPLACING an existing tree, the new content is built in
  // a sibling and swapped in at the end. See {@link stageDirectoryFor}.
  const stagingDir = replacing ? stageDirectoryFor(destination) : destination;
  if (replacing) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});

  // Owned = this call must clean it up. A CACHED checkout belongs to the cache
  // and is removed by disposeBundleCheckoutCache, never here.
  let owned: CachedCheckout | null = null;
  let checkout: CachedCheckout;
  try {
    const cache = options.checkoutCache;
    if (cache) {
      const key = `${repoUrl}@${checkoutRef}#${bundle.commitSha}`;
      let entry = cache.get(key);
      if (!entry) {
        entry = prepareCheckout(repoUrl, checkoutRef, bundle.commitSha, options.signal);
        cache.set(key, entry);
      }
      checkout = await entry;
    } else {
      owned = await prepareCheckout(repoUrl, checkoutRef, bundle.commitSha, options.signal);
      checkout = owned;
    }

    const sourceDir = path.resolve(checkout.checkoutDir, bundlePath);
    assertWithin(checkout.checkoutDir, sourceDir, `Unsafe bundle path "${bundle.path}"`);
    await assertFile(path.join(sourceDir, "SKILL.md"), "Bundle is missing SKILL.md");

    // Everything is read out of the STAGING tree, before the swap: a failure
    // here must still leave the previous bundle in place.
    await copyDirectorySkippingSymlinks(sourceDir, stagingDir);
    const markdown = await readFile(path.join(stagingDir, "SKILL.md"), "utf8");
    const fileInventory = await collectInventory(stagingDir);
    const byteCount = await sumBytes(stagingDir, fileInventory.map((entry) => entry.path));

    if (replacing) await swapIntoPlace(stagingDir, destination);

    return {
      destination,
      markdown,
      fileInventory,
      fileCount: fileInventory.length,
      byteCount,
    };
  } catch (err) {
    if (replacing) await removeTempTree(stagingDir);
    throw err;
  } finally {
    if (owned) await removeTempTree(owned.tempRoot);
  }
}

/**
 * Sibling path the replacement tree is built in.
 *
 * A sibling, not an OS temp dir, so the final move is a rename within one
 * filesystem rather than a cross-device copy — otherwise the "swap" would be
 * another slow non-atomic copy and buy nothing.
 */
function stageDirectoryFor(destination: string): string {
  return `${destination}.incoming-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/**
 * Move a fully-built staging tree over an existing destination.
 *
 * **Why this exists.** `materializeSkillBundle` used to `rm -rf` the destination
 * and only then start a network fetch, so a caller replacing a LIVE bundle
 * directory (one that `company_skills.metadata.catalogBundleInstallPath` points
 * at) destroyed it up to a full network timeout before knowing whether it could
 * produce a replacement — and if the fetch then failed, the bundle was simply
 * gone. Silently: `readAncillarySkillFiles` swallows a missing directory
 * (`company-skills.ts` `walkLocalFiles`) and hands the agent an empty file list.
 * The same window let a concurrent reader observe a half-copied tree.
 *
 * Ordering is chosen so that no step can leave the destination missing except
 * for the moment between two local renames:
 *
 * 1. `destination` → `outgoing`. If this throws, nothing has been destroyed and
 *    the caller removes the staging tree.
 * 2. `staging` → `destination`. Practically cannot fail — same parent, and
 *    `destination` was just vacated — but if it does, `outgoing` is renamed back
 *    and the error propagates with the old bundle restored.
 * 3. `outgoing` is removed best-effort. A leaked directory is a smaller problem
 *    than a masked failure (same reasoning as {@link removeTempTree}).
 */
async function swapIntoPlace(staging: string, destination: string): Promise<void> {
  const outgoing = `${destination}.outgoing-${randomBytes(6).toString("hex")}`;
  await rename(destination, outgoing);
  try {
    await rename(staging, destination);
  } catch (err) {
    await rename(outgoing, destination).catch(() => {});
    throw err;
  }
  await removeTempTree(outgoing);
}

/**
 * Clone + checkout + verify one repo into a fresh temp tree.
 *
 * Cleans up its own temp tree on failure, so a rejected promise left sitting in
 * a {@link BundleCheckoutCache} never leaks a directory. Callers that share the
 * result (the cache) deliberately share the REJECTION too: within one install a
 * repo that cannot be cloned fails every bundle drawn from it, which is the
 * outcome anyway — `installTeam` rejects on the first skill error.
 */
async function prepareCheckout(
  repoUrl: string,
  checkoutRef: string,
  expectedSha: string,
  signal: AbortSignal | undefined,
): Promise<CachedCheckout> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aoa-skill-bundle-"));
  const checkoutDir = path.join(tempRoot, "repo");
  try {
    await gitFetchCommit(repoUrl, checkoutDir, checkoutRef, signal);
    await git(checkoutDir, signal, "checkout", "--quiet", "--detach", "FETCH_HEAD");
    await assertCheckedOutCommit(checkoutDir, expectedSha, signal);
    return { tempRoot, checkoutDir };
  } catch (err) {
    await removeTempTree(tempRoot);
    throw err;
  }
}

/**
 * Best-effort removal of a temp checkout tree.
 *
 * Retried and swallowed on purpose. `git clone https://…` spawns a
 * `git-remote-https` helper, and aborting kills only the `git` process itself
 * (there is no process-group kill on win32), so a descendant can still hold a
 * handle under `tempRoot` for a moment. `rm`'s `force` ignores ENOENT but NOT
 * EBUSY/EPERM, and `maxRetries` defaults to 0 — so an unguarded cleanup in a
 * `finally` can throw and REPLACE the real error (an `AbortError`, typically)
 * with a filesystem one. A leaked temp directory is a far smaller problem than
 * a masked failure.
 */
async function removeTempTree(tempRoot: string): Promise<void> {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
    () => {},
  );
}

export function deriveBundleTrustLevel(
  fileInventory: CompanySkillFileInventoryEntry[],
): "markdown_only" | "assets" | "scripts_executables" {
  if (fileInventory.some((entry) => entry.kind === "script")) return "scripts_executables";
  if (fileInventory.some((entry) => entry.kind === "asset")) return "assets";
  return "markdown_only";
}

export function managedCatalogSkillDir(companyId: string, catalogItemId: string, version: string): string {
  return path.join(
    managedMarketplaceSkillsRoot(),
    safeCatalogSkillId(companyId),
    safeCatalogSkillId(catalogItemId),
    safeCatalogSkillId(version),
  );
}

export function safeCatalogSkillId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function repoUrlForBundle(
  bundle: MarketplaceSkillBundle,
  options: Pick<MaterializeSkillBundleOptions, "repoUrl" | "unsafeTestRepoUrl"> = {},
): string {
  const unsafeRepoUrl = unsafeTestValue(options.unsafeTestRepoUrl, "unsafeTestRepoUrl");
  if (unsafeRepoUrl) return unsafeRepoUrl;
  return marketplaceGitHubRepoUrl(options.repoUrl ?? bundle.repo);
}

function marketplaceGitHubRepoUrl(repo: string): string {
  if (!isMarketplaceGitHubRepo(repo)) {
    throw new Error(`Unsafe marketplace skill bundle GitHub repo "${repo}"`);
  }
  if (/^https:\/\//i.test(repo)) {
    const url = new URL(repo);
    const [owner, repoNameWithSuffix] = url.pathname.split("/").filter(Boolean);
    const repoName = repoNameWithSuffix.endsWith(".git")
      ? repoNameWithSuffix.slice(0, -".git".length)
      : repoNameWithSuffix;
    return `https://github.com/${owner}/${repoName}.git`;
  }
  return `https://github.com/${repo}.git`;
}

function unsafeTestValue(value: string | undefined, optionName: string): string | undefined {
  if (!value) return undefined;
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw new Error(`${optionName} is only available in tests`);
  }
  return value;
}

function validateBundlePath(rawPath: string): string {
  if (!rawPath || rawPath.includes("\0")) throw new Error(`Unsafe bundle path "${rawPath}"`);
  if (path.isAbsolute(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath)) {
    throw new Error(`Unsafe bundle path "${rawPath}"`);
  }
  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized.split("/").some((segment) => segment === "" || segment === "..")) {
    throw new Error(`Unsafe bundle path "${rawPath}"`);
  }
  return normalized === "." ? "." : normalized;
}

function validateDestination(destination: string) {
  const parsed = path.parse(destination);
  if (destination === parsed.root) {
    throw new Error("Refusing to materialize bundle into filesystem root");
  }
}

/**
 * Decide how the destination will be written, WITHOUT destroying anything.
 *
 * Returns true when an existing tree is about to be replaced, which is the
 * signal to build in a staging sibling and {@link swapIntoPlace} at the end.
 * Deliberately no longer removes the destination up front — see
 * {@link swapIntoPlace} for what that cost.
 */
async function prepareDestination(destination: string, overwrite: boolean): Promise<boolean> {
  const exists = await pathExists(destination);
  if (exists && !overwrite) {
    throw new Error(`Destination already exists: ${destination}`);
  }
  return exists;
}

/**
 * Fetch exactly the one commit a bundle pins, and nothing else.
 *
 * `git clone --no-checkout` — what this replaced — skips populating the working
 * tree but still downloads the **entire object database**, i.e. every commit of
 * every branch. A bundle only ever needs one tree, so a depth-1 fetch of the
 * pinned sha is both correct and dramatically cheaper: measured against the four
 * repos the published crew roster draws from, 15.3s → 2.6s.
 *
 * Fetching by raw sha requires the server to allow it. github.com does
 * (`uploadpack.allowAnySHA1InWant`), and `isMarketplaceGitHubRepo` restricts
 * production bundles to github.com; git's local transport allows it too, which
 * is what the `unsafeTestRepoUrl` fixtures use.
 */
async function gitFetchCommit(
  repoUrl: string,
  checkoutDir: string,
  ref: string,
  signal?: AbortSignal,
) {
  await mkdir(checkoutDir, { recursive: true });
  await git(checkoutDir, signal, "init", "--quiet");
  await git(checkoutDir, signal, "remote", "add", "origin", repoUrl);
  await git(checkoutDir, signal, "fetch", "--quiet", "--depth", "1", "origin", ref);
}

async function git(cwd: string, signal: AbortSignal | undefined, ...args: string[]) {
  await execFileAsync("git", args, { cwd, windowsHide: true, signal });
}

async function assertCheckedOutCommit(
  checkoutDir: string,
  expectedSha: string,
  signal?: AbortSignal,
) {
  const actualSha = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: checkoutDir,
    windowsHide: true,
    signal,
  })).stdout.trim();
  if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(`Checked out commit SHA ${actualSha} did not match expected ${expectedSha}`);
  }
}

async function assertFile(filePath: string, message: string) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new Error(message);
}

function assertWithin(root: string, candidate: string, message: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
}

async function copyDirectorySkippingSymlinks(sourceDir: string, destination: string) {
  await cp(sourceDir, destination, {
    recursive: true,
    dereference: false,
    filter: async (source) => {
      // Exclude a nested .git (e.g. a repo-root bundle clone) at any depth.
      if (path.basename(source) === ".git") return false;
      const info = await lstat(source);
      return !info.isSymbolicLink();
    },
  });
}

async function collectInventory(dir: string): Promise<CompanySkillFileInventoryEntry[]> {
  const files = await walkFiles(dir);
  return files
    .map((filePath) => ({ path: filePath, kind: classifyInventoryKind(filePath) }))
    .sort((a, b) => {
      if (a.path === "SKILL.md") return -1;
      if (b.path === "SKILL.md") return 1;
      return a.path.localeCompare(b.path);
    });
}

async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name === ".git") continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await walkFiles(dir, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function classifyInventoryKind(filePath: string): CompanySkillFileInventoryEntry["kind"] {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const basename = path.posix.basename(normalized);
  if (basename === "skill.md") return "skill";
  if (normalized.startsWith("references/")) return "reference";
  if (normalized.startsWith("scripts/")) return "script";
  if (normalized.startsWith("assets/")) return "asset";
  if (normalized.endsWith(".md")) return "markdown";
  const ext = path.posix.extname(normalized);
  if ([".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd", ".py", ".rb", ".js", ".ts", ".mjs", ".cjs"].includes(ext)) {
    return "script";
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".pdf"].includes(ext)) {
    return "asset";
  }
  if ([".txt", ".json", ".yaml", ".yml", ".toml"].includes(ext)) {
    return "reference";
  }
  return "other";
}

async function sumBytes(dir: string, files: string[]): Promise<number> {
  let total = 0;
  for (const file of files) {
    total += (await stat(path.join(dir, file))).size;
  }
  return total;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
