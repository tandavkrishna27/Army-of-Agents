import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { MarketplaceSkillBundle } from "@armyofagents/shared";
import {
  createBundleCheckoutCache,
  disposeBundleCheckoutCache,
  materializeSkillBundle,
  repoUrlForBundle,
} from "../services/marketplace-install/skill-bundle-materializer.js";

const execFileAsync = promisify(execFile);

describe("materializeSkillBundle", () => {
  it("copies a full skill bundle and classifies its inventory", async () => {
    const { repo, commitSha } = await createRepo({
      "skills/research/SKILL.md": "# Research\n",
      "skills/research/references/guide.md": "guide",
      "skills/research/scripts/run.js": "console.log('run')",
      "skills/research/assets/logo.png": "png",
    });
    const destination = path.join(await tempDir("bundle-dest-"), "out");

    const result = await materializeSkillBundle(makeBundle({ commitSha, path: "skills/research" }), {
      destination,
      unsafeTestRepoUrl: repo,
    });

    expect(normalizeNewlines(result.markdown)).toBe("# Research\n");
    expect(await readFile(path.join(destination, "references", "guide.md"), "utf8")).toBe("guide");
    expect(result.fileInventory).toEqual([
      { path: "SKILL.md", kind: "skill" },
      { path: "assets/logo.png", kind: "asset" },
      { path: "references/guide.md", kind: "reference" },
      { path: "scripts/run.js", kind: "script" },
    ]);
    expect(result.fileCount).toBe(4);
    expect(result.byteCount).toBeGreaterThan(0);
  });

  it("supports repo-root bundle path", async () => {
    const { repo, commitSha } = await createRepo({
      "SKILL.md": "# Root Skill\n",
      "references/root.md": "root",
    });
    const destination = path.join(await tempDir("bundle-root-"), "out");

    const result = await materializeSkillBundle(makeBundle({ commitSha, path: "." }), {
      destination,
      unsafeTestRepoUrl: repo,
    });

    expect(normalizeNewlines(result.markdown)).toBe("# Root Skill\n");
    expect(await readFile(path.join(destination, "references", "root.md"), "utf8")).toBe("root");
  });

  it.each(["../evil", "/absolute", "C:/absolute", "skills//bad", "skills/\0bad"])(
    "rejects unsafe bundle path %s",
    async (bundlePath) => {
      await expect(
        materializeSkillBundle(makeBundle({ path: bundlePath }), {
          destination: path.join(await tempDir("bundle-unsafe-"), "out"),
          unsafeTestRepoUrl: "unused",
        }),
      ).rejects.toThrow(/unsafe bundle path/i);
    },
  );

  it("adds a git suffix to HTTPS GitHub repo URLs when needed", () => {
    expect(repoUrlForBundle(makeBundle({ repo: "https://github.com/owner/repo" }))).toBe(
      "https://github.com/owner/repo.git",
    );
    expect(repoUrlForBundle(makeBundle({ repo: "https://github.com/owner/repo.git" }))).toBe(
      "https://github.com/owner/repo.git",
    );
    expect(repoUrlForBundle(makeBundle({ repo: "HTTPS://github.com/owner/repo" }))).toBe(
      "https://github.com/owner/repo.git",
    );
  });

  it.each(["file:///tmp/repo", "C:/Users/TK/repo", "/tmp/repo", "https://example.com/owner/repo.git"])(
    "rejects unsafe repo source %s before cloning",
    async (repo) => {
      const destination = path.join(await tempDir("bundle-unsafe-repo-"), "out");

      await expect(
        materializeSkillBundle(makeBundle({ commitSha: FULL_SHA, path: ".", repo }), { destination }),
      ).rejects.toThrow(/github repo/i);
      expect(existsSync(destination)).toBe(false);
    },
  );

  it.each(["file:///tmp/repo", "C:/Users/TK/repo", "/tmp/repo", "https://example.com/owner/repo.git"])(
    "rejects unsafe repoUrl override %s before cloning",
    async (repoUrl) => {
      const destination = path.join(await tempDir("bundle-unsafe-override-"), "out");

      await expect(
        materializeSkillBundle(makeBundle({ commitSha: FULL_SHA, path: "." }), { destination, repoUrl }),
      ).rejects.toThrow(/github repo/i);
      expect(existsSync(destination)).toBe(false);
    },
  );

  it("rejects when checkout resolves to a different commit SHA", async () => {
    const { repo, commitSha } = await createRepo({ "SKILL.md": "# Skill\n" });
    const destination = path.join(await tempDir("bundle-sha-mismatch-"), "out");
    const expectedSha = `${commitSha.slice(0, -1)}${commitSha.endsWith("0") ? "1" : "0"}`;

    await expect(
      materializeSkillBundle(makeBundle({ commitSha: expectedSha, path: "." }), {
        destination,
        unsafeTestRepoUrl: repo,
        unsafeTestCheckoutRef: commitSha,
      }),
    ).rejects.toThrow(/commit sha/i);
    expect(existsSync(destination)).toBe(false);
  });

  it("refuses to overwrite an existing destination unless requested", async () => {
    const { repo, commitSha } = await createRepo({ "SKILL.md": "# Skill\n" });
    const destination = await tempDir("bundle-overwrite-");
    await writeFile(path.join(destination, "old.txt"), "old");

    await expect(
      materializeSkillBundle(makeBundle({ commitSha, path: "." }), { destination, unsafeTestRepoUrl: repo }),
    ).rejects.toThrow(/already exists/i);

    await materializeSkillBundle(makeBundle({ commitSha, path: "." }), {
      destination,
      unsafeTestRepoUrl: repo,
      overwrite: true,
    });
    expect(existsSync(path.join(destination, "old.txt"))).toBe(false);
  });

  // ── Replacing an existing tree is non-destructive until it can succeed ────
  //
  // `overwrite: true` used to `rm -rf` the destination and only THEN start a
  // network fetch, so a caller replacing a LIVE bundle directory destroyed it
  // before knowing whether it could produce a replacement — and a failed fetch
  // left no bundle at all. Silently, because `readAncillarySkillFiles` swallows
  // a missing directory and hands the agent an empty file list.
  it("leaves an existing destination intact when the fetch fails", async () => {
    const { repo, commitSha } = await createRepo({ "SKILL.md": "# Skill\n" });
    const destination = await tempDir("bundle-live-");
    await mkdir(path.join(destination, "scripts"), { recursive: true });
    await writeFile(path.join(destination, "SKILL.md"), "# Live\n");
    await writeFile(path.join(destination, "scripts", "live.js"), "live");

    await expect(
      materializeSkillBundle(makeBundle({ commitSha: FULL_SHA, path: "." }), {
        destination,
        unsafeTestRepoUrl: repo,
        // A ref the repo does not have: `git fetch` fails AFTER the destination
        // would previously have been removed.
        unsafeTestCheckoutRef: "0".repeat(40),
        overwrite: true,
      }),
    ).rejects.toThrow();

    expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe("# Live\n");
    expect(await readFile(path.join(destination, "scripts", "live.js"), "utf8")).toBe("live");
    // No staging debris left beside it.
    expect(await siblingsOf(destination)).toEqual([path.basename(destination)]);
    void commitSha;
  });

  it("replaces an existing destination atomically, without a visible empty window", async () => {
    const { repo, commitSha } = await createRepo({
      "SKILL.md": "# New\n",
      "references/new.md": "new",
    });
    const destination = await tempDir("bundle-swap-");
    await writeFile(path.join(destination, "stale.txt"), "stale");

    const result = await materializeSkillBundle(makeBundle({ commitSha, path: "." }), {
      destination,
      unsafeTestRepoUrl: repo,
      overwrite: true,
    });

    expect(result.destination).toBe(path.resolve(destination));
    expect(normalizeNewlines(await readFile(path.join(destination, "SKILL.md"), "utf8"))).toBe("# New\n");
    expect(existsSync(path.join(destination, "stale.txt"))).toBe(false);
    // The staging and outgoing siblings are both cleaned up.
    expect(await siblingsOf(destination)).toEqual([path.basename(destination)]);
  });

  // ── The caller's deadline actually reaches `git` ──────────────────────────
  // `installTeam` → `installSkill` → here → `execFile`. Every docblock in that
  // chain claims an abort kills a running clone; nothing asserted it, at any
  // level, until this.
  it("rejects when the caller's signal is already aborted, without cloning", async () => {
    const { repo, commitSha } = await createRepo({ "SKILL.md": "# Skill\n" });
    const destination = path.join(await tempDir("bundle-abort-"), "out");

    await expect(
      materializeSkillBundle(makeBundle({ commitSha, path: "." }), {
        destination,
        unsafeTestRepoUrl: repo,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // The real failure surfaced — cleanup did not throw over it (C4) — and no
    // half-materialized destination was left behind.
    expect(existsSync(path.join(destination, "SKILL.md"))).toBe(false);
  });

  // ── The per-install clone cache ───────────────────────────────────────────
  // A `--no-checkout` clone still downloads the whole object database, and a
  // team's bundles cluster on a few repos (17 bundles / 4 repos for the
  // published crew), so without this most clones are byte-for-byte redundant.
  it("clones a repo once per install when a checkout cache is shared", async () => {
    const { repo, commitSha } = await createRepo({
      "skills/a/SKILL.md": "# A\n",
      "skills/b/SKILL.md": "# B\n",
    });
    const root = await tempDir("bundle-cache-");
    const cache = createBundleCheckoutCache();
    let sharedCheckoutDir = "";

    try {
      // Concurrent on purpose: two bundles from one repo starting at the same
      // moment is the exact shape the bootstrap produces, and a cache that only
      // works sequentially would not help there.
      const [a, b] = await Promise.all([
        materializeSkillBundle(makeBundle({ commitSha, path: "skills/a" }), {
          destination: path.join(root, "a"), unsafeTestRepoUrl: repo, checkoutCache: cache,
        }),
        materializeSkillBundle(makeBundle({ commitSha, path: "skills/b" }), {
          destination: path.join(root, "b"), unsafeTestRepoUrl: repo, checkoutCache: cache,
        }),
      ]);

      // ONE clone…
      expect(cache.size).toBe(1);
      sharedCheckoutDir = (await [...cache.values()][0]).checkoutDir;
      expect(existsSync(sharedCheckoutDir)).toBe(true);
      // …and each bundle still gets its own destination written out of it.
      // Sharing the checkout must not make the two destinations converge.
      expect(normalizeNewlines(a.markdown)).toBe("# A\n");
      expect(normalizeNewlines(b.markdown)).toBe("# B\n");
      expect(existsSync(path.join(root, "a", "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(root, "b", "SKILL.md"))).toBe(true);
    } finally {
      await disposeBundleCheckoutCache(cache);
    }

    // Disposal is the other half: a per-install cache that never frees its temp
    // trees is a disk leak, which is why it is not module-global.
    expect(cache.size).toBe(0);
    expect(existsSync(sharedCheckoutDir)).toBe(false);
  });

  it("skips symlinks while copying", async () => {
    const repo = await tempDir("bundle-symlink-repo-");
    await writeFile(path.join(repo, "SKILL.md"), "# Skill\n");
    try {
      await symlink(path.join(repo, "SKILL.md"), path.join(repo, "linked.md"));
    } catch (error: any) {
      if (error?.code === "EPERM") return;
      throw error;
    }
    await git(repo, "init");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test User");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");
    const commitSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    const destination = path.join(await tempDir("bundle-symlink-dest-"), "out");

    const result = await materializeSkillBundle(makeBundle({ commitSha, path: "." }), {
      destination,
      unsafeTestRepoUrl: repo,
    });

    expect(result.fileInventory).toEqual([{ path: "SKILL.md", kind: "skill" }]);
    expect(existsSync(path.join(destination, "linked.md"))).toBe(false);
  });
});

function makeBundle(overrides: Partial<MarketplaceSkillBundle> = {}): MarketplaceSkillBundle {
  return {
    type: "github-directory",
    repo: "owner/repo",
    commitSha: FULL_SHA,
    path: "skills/research",
    treeUrl: `https://github.com/owner/repo/tree/${FULL_SHA}/skills/research`,
    ...overrides,
  };
}

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

async function createRepo(files: Record<string, string>) {
  const repo = await tempDir("bundle-repo-");
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(repo, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  await git(repo, "init");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "init");
  const commitSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  return { repo, commitSha };
}

function tempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Entries sharing the destination's parent — catches leaked staging siblings. */
async function siblingsOf(destination: string): Promise<string[]> {
  const base = path.basename(destination);
  const entries = await readdir(path.dirname(destination));
  return entries.filter((name) => name === base || name.startsWith(`${base}.`)).sort();
}

function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd });
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
