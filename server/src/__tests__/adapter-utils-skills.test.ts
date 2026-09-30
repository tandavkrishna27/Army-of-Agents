import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPersistentSkillSnapshot,
  ensureAoaSkillSymlink,
  ensurePaperclipSkillSymlink,
  joinPromptSections,
  listAoaSkillEntries,
  listPaperclipSkillEntries,
  normalizeAoaWakePayload,
  normalizePaperclipWakePayload,
  readAoaRuntimeSkillEntries,
  readAoaSkillMarkdown,
  readAoaSkillSyncPreference,
  readInstalledSkillTargets,
  removeMaintainerOnlySkillSymlinks,
  renderAoaWakePrompt,
  resolveAoaDesiredSkillNames,
  resolveAoaSkillsDir,
  writeAoaSkillSyncPreference,
  type AoaSkillEntry,
  type InstalledSkillTarget,
} from "@armyofagents/adapter-utils/server-utils";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeSkillFixture(root: string, name: string, markdown?: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  if (typeof markdown === "string") {
    await fs.writeFile(path.join(dir, "SKILL.md"), markdown, "utf8");
  }
  return dir;
}

// Windows requires `junction` for directory symlinks when not elevated.
async function symlinkDir(target: string, linkPath: string) {
  return fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : undefined);
}

describe("adapter-utils skills helpers", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    cleanupDirs.clear();
  });

  describe("joinPromptSections", () => {
    it("filters nullish/empty entries and joins the remainder with a blank line", () => {
      const result = joinPromptSections(["first", null, "", "  ", "second"]);
      expect(result).toBe("first\n\nsecond");
    });

    it("honors a custom separator and trims whitespace around each section", () => {
      const result = joinPromptSections(["  a  ", "b"], " | ");
      expect(result).toBe("a | b");
    });
  });

  describe("resolveAoaSkillsDir", () => {
    it("returns a configured candidate directory when it exists", async () => {
      const root = await makeTempDir("aoa-skills-root-");
      cleanupDirs.add(root);
      const resolved = await resolveAoaSkillsDir(os.tmpdir(), [root]);
      expect(resolved).toBe(path.resolve(root));
    });

    it("returns null when no candidate directory exists", async () => {
      const bogus = path.join(os.tmpdir(), `aoa-skills-missing-${Date.now()}`);
      const resolved = await resolveAoaSkillsDir(bogus, []);
      expect(resolved).toBeNull();
    });
  });

  describe("listAoaSkillEntries", () => {
    it("lists directories under the resolved skills dir with AoA-prefixed keys", async () => {
      const root = await makeTempDir("aoa-skills-list-");
      cleanupDirs.add(root);
      await makeSkillFixture(root, "foo");
      await makeSkillFixture(root, "bar");
      await fs.writeFile(path.join(root, "ignore.txt"), "not a skill", "utf8");

      const entries = await listAoaSkillEntries(os.tmpdir(), [root]);
      const names = entries.map((entry) => entry.runtimeName).sort();
      expect(names).toEqual(["bar", "foo"]);
      expect(entries.every((entry) => entry.key.startsWith("armyofagents/aoa/"))).toBe(true);
      expect(entries.every((entry) => entry.required === true)).toBe(true);
    });

    it("returns an empty array when the skills dir cannot be found", async () => {
      const bogus = path.join(os.tmpdir(), `aoa-skills-none-${Date.now()}`);
      const entries = await listAoaSkillEntries(bogus, []);
      expect(entries).toEqual([]);
    });
  });

  describe("readInstalledSkillTargets", () => {
    it("reports directories, files, and symlinks in the skills home", async () => {
      const skillsHome = await makeTempDir("aoa-skills-home-");
      const sourceRoot = await makeTempDir("aoa-skills-source-");
      cleanupDirs.add(skillsHome);
      cleanupDirs.add(sourceRoot);

      const sourceDir = await makeSkillFixture(sourceRoot, "skill-a");
      await fs.mkdir(path.join(skillsHome, "skill-b"), { recursive: true });
      await fs.writeFile(path.join(skillsHome, "loose-file"), "data", "utf8");
      await symlinkDir(sourceDir, path.join(skillsHome, "skill-a"));

      const installed = await readInstalledSkillTargets(skillsHome);
      expect(installed.size).toBe(3);
      expect(installed.get("skill-a")?.kind).toBe("symlink");
      expect(installed.get("skill-b")?.kind).toBe("directory");
      expect(installed.get("loose-file")?.kind).toBe("file");
    });

    it("returns an empty map when the skills home does not exist", async () => {
      const bogus = path.join(os.tmpdir(), `aoa-skills-home-missing-${Date.now()}`);
      const installed = await readInstalledSkillTargets(bogus);
      expect(installed.size).toBe(0);
    });
  });

  describe("readAoaSkillSyncPreference", () => {
    it("marks preference as not explicit when aoaSkillSync is absent", () => {
      const result = readAoaSkillSyncPreference({});
      expect(result.explicit).toBe(false);
      expect(result.desiredSkills).toEqual([]);
    });

    it("parses explicit desired skills and dedupes whitespace", () => {
      const result = readAoaSkillSyncPreference({
        aoaSkillSync: { desiredSkills: ["foo", " foo ", "bar", ""] },
      });
      expect(result.explicit).toBe(true);
      expect(result.desiredSkills.sort()).toEqual(["bar", "foo"]);
    });

    it("falls back to paperclipSkillSync when aoaSkillSync is absent (back-compat)", () => {
      const result = readAoaSkillSyncPreference({
        paperclipSkillSync: { desiredSkills: ["legacy-key"] },
      });
      expect(result.explicit).toBe(true);
      expect(result.desiredSkills).toContain("legacy-key");
    });

    it("prefers aoaSkillSync over paperclipSkillSync when both are present", () => {
      const result = readAoaSkillSyncPreference({
        aoaSkillSync: { desiredSkills: ["new-key"] },
        paperclipSkillSync: { desiredSkills: ["old-key"] },
      });
      expect(result.desiredSkills).toContain("new-key");
      expect(result.desiredSkills).not.toContain("old-key");
    });
  });

  describe("writeAoaSkillSyncPreference", () => {
    it("sets desiredSkills and preserves unrelated config keys", () => {
      const input = { other: "keep", aoaSkillSync: { retained: true } };
      const next = writeAoaSkillSyncPreference(input, [" a ", "b", "b", ""]);
      expect(next.other).toBe("keep");
      const sync = next.aoaSkillSync as Record<string, unknown>;
      expect(sync.retained).toBe(true);
      expect(sync.desiredSkills).toEqual(["a", "b"]);
    });

    it("writes both aoaSkillSync and paperclipSkillSync for back-compat", () => {
      const out = writeAoaSkillSyncPreference({} as Record<string, unknown>, ["x", "y"]);
      expect(out.aoaSkillSync).toBeDefined();
      expect(out.paperclipSkillSync).toBeDefined();
      expect(out.paperclipSkillSync).toEqual(out.aoaSkillSync);
    });

    it("dual-writes the same desiredSkills array into both fields", () => {
      const out = writeAoaSkillSyncPreference({}, ["deploy-prod", "qa-agent"]);
      const aoa = out.aoaSkillSync as Record<string, unknown>;
      const pcp = out.paperclipSkillSync as Record<string, unknown>;
      expect(aoa.desiredSkills).toEqual(["deploy-prod", "qa-agent"]);
      expect(pcp.desiredSkills).toEqual(["deploy-prod", "qa-agent"]);
    });
  });

  describe("resolveAoaDesiredSkillNames", () => {
    const available: Array<{ key: string; runtimeName: string; required?: boolean }> = [
      { key: "armyofagents/aoa/alpha", runtimeName: "alpha", required: true },
      { key: "armyofagents/aoa/beta", runtimeName: "beta", required: false },
      { key: "armyofagents/aoa/gamma", runtimeName: "gamma", required: false },
    ];

    it("defaults to the required skills when no explicit preference is set", () => {
      const result = resolveAoaDesiredSkillNames({}, available);
      expect(result).toEqual(["armyofagents/aoa/alpha"]);
    });

    it("canonicalizes explicit references and unions them with the required set", () => {
      const result = resolveAoaDesiredSkillNames(
        { aoaSkillSync: { desiredSkills: ["beta", "armyofagents/aoa/gamma"] } },
        available,
      );
      expect(result.sort()).toEqual([
        "armyofagents/aoa/alpha",
        "armyofagents/aoa/beta",
        "armyofagents/aoa/gamma",
      ]);
    });
  });

  describe("readAoaSkillMarkdown", () => {
    it("returns null for an empty or unknown skill key", async () => {
      expect(await readAoaSkillMarkdown(os.tmpdir(), "")).toBeNull();
      expect(await readAoaSkillMarkdown(os.tmpdir(), "does-not-exist")).toBeNull();
    });
  });

  describe("readAoaRuntimeSkillEntries", () => {
    it("returns configured entries when aoaRuntimeSkills is provided", async () => {
      const entries = await readAoaRuntimeSkillEntries(
        {
          aoaRuntimeSkills: [
            {
              key: "armyofagents/aoa/custom",
              runtimeName: "custom",
              source: "/tmp/custom",
              required: true,
            },
          ],
        },
        os.tmpdir(),
        [],
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.runtimeName).toBe("custom");
      expect(entries[0]?.required).toBe(true);
    });
  });

  describe("buildPersistentSkillSnapshot", () => {
    it("produces an entry per available + extra installed skill and surfaces warnings", () => {
      const available: AoaSkillEntry[] = [
        {
          key: "armyofagents/aoa/alpha",
          runtimeName: "alpha",
          source: "/src/alpha",
          required: true,
          requiredReason: null,
        },
        {
          key: "armyofagents/aoa/beta",
          runtimeName: "beta",
          source: "/src/beta",
          required: false,
          requiredReason: null,
        },
      ];
      const installed = new Map<string, InstalledSkillTarget>([
        ["alpha", { targetPath: "/src/alpha", kind: "symlink" }],
        ["extra-user-skill", { targetPath: "/home/user/extra", kind: "directory" }],
      ]);

      const snapshot = buildPersistentSkillSnapshot({
        adapterType: "claude-local",
        availableEntries: available,
        desiredSkills: ["armyofagents/aoa/alpha", "armyofagents/aoa/missing-one"],
        installed,
        skillsHome: "/home/user/.aoa/skills/claude-local",
        installedDetail: "ok",
        missingDetail: "needs installing",
        externalConflictDetail: "conflict",
        externalDetail: "external",
      });

      expect(snapshot.mode).toBe("persistent");
      expect(snapshot.supported).toBe(true);
      expect(snapshot.adapterType).toBe("claude-local");

      const byKey = Object.fromEntries(snapshot.entries.map((entry) => [entry.key, entry]));
      expect(byKey["armyofagents/aoa/alpha"]?.state).toBe("installed");
      expect(byKey["armyofagents/aoa/alpha"]?.managed).toBe(true);
      expect(byKey["armyofagents/aoa/alpha"]?.origin).toBe("aoa_required");
      expect(byKey["armyofagents/aoa/beta"]?.state).toBe("available");
      expect(byKey["armyofagents/aoa/missing-one"]?.state).toBe("missing");
      expect(byKey["armyofagents/aoa/missing-one"]?.origin).toBe("external_unknown");
      expect(byKey["extra-user-skill"]?.state).toBe("external");
      expect(byKey["extra-user-skill"]?.origin).toBe("user_installed");

      expect(snapshot.warnings.some((w) => w.includes("missing-one"))).toBe(true);
    });
  });

  describe("ensureAoaSkillSymlink", () => {
    it("creates a missing symlink and is idempotent on re-run", async () => {
      const root = await makeTempDir("aoa-skill-symlink-");
      cleanupDirs.add(root);
      const source = await makeSkillFixture(root, "skill-src");
      const target = path.join(root, "skill-link");

      const first = await ensureAoaSkillSymlink(source, target);
      expect(first).toBe("created");
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);

      const second = await ensureAoaSkillSymlink(source, target);
      expect(second).toBe("skipped");
    });
  });

  describe("removeMaintainerOnlySkillSymlinks", () => {
    it("removes symlinks that point into /.agents/skills/ and keeps everything else", async () => {
      const root = await makeTempDir("aoa-skill-maintainer-");
      const externalSource = await makeTempDir("aoa-skill-ext-");
      cleanupDirs.add(root);
      cleanupDirs.add(externalSource);

      const maintainerSource = path.join(root, ".agents", "skills", "maintainer-only");
      await fs.mkdir(maintainerSource, { recursive: true });
      await symlinkDir(maintainerSource, path.join(root, "maintainer-only"));
      await symlinkDir(externalSource, path.join(root, "legit-external"));

      const removed = await removeMaintainerOnlySkillSymlinks(root, []);
      expect(removed).toEqual(["maintainer-only"]);
      await expect(fs.lstat(path.join(root, "legit-external"))).resolves.toBeTruthy();
    });
  });

  describe("wake payload helpers", () => {
    it("normalizes a minimal wake payload with issue + comments", () => {
      const normalized = normalizeAoaWakePayload({
        reason: "new_comment",
        issue: { id: "iss_1", identifier: "TASK-1", title: "Do the thing" },
        latestCommentId: "c_2",
        commentIds: ["c_1", "c_2"],
        comments: [
          {
            id: "c_2",
            body: "please handle this",
            author: { type: "user", id: "u_1" },
          },
        ],
      });
      expect(normalized).not.toBeNull();
      expect(normalized?.reason).toBe("new_comment");
      expect(normalized?.issue?.identifier).toBe("TASK-1");
      expect(normalized?.comments).toHaveLength(1);
      expect(normalized?.comments[0]?.body).toBe("please handle this");
    });

    it("renders a wake prompt mentioning AoA-branded header + latest comment", () => {
      const prompt = renderAoaWakePrompt({
        reason: "new_comment",
        issue: { identifier: "TASK-2", title: "Demo" },
        latestCommentId: "c_7",
        comments: [
          {
            id: "c_7",
            body: "take a look",
            author: { type: "user", id: "u_1" },
          },
        ],
      });
      expect(prompt).toContain("## AoA Wake Payload");
      expect(prompt).toContain("take a look");
      expect(prompt).not.toContain("Paperclip");
    });
  });

  describe("renderAoaWakePrompt — harness-checkout advisory", () => {
    const minimalPayload = {
      issue: { id: "iss_hco", identifier: "TASK-99", title: "Checkout test" },
      latestCommentId: "c_hco",
      comments: [
        {
          id: "c_hco",
          body: "please check this out",
          author: { type: "user", id: "u_hco" },
        },
      ],
    };

    it("includes 'already claimed by the harness' note when checkedOutByHarness=true", () => {
      const prompt = renderAoaWakePrompt({
        ...minimalPayload,
        checkedOutByHarness: true,
      });
      expect(prompt).toContain("already claimed by the harness");
      expect(prompt).toContain("Do not call");
      expect(prompt).toContain("/checkout");
    });

    it("includes the checkout bullet line when checkedOutByHarness=true", () => {
      const prompt = renderAoaWakePrompt({
        ...minimalPayload,
        checkedOutByHarness: true,
      });
      expect(prompt).toContain("- checkout: already claimed by the harness for this run");
    });

    it("omits the harness-claim note when checkedOutByHarness=false", () => {
      const prompt = renderAoaWakePrompt({
        ...minimalPayload,
        checkedOutByHarness: false,
      });
      expect(prompt).not.toContain("already claimed by the harness");
    });

    it("omits the harness-claim note when checkedOutByHarness is absent", () => {
      const prompt = renderAoaWakePrompt(minimalPayload);
      expect(prompt).not.toContain("already claimed by the harness");
    });
  });

  describe("Paperclip-named aliases", () => {
    it("exposes the same function identity as the AoA-named primaries", () => {
      expect(normalizePaperclipWakePayload).toBe(normalizeAoaWakePayload);
      expect(listPaperclipSkillEntries).toBe(listAoaSkillEntries);
      expect(ensurePaperclipSkillSymlink).toBe(ensureAoaSkillSymlink);
    });
  });
});
