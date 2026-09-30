import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { companySkills: tableProxy, marketplacePendingUpdates: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
}));
vi.mock("../services/marketplace-install/fetch-resource.js", () => ({
  loadSkillContent: vi.fn(),
}));
const materializerMock = vi.hoisted(() => vi.fn());
vi.mock("../services/marketplace-install/skill-bundle-materializer.js", async () => {
  const actual = await vi.importActual<typeof import("../services/marketplace-install/skill-bundle-materializer.js")>(
    "../services/marketplace-install/skill-bundle-materializer.js",
  );
  return { ...actual, materializeSkillBundle: materializerMock };
});
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: { updateCompleted: vi.fn() },
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn() },
}));

import {
  isWithinUpdateWindow,
  applySkillUpdate,
  SkillCustomizedError,
  SkillDeletedError,
} from "../services/marketplace-install/skill-auto-updater.js";
import { loadSkillContent } from "../services/marketplace-install/fetch-resource.js";
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
import type { CatalogItem } from "@armyofagents/shared";

const SKILL_ITEM: CatalogItem = {
  id: "skill:aoa-curated/code-review",
  type: "skill",
  name: "Code Review",
  description: "...",
  version: "1.1.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  resourceUrl: "https://raw.githubusercontent.com/.../SKILL.md",
  content: { inline: "# Code Review v1.1.0" },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

// ── isWithinUpdateWindow ──────────────────────────────────────────────────────

describe("isWithinUpdateWindow", () => {
  it("anytime — always returns true regardless of time", () => {
    expect(isWithinUpdateWindow("anytime", new Date("2026-05-04T10:00:00Z"))).toBe(true);
    expect(isWithinUpdateWindow("anytime", new Date("2026-05-04T03:00:00Z"))).toBe(true);
  });

  it("off_hours — returns true before 08:00 UTC", () => {
    expect(isWithinUpdateWindow("off_hours", new Date("2026-05-04T07:59:00Z"))).toBe(true);
  });

  it("off_hours — returns true at or after 20:00 UTC", () => {
    expect(isWithinUpdateWindow("off_hours", new Date("2026-05-04T20:00:00Z"))).toBe(true);
    expect(isWithinUpdateWindow("off_hours", new Date("2026-05-04T21:30:00Z"))).toBe(true);
  });

  it("off_hours — returns false during business hours (08:00–19:59 UTC)", () => {
    expect(isWithinUpdateWindow("off_hours", new Date("2026-05-04T10:00:00Z"))).toBe(false);
    expect(isWithinUpdateWindow("off_hours", new Date("2026-05-04T08:00:00Z"))).toBe(false);
  });

  it("weekends — returns true on Saturday (day=6)", () => {
    // 2026-05-02 is a Saturday
    expect(isWithinUpdateWindow("weekends", new Date("2026-05-02T12:00:00Z"))).toBe(true);
  });

  it("weekends — returns true on Sunday (day=0)", () => {
    // 2026-05-03 is a Sunday
    expect(isWithinUpdateWindow("weekends", new Date("2026-05-03T12:00:00Z"))).toBe(true);
  });

  it("weekends — returns false on a weekday", () => {
    // 2026-05-04 is a Monday
    expect(isWithinUpdateWindow("weekends", new Date("2026-05-04T12:00:00Z"))).toBe(false);
  });
});

// ── applySkillUpdate ──────────────────────────────────────────────────────────

function buildTx({
  skillRow = { id: "skill-1", customized: false },
  skillRows = skillRow ? [skillRow] : [],
  skillUpdateReturnRows = [{ id: "skill-1" }],
}: {
  skillRow?: { id: string; customized: boolean } | null;
  skillRows?: any[];
  skillUpdateReturnRows?: { id: string }[];
} = {}) {
  const updatedSkillValues: any[] = [];
  const updatedPendingValues: any[] = [];

  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(skillRows),
        }),
      }),
    }),
    update: (_table: any) => ({
      set: (values: any) => ({
        where: () => {
          if ("markdown" in values) {
            // Skill UPDATE: thenable AND chainable with .returning()
            updatedSkillValues.push(values);
            const rows = skillUpdateReturnRows;
            return {
              then: (resolve: any, reject: any) =>
                Promise.resolve(rows).then(resolve, reject),
              returning: () => Promise.resolve(rows),
            };
          }
          // Pending UPDATE: plain promise (no .returning() needed)
          updatedPendingValues.push(values);
          return Promise.resolve(undefined);
        },
      }),
    }),
    _updatedSkillValues: updatedSkillValues,
    _updatedPendingValues: updatedPendingValues,
  };
  return tx;
}

function buildDb(tx: any) {
  return {
    transaction: async (cb: (tx: any) => Promise<void>) => cb(tx),
  };
}

describe("applySkillUpdate", () => {
  const APPLY_ARGS = {
    catalogItemId: SKILL_ITEM.id,
    catalogItemName: SKILL_ITEM.name,
    companyId: "c1",
    catalogItem: SKILL_ITEM,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    materializerMock.mockReset();
    vi.mocked(loadSkillContent).mockResolvedValue("# Code Review v1.1.0");
    vi.mocked(marketplaceNotifications.updateCompleted).mockResolvedValue(undefined as any);
  });

  it("updates skill markdown, bumps sourceRef, marks pending applied, fires notification", async () => {
    const tx = buildTx();
    const db = buildDb(tx);

    await applySkillUpdate({ db: db as any, ...APPLY_ARGS });

    expect(tx._updatedSkillValues[0]).toMatchObject({
      markdown: "# Code Review v1.1.0",
      sourceRef: "1.1.0",
    });
    expect(tx._updatedPendingValues[0]).toMatchObject({ status: "applied" });
    expect(marketplaceNotifications.updateCompleted).toHaveBeenCalledWith(db, "c1", "Code Review");
  });

  it("materializes bundle updates and refreshes inventory metadata", async () => {
    const bundleItem: CatalogItem = {
      ...SKILL_ITEM,
      version: "1.2.0",
      provider: { id: "example", name: "Example", logoUrl: "https://example.com/logo.png", fallbackInitials: "EX" },
      skill: {
        bundle: {
          type: "github-directory",
          repo: "example/repo",
          commitSha: "newsha123",
          path: "skills/code-review",
          treeUrl: "https://github.com/example/repo/tree/newsha123/skills/code-review",
        },
        frontmatter: { name: "code-review", raw: {} },
      },
    };
    materializerMock.mockResolvedValue({
      destination: "C:\\repo\\.aoa\\marketplace-skills\\c1\\skill_aoa-curated_code-review\\1.2.0",
      markdown: "# New Bundle Skill",
      fileInventory: [
        { path: "SKILL.md", kind: "skill" },
        { path: "assets/logo.png", kind: "asset" },
      ],
      fileCount: 2,
      byteCount: 32,
    });
    const tx = buildTx();
    const db = buildDb(tx);

    await applySkillUpdate({ db: db as any, ...APPLY_ARGS, catalogItem: bundleItem });

    expect(loadSkillContent).not.toHaveBeenCalled();
    expect(tx._updatedSkillValues[0]).toMatchObject({
      markdown: "# New Bundle Skill",
      sourceRef: "1.2.0",
      trustLevel: "assets",
      fileInventory: [
        { path: "SKILL.md", kind: "skill" },
        { path: "assets/logo.png", kind: "asset" },
      ],
    });
    expect(tx._updatedSkillValues[0].metadata).toMatchObject({
      catalogProvider: bundleItem.provider,
      catalogSkillBundle: expect.objectContaining({ commitSha: "newsha123" }),
      catalogBundleInstallPath: expect.stringContaining(".aoa"),
    });
  });

  it("clears stale bundle columns when the upstream item stops carrying a bundle (T2.8c(a))", async () => {
    // Row was previously a bundled skill; the new catalog item (SKILL_ITEM) has
    // no `skill.bundle`. The pointer, inventory and trust level must not keep
    // naming the old version's tree.
    const tx = buildTx({
      skillRows: [
        {
          id: "skill-1",
          customized: false,
          metadata: {
            catalogBundleInstallPath:
              "C:\\repo\\.aoa\\marketplace-skills\\c1\\skill_aoa-curated_code-review\\1.0.0",
            catalogSkillBundle: {
              type: "github-directory",
              repo: "example/repo",
              commitSha: "oldsha",
              path: "skills/code-review",
            },
            catalogTrustTier: "verified",
          },
        },
      ],
    });
    const db = buildDb(tx);
    vi.mocked(loadSkillContent).mockResolvedValue("# Code Review v1.1.0 (markdown-only)");

    await applySkillUpdate({ db: db as any, ...APPLY_ARGS });

    const set = tx._updatedSkillValues[0];
    expect(set).toMatchObject({
      markdown: "# Code Review v1.1.0 (markdown-only)",
      sourceRef: "1.1.0",
      trustLevel: "markdown_only",
      fileInventory: [],
    });
    // Bundle pointers stripped, unrelated metadata preserved (this is a patch).
    expect(set.metadata).not.toHaveProperty("catalogBundleInstallPath");
    expect(set.metadata).not.toHaveProperty("catalogSkillBundle");
    expect(set.metadata.catalogTrustTier).toBe("verified");
    // No bundle was materialized, so no git checkout was attempted.
    expect(materializerMock).not.toHaveBeenCalled();
  });

  it("leaves bundle columns untouched for a markdown-only row that never had a bundle", async () => {
    const tx = buildTx({
      skillRows: [{ id: "skill-1", customized: false, metadata: { catalogTrustTier: "verified" } }],
    });
    const db = buildDb(tx);
    vi.mocked(loadSkillContent).mockResolvedValue("# Still markdown-only");

    await applySkillUpdate({ db: db as any, ...APPLY_ARGS });

    const set = tx._updatedSkillValues[0];
    expect(set).toMatchObject({ markdown: "# Still markdown-only", sourceRef: "1.1.0" });
    // A row that never carried a bundle must not be stamped with an empty
    // inventory / markdown_only trust / rewritten metadata it never had.
    expect(set).not.toHaveProperty("trustLevel");
    expect(set).not.toHaveProperty("fileInventory");
    expect(set).not.toHaveProperty("metadata");
  });

  it("throws SkillCustomizedError and makes no DB writes when customized=true inside tx", async () => {
    const tx = buildTx({ skillRow: { id: "skill-1", customized: true } });
    const db = buildDb(tx);

    await expect(applySkillUpdate({ db: db as any, ...APPLY_ARGS }))
      .rejects.toThrow(SkillCustomizedError);

    expect(tx._updatedSkillValues).toHaveLength(0);
    expect(tx._updatedPendingValues).toHaveLength(0);
    expect(marketplaceNotifications.updateCompleted).not.toHaveBeenCalled();
  });

  it("throws SkillDeletedError when skill row not found in DB", async () => {
    const tx = buildTx({ skillRow: null });
    const db = buildDb(tx);

    await expect(applySkillUpdate({ db: db as any, ...APPLY_ARGS }))
      .rejects.toThrow(SkillDeletedError);

    expect(tx._updatedSkillValues).toHaveLength(0);
  });

  it("does not rethrow when updateCompleted notification fails — DB is already committed", async () => {
    const tx = buildTx();
    const db = buildDb(tx);
    vi.mocked(marketplaceNotifications.updateCompleted).mockRejectedValue(new Error("Network error"));

    // Should resolve, not reject
    await expect(applySkillUpdate({ db: db as any, ...APPLY_ARGS })).resolves.toBeUndefined();

    // DB was still written
    expect(tx._updatedSkillValues[0]).toMatchObject({ markdown: "# Code Review v1.1.0" });
  });

  it("throws SkillCustomizedError when UPDATE affects 0 rows — concurrent edit set customized=true between SELECT and this UPDATE", async () => {
    // SELECT sees customized=false, but UPDATE WHERE customized=false matches 0 rows
    // (another request committed customized=true in the window between SELECT and UPDATE)
    const tx = buildTx({ skillUpdateReturnRows: [] });
    const db = buildDb(tx);

    await expect(applySkillUpdate({ db: db as any, ...APPLY_ARGS }))
      .rejects.toThrow(SkillCustomizedError);

    // Neither the pending-update write nor the notification should fire
    expect(tx._updatedPendingValues).toHaveLength(0);
    expect(marketplaceNotifications.updateCompleted).not.toHaveBeenCalled();
  });
});
