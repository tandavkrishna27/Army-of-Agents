import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return {
    marketplacePendingUpdates: tableProxy,
    companies: tableProxy,
    companySkills: tableProxy,
    plugins: tableProxy,
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  or: () => Symbol("or"),
}));
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: {
    updateAvailable: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../services/marketplace-install/skill-auto-updater.js", () => ({
  applySkillUpdate: vi.fn().mockResolvedValue(undefined),
  isWithinUpdateWindow: vi.fn().mockReturnValue(true),
  SkillCustomizedError: class SkillCustomizedError extends Error {
    constructor(id: string) {
      super(id);
      this.name = "SkillCustomizedError";
    }
  },
  SkillDeletedError: class SkillDeletedError extends Error {
    constructor(id: string) {
      super(id);
      this.name = "SkillDeletedError";
    }
  },
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn() },
}));

import {
  runUpdateCheck,
  upsertPendingUpdate,
  compareVersions,
} from "../services/marketplace-update-checker.js";
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
import { applySkillUpdate } from "../services/marketplace-install/skill-auto-updater.js";
import type { CatalogItem } from "@armyofagents/shared";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SKILL_CATALOG_ITEM: CatalogItem = {
  id: "skill:aoa-curated/code-review",
  type: "skill",
  name: "Code Review",
  description: "...",
  version: "1.1.0",
  source: {
    adapter: "aoa-curated",
    url: "...",
    locator: "...",
    commitSha: "abc",
  },
  resourceUrl: "https://example.com/SKILL.md",
  content: { inline: "# Code Review v1.1.0" },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

function buildMockDb({
  skillRows = [{ sourceLocator: SKILL_CATALOG_ITEM.id, sourceRef: "1.0.0" }],
  insertReturning = [{ id: "upd-1" }],
  existingPendingRow = null as { status: string; latestVersion: string } | null,
}: {
  skillRows?: Array<{ sourceLocator: string; sourceRef: string }>;
  insertReturning?: Array<{ id: string }>;
  existingPendingRow?: { status: string; latestVersion: string } | null;
} = {}) {
  let selectCall = 0;
  return {
    select: () => {
      selectCall++;
      const n = selectCall;
      return {
        from: () => {
          if (n === 1) return Promise.resolve([{ id: "c1" }]); // companies
          if (n === 2) return { where: () => Promise.resolve(skillRows) }; // companySkills
          if (n === 3 && insertReturning.length === 0) {
            return {
              where: () => ({
                limit: () =>
                  Promise.resolve(
                    existingPendingRow ? [existingPendingRow] : []
                  ),
              }),
            };
          }
          return { where: () => Promise.resolve([]) }; // plugins
        },
      };
    },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(insertReturning),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
}

/** Minimal mock DB for testing upsertPendingUpdate directly. */
function buildUpsertDb({
  insertReturning = [] as Array<{ id: string }>,
  existingRow = null as { status: string; latestVersion: string } | null,
} = {}) {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(insertReturning),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(existingRow ? [existingRow] : []),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
}

// ─── compareVersions ──────────────────────────────────────────────────────────

describe("compareVersions", () => {
  it("returns positive when latest > current", () => {
    expect(compareVersions("1.1.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });
  it("returns 0 when versions are equal", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
  it("returns negative when latest < current", () => {
    expect(compareVersions("0.9.0", "1.0.0")).toBeLessThan(0);
  });
});

// ─── upsertPendingUpdate ──────────────────────────────────────────────────────

describe("upsertPendingUpdate", () => {
  it("does not notify when latest version is not newer than current", async () => {
    const db = buildUpsertDb();
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.0.0",
      latestVersion: "1.0.0", // same version
    });
    expect(result).toEqual({
      inserted: false,
      shouldNotify: false,
      shouldReopenNotification: false,
    });
  });

  it("returns { inserted: true } when a new row is inserted", async () => {
    const db = buildUpsertDb({ insertReturning: [{ id: "upd-1" }] });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
    });
    expect(result).toEqual({
      inserted: true,
      shouldNotify: true,
      shouldReopenNotification: true,
    });
  });

  it("retries the idempotent notification when an existing row is still pending", async () => {
    const db = buildUpsertDb({
      existingRow: { status: "pending", latestVersion: "1.1.0" },
    });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
    });
    expect(result).toEqual({
      inserted: false,
      shouldNotify: true,
      shouldReopenNotification: false,
    });
  });

  it("reopens the stable hub item when a live pending row advances", async () => {
    const db = buildUpsertDb({
      existingRow: { status: "pending", latestVersion: "1.1.0" },
    });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
    });

    expect(result).toEqual({
      inserted: false,
      shouldNotify: true,
      shouldReopenNotification: true,
    });
  });

  it("returns { inserted: true } when existing row is applied — re-opens for new catalog version", async () => {
    // Bug scenario: v1.1 was auto-applied. v1.2 arrives. Must re-open.
    const db = buildUpsertDb({
      existingRow: { status: "applied", latestVersion: "1.1.0" },
    });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
    });
    expect(result).toEqual({
      inserted: true,
      shouldNotify: true,
      shouldReopenNotification: true,
    });
  });

  it("returns { inserted: true } when existing row is dismissed — re-opens for new catalog version", async () => {
    // Dismiss was for v1.1; v1.2 is a different release and should re-notify.
    const db = buildUpsertDb({
      existingRow: { status: "dismissed", latestVersion: "1.1.0" },
    });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
    });
    expect(result).toEqual({
      inserted: true,
      shouldNotify: true,
      shouldReopenNotification: true,
    });
  });

  it("keeps a dismissal closed for the same catalog version", async () => {
    const db = buildUpsertDb({
      existingRow: { status: "dismissed", latestVersion: "1.2.0" },
    });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
    });

    expect(result).toEqual({
      inserted: false,
      shouldNotify: false,
      shouldReopenNotification: false,
    });
  });

  it("returns { inserted: false } when row disappears after conflict (race condition)", async () => {
    // existingRow: null means the SELECT returns [] — very rare race.
    const db = buildUpsertDb({ existingRow: null });
    const result = await upsertPendingUpdate(db as any, "c1", {
      catalogItemId: "skill:x",
      catalogItemName: "X",
      itemType: "skill",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
    });
    expect(result).toEqual({
      inserted: false,
      shouldNotify: false,
      shouldReopenNotification: false,
    });
  });
});

// ─── runUpdateCheck always-notify behavior ────────────────────────────────────

describe("runUpdateCheck — always-notify behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires updateAvailable for every detected skill update regardless of any policy", async () => {
    const db = buildMockDb();
    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledOnce();
    expect(applySkillUpdate).not.toHaveBeenCalled();
  });

  it("retries updateAvailable for an existing same-version pending skill row", async () => {
    const db = buildMockDb({
      insertReturning: [],
      existingPendingRow: { status: "pending", latestVersion: "1.1.0" },
    });

    const result = await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledOnce();
    expect(result.failures).toEqual([]);
  });

  it("does NOT call applySkillUpdate — auto-apply is removed", async () => {
    const db = buildMockDb();
    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(applySkillUpdate).not.toHaveBeenCalled();
  });

  it("fires updateAvailable for each skill that has a newer catalog version", async () => {
    const SKILL_2: CatalogItem = {
      ...SKILL_CATALOG_ITEM,
      id: "skill:aoa-curated/web-search",
      name: "Web Search",
    };
    const db = buildMockDb({
      skillRows: [
        { sourceLocator: SKILL_CATALOG_ITEM.id, sourceRef: "1.0.0" },
        { sourceLocator: SKILL_2.id, sourceRef: "1.0.0" },
      ],
      insertReturning: [{ id: "upd-1" }],
    });

    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM, SKILL_2]);

    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledTimes(2);
    expect(applySkillUpdate).not.toHaveBeenCalled();
  });

  it("processes remaining companies even when one company's checkCompany throws", async () => {
    // Two companies — first one throws during skill rows query, second should still be processed
    let companySelectCall = 0;
    const twoCompanyDb = {
      select: () => {
        companySelectCall++;
        if (companySelectCall === 1) {
          // companies list
          return { from: () => Promise.resolve([{ id: "c1" }, { id: "c2" }]) };
        }
        if (companySelectCall === 2) {
          // First company skill rows — throw
          return {
            from: () => ({
              where: () => Promise.reject(new Error("DB error for c1")),
            }),
          };
        }
        // Second company skill rows — return one skill
        return {
          from: () => ({
            where: () =>
              Promise.resolve([
                { sourceLocator: SKILL_CATALOG_ITEM.id, sourceRef: "1.0.0" },
              ]),
          }),
        };
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ id: "upd-1" }]),
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    };

    const result = await runUpdateCheck(twoCompanyDb as any, [
      SKILL_CATALOG_ITEM,
    ]);

    // updateAvailable should have been called for company c2 (despite c1 failing)
    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledOnce();
    expect(result).toEqual({
      companiesExamined: 2,
      failures: [
        {
          companyId: "c1",
          itemType: "company",
          message: "DB error for c1",
        },
      ],
    });
  });

  it("returns a structured failure when a pending skill notification fails", async () => {
    vi.mocked(marketplaceNotifications.updateAvailable).mockRejectedValueOnce(
      new Error("notification unavailable")
    );
    const db = buildMockDb();

    const result = await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(result).toEqual({
      companiesExamined: 1,
      failures: [
        {
          companyId: "c1",
          itemType: "skill",
          catalogItemId: SKILL_CATALOG_ITEM.id,
          message: "notification unavailable",
        },
      ],
    });
  });

  it("redacts secrets, URLs, and absolute paths from returned failures", async () => {
    const secret = `sk-ant-${"a".repeat(24)}`;
    vi.mocked(marketplaceNotifications.updateAvailable).mockRejectedValueOnce(
      new Error(
        `Bearer ${secret} failed at C:\\Users\\operator\\secrets.json via https://user:pass@example.com/resource?token=hidden`,
      ),
    );
    const db = buildMockDb();

    const result = await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);
    const serialized = JSON.stringify(result.failures);

    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("[redacted-path]");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("operator");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("token=hidden");
  });

  it("uses an audited company snapshot without rediscovering the fleet", async () => {
    const where = vi.fn().mockResolvedValue([]);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { select };

    await runUpdateCheck(db as any, [], {
      companyIds: ["company-b", "company-a", "company-b"],
    });

    // One skill query + one plugin query for each unique supplied company.
    // A fleet-discovery query would add a fifth select (and is forbidden here).
    expect(select).toHaveBeenCalledTimes(4);
    expect(where).toHaveBeenCalledTimes(4);
  });

  it("does no database work for an explicitly empty company snapshot", async () => {
    const select = vi.fn();

    await runUpdateCheck({ select } as any, [], { companyIds: [] });

    expect(select).not.toHaveBeenCalled();
  });
});
