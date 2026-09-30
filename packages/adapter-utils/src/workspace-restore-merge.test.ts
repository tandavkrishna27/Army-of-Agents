import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorkspaceSnapshot, mergeChangedWorkspaceFiles } from "./workspace-restore-merge.js";

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-restore-merge-"));
  tempRoots.push(root);
  return root;
}

async function writeText(filePath: string, contents: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

function sha256(contents: string) {
  return createHash("sha256").update(contents).digest("hex");
}

async function tryCreateSymlink(target: string, linkPath: string) {
  try {
    await symlink(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("captureWorkspaceSnapshot", () => {
  it("captures files and hashes contents", async () => {
    const root = await tempRoot();
    await writeText(path.join(root, "src", "index.ts"), "export const value = 42;\n");

    const snapshot = await captureWorkspaceSnapshot(root);

    expect(snapshot.get("src")).toMatchObject({ kind: "directory" });
    expect(snapshot.get("src/index.ts")).toMatchObject({
      kind: "file",
      sha256: sha256("export const value = 42;\n"),
    });
  });

  it("ignores .git and node_modules by default", async () => {
    const root = await tempRoot();
    await writeText(path.join(root, ".git", "config"), "private");
    await writeText(path.join(root, "node_modules", "dep", "index.js"), "module");
    await writeText(path.join(root, "src", "index.ts"), "source");

    const snapshot = await captureWorkspaceSnapshot(root);

    expect(snapshot.has(".git")).toBe(false);
    expect(snapshot.has(".git/config")).toBe(false);
    expect(snapshot.has("node_modules")).toBe(false);
    expect(snapshot.has("node_modules/dep/index.js")).toBe(false);
    expect(snapshot.has("src/index.ts")).toBe(true);
  });

  it("ignores protected names even when they are files or symlinks", async () => {
    const root = await tempRoot();
    await writeText(path.join(root, ".git"), "not a directory");
    await writeText(path.join(root, "node_modules"), "not a directory");
    await mkdir(path.join(root, "nested"), { recursive: true });
    const created = await tryCreateSymlink("target", path.join(root, "nested", ".git"));
    await writeText(path.join(root, "src", "index.ts"), "source");

    const snapshot = await captureWorkspaceSnapshot(root);

    expect(snapshot.has(".git")).toBe(false);
    expect(snapshot.has("node_modules")).toBe(false);
    if (created) {
      expect(snapshot.has("nested/.git")).toBe(false);
    }
    expect(snapshot.has("src/index.ts")).toBe(true);
  });

  it("records symlink targets when the filesystem supports them", async () => {
    const root = await tempRoot();
    const created = await tryCreateSymlink("target.txt", path.join(root, "linked.txt"));
    if (!created) {
      return;
    }

    const snapshot = await captureWorkspaceSnapshot(root);

    expect(snapshot.get("linked.txt")).toMatchObject({
      kind: "symlink",
      linkTarget: "target.txt",
    });
  });
});

describe("mergeChangedWorkspaceFiles", () => {
  it("copies new and modified files, deletes removed files, and creates directories", async () => {
    const beforeRoot = await tempRoot();
    await writeText(path.join(beforeRoot, "changed.txt"), "before");
    await writeText(path.join(beforeRoot, "removed.txt"), "remove me");
    const before = await captureWorkspaceSnapshot(beforeRoot);

    const afterRoot = await tempRoot();
    await writeText(path.join(afterRoot, "changed.txt"), "after");
    await writeText(path.join(afterRoot, "new-dir", "new.txt"), "new file");

    const destinationRoot = await tempRoot();
    await writeText(path.join(destinationRoot, "changed.txt"), "before");
    await writeText(path.join(destinationRoot, "removed.txt"), "remove me");
    await writeText(path.join(destinationRoot, "untouched.txt"), "keep me");

    await mergeChangedWorkspaceFiles({ before, afterRoot, destinationRoot });

    await expect(readFile(path.join(destinationRoot, "changed.txt"), "utf8")).resolves.toBe("after");
    await expect(readFile(path.join(destinationRoot, "new-dir", "new.txt"), "utf8")).resolves.toBe(
      "new file",
    );
    await expect(readFile(path.join(destinationRoot, "removed.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(destinationRoot, "untouched.txt"), "utf8")).resolves.toBe(
      "keep me",
    );
  });

  it("restores changed symlinks when the filesystem supports them", async () => {
    const beforeRoot = await tempRoot();
    const beforeCreated = await tryCreateSymlink("old.txt", path.join(beforeRoot, "linked.txt"));
    if (!beforeCreated) {
      return;
    }
    const before = await captureWorkspaceSnapshot(beforeRoot);

    const afterRoot = await tempRoot();
    const afterCreated = await tryCreateSymlink("new.txt", path.join(afterRoot, "linked.txt"));
    if (!afterCreated) {
      return;
    }

    const destinationRoot = await tempRoot();
    const destinationCreated = await tryCreateSymlink("old.txt", path.join(destinationRoot, "linked.txt"));
    if (!destinationCreated) {
      return;
    }

    await mergeChangedWorkspaceFiles({ before, afterRoot, destinationRoot });

    const destinationEntry = await lstat(path.join(destinationRoot, "linked.txt"));
    expect(destinationEntry.isSymbolicLink()).toBe(true);
    expect((await captureWorkspaceSnapshot(destinationRoot)).get("linked.txt")?.linkTarget).toBe("new.txt");
  });

  it("does not rewrite untouched files", async () => {
    const beforeRoot = await tempRoot();
    await writeText(path.join(beforeRoot, "untouched.txt"), "same");
    const before = await captureWorkspaceSnapshot(beforeRoot);

    const afterRoot = await tempRoot();
    await writeText(path.join(afterRoot, "untouched.txt"), "same");
    await writeText(path.join(afterRoot, "changed.txt"), "new");

    const destinationRoot = await tempRoot();
    const untouchedPath = path.join(destinationRoot, "untouched.txt");
    await writeText(untouchedPath, "destination-local-copy");
    await writeText(path.join(destinationRoot, "changed.txt"), "old");
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await utimes(untouchedPath, oldTime, oldTime);

    await mergeChangedWorkspaceFiles({ before, afterRoot, destinationRoot });

    const untouchedStat = await lstat(untouchedPath);
    expect(untouchedStat.mtimeMs).toBe(oldTime.getTime());
    await expect(readFile(untouchedPath, "utf8")).resolves.toBe("destination-local-copy");
    await expect(readFile(path.join(destinationRoot, "changed.txt"), "utf8")).resolves.toBe("new");
  });

  it("rejects snapshot paths that escape the workspace root", async () => {
    const afterRoot = await tempRoot();
    const destinationRoot = await tempRoot();
    const before = new Map([["../escape.txt", { kind: "file" as const, sha256: "abc" }]]);

    await expect(mergeChangedWorkspaceFiles({ before, afterRoot, destinationRoot })).rejects.toThrow(
      "escapes root",
    );
  });

  it("does not let ignored paths from stale snapshots replace protected destination paths", async () => {
    const afterRoot = await tempRoot();
    await writeText(path.join(afterRoot, ".git"), "malicious replacement");
    await writeText(path.join(afterRoot, "node_modules"), "malicious replacement");

    const destinationRoot = await tempRoot();
    await writeText(path.join(destinationRoot, ".git", "config"), "real git config");
    await writeText(path.join(destinationRoot, "node_modules", "dep.js"), "real dependency");
    const before = new Map([
      [".git", { kind: "directory" as const }],
      ["node_modules", { kind: "directory" as const }],
    ]);

    await mergeChangedWorkspaceFiles({ before, afterRoot, destinationRoot });

    await expect(readFile(path.join(destinationRoot, ".git", "config"), "utf8")).resolves.toBe(
      "real git config",
    );
    await expect(readFile(path.join(destinationRoot, "node_modules", "dep.js"), "utf8")).resolves.toBe(
      "real dependency",
    );
  });

  it("rejects symlink targets that escape the destination workspace", async () => {
    const beforeRoot = await tempRoot();
    const before = await captureWorkspaceSnapshot(beforeRoot);

    const afterRoot = await tempRoot();
    const created = await tryCreateSymlink("../outside.txt", path.join(afterRoot, "linked.txt"));
    if (!created) {
      return;
    }

    const destinationRoot = await tempRoot();
    await writeText(path.join(destinationRoot, "linked.txt"), "keep existing destination");

    await expect(mergeChangedWorkspaceFiles({ before, afterRoot, destinationRoot })).rejects.toThrow(
      "symlink target escapes root",
    );
    await expect(readFile(path.join(destinationRoot, "linked.txt"), "utf8")).resolves.toBe(
      "keep existing destination",
    );
  });
});
