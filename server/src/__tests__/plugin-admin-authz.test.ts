import express from "express";
import supertest from "supertest";
import { describe, it, expect, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import { companyPluginRoutes } from "../routes/company-plugins.js";
import { createMarketplaceRouter } from "../routes/marketplace.js";

// ---------------------------------------------------------------------------
// Shared test actors
// ---------------------------------------------------------------------------

const NON_ADMIN = {
  type: "board",
  source: "session",
  isInstanceAdmin: false,
  userId: "user-test",
  companyIds: [],
};

const LOCAL_IMPLICIT = {
  type: "board",
  source: "local_implicit",
  isInstanceAdmin: false,
  userId: "user-local",
  companyIds: [],
};

// ---------------------------------------------------------------------------
// Unit tests: assertCanManageInstanceSettings
// ---------------------------------------------------------------------------

describe("assertCanManageInstanceSettings", () => {
  function makeReq(overrides: Record<string, unknown> = {}) {
    return {
      actor: {
        type: "board",
        source: "session",
        isInstanceAdmin: false,
        ...overrides,
      },
    };
  }

  it("allows local_implicit board regardless of isInstanceAdmin", async () => {
    const { assertCanManageInstanceSettings } = await import("../routes/authz.js");
    expect(() =>
      assertCanManageInstanceSettings(makeReq({ source: "local_implicit" }) as any)
    ).not.toThrow();
  });

  it("allows session board with operator=true (operator plane)", async () => {
    const { assertCanManageInstanceSettings } = await import("../routes/authz.js");
    expect(() =>
      assertCanManageInstanceSettings(makeReq({ operator: true }) as any)
    ).not.toThrow();
  });

  it("rejects session board with isInstanceAdmin=true but no operator (data plane does NOT grant operator plane)", async () => {
    const { assertCanManageInstanceSettings } = await import("../routes/authz.js");
    // Security-critical: the operator plane reads req.actor.operator, NOT the
    // data-plane isInstanceAdmin (clamped to false in cloud_auth). A stray
    // isInstanceAdmin=true must not unlock instance-settings management.
    expect(() =>
      assertCanManageInstanceSettings(makeReq({ isInstanceAdmin: true }) as any)
    ).toThrow(/Instance admin access required/);
  });

  it("throws 403 for session board with isInstanceAdmin=false", async () => {
    const { assertCanManageInstanceSettings } = await import("../routes/authz.js");
    expect(() =>
      assertCanManageInstanceSettings(makeReq() as any)
    ).toThrow(/Instance admin access required/);
  });

  it("throws 403 for non-board actor", async () => {
    const { assertCanManageInstanceSettings } = await import("../routes/authz.js");
    expect(() =>
      assertCanManageInstanceSettings({ actor: { type: "agent" } } as any)
    ).toThrow(/Board access required/);
  });
});

// ---------------------------------------------------------------------------
// HTTP-level tests: plugin admin routes
// ---------------------------------------------------------------------------

describe("plugin admin routes — non-admin board gets 403", () => {
  function makeApp(actor: object) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    // Mount with minimal stubs — authz fires before any db/loader access
    const db = {} as any;
    const loader = {} as any;
    const router = pluginRoutes(db, loader);
    app.use("/api", router);
    app.use(errorHandler);
    return supertest(app);
  }

  const cases = [
    { method: "get" as const, path: "/api/plugins/examples" },
    { method: "get" as const, path: "/api/plugins/tools" },
    { method: "get" as const, path: "/api/plugins/plugin-test-id" },
    { method: "get" as const, path: "/api/plugins/plugin-test-id/health" },
    { method: "get" as const, path: "/api/plugins/plugin-test-id/logs" },
    { method: "get" as const, path: "/api/plugins/plugin-test-id/config" },
    { method: "get" as const, path: "/api/plugins/plugin-test-id/jobs" },
    { method: "get" as const, path: "/api/plugins/plugin-test-id/jobs/job-test-id/runs" },
    { method: "get" as const, path: "/api/plugins/plugin-test-id/dashboard" },
    { method: "get" as const, path: "/api/plugins/plugin-test-id/version-history" },
    { method: "post" as const, path: "/api/plugins/install", body: {} },
    { method: "delete" as const, path: "/api/plugins/plugin-test-id" },
    { method: "post" as const, path: "/api/plugins/plugin-test-id/enable", body: {} },
    { method: "post" as const, path: "/api/plugins/plugin-test-id/disable", body: {} },
    { method: "post" as const, path: "/api/plugins/plugin-test-id/upgrade", body: {} },
    { method: "post" as const, path: "/api/plugins/plugin-test-id/config", body: {} },
    { method: "post" as const, path: "/api/plugins/plugin-test-id/config/test", body: {} },
    { method: "post" as const, path: "/api/plugins/plugin-test-id/jobs/job-test-id/trigger", body: {} },
    { method: "post" as const, path: "/api/plugins/plugin-test-id/rollback", body: {} },
  ];

  for (const { method, path, body } of cases) {
    it(`${method.toUpperCase()} ${path} → 403 for non-admin board`, async () => {
      const agent = makeApp(NON_ADMIN);
      const req = agent[method](path);
      if (body !== undefined) req.send(body);
      const res = await req;
      expect(res.status).toBe(403);
    });

    it(`${method.toUpperCase()} ${path} → NOT 403 for local_implicit`, async () => {
      const agent = makeApp(LOCAL_IMPLICIT);
      const req = agent[method](path);
      if (body !== undefined) req.send(body);
      const res = await req;
      expect(res.status).not.toBe(403);
    });
  }
});

// ---------------------------------------------------------------------------
// H9: company-scoped plugin MUTATIONS require instance admin (parity with the
// instance-scoped routes). Reads stay member-accessible. In authenticated mode
// any company member is a `board` actor and assertCompanyAccess passes for any
// member, so before the fix a plain team_member could approve plugin capability
// escalation, drive host-side npm install, and rewrite plugin config.
// ---------------------------------------------------------------------------
describe("company plugin routes — mutations require instance admin (H9)", () => {
  // A board member OF the company (passes assertCompanyAccess) who is NOT an
  // instance admin — the exact actor the escalation hole relied on.
  const NON_ADMIN_MEMBER = {
    type: "board",
    source: "session",
    isInstanceAdmin: false,
    userId: "user-test",
    companyIds: ["co-1"],
  };

  function makeApp(actor: object) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    // Empty stubs — the authz gate fires before any db/lifecycle/loader access.
    const router = companyPluginRoutes({} as any, {} as any, {} as any);
    app.use("/api/companies/:companyId/plugins", router);
    app.use(errorHandler);
    return supertest(app);
  }

  const mutating = [
    { method: "post" as const, path: "/api/companies/co-1/plugins/plugin-1/config", body: {} },
    { method: "post" as const, path: "/api/companies/co-1/plugins/plugin-1/upgrade", body: {} },
    { method: "post" as const, path: "/api/companies/co-1/plugins/plugin-1/upgrade/approve", body: {} },
    { method: "post" as const, path: "/api/companies/co-1/plugins/plugin-1/upgrade/rollback", body: {} },
    { method: "patch" as const, path: "/api/companies/co-1/plugins/plugin-1/settings", body: {} },
  ];

  for (const { method, path, body } of mutating) {
    it(`${method.toUpperCase()} ${path} → 403 for a non-admin company member`, async () => {
      const res = await makeApp(NON_ADMIN_MEMBER)[method](path).send(body);
      expect(res.status).toBe(403);
    });

    it(`${method.toUpperCase()} ${path} → NOT 403 for local_implicit`, async () => {
      const res = await makeApp(LOCAL_IMPLICIT)[method](path).send(body);
      expect(res.status).not.toBe(403);
    });
  }

  // Reads must stay member-accessible — the gate must NOT be on the GETs.
  for (const path of [
    "/api/companies/co-1/plugins",
  ]) {
    it(`GET ${path} → NOT 403 for a non-admin company member`, async () => {
      const res = await makeApp(NON_ADMIN_MEMBER).get(path);
      expect(res.status).not.toBe(403);
    });
  }

  it("protects operator-provided company plugin config from ordinary members", async () => {
    const res = await makeApp(NON_ADMIN_MEMBER)
      .get("/api/companies/co-1/plugins/plugin-1/config");
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// HTTP-level tests: marketplace catalog/sync
// ---------------------------------------------------------------------------

describe("marketplace catalog/sync — non-admin board gets 403", () => {
  function makeMarketplaceApp(actor: object) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    const mockService = {
      refresh: vi.fn().mockResolvedValue({
        catalog: { itemCount: 0 },
        status: { lastSyncStatus: "success" },
      }),
      refreshAndCheckForUpdates: vi.fn().mockResolvedValue({
        catalog: { itemCount: 0 },
        status: { lastSyncStatus: "success" },
      }),
      readCache: vi.fn().mockResolvedValue(null),
      getStatus: vi.fn().mockResolvedValue(null),
    };
    const router = createMarketplaceRouter({ service: mockService as any });
    app.use("/api/marketplace", router);
    app.use(errorHandler);
    return supertest(app);
  }

  it("POST /api/marketplace/catalog/sync → 403 for non-admin", async () => {
    const res = await makeMarketplaceApp(NON_ADMIN).post("/api/marketplace/catalog/sync");
    expect(res.status).toBe(403);
  });

  it("POST /api/marketplace/catalog/sync → NOT 403 for local_implicit", async () => {
    const res = await makeMarketplaceApp(LOCAL_IMPLICIT).post("/api/marketplace/catalog/sync");
    expect(res.status).not.toBe(403);
  });
});
