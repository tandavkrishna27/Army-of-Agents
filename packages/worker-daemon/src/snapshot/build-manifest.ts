/**
 * The workspace-snapshot PRODUCER (DAT-001).
 *
 * A deterministic, pure library that walks a granted folder and emits a frozen
 * `WorkspaceManifestV1` (worker-protocol) plus its two pinned digests
 * (`contentRevision`, `manifestHash`), self-validating FAIL-CLOSED with the frozen
 * `workspaceManifestV1Schema.parse()` (DAT-001-D2) as the final gate.
 *
 * NO DB / persistence / server route — that is DAT-002. Everything is injected
 * for determinism + testability: the `sha256` provider, the `runGit` seam, and
 * `capturedAt` (the producer NEVER reads the clock).
 *
 * Fail-closed checks (each rejects the WHOLE snapshot — never a silent skip):
 *   1. lstat every node → reject symlink / FIFO / socket / block / char device.
 *   2. path-safety pre-check (`isSafeWorkspacePath`) on the normalized rel path.
 *   3. size ceilings (per-file, total, entry-count).
 *   4. ignored-file leakage → an ignored entry is never emitted.
 *   5. (git base) declared-algorithm vs actual object-format mismatch.
 *   6. case-collision / duplicate path (early clean error; schema re-enforces).
 * The frozen `.parse()` gate re-enforces (2), symlink-kind, (6), directory
 * invariants, and base algorithm↔revision format as defense-in-depth.
 */

import { lstatSync, readFileSync, readdirSync, type Stats } from "node:fs";
import path from "node:path";

import { isSafeWorkspacePath, workspaceManifestV1Schema, type WorkspaceManifestV1 } from "@armyofagents/worker-protocol";

import { WorkspaceSnapshotError } from "./errors.js";
import {
  compareUtf8,
  computeContentRevision,
  computeManifestHash,
  sortSnapshotEntries,
  type IgnorePolicyRecord,
  type InclusionRecord,
  type Sha256Fn,
  type SnapshotEntry,
} from "./hashing.js";
import {
  computeExplicitIgnoreDigest,
  computeGitignoreDigest,
  isIgnoredByExplicit,
  resolveEffectiveExplicitRules,
  type GitignoreSource,
  type IgnorePolicyInput,
} from "./ignore.js";
import { createGitRunner, type GitRunner } from "./git-runner.js";
import { captureGitBase } from "./git-base.js";
import { DEFAULT_SNAPSHOT_LIMITS, type SnapshotLimits } from "./limits.js";

export interface BuildWorkspaceManifestInput {
  /** Absolute path to the granted folder to snapshot. */
  readonly root: string;
  /** Base capture strategy. */
  readonly base: "git_commit" | "content_manifest";
  /** Case policy recorded + hashed into `contentRevision`. */
  readonly caseMode: "sensitive" | "insensitive_preserving";
  readonly organizationId: string;
  readonly companyId: string;
  readonly artifactId: string;
  readonly sourceTargetId: string;
  readonly folderGrantId: string | null;
  readonly captureToolVersion: string;
  /** RFC3339 capture timestamp — INJECTED (never read from the clock). */
  readonly capturedAt: string;
  /** For a git base: whether to include untracked files. */
  readonly untracked: "include" | "exclude";
  /** Ignore policy; kind MUST match the base kind (git→gitignore_plus_aoa, content→explicit). */
  readonly ignore: IgnorePolicyInput;
  /** DAT-owned fail-closed size ceilings (defaults to {@link DEFAULT_SNAPSHOT_LIMITS}). */
  readonly limits?: SnapshotLimits;
  /** Injected sha256 provider (lowercase hex). */
  readonly sha256: Sha256Fn;
  /** Injected git seam (defaults to the hardened `execFile` runner). */
  readonly runGit?: GitRunner;
}

export interface BuildWorkspaceManifestResult {
  readonly manifest: WorkspaceManifestV1;
  readonly manifestHash: string;
  readonly contentRevision: string;
}

/** A plain (unbranded) workspace base — branded by the schema on `.parse()`. */
interface SnapshotBase {
  readonly kind: "git_commit" | "content_manifest";
  readonly algorithm: "git_sha1" | "git_sha256" | "sha256";
  readonly revision: string;
  readonly dirty: boolean;
  readonly caseMode: "sensitive" | "insensitive_preserving";
  readonly ignorePolicy: IgnorePolicyRecord;
  readonly inclusion: InclusionRecord;
}

/** A running budget threaded through the walk to enforce the DAT ceilings. */
export interface SnapshotBudget {
  totalBytes: number;
  entryCount: number;
}

/** Reject anything that is not a plain regular file or directory (fail-closed). */
export function assertRepresentable(stats: Stats, relPath: string): void {
  if (stats.isSymbolicLink()) {
    throw new WorkspaceSnapshotError(`symlink is not representable in v1: ${relPath}`);
  }
  if (stats.isFIFO() || stats.isSocket() || stats.isBlockDevice() || stats.isCharacterDevice()) {
    throw new WorkspaceSnapshotError(`special/device file is not representable: ${relPath}`);
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new WorkspaceSnapshotError(`unsupported filesystem node: ${relPath}`);
  }
}

/**
 * Fail closed on a capture ROOT that is not a plain directory (DSK-002/I4).
 *
 * The walk `lstat`s every CHILD, so a symlink anywhere inside the tree is rejected —
 * but `walkContentTree(root, root, …)` goes straight to `readdirSync`, so the root
 * itself was never stat'ed and a root that IS a link was silently followed. Under
 * DSK-002's threat model that is a TOCTOU escape: a grant names a base, and whatever
 * can replace that base with a link between grant time and capture time redirects the
 * entire capture. The agent writing into the granted folder is precisely the actor
 * with that access.
 *
 * Applied to BOTH bases. `captureGitBase` uses `root` only as a git cwd and a join
 * base and never stats it either, so the git path had the identical hole.
 *
 * `lstat`, never `stat` — the whole point is to see the link rather than its target.
 *
 * The symlink arm is kept SEPARATE from the directory arm even though `lstat` already
 * reports a link as a non-directory, so today either arm would reject. Two reasons:
 * the operator-facing diagnosis differs ("you pointed at a file" is not "we refuse to
 * follow your link"), and if any platform ever reported a link as a directory the
 * directory arm would ADMIT it — which is precisely the platform assumption the
 * junction test in `capture-root.test.ts` exists to keep honest.
 */
export function assertCaptureRoot(root: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(root);
  } catch (cause) {
    // WorkspaceSnapshotError carries a message only, so the errno is folded in rather
    // than widening a shared error type — ENOENT and EACCES need to stay tellable apart.
    const code = (cause as NodeJS.ErrnoException | null)?.code ?? "unknown";
    throw new WorkspaceSnapshotError(`capture root is not readable (${code}): ${root}`);
  }
  if (stats.isSymbolicLink()) {
    throw new WorkspaceSnapshotError(
      `capture root is a symlink and will not be followed: ${root}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new WorkspaceSnapshotError(`capture root is not a directory: ${root}`);
  }
}

/**
 * Normalize an absolute path under `root` to a forward-slash relative path, folded
 * to Unicode NFC so a tree whose filesystem reports NFD names (e.g. HFS+/APFS)
 * yields the SAME entry path — and thus the same content-base hash — as one
 * reporting NFC (Finding E; cross-platform repeatable content-base hashes).
 */
export function normalizeRelPath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/").normalize("NFC");
}

/**
 * Defense-in-depth (Finding F): entries MUST be in the pinned UTF-8 byte order —
 * the sort is the SOLE ordering authority and the frozen schema does not encode
 * order, so a future sort regression would mint a non-reproducible `manifestHash`.
 * Fails closed.
 */
export function assertEntriesSorted(entries: readonly SnapshotEntry[]): void {
  for (let i = 1; i < entries.length; i += 1) {
    if (compareUtf8(entries[i - 1].path, entries[i].path) >= 0) {
      throw new WorkspaceSnapshotError(`entries not in canonical UTF-8 byte order at index ${i}: ${entries[i].path}`);
    }
  }
}

/** Charge one entry (and, for files, its bytes) against the DAT ceilings. */
function chargeBudget(budget: SnapshotBudget, sizeBytes: number, limits: SnapshotLimits, relPath: string): void {
  budget.entryCount += 1;
  if (budget.entryCount > limits.maxEntries) {
    throw new WorkspaceSnapshotError(`entry-count ceiling exceeded (> ${limits.maxEntries})`);
  }
  if (sizeBytes > limits.maxFileBytes) {
    throw new WorkspaceSnapshotError(`file exceeds per-file ceiling (${sizeBytes} > ${limits.maxFileBytes}): ${relPath}`);
  }
  budget.totalBytes += sizeBytes;
  if (budget.totalBytes > limits.maxTotalBytes) {
    throw new WorkspaceSnapshotError(`total-bytes ceiling exceeded (> ${limits.maxTotalBytes})`);
  }
}

/** Reject a duplicate or case-colliding path early (the schema re-enforces). */
export function assertNoCollisions(paths: readonly string[]): void {
  const seen = new Set<string>();
  const seenLower = new Set<string>();
  for (const p of paths) {
    if (seen.has(p)) throw new WorkspaceSnapshotError(`duplicate workspace path: ${p}`);
    const lower = p.toLowerCase();
    if (seenLower.has(lower)) throw new WorkspaceSnapshotError(`case-colliding workspace path: ${p}`);
    seen.add(p);
    seenLower.add(lower);
  }
}

/** Executable-bit derivation for a content_manifest file (DAT-001-D5). */
function contentExecutable(stats: Stats): boolean {
  // Windows `stat.mode` is unreliable → forced false (documented). POSIX uses
  // the owner/group/other execute bits.
  if (process.platform === "win32") return false;
  return (stats.mode & 0o111) !== 0;
}

/** Recursively walk a content_manifest tree, applying every fail-closed check. */
function walkContentTree(
  root: string,
  dirAbs: string,
  rules: readonly string[],
  limits: SnapshotLimits,
  sha256: Sha256Fn,
  budget: SnapshotBudget,
  out: SnapshotEntry[],
): void {
  const names = readdirSync(dirAbs);
  for (const name of names) {
    const abs = path.join(dirAbs, name);
    const stats = lstatSync(abs);
    const relPath = normalizeRelPath(root, abs);
    assertRepresentable(stats, relPath);

    if (isIgnoredByExplicit(relPath, rules)) {
      continue; // leakage fail-closed: never emit / never descend into an ignored node.
    }
    if (!isSafeWorkspacePath(relPath)) {
      throw new WorkspaceSnapshotError(`unsafe workspace path: ${relPath}`);
    }

    if (stats.isDirectory()) {
      chargeBudget(budget, 0, limits, relPath);
      out.push({ path: relPath, kind: "directory", provenance: "untracked", sizeBytes: 0, sha256: null, executable: false });
      walkContentTree(root, abs, rules, limits, sha256, budget, out);
      continue;
    }
    // Regular file. Enforce the per-file ceiling from the stat size BEFORE
    // reading, so an over-ceiling file is never buffered into memory (Finding A:
    // a >2 GiB file would otherwise throw a raw RangeError, not a clean reject).
    if (stats.size > limits.maxFileBytes) {
      throw new WorkspaceSnapshotError(`file exceeds per-file ceiling (${stats.size} > ${limits.maxFileBytes}): ${relPath}`);
    }
    const bytes = readFileSync(abs);
    chargeBudget(budget, bytes.length, limits, relPath);
    out.push({
      path: relPath,
      kind: "file",
      provenance: "untracked",
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      executable: contentExecutable(stats),
    });
  }
}

/**
 * DAT-001-D2: the frozen schema is the FINAL fail-closed gate, run INSIDE the
 * worker as a real runtime `.parse()` (not a type assertion). Any schema
 * violation — unsafe path, symlink kind, case-collision, directory invariant,
 * algorithm↔revision format, unknown/forbidden key — rejects the whole snapshot.
 */
export function parseManifestFailClosed(candidate: unknown): WorkspaceManifestV1 {
  try {
    return workspaceManifestV1Schema.parse(candidate);
  } catch (error) {
    throw new WorkspaceSnapshotError(`self-validation failed: ${(error as Error).message}`);
  }
}

/** Assemble, self-validate (`.parse()`), and hash the final manifest. */
function finalizeManifest(
  input: BuildWorkspaceManifestInput,
  base: SnapshotBase,
  entries: SnapshotEntry[],
  contentRevision: string,
): BuildWorkspaceManifestResult {
  const candidate = {
    protocolVersion: 1 as const,
    organizationId: input.organizationId,
    companyId: input.companyId,
    artifactId: input.artifactId,
    base,
    snapshotProvenance: {
      capturedAt: input.capturedAt,
      sourceTargetId: input.sourceTargetId,
      folderGrantId: input.folderGrantId,
      captureToolVersion: input.captureToolVersion,
    },
    entries,
  };
  assertEntriesSorted(entries);
  const manifest = parseManifestFailClosed(candidate);
  const manifestHash = computeManifestHash(manifest, input.sha256);
  return { manifest, manifestHash, contentRevision };
}

export async function buildWorkspaceManifest(
  input: BuildWorkspaceManifestInput,
): Promise<BuildWorkspaceManifestResult> {
  const limits = input.limits ?? DEFAULT_SNAPSHOT_LIMITS;
  if (limits.maxEntries > DEFAULT_SNAPSHOT_LIMITS.maxEntries) {
    throw new WorkspaceSnapshotError("maxEntries may not exceed the schema cap of 1,000,000");
  }
  // Before EITHER base branch: both walk from `input.root` and neither stat'ed it.
  assertCaptureRoot(input.root);

  if (input.base === "content_manifest") {
    if (input.ignore.kind !== "explicit") {
      throw new WorkspaceSnapshotError("content_manifest base requires an explicit ignore policy");
    }
    // The pinned built-ins go UNDERNEATH the caller's rules, and the SAME resolved
    // value feeds the walk below and the digest further down. A caller passing an
    // empty list is not asking to snapshot the `.aoa/` keystore; before this, one
    // did exactly that.
    const rules = resolveEffectiveExplicitRules(input.ignore.rules);
    const budget: SnapshotBudget = { totalBytes: 0, entryCount: 0 };
    const collected: SnapshotEntry[] = [];
    walkContentTree(input.root, input.root, rules, limits, input.sha256, budget, collected);
    const entries = sortSnapshotEntries(collected);
    assertNoCollisions(entries.map((entry) => entry.path));

    const ignorePolicy: IgnorePolicyRecord = { kind: "explicit", digest: computeExplicitIgnoreDigest(rules, input.sha256) };
    const inclusion: InclusionRecord = { tracked: true, untracked: "include", ignored: false };
    const contentRevision = computeContentRevision({ caseMode: input.caseMode, ignorePolicy, inclusion, entries }, input.sha256);
    const base: SnapshotBase = {
      kind: "content_manifest",
      algorithm: "sha256",
      revision: contentRevision,
      dirty: false,
      caseMode: input.caseMode,
      ignorePolicy,
      inclusion,
    };
    return finalizeManifest(input, base, entries, contentRevision);
  }

  // git_commit base.
  if (input.ignore.kind !== "gitignore_plus_aoa") {
    throw new WorkspaceSnapshotError("git_commit base requires a gitignore_plus_aoa ignore policy");
  }
  const runGit = input.runGit ?? createGitRunner();
  const captured = await captureGitBase({
    root: input.root,
    untracked: input.untracked,
    limits,
    sha256: input.sha256,
    runGit,
  });
  assertNoCollisions(captured.entries.map((entry) => entry.path));

  const ignorePolicy: IgnorePolicyRecord = {
    kind: "gitignore_plus_aoa",
    digest: computeGitignoreDigest(captured.gitignoreSources satisfies readonly GitignoreSource[], input.sha256),
  };
  const inclusion: InclusionRecord = { tracked: true, untracked: input.untracked, ignored: false };
  const base: SnapshotBase = {
    kind: "git_commit",
    algorithm: captured.algorithm,
    revision: captured.revision,
    dirty: captured.dirty,
    caseMode: input.caseMode,
    ignorePolicy,
    inclusion,
  };
  // git base: contentRevision IS the git HEAD sha (git is the content authority).
  return finalizeManifest(input, base, captured.entries, captured.revision);
}
