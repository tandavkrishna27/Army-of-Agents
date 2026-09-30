/**
 * Tests for POST /updates/:id/apply — skill item branch (Sprint 2).
 *
 * Covers:
 *   1. Happy path: itemType === "skill", catalog found, applySkillUpdate succeeds → 200
 *   2. Catalog item not found → 422
 *   3. applySkillUpdate throws SkillCustomizedError → 409 with code SKILL_CUSTOMIZED
 *   4. applySkillUpdate throws generic error → 500
 *   5. PATCH /settings with skillUpdatePolicy: "auto" → 400 (literal "notify" required)
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const authzMocks = vi.hoisted(() => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  assertCanManageInstanceSettings: vi.fn(),
}));

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return {
    marketplacePendingUpdates: tableProxy,
    companySkills: tableProxy,
    plugins: tableProxy,
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  ne: () => Symbol("ne"),
  inArray: () => Symbol("inArray"),
}));
vi.mock("../routes/authz.js", () => ({
  assertBoard: authzMocks.assertBoard,
  assertCompanyAccess: authzMocks.assertCompanyAccess,
  assertCanManageInstanceSettings: authzMocks.assertCanManageInstanceSettings,
}));
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: {
    installRequested: vi.fn(),
    updateAvailable: vi.fn(),
  },
}));
vi.mock("../services/marketplace-settings.js", () => ({
  marketplaceSettingsService: vi.fn(() => ({ get: vi.fn(), patch: vi.fn() })),
}));
vi.mock("../services/marketplace-merge.js", () => ({
  computeSectionDiff: vi.fn(() => []),
  applyMergeDecisions: vi.fn(() => ""),
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

import { createMarketplaceCompanyRouter } from "../routes/marketplace-company.js";
import { applySkillUpdate, SkillCustomizedError } from "../services/marketplace-install/skill-auto-updater.js";

// ── helpers ────────────────────────────────────────────────────────────────────

const BASE_SKILL_UPDATE_ROW = {
  id: "upd-skill-1",
  companyId: "c1",
  catalogItemId: "skill:aoa-curated/code-review",
  catalogItemName: "Code Review",
  itemType: "skill",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  status: "pending",
};

const BASE_CATALOG_ITEMS = [
  {
    id: "skill:aoa-curated/code-review",
    type: "skill" as const,
    name: "Code Review",
    description: "...",
    version: "1.1.0",
    source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
    resourceUrl: "https://example.com/SKILL.md",
    trust: { tier: "verified" as const, source: "aoa-curated" },
    status: "active" as const,
    addedAt: "2026-04-30T00:00:00Z",
    category: "engineering" as const,
    tags: [],
  },
];

function buildSkillApplyApp({
  updateRow = BASE_SKILL_UPDATE_ROW as any,
  catalogItems = BASE_CATALOG_ITEMS as any[],
}: {
  updateRow?: any;
  catalogItems?: any[];
} = {}) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(updateRow ? [updateRow] : []),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  };

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "u1",
      companyId: "c1",
    };
    next();
  });

  app.use(
    "/api/companies/:companyId/marketplace",
    createMarketplaceCompanyRouter({
      db: db as any,
      catalogService: {
        readCache: async () => ({
          schemaVersion: "1.0.0",
          generatedAt: "2026-04-30T00:00:00Z",
          itemCount: catalogItems.length,
          items: catalogItems,
        }),
      },
    }),
  );

  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return { app };
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe("POST /updates/:id/apply — skill item", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authzMocks.assertBoard.mockReturnValue(undefined);
    authzMocks.assertCompanyAccess.mockReturnValue(undefined);
  });

  it("1. happy path: catalog found, applySkillUpdate succeeds → 200 { ok: true, applied: true }", async () => {
    vi.mocked(applySkillUpdate).mockResolvedValueOnce(undefined);

    const { app } = buildSkillApplyApp();
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-skill-1/apply")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, applied: true });
    expect(applySkillUpdate).toHaveBeenCalledOnce();
    expect(applySkillUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogItemId: BASE_SKILL_UPDATE_ROW.catalogItemId,
        companyId: "c1",
      }),
    );
  });

  it("2. catalog item not found → 422", async () => {
    const { app } = buildSkillApplyApp({ catalogItems: [] }); // empty catalog

    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-skill-1/apply")
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Catalog item not found") });
    expect(applySkillUpdate).not.toHaveBeenCalled();
  });

  it("3. applySkillUpdate throws SkillCustomizedError → 409 with code SKILL_CUSTOMIZED", async () => {
    vi.mocked(applySkillUpdate).mockRejectedValueOnce(
      new SkillCustomizedError("skill:aoa-curated/code-review"),
    );

    const { app } = buildSkillApplyApp();
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-skill-1/apply")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "SKILL_CUSTOMIZED" });
  });

  it("4. applySkillUpdate throws generic error → 500", async () => {
    vi.mocked(applySkillUpdate).mockRejectedValueOnce(new Error("DB write failed"));

    const { app } = buildSkillApplyApp();
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-skill-1/apply")
      .send({});

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "DB write failed" });
  });
});

// ── PATCH /settings validation ─────────────────────────────────────────────────

describe("PATCH /settings — skillUpdatePolicy validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authzMocks.assertBoard.mockReturnValue(undefined);
    authzMocks.assertCompanyAccess.mockReturnValue(undefined);
  });

  it('5. skillUpdatePolicy: "auto" → 400 (only "notify" is accepted)', async () => {
    const { app } = buildSkillApplyApp();

    const res = await request(app)
      .patch("/api/companies/c1/marketplace/settings")
      .send({ skillUpdatePolicy: "auto" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Invalid settings" });
  });

  it('skillUpdatePolicy: "notify" → passes validation (delegates to service)', async () => {
    // marketplaceSettingsService is mocked to return a mock service;
    // we just need the route to not 400.
    const { app } = buildSkillApplyApp();

    // The mock service's patch returns undefined by default.
    const res = await request(app)
      .patch("/api/companies/c1/marketplace/settings")
      .send({ skillUpdatePolicy: "notify" });

    // Any non-400 is acceptable here (service mock returns undefined → 200 with null body).
    expect(res.status).not.toBe(400);
  });
});
