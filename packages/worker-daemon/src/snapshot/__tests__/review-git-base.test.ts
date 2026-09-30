/**
 * DAT-001 adversarial-review regression tests — git-base fail-closed defects.
 *
 * Covers the CONFIRMED review findings:
 *   B — the pinned AOA built-in ignore rules (`.aoa/`, `.git/`) are ATTESTED in
 *       the gitignore digest but were never APPLIED, so `.aoa/` (the worker
 *       keystore dir) leaked into a git-base manifest with a false attestation.
 *   C — an unresolved merge conflict makes `git ls-files -z` emit a path once per
 *       index stage, corrupting the budget and surfacing a misleading duplicate-
 *       path error instead of a clear rejection.
 *   D — a tracked-but-deleted-in-worktree file threw a raw fs ENOENT instead of a
 *       fail-closed WorkspaceSnapshotError.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildWorkspaceManifest, type BuildWorkspaceManifestInput } from "../build-manifest.js";
import { WorkspaceSnapshotError } from "../errors.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoa-snap-review-git-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}
function initRepo(): void {
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
}
function currentBranch(): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).toString().trim();
}
function gitInput(over: Partial<BuildWorkspaceManifestInput> = {}): BuildWorkspaceManifestInput {
  return {
    root: dir,
    base: "git_commit",
    caseMode: "sensitive",
    organizationId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    artifactId: "33333333-3333-4333-8333-333333333333",
    sourceTargetId: "44444444-4444-4444-8444-444444444444",
    folderGrantId: null,
    captureToolVersion: "aoa-worker-daemon/test",
    capturedAt: "2026-08-14T00:00:00.000Z",
    untracked: "exclude",
    ignore: { kind: "gitignore_plus_aoa" },
    sha256,
    ...over,
  };
}

describe("DAT-001 review — git-base fail-closed", () => {
  // Finding B — the .aoa/ keystore dir must never leak, tracked OR untracked.
  it("applies the pinned AOA built-in ignore rules: .aoa/ never appears (untracked)", async () => {
    initRepo();
    writeFileSync(path.join(dir, "keep.txt"), "k\n");
    git(["add", "keep.txt"]);
    git(["commit", "-q", "-m", "init"]);
    // A worker keystore dir left in the tree, untracked (the realistic leak).
    mkdirSync(path.join(dir, ".aoa"), { recursive: true });
    writeFileSync(path.join(dir, ".aoa", "session.key"), "SECRET-KEY-MATERIAL\n");

    const result = await buildWorkspaceManifest(gitInput({ untracked: "include" }));
    const paths = result.manifest.entries.map((e) => e.path);
    expect(paths).toContain("keep.txt");
    expect(paths.some((p) => p === ".aoa" || p.startsWith(".aoa/"))).toBe(false);
  });

  it("applies the pinned AOA built-in ignore rules: even a force-tracked .aoa/ file is excluded", async () => {
    initRepo();
    writeFileSync(path.join(dir, "keep.txt"), "k\n");
    mkdirSync(path.join(dir, ".aoa"), { recursive: true });
    writeFileSync(path.join(dir, ".aoa", "session.key"), "SECRET\n");
    git(["add", "keep.txt"]);
    git(["add", "-f", ".aoa/session.key"]); // deliberately tracked
    git(["commit", "-q", "-m", "init"]);

    const result = await buildWorkspaceManifest(gitInput({ untracked: "exclude" }));
    const paths = result.manifest.entries.map((e) => e.path);
    expect(paths).toContain("keep.txt");
    expect(paths.some((p) => p.startsWith(".aoa/"))).toBe(false);
  });

  // Finding C — an unresolved merge conflict must fail closed with a clear error.
  it("rejects a repo with an unresolved merge conflict (clear error, not a duplicate-path)", async () => {
    initRepo();
    writeFileSync(path.join(dir, "f.txt"), "base\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    const main = currentBranch();
    git(["checkout", "-q", "-b", "other"]);
    writeFileSync(path.join(dir, "f.txt"), "other\n");
    git(["commit", "-q", "-am", "other"]);
    git(["checkout", "-q", main]);
    writeFileSync(path.join(dir, "f.txt"), "mainline\n");
    git(["commit", "-q", "-am", "main"]);
    try {
      git(["merge", "other"]); // conflicts → non-zero exit
    } catch {
      /* expected conflict */
    }

    await expect(buildWorkspaceManifest(gitInput())).rejects.toThrow(/merge conflict|unmerged/i);
  });

  // Finding D — a tracked file deleted from the worktree must fail closed cleanly.
  it("throws a WorkspaceSnapshotError (not a raw ENOENT) for a tracked-but-deleted file", async () => {
    initRepo();
    writeFileSync(path.join(dir, "gone.txt"), "g\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    rmSync(path.join(dir, "gone.txt")); // plain delete, not `git rm` → still in the index

    await expect(buildWorkspaceManifest(gitInput())).rejects.toBeInstanceOf(WorkspaceSnapshotError);
    await expect(buildWorkspaceManifest(gitInput())).rejects.toThrow(/missing from worktree|cannot stat/i);
  });
});
