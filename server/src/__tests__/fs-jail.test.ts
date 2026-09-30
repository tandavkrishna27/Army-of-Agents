import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { containBrowsePath, containMkdirPath, isPathContained } from "../services/fs-jail.js";

let tmpRoot: string;
let jailBase: string; // <tmpRoot>/co  — the jail
let outsideDir: string; // <tmpRoot>/outside — NOT in the jail
let siblingCollision: string; // <tmpRoot>/co2 — prefix-collision sibling

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-fs-jail-test-"));
  jailBase = path.join(tmpRoot, "co");
  outsideDir = path.join(tmpRoot, "outside");
  siblingCollision = path.join(tmpRoot, "co2");
  await fs.mkdir(jailBase, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.mkdir(siblingCollision, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("isPathContained", () => {
  it("true for the base dir itself", () => {
    expect(isPathContained(jailBase, jailBase)).toBe(true);
  });

  it("true for a descendant", () => {
    expect(isPathContained(jailBase, path.join(jailBase, "sub", "dir"))).toBe(true);
  });

  it("false for a prefix-collision sibling (/base/co vs /base/co2)", () => {
    expect(isPathContained(jailBase, siblingCollision)).toBe(false);
    expect(isPathContained(jailBase, path.join(siblingCollision, "x"))).toBe(false);
  });

  it("false for an unrelated dir", () => {
    expect(isPathContained(jailBase, outsideDir)).toBe(false);
  });

  it("false for the parent of base", () => {
    expect(isPathContained(jailBase, tmpRoot)).toBe(false);
  });

  it("true for a real descendant literally named with a leading '..' prefix", () => {
    // Regression guard: a naive `rel.startsWith("..")` check would wrongly
    // reject a subdirectory whose *name* happens to start with "..".
    const weirdName = path.join(jailBase, "..foo");
    expect(isPathContained(jailBase, weirdName)).toBe(true);
  });
});

describe("containBrowsePath — jail escape vectors", () => {
  it("allows a path inside the jail", async () => {
    const inside = path.join(jailBase, "project");
    await fs.mkdir(inside);
    const result = await containBrowsePath(jailBase, inside);
    expect(result.ok).toBe(true);
  });

  it("rejects '..' traversal out of the jail", async () => {
    const traversal = path.join(jailBase, "..", "outside");
    const result = await containBrowsePath(jailBase, traversal);
    expect(result.ok).toBe(false);
  });

  it("rejects an absolute path outside the jail", async () => {
    const result = await containBrowsePath(jailBase, outsideDir);
    expect(result.ok).toBe(false);
  });

  it("rejects a prefix-collision sibling (/base/co vs /base/co2)", async () => {
    const result = await containBrowsePath(jailBase, siblingCollision);
    expect(result.ok).toBe(false);
  });

  it("rejects a symlinked directory pointing outside the jail", async () => {
    const linkPath = path.join(jailBase, "escape-link");
    await fs.symlink(outsideDir, linkPath, "junction");
    const result = await containBrowsePath(jailBase, linkPath);
    expect(result.ok).toBe(false);
  });

  it("allows a symlink that points to a directory still inside the jail", async () => {
    const realInside = path.join(jailBase, "real-inside");
    await fs.mkdir(realInside);
    const linkPath = path.join(jailBase, "inside-link");
    await fs.symlink(realInside, linkPath, "junction");
    const result = await containBrowsePath(jailBase, linkPath);
    expect(result.ok).toBe(true);
  });

  it("Windows case/separator variant of the jail base is still contained", async () => {
    const inside = path.join(jailBase, "Project");
    await fs.mkdir(inside);
    const upperCaseVariant =
      process.platform === "win32" ? inside.toUpperCase() : inside;
    const result = await containBrowsePath(jailBase, upperCaseVariant);
    expect(result.ok).toBe(true);
  });

  it("reports not_found for a path that does not exist (still lexically inside jail)", async () => {
    const missing = path.join(jailBase, "does-not-exist");
    const result = await containBrowsePath(jailBase, missing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });
});

describe("containMkdirPath — mkdir jail escape vectors", () => {
  it("allows creating a new dir directly inside the jail", async () => {
    const target = path.join(jailBase, "new-dir");
    const result = await containMkdirPath(jailBase, target);
    expect(result.ok).toBe(true);
  });

  it("allows creating a nested new dir (recursive) inside the jail", async () => {
    const target = path.join(jailBase, "a", "b", "c");
    const result = await containMkdirPath(jailBase, target);
    expect(result.ok).toBe(true);
  });

  it("rejects '..' traversal mkdir out of the jail", async () => {
    const target = path.join(jailBase, "..", "outside", "evil");
    const result = await containMkdirPath(jailBase, target);
    expect(result.ok).toBe(false);
  });

  it("rejects an absolute-outside mkdir target", async () => {
    const target = path.join(outsideDir, "evil");
    const result = await containMkdirPath(jailBase, target);
    expect(result.ok).toBe(false);
  });

  it("rejects a prefix-collision sibling mkdir target", async () => {
    const target = path.join(siblingCollision, "evil");
    const result = await containMkdirPath(jailBase, target);
    expect(result.ok).toBe(false);
  });

  it("rejects mkdir-through-symlink: an intermediate dir is a symlink escaping the jail", async () => {
    const linkPath = path.join(jailBase, "escape-link");
    await fs.symlink(outsideDir, linkPath, "junction");
    const target = path.join(linkPath, "evil-new-dir");
    const result = await containMkdirPath(jailBase, target);
    expect(result.ok).toBe(false);
  });

  it("rejects mkdir-through-symlink even when the escaped target segment doesn't exist yet", async () => {
    const linkPath = path.join(jailBase, "escape-link2");
    await fs.symlink(outsideDir, linkPath, "junction");
    const target = path.join(linkPath, "nested", "evil-new-dir");
    const result = await containMkdirPath(jailBase, target);
    expect(result.ok).toBe(false);
  });

  it("allows mkdir through a symlink that stays inside the jail", async () => {
    const realInside = path.join(jailBase, "real-inside");
    await fs.mkdir(realInside);
    const linkPath = path.join(jailBase, "inside-link");
    await fs.symlink(realInside, linkPath, "junction");
    const target = path.join(linkPath, "new-dir");
    const result = await containMkdirPath(jailBase, target);
    expect(result.ok).toBe(true);
  });

  it("rejects when the jail base itself does not exist", async () => {
    const missingBase = path.join(tmpRoot, "does-not-exist-base");
    const target = path.join(missingBase, "new-dir");
    const result = await containMkdirPath(missingBase, target);
    expect(result.ok).toBe(false);
  });
});
