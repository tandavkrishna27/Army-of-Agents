import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { HttpError } from "../errors.js";

const authzMocks = vi.hoisted(() => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  assertCanManageInstanceSettings: vi.fn(),
}));
const upstreamFetch = vi.hoisted(() => ({
  body: "# New upstream content",
  fetchCatalogResource: vi.fn(),
}));

vi.mock("../services/marketplace-install/fetch-resource.js", () => ({
  fetchCatalogResource: upstreamFetch.fetchCatalogResource,
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
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: {
    installRequested: vi.fn(),
  },
}));
vi.mock("../services/marketplace-settings.js", () => ({
  marketplaceSettingsService: vi.fn(() => ({ get: vi.fn(), patch: vi.fn() })),
}));
vi.mock("../services/marketplace-merge.js", () => ({
  computeSectionDiff: vi.fn(() => [{ heading: "## Overview", mine: "old", theirs: "new" }]),
  applyMergeDecisions: vi.fn(() => "# Merged Content"),
  mergeSkillDocument: vi.fn(() => ({
    content: "# New upstream content",
    pureUpstream: true,
  })),
}));
vi.mock("../routes/authz.js", () => ({
  assertBoard: authzMocks.assertBoard,
  assertCompanyAccess: authzMocks.assertCompanyAccess,
  assertCanManageInstanceSettings: authzMocks.assertCanManageInstanceSettings,
}));

import { createMarketplaceCompanyRouter } from "../routes/marketplace-company.js";
import { assertCanManageInstanceSettings } from "../routes/authz.js";
import { skillMergeSnapshotToken } from "../services/marketplace-install/skill-update-merge.js";
import {
  CLOUD_PLUGIN_BLOCK_MESSAGE,
  CLOUD_PLUGIN_EXECUTION_DOC_PATH,
  CloudPluginExecutionBlockedError,
  PLUGIN_WORKER_BLOCKED_IN_CLOUD,
} from "../services/cloud-plugin-execution.js";

beforeEach(() => {
  authzMocks.assertBoard.mockReset();
  authzMocks.assertCompanyAccess.mockReset();
  authzMocks.assertCanManageInstanceSettings.mockReset();
  upstreamFetch.body = "# New upstream content";
  upstreamFetch.fetchCatalogResource.mockReset().mockImplementation(async () => upstreamFetch.body);
});

function buildApp(dbOverrides: any = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.actor = { type: "board", source: "local_implicit", userId: "u1", companyId: "c1" };
    next();
  });

  const UPDATE_ROW = {
    id: "upd-1",
    companyId: "c1",
    catalogItemId: "skill:aoa-curated/code-review",
    catalogItemName: "Code Review",
    itemType: "skill",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    status: "pending",
  };
  const SKILL_ROW = {
    id: "skill-1",
    markdown: "# Old Content",
    metadata: {},
    customized: true,
  };

  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([UPDATE_ROW]),
        then: (r: any) => r([UPDATE_ROW]),
      }),
    }),
    update: () => ({
      set: (values: any) => ({
        where: () => {
          dbOverrides.capturedSets?.push(values);
          return Promise.resolve();
        },
      }),
    }),
    ...dbOverrides.db,
  };

  // Second select for skill row needs different data
  let selectCall = 0;
  const txSetsCapture: any[][] = [];

  const smartDb: any = {
    select: () => {
      selectCall++;
      const n = selectCall;
      return {
        from: () => ({
          where: () => Promise.resolve(n === 1 ? [UPDATE_ROW] : [SKILL_ROW]),
        }),
      };
    },
    update: db.update,
    transaction: async (cb: (tx: any) => Promise<any>) => {
      const txSets: any[] = [];
      const tx = {
        update: () => ({
          set: (values: any) => ({
            where: () => ({
              returning: async () => {
                txSets.push(values);
                dbOverrides.capturedSets?.push(values);
                return [{ id: "updated" }];
              },
            }),
          }),
        }),
      };
      const result = await cb(tx);
      txSetsCapture.push(txSets);
      return result;
    },
    _txSetsCapture: txSetsCapture,
  };

  const router = createMarketplaceCompanyRouter({
    db: smartDb as any,
    catalogService: {
      readCache: async () => ({
        schemaVersion: "1.0.0",
        generatedAt: "2026-04-30T00:00:00Z",
        itemCount: 1,
        items: [{
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
        }],
      }),
    },
  });

  app.use("/api/companies/:companyId/marketplace", router);
  return { app, smartDb };
}

describe("POST /updates/:id/merge — derives customized from result bytes", () => {
  it("sets customized: false for a pure-upstream merge", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => "# New upstream content",
    })) as any;

    const capturedSets: any[] = [];
    const { app } = buildApp({ capturedSets });

    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/merge")
      .send({
        decisions: { "## Overview": "theirs" },
        snapshotToken: skillMergeSnapshotToken(
          "# Old Content",
          "# New upstream content",
          "1.1.0",
        ),
      });

    expect(res.status).toBe(200);
    expect(capturedSets.some((s) => s.customized === false)).toBe(true);
  });

  it("executes both the skill update and the pending-update status change inside a single transaction", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => "# New upstream content",
    })) as any;

    const capturedSets: any[] = [];
    const { app, smartDb } = buildApp({ capturedSets });

    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/merge")
      .send({
        decisions: { "## Overview": "theirs" },
        snapshotToken: skillMergeSnapshotToken(
          "# Old Content",
          "# New upstream content",
          "1.1.0",
        ),
      });

    expect(res.status).toBe(200);

    // Exactly one transaction should have been opened
    expect(smartDb._txSetsCapture).toHaveLength(1);

    const txSets = smartDb._txSetsCapture[0];
    // Transaction must contain both writes: the skill update and the pending-update status
    expect(txSets.some((s: any) => "markdown" in s)).toBe(true);   // skill update
    expect(txSets.some((s: any) => s.status === "applied")).toBe(true); // pending update
  });
});

describe("GET /updates/:id/diff — binds the reviewed skill snapshot", () => {
  it("returns a token for the exact local, upstream, and catalog version bytes", async () => {
    const { app } = buildApp();
    const res = await request(app).get(
      "/api/companies/c1/marketplace/updates/upd-1/diff",
    );

    expect(res.status).toBe(200);
    expect(res.body.snapshotToken).toBe(
      skillMergeSnapshotToken("# Old Content", "# New upstream content", "1.1.0"),
    );
    expect(upstreamFetch.fetchCatalogResource).toHaveBeenCalledWith(
      expect.objectContaining({ id: "skill:aoa-curated/code-review" }),
      "skill update diff",
    );
  });
});

describe("POST /updates/:id/apply plugin updates", () => {
  function buildPluginApplyApp({
    updateRow,
    pluginRows,
    catalogItems = [],
    upgrade = vi.fn(async () => ({ version: "1.0.0", status: "ready" })),
    pluginLoader,
    pluginRollback,
    lifecycleLoad,
    blockActivationInCloud = vi.fn(async () => {}),
    capturedSets = [],
  }: {
    updateRow: any;
    pluginRows: any[][];
    catalogItems?: any[];
    upgrade?: any;
    pluginLoader?: any;
    pluginRollback?: any;
    lifecycleLoad?: any;
    blockActivationInCloud?: any;
    capturedSets?: any[];
  }) {
    let selectCall = 0;
    const db = {
      select: () => {
        selectCall += 1;
        const rows = selectCall === 1 ? [updateRow] : (pluginRows[selectCall - 2] ?? []);
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(rows),
              then: (resolve: any) => resolve(rows),
            }),
            limit: () => Promise.resolve(rows),
            then: (resolve: any) => resolve(rows),
          }),
        };
      },
      update: () => ({
        set: (values: any) => ({
          where: () => {
            capturedSets.push(values);
            return Promise.resolve();
          },
        }),
      }),
    };

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.actor = { type: "board", source: "local_implicit", userId: "u1", companyId: "c1" };
      next();
    });
    app.use(
      "/api/companies/:companyId/marketplace",
      createMarketplaceCompanyRouter({
        db: db as any,
        catalogService: {
          readCache: async () => ({
            schemaVersion: "1.0.0",
            generatedAt: "2026-05-15T00:00:00.000Z",
            itemCount: catalogItems.length,
            items: catalogItems,
          }),
        },
        pluginLifecycle: {
          upgrade,
          load: lifecycleLoad ?? vi.fn(),
          blockActivationInCloud,
        } as any,
        pluginLoader,
        pluginRollback,
      }),
    );
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });

    return { app, upgrade, capturedSets };
  }

  const baseUpdateRow = {
    id: "upd-plugin-1",
    companyId: "c1",
    catalogItemId: "plugin:aoa-curated/aoa-plugin-github-issues",
    catalogItemName: "GitHub Issues",
    itemType: "plugin",
    currentVersion: "0.1.1",
    latestVersion: "1.0.0",
    status: "pending",
  };

  const basePluginRow = {
    id: "plugin-1",
    companyId: "c1",
    catalogItemId: "plugin:aoa-curated/aoa-plugin-github-issues",
    version: "0.1.1",
  };

  it("upgrades the installed plugin and marks the pending update applied", async () => {
    const capturedSets: any[] = [];
    const upgrade = vi.fn(async () => ({ version: "1.0.0", status: "ready" }));
    const { app } = buildPluginApplyApp({
      updateRow: baseUpdateRow,
      pluginRows: [[basePluginRow]],
      upgrade,
      capturedSets,
    });

    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-plugin-1/apply")
      .send({});

    expect(res.status).toBe(200);
    expect(upgrade).toHaveBeenCalledWith("plugin-1", "1.0.0");
    expect(capturedSets.some((set) => set.status === "applied")).toBe(true);
  });

  it("requires instance settings permission before upgrading a marketplace plugin", async () => {
    const upgrade = vi.fn(async () => ({ version: "1.0.0", status: "ready" }));
    vi.mocked(assertCanManageInstanceSettings).mockImplementationOnce(() => {
      throw new HttpError(403, "Instance admin access required");
    });
    const { app } = buildPluginApplyApp({
      updateRow: baseUpdateRow,
      pluginRows: [[basePluginRow]],
      upgrade,
    });

    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-plugin-1/apply")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Instance admin access required" });
    expect(assertCanManageInstanceSettings).toHaveBeenCalled();
    expect(upgrade).not.toHaveBeenCalled();
  });

  it("rejects stale plugin update rows without upgrading", async () => {
    const upgrade = vi.fn(async () => ({ version: "1.0.0", status: "ready" }));
    const { app } = buildPluginApplyApp({
      updateRow: { ...baseUpdateRow, status: "applied" },
      pluginRows: [[basePluginRow]],
      upgrade,
    });

    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-plugin-1/apply")
      .send({});

    expect(res.status).toBe(409);
    expect(upgrade).not.toHaveBeenCalled();
  });

  it("returns capability delta and does not mark the update applied when approval is pending", async () => {
    const capturedSets: any[] = [];
    const upgrade = vi.fn(async () => ({
      version: "1.0.0",
      status: "upgrade_pending",
      delta: ["storage.write"],
    }));
    const { app } = buildPluginApplyApp({
      updateRow: baseUpdateRow,
      pluginRows: [[basePluginRow]],
      upgrade,
      capturedSets,
    });

    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-plugin-1/apply")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "upgrade_pending",
      delta: ["storage.write"],
      pluginId: "plugin-1",
    });
    expect(capturedSets.some((set) => set.status === "applied")).toBe(false);
  });

  it("rolls back the plugin package when lifecycle upgrade fails", async () => {
    const upgrade = vi.fn(async () => {
      throw new Error("upgrade failed");
    });
    const installPlugin = vi.fn(async () => ({}));
    const lifecycleLoad = vi.fn(async () => ({}));
    const getRollbackTarget = vi.fn(async () => ({
      packageName: "@aoa/github-issues",
      version: "0.1.1",
    }));
    const { app } = buildPluginApplyApp({
      updateRow: baseUpdateRow,
      pluginRows: [[{ ...basePluginRow, packageName: "@aoa/github-issues" }]],
      upgrade,
      lifecycleLoad,
      pluginLoader: { installPlugin },
      pluginRollback: { getRollbackTarget },
    });

    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-plugin-1/apply")
      .send({});

    expect(res.status).toBe(400);
    expect(installPlugin).toHaveBeenCalledWith({
      packageName: "@aoa/github-issues",
      version: "0.1.1",
      companyId: "c1",
    });
    expect(lifecycleLoad).toHaveBeenCalledWith("plugin-1");
  });

  it("returns the canonical cloud denial without rollback side effects", async () => {
    const upgrade = vi.fn();
    const blockActivationInCloud = vi.fn(async () => {
      throw new CloudPluginExecutionBlockedError();
    });
    const installPlugin = vi.fn(async () => ({}));
    const lifecycleLoad = vi.fn(async () => ({}));
    const getRollbackTarget = vi.fn(async () => ({
      packageName: "@aoa/github-issues",
      version: "0.1.1",
    }));
    const { app } = buildPluginApplyApp({
      updateRow: baseUpdateRow,
      pluginRows: [[{ ...basePluginRow, packageName: "@aoa/github-issues" }]],
      upgrade,
      lifecycleLoad,
      pluginLoader: { installPlugin },
      pluginRollback: { getRollbackTarget },
      blockActivationInCloud,
    });

    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-plugin-1/apply")
      .send({});

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: CLOUD_PLUGIN_BLOCK_MESSAGE,
      code: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
      docs: CLOUD_PLUGIN_EXECUTION_DOC_PATH,
    });
    expect(blockActivationInCloud).toHaveBeenCalledWith("plugin-1", "marketplace");
    expect(upgrade).not.toHaveBeenCalled();
    expect(getRollbackTarget).not.toHaveBeenCalled();
    expect(installPlugin).not.toHaveBeenCalled();
    expect(lifecycleLoad).not.toHaveBeenCalled();
  });

  it("falls back to catalog npm package name when installed plugin has no catalog item id", async () => {
    const upgrade = vi.fn(async () => ({ version: "1.0.0", status: "ready" }));
    const { app } = buildPluginApplyApp({
      updateRow: baseUpdateRow,
      pluginRows: [[], [{ ...basePluginRow, catalogItemId: null, packageName: "@aoa/github-issues" }]],
      upgrade,
      catalogItems: [
        {
          id: baseUpdateRow.catalogItemId,
          type: "plugin",
          name: "GitHub Issues",
          description: "Sync GitHub issues",
          version: "1.0.0",
          source: { adapter: "aoa-curated", url: "...", locator: "..." },
          npm: { packageName: "@aoa/github-issues", version: "1.0.0" },
          trust: { tier: "verified", source: "aoa-curated" },
          status: "active",
          addedAt: "2026-05-15T00:00:00.000Z",
          category: "integrations",
          tags: [],
        },
      ],
    });

    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-plugin-1/apply")
      .send({});

    expect(res.status).toBe(200);
    expect(upgrade).toHaveBeenCalledWith("plugin-1", "1.0.0");
  });
});
