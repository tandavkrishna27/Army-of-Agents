/**
 * git_commit base capture (DAT-001).
 *
 * Enumerates tracked (+ optionally untracked) files via the hardened git seam,
 * probes the object format, derives the exec bit from the git tree mode, reads +
 * hashes content via `node:fs` (NEVER through git — so filters/autocrlf cannot
 * perturb content hashes), and attributes the `.gitignore` sources for the ignore
 * digest. Git is the ignore engine (`--exclude-standard`).
 *
 * Fail-closed: a non-repo / no-HEAD folder, a git object-format that disagrees
 * with the HEAD revision format (DAT-001 check 5), a tracked entry that is not a
 * plain file on disk (symlink / gitlink / special), an unsafe path, or a
 * size-ceiling breach all throw a `WorkspaceSnapshotError`.
 */

import { lstatSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";

import { isSafeWorkspacePath } from "@armyofagents/worker-protocol";

import { WorkspaceSnapshotError } from "./errors.js";
import type { Sha256Fn, SnapshotEntry } from "./hashing.js";
import { sortSnapshotEntries } from "./hashing.js";
import { AOA_BUILTIN_IGNORE_RULES, isIgnoredByExplicit, type GitignoreSource } from "./ignore.js";
import { GitRunnerError, type GitRunner } from "./git-runner.js";
import type { SnapshotLimits } from "./limits.js";

export interface CaptureGitBaseInput {
  readonly root: string;
  readonly untracked: "include" | "exclude";
  readonly limits: SnapshotLimits;
  readonly sha256: Sha256Fn;
  readonly runGit: GitRunner;
}

export interface CapturedGitBase {
  readonly algorithm: "git_sha1" | "git_sha256";
  readonly revision: string;
  readonly dirty: boolean;
  readonly entries: SnapshotEntry[];
  readonly gitignoreSources: GitignoreSource[];
}

/** Split raw `-z` (NUL-delimited) git stdout into non-empty utf8 records. */
function splitNulRecords(stdout: Buffer): string[] {
  return stdout
    .toString("utf8")
    .split("\0")
    .filter((record) => record.length > 0);
}

async function runOrThrow(input: CaptureGitBaseInput, args: string[], notRepoMessage: string): Promise<Buffer> {
  try {
    return (await input.runGit(args, { cwd: input.root })).stdout;
  } catch (error) {
    if (error instanceof GitRunnerError) {
      throw new WorkspaceSnapshotError(`${notRepoMessage}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Fail closed on an unresolved merge conflict (Finding C). `git ls-files -z` emits
 * an unmerged path once per populated index stage (1/2/3), which would otherwise
 * enumerate the path multiple times → corrupt the budget + surface a misleading
 * "duplicate workspace path" error. A mid-conflict tree is ambiguous and must not
 * be snapshotted.
 */
function assertNoUnmergedIndex(stdout: Buffer): void {
  for (const record of splitNulRecords(stdout)) {
    // Format: "<mode> <object> <stage>\t<path>"; stage 0 = merged, 1/2/3 = conflict.
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const stage = record.slice(0, tab).split(" ")[2] ?? "0";
    if (stage !== "0") {
      throw new WorkspaceSnapshotError(
        `workspace has an unresolved merge conflict; resolve before snapshot: ${record.slice(tab + 1)}`,
      );
    }
  }
}

/** Parse `git ls-files --stage -z` into a path→mode map (`100644` / `100755` / …). */
function parseStageModes(stdout: Buffer): Map<string, string> {
  const modes = new Map<string, string>();
  for (const record of splitNulRecords(stdout)) {
    // Format: "<mode> <object> <stage>\t<path>"
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab);
    const filePath = record.slice(tab + 1);
    const mode = meta.split(" ")[0] ?? "";
    modes.set(filePath, mode);
  }
  return modes;
}

export async function captureGitBase(input: CaptureGitBaseInput): Promise<CapturedGitBase> {
  // 1. Confirm this is a git worktree (fail-closed for a non-repo folder).
  await runOrThrow(input, ["rev-parse", "--show-toplevel"], "not a git repository");

  // 2. Probe the object format → algorithm.
  const objectFormat = (await runOrThrow(input, ["rev-parse", "--show-object-format"], "cannot probe object format"))
    .toString("utf8")
    .trim();
  let algorithm: "git_sha1" | "git_sha256";
  if (objectFormat === "sha1") algorithm = "git_sha1";
  else if (objectFormat === "sha256") algorithm = "git_sha256";
  else throw new WorkspaceSnapshotError(`unknown git object format: ${objectFormat}`);

  // 3. Resolve HEAD (fails on a repo with no commits).
  const revision = (await runOrThrow(input, ["rev-parse", "HEAD"], "cannot resolve HEAD")).toString("utf8").trim();

  // 4. Check 5 — declared-algorithm vs actual-repo-object-format consistency.
  const expected = algorithm === "git_sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (!expected.test(revision)) {
    throw new WorkspaceSnapshotError(`git object format ${objectFormat} disagrees with HEAD revision format: ${revision}`);
  }

  // 5. Dirty = the working tree diverges from HEAD (tracked changes OR untracked files).
  const statusOut = await runOrThrow(
    input,
    ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    "cannot read status",
  );
  const dirty = statusOut.length > 0;

  // 6. Enumerate tracked (+ optionally untracked) files.
  const trackedPaths = splitNulRecords(await runOrThrow(input, ["ls-files", "-z"], "cannot list tracked files"));
  const stageOut = await runOrThrow(input, ["ls-files", "--stage", "-z"], "cannot list staged modes");
  assertNoUnmergedIndex(stageOut);
  const stageModes = parseStageModes(stageOut);
  const untrackedPaths =
    input.untracked === "include"
      ? splitNulRecords(
          await runOrThrow(input, ["ls-files", "-z", "--others", "--exclude-standard"], "cannot list untracked files"),
        )
      : [];

  const budget = { totalBytes: 0, entryCount: 0 };
  const entries: SnapshotEntry[] = [];
  const gitignoreSources: GitignoreSource[] = [];

  const addFile = (relPath: string, provenance: "tracked" | "untracked"): void => {
    // The stored/hashed path is NFC-normalized (Finding E) so an NFD-reporting
    // filesystem hashes identically; fs access + the stage-mode lookup use the
    // RAW git path (the index/worktree key).
    const entryPath = relPath.normalize("NFC");
    if (!isSafeWorkspacePath(entryPath)) {
      throw new WorkspaceSnapshotError(`unsafe workspace path: ${entryPath}`);
    }
    const abs = path.join(input.root, relPath);
    // A tracked path may be absent from the worktree (deleted without `git rm`) —
    // surface a fail-closed WorkspaceSnapshotError, not a raw fs error (Finding D).
    let stats: Stats;
    try {
      stats = lstatSync(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new WorkspaceSnapshotError(`tracked file missing from worktree: ${relPath}`);
      }
      throw new WorkspaceSnapshotError(`cannot stat workspace file ${relPath}: ${(error as Error).message}`);
    }
    if (stats.isSymbolicLink()) {
      throw new WorkspaceSnapshotError(`symlink is not representable in v1: ${relPath}`);
    }
    if (!stats.isFile()) {
      // A gitlink (submodule) or special node listed by git is not a blob file.
      throw new WorkspaceSnapshotError(`git entry is not a plain file: ${relPath}`);
    }
    // Enforce the per-file ceiling from the stat size BEFORE reading (Finding A).
    if (stats.size > input.limits.maxFileBytes) {
      throw new WorkspaceSnapshotError(`file exceeds per-file ceiling (${stats.size} > ${input.limits.maxFileBytes}): ${relPath}`);
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch (error) {
      throw new WorkspaceSnapshotError(`cannot read workspace file ${relPath}: ${(error as Error).message}`);
    }

    budget.entryCount += 1;
    if (budget.entryCount > input.limits.maxEntries) {
      throw new WorkspaceSnapshotError(`entry-count ceiling exceeded (> ${input.limits.maxEntries})`);
    }
    if (bytes.length > input.limits.maxFileBytes) {
      throw new WorkspaceSnapshotError(`file exceeds per-file ceiling (${bytes.length} > ${input.limits.maxFileBytes}): ${relPath}`);
    }
    budget.totalBytes += bytes.length;
    if (budget.totalBytes > input.limits.maxTotalBytes) {
      throw new WorkspaceSnapshotError(`total-bytes ceiling exceeded (> ${input.limits.maxTotalBytes})`);
    }

    const contentSha = input.sha256(bytes);
    // Tracked exec bit comes from the git tree mode (100755); untracked has no
    // stage entry, so derive from the filesystem (POSIX) / false on Windows.
    let executable: boolean;
    if (provenance === "tracked") {
      executable = stageModes.get(relPath) === "100755";
    } else {
      executable = process.platform === "win32" ? false : (stats.mode & 0o111) !== 0;
    }
    entries.push({ path: entryPath, kind: "file", provenance, sizeBytes: bytes.length, sha256: contentSha, executable });

    if (path.posix.basename(relPath) === ".gitignore") {
      gitignoreSources.push({ path: entryPath, sha256: contentSha });
    }
  };

  // Apply the pinned AOA built-in ignore rules the digest ATTESTS (Finding B).
  // Git's `--exclude-standard` covers .gitignore only; the `.aoa/` keystore dir
  // (and `.git/`, a no-op git never lists) must be enforced here so no key
  // material leaks and the attested policy matches what was actually applied.
  const builtinIgnored = (relPath: string): boolean => isIgnoredByExplicit(relPath, AOA_BUILTIN_IGNORE_RULES);
  for (const relPath of trackedPaths) if (!builtinIgnored(relPath)) addFile(relPath, "tracked");
  for (const relPath of untrackedPaths) if (!builtinIgnored(relPath)) addFile(relPath, "untracked");

  return { algorithm, revision, dirty, entries: sortSnapshotEntries(entries), gitignoreSources };
}
