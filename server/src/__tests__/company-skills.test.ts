import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const agentGetByIdMock = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    getById: agentGetByIdMock,
    list: vi.fn().mockResolvedValue([]),
  }),
}));
vi.mock("../services/projects.js", () => ({
  projectService: () => ({}),
}));
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({}),
}));

import {
  companySkillService,
  discoverProjectWorkspaceSkillDirectories,
  findMissingLocalSkillIds,
  normalizeGitHubSkillDirectory,
  parseSkillImportSourceInput,
  readLocalSkillImportFromDirectory,
  validatePackageFileKey,
} from "../services/company-skills.js";
import { managedMarketplaceSkillsRoot } from "../services/marketplace-install/managed-skills-root.js";

const cleanupDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
  vi.clearAllMocks();
});

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

async function writeSkillDir(skillDir: string, name: string) {
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}\n`, "utf8");
}

describe("validatePackageFileKey (path-traversal guard used by readFile/updateFile)", () => {
  const base = path.join(os.tmpdir(), "skills", "co1", "s1");

  it("rejects parent-dir traversal", () => {
    expect(() => validatePackageFileKey(base, "../../../etc/passwd")).toThrow(/path traversal/);
    expect(() => validatePackageFileKey(base, "a/../../b")).toThrow(/path traversal/);
  });

  it("accepts safe in-dir paths and returns the normalized key", () => {
    expect(validatePackageFileKey(base, "references/guide.md")).toBe("references/guide.md");
    expect(validatePackageFileKey(base, "SKILL.md")).toBe("SKILL.md");
    // backslashes are normalized to forward slashes
    expect(validatePackageFileKey(base, "scripts\\run.sh")).toBe("scripts/run.sh");
  });
});

describe("company skill import source parsing", () => {
  it("parses a skills.sh command without executing shell input", () => {
    const parsed = parseSkillImportSourceInput(
      "npx skills add https://github.com/vercel-labs/skills --skill find-skills",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.requestedSkillSlug).toBe("find-skills");
    expect(parsed.originalSkillsShUrl).toBeNull();
    expect(parsed.warnings).toEqual([]);
  });

  it("parses owner/repo/skill shorthand as skills.sh-managed", () => {
    const parsed = parseSkillImportSourceInput("vercel-labs/skills/find-skills");

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.requestedSkillSlug).toBe("find-skills");
    expect(parsed.originalSkillsShUrl).toBe("https://skills.sh/vercel-labs/skills/find-skills");
  });

  it("resolves skills.sh URL with org/repo/skill to GitHub repo and preserves original URL", () => {
    const parsed = parseSkillImportSourceInput(
      "https://skills.sh/google-labs-code/stitch-skills/design-md",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/google-labs-code/stitch-skills");
    expect(parsed.requestedSkillSlug).toBe("design-md");
    expect(parsed.originalSkillsShUrl).toBe("https://skills.sh/google-labs-code/stitch-skills/design-md");
  });

  it("resolves skills.sh URL with org/repo (no skill) to GitHub repo and preserves original URL", () => {
    const parsed = parseSkillImportSourceInput(
      "https://skills.sh/vercel-labs/skills",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.requestedSkillSlug).toBeNull();
    expect(parsed.originalSkillsShUrl).toBe("https://skills.sh/vercel-labs/skills");
  });

  it("parses skills.sh commands whose requested skill differs from the folder name", () => {
    const parsed = parseSkillImportSourceInput(
      "npx skills add https://github.com/remotion-dev/skills --skill remotion-best-practices",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/remotion-dev/skills");
    expect(parsed.requestedSkillSlug).toBe("remotion-best-practices");
    expect(parsed.originalSkillsShUrl).toBeNull();
  });

  it("does not set originalSkillsShUrl for owner/repo shorthand", () => {
    const parsed = parseSkillImportSourceInput("vercel-labs/skills");

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.originalSkillsShUrl).toBeNull();
  });
});

describe("project workspace skill discovery", () => {
  it("normalizes GitHub skill directories for blob imports and legacy metadata", () => {
    expect(normalizeGitHubSkillDirectory("retro/.", "retro")).toBe("retro");
    expect(normalizeGitHubSkillDirectory("retro/SKILL.md", "retro")).toBe("retro");
    expect(normalizeGitHubSkillDirectory("SKILL.md", "root-skill")).toBe("");
    expect(normalizeGitHubSkillDirectory("", "fallback-skill")).toBe("fallback-skill");
  });

  it("finds bounded skill roots under supported workspace paths", async () => {
    const workspace = await makeTempDir("paperclip-skill-workspace-");
    await writeSkillDir(workspace, "Workspace Root");
    await writeSkillDir(path.join(workspace, "skills", "find-skills"), "Find Skills");
    await writeSkillDir(path.join(workspace, ".agents", "skills", "release"), "Release");
    await writeSkillDir(path.join(workspace, "skills", ".system", "paperclip"), "Paperclip");
    await fs.writeFile(path.join(workspace, "README.md"), "# ignore\n", "utf8");

    const discovered = await discoverProjectWorkspaceSkillDirectories({
      workspaceCwd: workspace,
    });

    expect(discovered).toEqual([
      { skillDir: path.resolve(workspace), inventoryMode: "project_root" },
      { skillDir: path.resolve(workspace, ".agents", "skills", "release"), inventoryMode: "full" },
      { skillDir: path.resolve(workspace, "skills", ".system", "paperclip"), inventoryMode: "full" },
      { skillDir: path.resolve(workspace, "skills", "find-skills"), inventoryMode: "full" },
    ]);
  });

  it("limits root SKILL.md imports to skill-related support folders", async () => {
    const workspace = await makeTempDir("paperclip-root-skill-");
    await writeSkillDir(workspace, "Workspace Skill");
    await fs.mkdir(path.join(workspace, "references"), { recursive: true });
    await fs.mkdir(path.join(workspace, "scripts"), { recursive: true });
    await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "references", "checklist.md"), "# Checklist\n", "utf8");
    await fs.writeFile(path.join(workspace, "scripts", "run.sh"), "echo ok\n", "utf8");
    await fs.writeFile(path.join(workspace, "assets", "logo.svg"), "<svg />\n", "utf8");
    await fs.writeFile(path.join(workspace, "README.md"), "# Repo\n", "utf8");
    await fs.writeFile(path.join(workspace, "src", "index.ts"), "export {};\n", "utf8");

    const imported = await readLocalSkillImportFromDirectory(
      "33333333-3333-4333-8333-333333333333",
      workspace,
      { inventoryMode: "project_root", metadata: { sourceKind: "project_scan" } },
    );

    expect(new Set(imported!.fileInventory.map((entry) => entry.path))).toEqual(new Set([
      "assets/logo.svg",
      "references/checklist.md",
      "scripts/run.sh",
      "SKILL.md",
    ]));
    expect(imported!.fileInventory.map((entry) => entry.kind)).toContain("script");
    expect(imported!.metadata?.sourceKind).toBe("project_scan");
  });

  it("parses inline object array items in skill frontmatter metadata", async () => {
    const workspace = await makeTempDir("paperclip-inline-skill-yaml-");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "SKILL.md"),
      [
        "---",
        "name: Inline Metadata Skill",
        "metadata:",
        "  sources:",
        "    - kind: github-dir",
        "      repo: paperclipai/paperclip",
        "      path: skills/aoa",
        "---",
        "",
        "# Inline Metadata Skill",
        "",
      ].join("\n"),
      "utf8",
    );

    const imported = await readLocalSkillImportFromDirectory(
      "33333333-3333-4333-8333-333333333333",
      workspace,
      { inventoryMode: "full" },
    );

    expect(imported!.metadata).toMatchObject({
      sourceKind: "local_path",
      sources: [
        {
          kind: "github-dir",
          repo: "paperclipai/paperclip",
          path: "skills/aoa",
        },
      ],
    });
  });
});

describe("missing local skill reconciliation", () => {
  it("flags local-path skills whose directory was removed", async () => {
    const workspace = await makeTempDir("paperclip-missing-skill-dir-");
    const skillDir = path.join(workspace, "skills", "ghost");
    await writeSkillDir(skillDir, "Ghost");
    await fs.rm(skillDir, { recursive: true, force: true });

    const missingIds = await findMissingLocalSkillIds([
      {
        id: "skill-1",
        sourceType: "local_path",
        sourceLocator: skillDir,
      },
      {
        id: "skill-2",
        sourceType: "github",
        sourceLocator: "https://github.com/vercel-labs/agent-browser",
      },
    ]);

    expect(missingIds).toEqual(["skill-1"]);
  });

  it("flags local-path skills whose SKILL.md file was removed", async () => {
    const workspace = await makeTempDir("paperclip-missing-skill-file-");
    const skillDir = path.join(workspace, "skills", "ghost");
    await writeSkillDir(skillDir, "Ghost");
    await fs.rm(path.join(skillDir, "SKILL.md"), { force: true });

    const missingIds = await findMissingLocalSkillIds([
      {
        id: "skill-1",
        sourceType: "local_path",
        sourceLocator: skillDir,
      },
    ]);

    expect(missingIds).toEqual(["skill-1"]);
  });
});

describe("runtime catalog bundle injection", () => {
  it("injects ancillary files from catalog bundle install path", async () => {
    const bundleDir = await makeTempDir("paperclip-catalog-bundle-runtime-");
    await fs.mkdir(path.join(bundleDir, "references"), { recursive: true });
    await fs.mkdir(path.join(bundleDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(bundleDir, "SKILL.md"), "# OpenAI Docs\n", "utf8");
    await fs.writeFile(path.join(bundleDir, "references", "guide.md"), "guide", "utf8");
    await fs.writeFile(path.join(bundleDir, "scripts", "run.js"), "console.log('run')", "utf8");
    agentGetByIdMock.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      skillKeys: ["skill:github-skills/openai/skills/openai-docs"],
    });
    const row = makeSkillRow({
      key: "skill:github-skills/openai/skills/openai-docs",
      sourceType: "catalog",
      sourceLocator: "skill:github-skills/openai/skills/openai-docs",
      metadata: { catalogBundleInstallPath: bundleDir },
      fileInventory: [
        { path: "SKILL.md", kind: "skill" },
        { path: "references/guide.md", kind: "reference" },
        { path: "scripts/run.js", kind: "script" },
      ],
    });
    const service = companySkillService(makeDbReturning([row]) as any);

    const entries = await service.listRuntimeSkillEntries("company-1", "agent-1");

    expect(entries).toEqual([
      {
        key: "skill:github-skills/openai/skills/openai-docs",
        name: "OpenAI Docs",
        markdown: "# OpenAI Docs",
        trustLevel: "scripts_executables",
        files: [
          { path: "references/guide.md", content: "guide" },
          { path: "scripts/run.js", content: "console.log('run')" },
        ],
      },
    ]);
  });
});

describe("catalog skill source metadata", () => {
  it("labels catalog skills with provider name when catalogProvider metadata exists", async () => {
    const row = makeSkillRow({
      sourceType: "catalog",
      metadata: {
        catalogProvider: {
          id: "anthropic",
          name: "Anthropic",
          fallbackInitials: "A",
          logoUrl: "https://github.com/anthropics.png",
        },
      },
    });
    const service = companySkillService(makeDbReturning([row]) as any);

    const list = await service.list("company-1");

    expect(list[0]?.sourceBadge).toBe("catalog");
    expect(list[0]?.sourceLabel).toBe("Anthropic");
  });
});

function makeSkillRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-14T00:00:00Z");
  return {
    id: "skill-row-1",
    companyId: "company-1",
    key: "skill:key",
    slug: "openai-docs",
    name: "OpenAI Docs",
    description: "Docs",
    markdown: "# OpenAI Docs",
    sourceType: "catalog",
    sourceLocator: null,
    sourceRef: "1.0.0",
    trustLevel: "scripts_executables",
    compatibility: "compatible",
    fileInventory: [],
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("managed marketplace-skills jail (T2.8c(b))", () => {
  it("importFromSource refuses a local skill from inside the managed marketplace-skills tree", async () => {
    // A directory the catalog installer owns. Importing it would mint an
    // editable `local_path` row, after which PATCH /skills/:id/files could write
    // into a catalog-managed bundle. server/.aoa is gitignored; clean up after.
    const base = path.join(managedMarketplaceSkillsRoot(), "__t2_8c_import_test__");
    cleanupDirs.add(base);
    const skillDir = path.join(base, "company-1", "skill_x", "1.0.0");
    await writeSkillDir(skillDir, "code-review");

    const service = companySkillService(makeDbReturning([]) as any);

    await expect(service.importFromSource("company-1", skillDir)).rejects.toThrow(
      /managed marketplace-skills tree/,
    );
  });

  it("updateFile refuses to edit a local_path row whose files live inside the managed tree (Codex #302 writable-sink)", async () => {
    // The authoritative sink guard: covers rows minted by scanProjectWorkspaces
    // and any that predate the importFromSource check. No filesystem needed —
    // the guard fires before any disk write.
    const insideManaged = path.join(managedMarketplaceSkillsRoot(), "company-1", "skill_x", "1.0.0");
    const row = makeSkillRow({ sourceType: "local_path", sourceLocator: insideManaged });
    const service = companySkillService(makeDbReturning([row]) as any);

    await expect(
      service.updateFile("company-1", "skill-row-1", "SKILL.md", "# hijack"),
    ).rejects.toThrow(/managed marketplace-skills directory/);
  });

  it("updateFile still enforces the managed-tree jail on a byte-identical SKILL.md save", async () => {
    const insideManaged = path.join(managedMarketplaceSkillsRoot(), "company-1", "skill_x", "1.0.0");
    const row = makeSkillRow({
      sourceType: "local_path",
      sourceLocator: insideManaged,
      markdown: "# OpenAI Docs",
    });
    const service = companySkillService(makeDbReturning([row]) as any);

    await expect(
      service.updateFile("company-1", "skill-row-1", "SKILL.md", "# OpenAI Docs"),
    ).rejects.toThrow(/managed marketplace-skills directory/);
  });

  it("updateFile refuses a forward path resolving into the managed tree from an ANCESTOR sourceLocator (Codex #302 re-review)", async () => {
    // sourceLocator is an ANCESTOR of the managed tree, so a sourceLocator-only
    // check would pass; the guard must check the resolved sourceLocator+path.
    const ancestorLocator = path.join(process.cwd(), ".aoa");
    const row = makeSkillRow({ sourceType: "local_path", sourceLocator: ancestorLocator });
    const service = companySkillService(makeDbReturning([row]) as any);

    await expect(
      service.updateFile(
        "company-1",
        "skill-row-1",
        "marketplace-skills/company-1/skill_x/1.0.0/evil.md",
        "# hijack",
      ),
    ).rejects.toThrow(/managed marketplace-skills directory/);
  });
});

function makeDbReturning(rows: any[]) {
  const queryResult = {
    orderBy: vi.fn().mockResolvedValue(rows),
    then: (resolve: (value: any[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => queryResult),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn() })),
  };
}
