import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return {
    marketplaceInstallOperations: tableProxy,
    plugins: tableProxy,
    agents: tableProxy,
    teams: tableProxy,
    companySkills: tableProxy,
    projects: tableProxy,
    // Required because dispatchInstall fires-and-forgets through
    // marketplace-notifications.notifyFounders, which queries userRoles.
    // Without this entry, vitest hoisted-mock resolution surfaces an error
    // on macOS even though the test itself swallows the failure. (Issue #112)
    userRoles: tableProxy,
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
  gt: () => Symbol("op:gt"),
  // Used by marketplace-notifications.notifyFounders' fire-and-forget query.
  // Same hoisted-mock-resolution pathway as userRoles. (Issue #112)
  isNull: () => Symbol("op:isNull"),
}));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));
vi.mock(
  "../services/outbound-url-guard.js",
  () => import("./helpers/outbound-url-guard.mock.js"),
);

import { createMarketplaceInstallRouter } from "../routes/marketplace-installs.js";

const PINNED_RESOURCE_BASE =
  `https://raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace/${"f".repeat(40)}`;
const SKILL = {
  id: "skill:aoa-curated/code-review", type: "skill", name: "Code Review", description: "...", version: "1.0.0",
  source: { adapter: "aoa-curated", url: "https://github.com/aoa-curated/package", locator: "...", commitSha: "abc" },
  resourceUrl: `${PINNED_RESOURCE_BASE}/content/skills/code-review/SKILL.md`,
  content: { inline: "# Code Review" },
  trust: { tier: "verified", source: "aoa-curated" }, status: "active",
  addedAt: "2026-04-30T00:00:00Z", category: "engineering", tags: [],
};

const SKILL_B = {
  ...SKILL,
  id: "skill:aoa-curated/code-review-b",
  name: "Code Review B",
};

// Agent items require a targetDepartmentId; skills do not.
const AGENT = {
  id: "agent:aoa-curated/engineer", type: "agent", name: "Engineer", description: "...", version: "1.0.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  resourceUrl: `${PINNED_RESOURCE_BASE}/content/agents/engineer/agent.json`,
  content: undefined,
  trust: { tier: "verified", source: "aoa-curated" }, status: "active",
  addedAt: "2026-04-30T00:00:00Z", category: "engineering", tags: [],
};

const MIXED_SKILL = {
  ...SKILL,
  id: "skill:aoa-curated/mixed-skill",
  packageId: "mixed/package",
};

const MIXED_TEAM = {
  ...SKILL,
  id: "team:aoa-curated/mixed-team",
  type: "team",
  name: "Mixed Team",
  packageId: "mixed/package",
};

const CATALOG = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-04-30T00:00:00Z",
  itemCount: 5,
  items: [SKILL, SKILL_B, AGENT, MIXED_SKILL, MIXED_TEAM],
};

function buildApp(catalog = CATALOG, operationRows: unknown[] = []) {
  const app = express();
  app.use(express.json());

  // Inject board actor on every request.
  // source: "local_implicit" bypasses the RBAC gate added in M.4.M so this
  // test suite can focus on install mechanics rather than permission logic
  // (RBAC is covered separately by marketplace-rbac.test.ts).
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", source: "local_implicit", userId: "u1", companyId: "c1" };
    next();
  });

  const router = createMarketplaceInstallRouter({
    db: {
      insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: "op-1", status: "pending", companyId: "c1", catalogItemId: SKILL.id, itemType: "skill" }]) }) }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(operationRows) }) }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      transaction: async (cb: any) => cb({ insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "skill-1" }]) }) }) }),
    } as any,
    catalogService: {
      readCache: async () => catalog,
      sync: async () => catalog,
      getStatus: async () => null,
      startSyncLoop: () => {}, stopSyncLoop: () => {},
    } as any,
    pluginLoader: {
      installPlugin: async () => ({
        packagePath: "/tmp/x", packageName: "aoa-plugin-slack", version: "1.0.0",
        source: "npm" as const,
        manifest: { id: "aoa.slack", displayName: "Slack" } as any,
      }),
      registry: { getByKey: async () => ({ id: "p1", pluginKey: "aoa.slack" }) },
      lifecycle: { load: async () => {} },
    } as any,
  });
  app.use("/api/companies/:companyId/marketplace", router);
  return app;
}

const C_ID = "c1";

describe("GET /api/companies/:companyId/marketplace/install/:operationId", () => {
  it("returns the canonical 503 envelope for a blocked cloud plugin install", async () => {
    const res = await request(
      buildApp(CATALOG, [
        {
          id: "op-blocked",
          companyId: C_ID,
          catalogItemId: "plugin:aoa/test",
          itemType: "plugin",
          status: "failure",
          errorMessage: "Localized or revised diagnostic text",
          errorCode: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
          errorDocs: "/some/older/docs/path",
        },
      ]),
    ).get(`/api/companies/${C_ID}/marketplace/install/op-blocked`);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error:
        "Plugin execution was blocked on AoA Cloud until a host-resident worker was available",
      code: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
      docs: "/docs/guides/cloud-plugin-execution",
    });
  });
});

describe("POST /api/companies/:companyId/marketplace/install", () => {
  it("returns 202 with operationId for valid skill install", async () => {
    const res = await request(buildApp())
      .post(`/api/companies/${C_ID}/marketplace/install`)
      .send({ catalogItemId: SKILL.id, targetDepartmentId: "00000000-0000-0000-0000-000000000001" });
    expect(res.status).toBe(202);
    expect(res.body.operationId).toBe("op-1");
  });

  it("returns 202 for skill install without targetDepartmentId (skills don't require a dept)", async () => {
    // Fix 5: skills should install successfully without a department.
    const res = await request(buildApp())
      .post(`/api/companies/${C_ID}/marketplace/install`)
      .send({ catalogItemId: SKILL.id });
    expect(res.status).toBe(202);
    expect(res.body.operationId).toBeDefined();
  });

  it("returns 400 when targetDepartmentId missing for agent installs", async () => {
    // Agents (and teams) require a targetDepartmentId.
    const res = await request(buildApp())
      .post(`/api/companies/${C_ID}/marketplace/install`)
      .send({ catalogItemId: AGENT.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/targetDepartmentId/);
  });

  it("returns 400 when targetDepartmentId missing for team installs", async () => {
    // D21 made `teams.parent_project_id` nullable so the internal bootstrap can
    // install a company-wide crew. The PUBLIC install API is unchanged: a
    // founder-initiated team install must still name a department.
    const res = await request(buildApp())
      .post(`/api/companies/${C_ID}/marketplace/install`)
      .send({ catalogItemId: MIXED_TEAM.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/targetDepartmentId/);
  });

  it("returns 404 for unknown catalogItemId", async () => {
    const res = await request(buildApp())
      .post(`/api/companies/${C_ID}/marketplace/install`)
      .send({ catalogItemId: "unknown:item" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for malformed body", async () => {
    const res = await request(buildApp())
      .post(`/api/companies/${C_ID}/marketplace/install`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.details).toBeDefined();
  });

  it("returns 202 for package install requests", async () => {
    const res = await request(buildApp())
      .post(`/api/companies/${C_ID}/marketplace/install`)
      .send({
        packageId: "aoa-curated/package",
        catalogItemIds: [SKILL.id, SKILL_B.id],
      });

    expect(res.status).toBe(202);
    expect(res.body.operationId).toBe("op-1");
  });

  it("returns 400 when requested package members do not match", async () => {
    const res = await request(buildApp())
      .post(`/api/companies/${C_ID}/marketplace/install`)
      .send({
        packageId: "aoa-curated/package",
        catalogItemIds: [SKILL.id],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/package member mismatch/i);
  });

  it("returns 400 for mixed packages in v1", async () => {
    const res = await request(buildApp())
      .post(`/api/companies/${C_ID}/marketplace/install`)
      .send({
        packageId: "mixed/package",
        catalogItemIds: [MIXED_SKILL.id, MIXED_TEAM.id],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/skill-only packages/i);
  });
});

describe("GET /api/companies/:companyId/marketplace/resolve/:catalogItemId", () => {
  it("returns InstallPlan for known item", async () => {
    const res = await request(buildApp())
      .get(`/api/companies/${C_ID}/marketplace/resolve/${encodeURIComponent(SKILL.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.rootItem.id).toBe(SKILL.id);
    expect(res.body.steps).toBeInstanceOf(Array);
  });

  it("returns 404 only when the requested catalog item is missing", async () => {
    const res = await request(buildApp())
      .get(`/api/companies/${C_ID}/marketplace/resolve/${encodeURIComponent("skill:missing")}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/catalog item not found/i);
  });

  it("returns non-404 when agent preview resolution fails after the item is found", async () => {
    const badAgent = {
      ...AGENT,
      resourceUrl: `${PINNED_RESOURCE_BASE}/content/agents/bad/agent.json`,
    };
    global.fetch = vi.fn(async () => ({
      status: 200,
      text: async () => "{not-json",
    })) as any;
    const res = await request(buildApp({ ...CATALOG, items: [badAgent] }))
      .get(`/api/companies/${C_ID}/marketplace/resolve/${encodeURIComponent(AGENT.id)}`);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/failed to parse agent template json/i);
  });

  it("returns 502 when agent template preview fetch rejects before an HTTP response", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as any;

    const res = await request(buildApp({ ...CATALOG, items: [AGENT] }))
      .get(`/api/companies/${C_ID}/marketplace/resolve/${encodeURIComponent(AGENT.id)}`);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/failed to fetch agent template/i);
    expect(res.body.error).not.toContain("fetch failed");
  });
});
