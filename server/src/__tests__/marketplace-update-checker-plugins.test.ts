import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks (required by checkPluginUpdates scoping tests) ─────────
vi.mock("@armyofagents/db", () => {
  const t = new Proxy({}, { get: () => Symbol("col") });
  return {
    plugins: t,
    marketplacePendingUpdates: t,
    companies: t,
    companySkills: t,
  };
});
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: {
    updateAvailable: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  asc: () => Symbol("asc"),
  or: () => Symbol("or"),
}));
vi.mock("../services/marketplace-settings.js", () => ({
  marketplaceSettingsService: { getSettings: vi.fn().mockResolvedValue({}) },
}));
vi.mock("../services/marketplace-install/skill-auto-updater.js", () => ({
  applySkillUpdate: vi.fn(),
  isWithinUpdateWindow: vi.fn().mockReturnValue(true),
  SkillCustomizedError: class SkillCustomizedError extends Error {},
  SkillDeletedError: class SkillDeletedError extends Error {},
}));

// Import the pure compareVersions helper (already exists in update-checker)
import {
  compareVersions,
  checkPluginUpdates,
} from "../services/marketplace-update-checker.js";
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
import type { CatalogItem } from "@armyofagents/shared";

describe("compareVersions", () => {
  it("returns 1 when latest is newer", () => {
    expect(compareVersions("1.0.0", "0.1.1")).toBe(1);
  });
  it("returns 0 when equal", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
  it("returns -1 when latest is older", () => {
    expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
  });
  it("returns 1 when latest is newer by minor version", () => {
    expect(compareVersions("1.1.0", "1.0.9")).toBe(1);
  });
  it("returns 1 when latest is newer by patch version", () => {
    expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
  });
});

// ── checkPluginUpdates company-scoping tests ─────────────────────────────────

const PLUGIN_CATALOG_ITEM: CatalogItem = {
  id: "plugin:test/discord",
  type: "plugin",
  name: "Discord",
  description: "Discord plugin",
  version: "2.0.0",
  npm: { packageName: "@test/discord", version: "2.0.0" },
  source: {
    adapter: "npm",
    url: "https://registry.npmjs.org",
    locator: "@test/discord",
    commitSha: "",
  },
  resourceUrl: "",
  content: { inline: "" },
  trust: { tier: "community", source: "npm" },
  status: "active",
  addedAt: "2026-01-01T00:00:00Z",
  category: "integrations",
  tags: [],
} as any;

function buildPluginDb(
  pluginRows: Array<{ packageName: string; version: string }>,
  {
    insertReturning = [{ id: "upd-1" }] as Array<{ id: string }>,
    existingPendingRow = null as {
      status: string;
      latestVersion: string;
    } | null,
  } = {}
) {
  const insertedValues: any[] = [];
  let selectCall = 0;
  return {
    db: {
      select: () => {
        selectCall += 1;
        return {
          from: () => ({
            where: () =>
              selectCall === 1
                ? Promise.resolve(pluginRows)
                : {
                    limit: () =>
                      Promise.resolve(
                        existingPendingRow ? [existingPendingRow] : []
                      ),
                  },
          }),
        };
      },
      insert: () => ({
        values: (vals: any) => {
          insertedValues.push(vals);
          return {
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve(insertReturning),
            }),
          };
        },
      }),
    } as any,
    insertedValues,
  };
}

describe("checkPluginUpdates — company scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts pending update with the provided companyId", async () => {
    const { db, insertedValues } = buildPluginDb([
      { packageName: "@test/discord", version: "1.0.0" },
    ]);

    await checkPluginUpdates(db, "co-a", [PLUGIN_CATALOG_ITEM]);

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0].companyId).toBe("co-a");
    expect(insertedValues[0].latestVersion).toBe("2.0.0");
    expect(insertedValues[0].currentVersion).toBe("1.0.0");
  });

  it("different companyIds produce independent upserts", async () => {
    const { db: dbA, insertedValues: insertedA } = buildPluginDb([
      { packageName: "@test/discord", version: "1.0.0" },
    ]);
    const { db: dbB, insertedValues: insertedB } = buildPluginDb([
      { packageName: "@test/discord", version: "1.0.0" },
    ]);

    await checkPluginUpdates(dbA, "co-a", [PLUGIN_CATALOG_ITEM]);
    await checkPluginUpdates(dbB, "co-b", [PLUGIN_CATALOG_ITEM]);

    expect(insertedA[0]?.companyId).toBe("co-a");
    expect(insertedB[0]?.companyId).toBe("co-b");
  });

  it("skips plugins that are already at the latest version", async () => {
    const { db, insertedValues } = buildPluginDb([
      { packageName: "@test/discord", version: "2.0.0" }, // already at latest
    ]);

    await checkPluginUpdates(db, "co-a", [PLUGIN_CATALOG_ITEM]);

    expect(insertedValues).toHaveLength(0);
  });

  it("retries updateAvailable for an existing same-version pending plugin row", async () => {
    const { db } = buildPluginDb(
      [{ packageName: "@test/discord", version: "1.0.0" }],
      {
        insertReturning: [],
        existingPendingRow: { status: "pending", latestVersion: "2.0.0" },
      }
    );

    const result = await checkPluginUpdates(db, "co-a", [PLUGIN_CATALOG_ITEM]);

    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledOnce();
    expect(result).toEqual([]);
  });

  it("returns a structured failure when a pending plugin notification fails", async () => {
    vi.mocked(marketplaceNotifications.updateAvailable).mockRejectedValueOnce(
      new Error("notification unavailable")
    );
    const { db } = buildPluginDb([
      { packageName: "@test/discord", version: "1.0.0" },
    ]);

    const result = await checkPluginUpdates(db, "co-a", [PLUGIN_CATALOG_ITEM]);

    expect(result).toEqual([
      {
        companyId: "co-a",
        itemType: "plugin",
        catalogItemId: PLUGIN_CATALOG_ITEM.id,
        message: "notification unavailable",
      },
    ]);
  });
});
