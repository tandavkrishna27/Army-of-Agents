import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeAoaSkillCopy } from "../server-utils.js";

/**
 * Codex P2 — fs.cp's `filter` only skips copying matching SOURCE entries; it
 * does not remove a same-named path already present in the TARGET. For a
 * persistent runtime target reused across runs, a stale `.git` (or symlink)
 * materialized by an earlier run/version would survive, defeating the
 * exclude-VCS/symlink guarantee. materializeAoaSkillCopy now removes the target
 * up front so each materialization is a clean, filtered copy.
 */
const tmpRoots: string[] = [];
async function mkTmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-materialize-"));
  tmpRoots.push(d);
  return d;
}
async function exists(p: string) {
  return fs.access(p).then(() => true).catch(() => false);
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("materializeAoaSkillCopy (Codex P2)", () => {
  it("clears a stale .git + stale files already in a reused target before copying", async () => {
    const root = await mkTmp();
    const source = path.join(root, "src-skill");
    const target = path.join(root, "runtime", "MySkill");

    // Source skill: a SKILL.md plus a nested .git that must NOT be materialized.
    await fs.mkdir(path.join(source, ".git"), { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: MySkill\n---\n");
    await fs.writeFile(path.join(source, ".git", "config"), "[core]\n");

    // Target already exists from an earlier run with a STALE .git + stale file.
    await fs.mkdir(path.join(target, ".git"), { recursive: true });
    await fs.writeFile(path.join(target, ".git", "HEAD"), "ref: stale\n");
    await fs.writeFile(path.join(target, "stale-old.txt"), "old");

    await materializeAoaSkillCopy(source, target);

    // Fresh, filtered copy: SKILL.md present; the stale target .git AND stale
    // file are gone; the source .git was filtered out (never copied).
    expect(await exists(path.join(target, "SKILL.md"))).toBe(true);
    expect(await exists(path.join(target, ".git"))).toBe(false);
    expect(await exists(path.join(target, "stale-old.txt"))).toBe(false);
  });

  it("materializes a fresh target when none exists (happy path unaffected)", async () => {
    const root = await mkTmp();
    const source = path.join(root, "src-skill");
    const target = path.join(root, "runtime", "MySkill");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: MySkill\n---\n");

    const { skippedSymlinks } = await materializeAoaSkillCopy(source, target);

    expect(await exists(path.join(target, "SKILL.md"))).toBe(true);
    expect(skippedSymlinks).toEqual([]);
  });
});
