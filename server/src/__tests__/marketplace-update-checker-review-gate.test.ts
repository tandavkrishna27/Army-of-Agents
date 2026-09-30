/**
 * Regression tests locking the "always notify, never auto-apply" behavior
 * introduced in Sprint 2. These tests prevent regression of the removed
 * auto-apply code path.
 *
 * Covers:
 *   1. Skill update detected → updateAvailable ALWAYS fired
 *   2. Skill update detected → applySkillUpdate NEVER called from the checker
 *   3. skillUpdatePolicy absent (undefined) → notification still fires
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return {
    marketplacePendingUpdates: tableProxy,
    companies: tableProxy,
    companySkills: tableProxy,
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
  logger: { error: vi.fn(), warn: vi.fn() },
}));

import { runUpdateCheck } from "../services/marketplace-update-checker.js";
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
import { applySkillUpdate } from "../services/marketplace-install/skill-auto-updater.js";
import type { CatalogItem } from "@armyofagents/shared";

// ── helpers ────────────────────────────────────────────────────────────────────

const SKILL_CATALOG_ITEM: CatalogItem = {
  id: "skill:aoa-curated/code-review",
  type: "skill",
  name: "Code Review",
  description: "...",
  version: "1.1.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  resourceUrl: "https://example.com/SKILL.md",
  content: { inline: "# Code Review v1.1.0" },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

function buildMockDb() {
  let selectCall = 0;
  return {
    select: () => {
      selectCall++;
      const n = selectCall;
      return {
        from: () => {
          if (n === 1) return Promise.resolve([{ id: "c1" }]); // companies
          return {
            where: () =>
              Promise.resolve([
                { sourceLocator: SKILL_CATALOG_ITEM.id, sourceRef: "1.0.0" },
              ]),
          }; // companySkills
        },
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
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe("marketplace-update-checker — review-gate regression tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. when a skill update is detected, updateAvailable notification is ALWAYS fired", async () => {
    const db = buildMockDb();
    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledOnce();
  });

  it("2. when a skill update is detected, applySkillUpdate is NEVER called from the checker", async () => {
    const db = buildMockDb();
    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    expect(applySkillUpdate).not.toHaveBeenCalled();
  });

  it("3. when skillUpdatePolicy is absent (no company settings), update checker still fires notification", async () => {
    // The checker does not read marketplace settings — it always fires updateAvailable.
    // This test ensures no hidden policy check sneaks back in.
    const db = buildMockDb();
    await runUpdateCheck(db as any, [SKILL_CATALOG_ITEM]);

    // updateAvailable must be called regardless of any policy value
    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledOnce();
    // applySkillUpdate must never be called by the checker
    expect(applySkillUpdate).not.toHaveBeenCalled();
  });
});
