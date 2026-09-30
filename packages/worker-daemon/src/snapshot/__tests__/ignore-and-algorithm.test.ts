/**
 * Slice 4 — algorithm probe + ignore policy.
 *
 * git object-format detection (sha1 / sha256) and the DAT-001 check-5
 * declared-vs-actual mismatch rejection (driven through the injected `runGit`
 * seam); `gitignore_plus_aoa` digest determinism; and the content_manifest
 * `explicit` matcher (exact / `dir/` / `*.ext`) with ignored-leakage fail-closed.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildWorkspaceManifest, type BuildWorkspaceManifestInput } from "../build-manifest.js";
import { captureGitBase } from "../git-base.js";
import { WorkspaceSnapshotError } from "../errors.js";
import type { GitRunner } from "../git-runner.js";
import {
  AOA_BUILTIN_IGNORE_RULES,
  classifyExplicitRule,
  computeExplicitIgnoreDigest,
  isIgnoredByExplicit,
  resolveEffectiveExplicitRules,
} from "../ignore.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../limits.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoa-snap-ign-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function contentInput(root: string, rules: string[]): BuildWorkspaceManifestInput {
  return {
    root,
    base: "content_manifest",
    caseMode: "sensitive",
    organizationId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    artifactId: "33333333-3333-4333-8333-333333333333",
    sourceTargetId: "44444444-4444-4444-8444-444444444444",
    folderGrantId: null,
    captureToolVersion: "aoa-worker-daemon/test",
    capturedAt: "2026-08-14T00:00:00.000Z",
    untracked: "include",
    ignore: { kind: "explicit", rules },
    sha256,
  };
}

// ---- explicit matcher (pure) ------------------------------------------------

describe("explicit ignore matcher", () => {
  it("classifies rules into exact / dir / ext", () => {
    expect(classifyExplicitRule("a/b.txt")).toEqual({ type: "exact", value: "a/b.txt" });
    expect(classifyExplicitRule("node_modules/")).toEqual({ type: "dir", value: "node_modules" });
    expect(classifyExplicitRule("*.log")).toEqual({ type: "ext", value: ".log" });
  });

  it("matches exact paths, directory prefixes, and extension suffixes", () => {
    const rules = ["secret.env", "node_modules/", "*.log"];
    expect(isIgnoredByExplicit("secret.env", rules)).toBe(true);
    expect(isIgnoredByExplicit("node_modules", rules)).toBe(true);
    expect(isIgnoredByExplicit("node_modules/x/y.js", rules)).toBe(true);
    expect(isIgnoredByExplicit("app.log", rules)).toBe(true);
    expect(isIgnoredByExplicit("keep.txt", rules)).toBe(false);
    expect(isIgnoredByExplicit("secret.env.bak", rules)).toBe(false);
  });

  it("computes a deterministic, order-sensitive explicit digest", () => {
    expect(computeExplicitIgnoreDigest(["a", "b"], sha256)).toBe(computeExplicitIgnoreDigest(["a", "b"], sha256));
    expect(computeExplicitIgnoreDigest(["a", "b"], sha256)).not.toBe(computeExplicitIgnoreDigest(["b", "a"], sha256));
    expect(computeExplicitIgnoreDigest([], sha256)).toMatch(/^[a-f0-9]{64}$/);
  });

  // The EXPORTED digest contract, tested at the function rather than through
  // buildWorkspaceManifest. Mutation is why this exists: a mutant that digested the
  // raw argument SURVIVED, because the build path already hands in a resolved list —
  // so the internal resolve is load-bearing only for the package's other consumers,
  // and that is precisely the caller with no coverage. An external consumer computing
  // an expected digest from a raw rule list must land on the value the daemon
  // actually emits, or the attestation cannot be checked from outside.
  it("digests the EFFECTIVE policy, so a raw rule list and a resolved one agree", () => {
    expect(computeExplicitIgnoreDigest([], sha256))
      .toBe(computeExplicitIgnoreDigest([".git/", ".aoa/"], sha256));
    expect(computeExplicitIgnoreDigest(["build/"], sha256))
      .toBe(computeExplicitIgnoreDigest([".git/", ".aoa/", "build/"], sha256));
  });

  it("resolves to the built-ins underneath the caller's rules, deduplicated", () => {
    expect(resolveEffectiveExplicitRules([])).toEqual([...AOA_BUILTIN_IGNORE_RULES]);
    expect(resolveEffectiveExplicitRules(["build/"])).toEqual([...AOA_BUILTIN_IGNORE_RULES, "build/"]);
    // Restating a built-in must not duplicate it, whatever order it is given in.
    expect(resolveEffectiveExplicitRules([".aoa/", "build/", ".git/"]))
      .toEqual([...AOA_BUILTIN_IGNORE_RULES, "build/"]);
  });

  it("is idempotent — which is what makes the internal resolve safe to apply blindly", () => {
    for (const input of [[], ["build/"], [".aoa/"], [".git/", ".aoa/", "x.txt"]]) {
      const once = resolveEffectiveExplicitRules(input);
      expect(resolveEffectiveExplicitRules(once)).toEqual([...once]);
      expect(computeExplicitIgnoreDigest(once, sha256)).toBe(computeExplicitIgnoreDigest(input, sha256));
    }
  });

  it("still distinguishes policies that genuinely differ", () => {
    // Non-vacuity: if resolve collapsed everything to the built-ins, every assertion
    // above would pass while the digest stopped meaning anything.
    expect(computeExplicitIgnoreDigest(["build/"], sha256))
      .not.toBe(computeExplicitIgnoreDigest(["dist/"], sha256));
    expect(computeExplicitIgnoreDigest([], sha256))
      .not.toBe(computeExplicitIgnoreDigest(["build/"], sha256));
  });
});

describe("content_manifest — ignored-file leakage is fail-closed", () => {
  it("never emits an entry it resolved as ignored (files and directories)", async () => {
    writeFileSync(path.join(dir, "keep.txt"), "k");
    writeFileSync(path.join(dir, "secret.env"), "s");
    writeFileSync(path.join(dir, "app.log"), "l");
    mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "dep.js"), "d");

    const result = await buildWorkspaceManifest(contentInput(dir, ["secret.env", "node_modules/", "*.log"]));
    const paths = result.manifest.entries.map((e) => e.path);
    expect(paths).toEqual(["keep.txt"]);
    expect(paths).not.toContain("secret.env");
    expect(paths).not.toContain("app.log");
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(result.manifest.base.ignorePolicy.kind).toBe("explicit");
    expect(result.manifest.base.ignorePolicy.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("different rule lists change contentRevision (ignore policy is hashed)", async () => {
    writeFileSync(path.join(dir, "keep.txt"), "k");
    writeFileSync(path.join(dir, "app.log"), "l");
    const a = await buildWorkspaceManifest(contentInput(dir, []));
    const b = await buildWorkspaceManifest(contentInput(dir, ["*.log"]));
    expect(a.contentRevision).not.toBe(b.contentRevision);
  });
});

// ---- git object-format probe + gitignore digest -----------------------------

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}
function initRepo(root: string, extraInitArgs: string[] = []): void {
  git(root, ["init", "-q", ...extraInitArgs]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
}

function gitInput(root: string): BuildWorkspaceManifestInput {
  return { ...contentInput(root, []), base: "git_commit", ignore: { kind: "gitignore_plus_aoa" }, untracked: "exclude" };
}

describe("git object-format probe", () => {
  it("detects a sha256 repository (skipped if unsupported)", async () => {
    let ok = true;
    try {
      initRepo(dir, ["--object-format=sha256"]);
      writeFileSync(path.join(dir, "a.txt"), "a\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "init"]);
    } catch {
      ok = false;
    }
    if (!ok) {
      expect(true).toBe(true);
      return;
    }
    const result = await buildWorkspaceManifest(gitInput(dir));
    expect(result.manifest.base.algorithm).toBe("git_sha256");
    expect(result.manifest.base.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a repo whose object-format disagrees with the HEAD revision format", async () => {
    // Injected seam: object-format says sha1 but HEAD is 64-hex → check-5 rejects.
    const fakeRunGit: GitRunner = async (args) => {
      const join = args.join(" ");
      const reply = (s: string) => ({ stdout: Buffer.from(s, "utf8") });
      if (join.includes("--show-toplevel")) return reply(dir);
      if (join.includes("--show-object-format")) return reply("sha1\n");
      if (join.startsWith("rev-parse HEAD")) return reply(`${"a".repeat(64)}\n`);
      return reply("");
    };
    await expect(
      captureGitBase({ root: dir, untracked: "exclude", limits: DEFAULT_SNAPSHOT_LIMITS, sha256, runGit: fakeRunGit }),
    ).rejects.toBeInstanceOf(WorkspaceSnapshotError);
  });
});

describe("gitignore_plus_aoa digest", () => {
  it("is deterministic and content-sensitive", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);

    const a = await buildWorkspaceManifest(gitInput(dir));
    const b = await buildWorkspaceManifest(gitInput(dir));
    expect(a.manifest.base.ignorePolicy.kind).toBe("gitignore_plus_aoa");
    expect(a.manifest.base.ignorePolicy.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(a.manifest.base.ignorePolicy.digest).toBe(b.manifest.base.ignorePolicy.digest);

    // Changing the .gitignore content changes the attribution digest.
    writeFileSync(path.join(dir, ".gitignore"), "*.tmp\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "change ignore"]);
    const c = await buildWorkspaceManifest(gitInput(dir));
    expect(c.manifest.base.ignorePolicy.digest).not.toBe(a.manifest.base.ignorePolicy.digest);
  });
});
