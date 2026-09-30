import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { companySkills: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
}));
vi.mock(
  "../services/outbound-url-guard.js",
  () => import("./helpers/outbound-url-guard.mock.js"),
);

const materializerMock = vi.hoisted(() => vi.fn());

vi.mock("../services/marketplace-install/skill-bundle-materializer.js", async () => {
  const actual = await vi.importActual<typeof import("../services/marketplace-install/skill-bundle-materializer.js")>(
    "../services/marketplace-install/skill-bundle-materializer.js",
  );
  return {
    ...actual,
    materializeSkillBundle: materializerMock,
  };
});

import { installSkill } from "../services/marketplace-install/skill-installer.js";
import { createBundleCheckoutCache } from "../services/marketplace-install/skill-bundle-materializer.js";
import type { CatalogItem } from "@armyofagents/shared";

const PINNED_RESOURCE_BASE =
  `https://raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace/${"f".repeat(40)}`;
const SKILL_INLINE: CatalogItem = {
  id: "skill:aoa-curated/code-review",
  type: "skill",
  name: "Code Review Skill",
  description: "Review code for issues",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "https://...", locator: "content/skills/code-review", commitSha: "abc123" },
  resourceUrl: `${PINNED_RESOURCE_BASE}/content/skills/code-review/SKILL.md`,
  content: { inline: "# Code Review\n\nAlways check for memory leaks." },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

const SKILL_FETCH: CatalogItem = {
  ...SKILL_INLINE,
  id: "skill:aoa-curated/web-search",
  name: "Web Search",
  content: undefined,  // forces HTTP fetch
  resourceUrl: `${PINNED_RESOURCE_BASE}/content/skills/web-search/SKILL.md`,
};

const SKILL_BUNDLE: CatalogItem = {
  ...SKILL_INLINE,
  id: "skill:github-skills/example/repo/bundle-skill",
  name: "Bundle Skill",
  skill: {
    bundle: {
      type: "github-directory",
      repo: "example/repo",
      commitSha: "abc123",
      path: "skills/bundle-skill",
      treeUrl: "https://github.com/example/repo/tree/abc123/skills/bundle-skill",
    },
    frontmatter: { name: "bundle-skill", raw: {} },
  },
  provider: {
    id: "example",
    name: "Example",
    logoUrl: "https://example.com/logo.png",
    fallbackInitials: "EX",
  },
};

describe("installSkill", () => {
  let insertedRow: any = null;

  // Default mockDb: select returns [] (no existing install), insert succeeds.
  const mockDb = {
    select: (_fields?: any) => ({
      from: (_table: any) => ({
        where: (_cond: any) => ({
          limit: (_n: number) => Promise.resolve([]),
        }),
      }),
    }),
    insert: () => ({
      values: (row: any) => {
        insertedRow = row;
        return {
          returning: () => Promise.resolve([{ ...row, id: "skill-uuid-1" }]),
        };
      },
    }),
  };

  beforeEach(() => {
    insertedRow = null;
    materializerMock.mockReset();
  });

  it("uses inline content when present (no HTTP fetch)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    const result = await installSkill({
      catalogItem: SKILL_INLINE,
      companyId: "c1",
      db: mockDb as any,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertedRow.markdown).toBe("# Code Review\n\nAlways check for memory leaks.");
    expect(insertedRow.sourceType).toBe("catalog");
    expect(insertedRow.sourceLocator).toBe("skill:aoa-curated/code-review");
    expect(insertedRow.sourceRef).toBe("1.0.0");
    expect(result.skillId).toBe("skill-uuid-1");
  });

  it("fetches from resourceUrl when inline content absent", async () => {
    const markdownBody = "# Web Search\n\nFetched from CDN.";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => markdownBody,
    }));
    global.fetch = fetchMock as any;

    const result = await installSkill({
      catalogItem: SKILL_FETCH,
      companyId: "c1",
      db: mockDb as any,
    });

    expect(fetchMock).toHaveBeenCalledWith(SKILL_FETCH.resourceUrl, expect.any(Object));
    expect(insertedRow.markdown).toBe(markdownBody);
    expect(result.skillId).toBe("skill-uuid-1");
  });

  it("throws if HTTP fetch returns non-ok", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    global.fetch = fetchMock as any;

    await expect(
      installSkill({ catalogItem: SKILL_FETCH, companyId: "c1", db: mockDb as any }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("throws if catalog item has neither inline content nor resourceUrl", async () => {
    const broken: CatalogItem = { ...SKILL_INLINE, content: undefined, resourceUrl: undefined };
    await expect(
      installSkill({ catalogItem: broken, companyId: "c1", db: mockDb as any }),
    ).rejects.toThrow(/no resourceUrl/i);
  });

  it("always uses trustLevel 'markdown_only' for marketplace skills", async () => {
    global.fetch = vi.fn() as any;
    await installSkill({ catalogItem: SKILL_INLINE, companyId: "c1", db: mockDb as any });
    expect(insertedRow.trustLevel).toBe("markdown_only");
    expect(insertedRow.metadata.catalogTrustTier).toBe("verified");

    // Even community/unverified skills get markdown_only (catalog tier stored separately).
    const COMMUNITY_SKILL: CatalogItem = {
      ...SKILL_INLINE,
      trust: { tier: "community", source: "community" },
    };
    await installSkill({ catalogItem: COMMUNITY_SKILL, companyId: "c1", db: mockDb as any });
    expect(insertedRow.trustLevel).toBe("markdown_only");
    expect(insertedRow.metadata.catalogTrustTier).toBe("community");
  });

  it("materializes bundle-backed skills and stores inventory metadata", async () => {
    materializerMock.mockResolvedValue({
      destination: "C:\\repo\\.aoa\\marketplace-skills\\c1\\skill_github-skills_example_repo_bundle-skill\\1.0.0",
      markdown: "# Bundle Skill\n\nUse the whole package.",
      fileInventory: [
        { path: "SKILL.md", kind: "skill" },
        { path: "references/guide.md", kind: "reference" },
        { path: "scripts/run.js", kind: "script" },
        { path: "assets/logo.png", kind: "asset" },
      ],
      fileCount: 4,
      byteCount: 72,
    });
    global.fetch = vi.fn() as any;

    await installSkill({
      catalogItem: SKILL_BUNDLE,
      companyId: "c1",
      db: mockDb as any,
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(materializerMock).toHaveBeenCalledWith(
      SKILL_BUNDLE.skill?.bundle,
      expect.objectContaining({ overwrite: true }),
    );
    expect(insertedRow.markdown).toContain("# Bundle Skill");
    expect(insertedRow.trustLevel).toBe("scripts_executables");
    expect(insertedRow.fileInventory).toEqual([
      { path: "SKILL.md", kind: "skill" },
      { path: "references/guide.md", kind: "reference" },
      { path: "scripts/run.js", kind: "script" },
      { path: "assets/logo.png", kind: "asset" },
    ]);
    expect(insertedRow.metadata.catalogProvider).toEqual(SKILL_BUNDLE.provider);
    expect(insertedRow.metadata.catalogSkillBundle.path).toBe("skills/bundle-skill");
    expect(insertedRow.metadata.catalogBundleInstallPath).toContain(".aoa");
  });

  // The forwarding is the load-bearing half of the caller's deadline story:
  // `materializeSkillBundle` hands the signal to every `execFile`, so an abort
  // kills a running `git clone` instead of waiting on git's own network timeout.
  // Nothing below installTeam asserted it existed.
  it("forwards the caller's signal and checkout cache to the materializer", async () => {
    materializerMock.mockResolvedValue({
      destination: "dest", markdown: "# Bundle Skill", fileInventory: [], fileCount: 0, byteCount: 0,
    });
    global.fetch = vi.fn() as any;
    const controller = new AbortController();
    const checkoutCache = createBundleCheckoutCache();

    await installSkill({
      catalogItem: SKILL_BUNDLE,
      companyId: "c1",
      db: mockDb as any,
      signal: controller.signal,
      checkoutCache,
    });

    expect(materializerMock).toHaveBeenCalledWith(
      SKILL_BUNDLE.skill?.bundle,
      expect.objectContaining({ signal: controller.signal, checkoutCache }),
    );
  });

  it("stores package metadata when installed through a marketplace package", async () => {
    global.fetch = vi.fn() as any;

    await installSkill({
      catalogItem: SKILL_INLINE,
      companyId: "c1",
      db: mockDb as any,
      packageContext: {
        packageId: "anthropic/skills",
        packageName: "skills",
        sourceUrl: "https://github.com/anthropic/skills",
        provider: {
          id: "anthropic",
          name: "Anthropic",
          logoUrl: "https://github.com/anthropics.png",
          fallbackInitials: "A",
        },
      },
    });

    expect(insertedRow.metadata.packageId).toBe("anthropic/skills");
    expect(insertedRow.metadata.catalogPackageId).toBe("anthropic/skills");
    expect(insertedRow.metadata.catalogPackageName).toBe("skills");
    expect(insertedRow.metadata.catalogPackageSourceUrl).toBe("https://github.com/anthropic/skills");
    expect(insertedRow.metadata.catalogProvider.name).toBe("Anthropic");
  });
});

describe("installSkill — idempotency", () => {
  it("returns alreadyInstalled: true when the same version is already installed", async () => {
    const idempotentDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            // Simulate existing row at same version
            limit: () => Promise.resolve([{ id: "existing-uuid", sourceRef: "1.0.0" }]),
          }),
        }),
      }),
    };

    const result = await installSkill({
      catalogItem: SKILL_INLINE, // version: "1.0.0"
      companyId: "c1",
      db: idempotentDb as any,
    });

    expect(result).toEqual({ skillId: "existing-uuid", alreadyInstalled: true });
  });

  it("throws a clean error when a different version is already installed", async () => {
    const conflictDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            // Simulate existing row at an older version
            limit: () => Promise.resolve([{ id: "existing-uuid", sourceRef: "0.9.0" }]),
          }),
        }),
      }),
    };

    await expect(
      installSkill({
        catalogItem: SKILL_INLINE, // version: "1.0.0" vs existing "0.9.0"
        companyId: "c1",
        db: conflictDb as any,
      }),
    ).rejects.toThrow(/already installed at version 0\.9\.0/);
  });
});
