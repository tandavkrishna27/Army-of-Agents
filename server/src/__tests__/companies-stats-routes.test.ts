import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";

type StatsEntry = {
  agentCount: number;
  issueCount: number;
  pendingApprovalCount: number;
  unreadNotificationCount: number;
};

const STATS_BY_COMPANY: Record<string, StatsEntry> = {
  "co-1": { agentCount: 7, issueCount: 24, pendingApprovalCount: 3, unreadNotificationCount: 12 },
  "co-2": { agentCount: 3, issueCount: 9, pendingApprovalCount: 0, unreadNotificationCount: 2 },
};

// Post-Fix-4 contract: GET /companies/stats delegates tenant scoping to the
// SERVICE — the route calls svc.stats(req.actor.companyIds ?? []) and the
// service filters in SQL; the route no longer JS-filters the result. This mock
// therefore HONORS its allow-set argument so the route→service contract is
// exercised faithfully: "unscoped" (operator view) → all companies, otherwise
// only the requested company ids. (Real SQL scoping is proven by
// companies-scope-pushdown.test.ts + the integration suite.)
const statsMock = vi.fn(async (allowed: string[] | "unscoped") => {
  if (allowed === "unscoped") return { ...STATS_BY_COMPANY };
  return Object.fromEntries(
    allowed
      .filter((id): id is keyof typeof STATS_BY_COMPANY => id in STATS_BY_COMPANY)
      .map((id) => [id, STATS_BY_COMPANY[id]]),
  );
});

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: statsMock,
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    ensureMembership: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

describe("GET /api/companies/stats", () => {
  beforeEach(() => {
    // Clear call history between tests (keeps the honoring implementation).
    vi.clearAllMocks();
  });

  function makeApp(actor: Record<string, unknown>) {
    const app = express();
    app.use((req, _res, next) => {
      (req as { actor: Record<string, unknown> }).actor = actor;
      next();
    });
    app.use("/api/companies", companyRoutes({} as never, { deploymentMode: "local_trusted" }));
    return app;
  }

  it("returns pendingApprovalCount and unreadNotificationCount per accessible company", async () => {
    const app = makeApp({
      type: "board",
      userId: "u1",
      companyIds: ["co-1", "co-2"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/companies/stats");

    expect(res.status).toBe(200);
    expect(res.body["co-1"]).toEqual({
      agentCount: 7,
      issueCount: 24,
      pendingApprovalCount: 3,
      unreadNotificationCount: 12,
    });
    expect(res.body["co-2"]).toEqual({
      agentCount: 3,
      issueCount: 9,
      pendingApprovalCount: 0,
      unreadNotificationCount: 2,
    });
  });

  it("scopes stats to the actor's companies via the service (multi-tenant isolation)", async () => {
    const app = makeApp({
      type: "board",
      userId: "u1",
      companyIds: ["co-1"], // only co-1
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/companies/stats");

    // Post-Fix-4: the route pushes the actor's scoped ids into the service
    // (SQL scoping) rather than JS-filtering the result. Assert the contract —
    // svc.stats(["co-1"]) — and that the service's scoped result is returned.
    expect(res.status).toBe(200);
    expect(statsMock).toHaveBeenCalledWith(["co-1"]);
    expect(res.body["co-1"]).toBeDefined();
    expect(res.body["co-1"].pendingApprovalCount).toBe(3);
  });
});
