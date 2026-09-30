/**
 * Slice 3 — git_commit base.
 *
 * Init a temp repo, commit, and assert algorithm / revision(=HEAD) / dirty /
 * tracked provenance / exec-bit-from-100755. Dirty the tree and vary untracked
 * handling. Prove the D7 hardening flags (`core.hooksPath=`, `core.quotepath=`)
 * are delivered on every real git call.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildWorkspaceManifest, type BuildWorkspaceManifestInput } from "../build-manifest.js";
import { createGitRunner } from "../git-runner.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoa-snap-git-"));
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

function gitInput(root: string, over: Partial<BuildWorkspaceManifestInput> = {}): BuildWorkspaceManifestInput {
  return {
    root,
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

describe("buildWorkspaceManifest — git_commit base", () => {
  it("captures algorithm, revision=HEAD, dirty=false, tracked provenance", async () => {
    initRepo();
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.txt"), "alpha\n");
    writeFileSync(path.join(dir, "readme.md"), "# hi\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();

    const result = await buildWorkspaceManifest(gitInput(dir));
    expect(result.manifest.base.kind).toBe("git_commit");
    expect(result.manifest.base.algorithm).toBe("git_sha1");
    expect(result.manifest.base.revision).toBe(head);
    expect(result.contentRevision).toBe(head);
    expect(result.manifest.base.dirty).toBe(false);

    const paths = result.manifest.entries.map((e) => e.path);
    expect(paths).toEqual(["readme.md", "src/a.txt"]); // sorted; no directory entries
    for (const entry of result.manifest.entries) {
      expect(entry.kind).toBe("file");
      expect(entry.provenance).toBe("tracked");
    }
    const a = result.manifest.entries.find((e) => e.path === "src/a.txt");
    expect(a?.sha256).toBe(sha256("alpha\n"));
  });

  it("derives the executable bit from git mode 100755", async () => {
    initRepo();
    writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
    writeFileSync(path.join(dir, "plain.txt"), "x\n");
    git(["add", "."]);
    git(["update-index", "--chmod=+x", "run.sh"]);
    git(["commit", "-q", "-m", "init"]);

    const result = await buildWorkspaceManifest(gitInput(dir));
    expect(result.manifest.entries.find((e) => e.path === "run.sh")?.executable).toBe(true);
    expect(result.manifest.entries.find((e) => e.path === "plain.txt")?.executable).toBe(false);
  });

  it("reports dirty=true when the working tree diverges from HEAD", async () => {
    initRepo();
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    writeFileSync(path.join(dir, "a.txt"), "two\n");

    const result = await buildWorkspaceManifest(gitInput(dir));
    expect(result.manifest.base.dirty).toBe(true);
  });

  it("excludes untracked files by default and includes them when asked", async () => {
    initRepo();
    writeFileSync(path.join(dir, "tracked.txt"), "t\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    writeFileSync(path.join(dir, "loose.txt"), "u\n");

    const excluded = await buildWorkspaceManifest(gitInput(dir, { untracked: "exclude" }));
    expect(excluded.manifest.entries.map((e) => e.path)).toEqual(["tracked.txt"]);
    expect(excluded.manifest.base.inclusion.untracked).toBe("exclude");

    const included = await buildWorkspaceManifest(gitInput(dir, { untracked: "include" }));
    const loose = included.manifest.entries.find((e) => e.path === "loose.txt");
    expect(loose?.provenance).toBe("untracked");
    expect(included.manifest.base.inclusion.untracked).toBe("include");
  });

  it("rejects a folder that is not a git repository", async () => {
    await expect(buildWorkspaceManifest(gitInput(dir))).rejects.toThrow();
  });

  it("delivers the D7 hardening flags (core.hooksPath= and core.quotepath=false) on every call", async () => {
    initRepo();
    const runGit = createGitRunner();
    const out = (await runGit(["config", "--list"], { cwd: dir })).stdout.toString("utf8");
    expect(out).toMatch(/core\.hookspath=/);
    expect(out).toMatch(/core\.quotepath=false/);
  });
});
