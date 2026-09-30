import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { forbidden } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";

const routeSpies = vi.hoisted(() => ({
  assertCompanyAccess: vi.fn(),
  assertRole: vi.fn(),
  verify: vi.fn(),
  revoke: vi.fn(),
  eq: vi.fn((_column: unknown, value: unknown) => ({ value })),
}));

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: routeSpies.assertCompanyAccess,
}));
vi.mock("../middleware/rbac.js", () => ({
  assertRole: routeSpies.assertRole,
}));
vi.mock("../services/provider-connections.js", () => ({
  providerConnectionService: () => ({
    verify: routeSpies.verify,
    revoke: routeSpies.revoke,
  }),
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, eq: routeSpies.eq };
});

import { providerConnectionRoutes } from "../routes/provider-connections.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const MISSING_CONNECTION_ID = "44444444-4444-4444-8444-444444444444";

const boardActor = {
  type: "board",
  source: "session",
  userId: "u1",
  companyIds: [COMPANY_ID],
};

function fakeDb(rows: unknown[] = []) {
  const where = vi.fn(async () => rows);
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where })),
    })),
  };
  return { db, where };
}

function appWith(db: unknown, actor: unknown = boardActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", providerConnectionRoutes(db as never, { trustBoundary: "single_tenant" } as never));
  app.use(errorHandler);
  return app;
}

describe("provider-connections routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeSpies.assertCompanyAccess.mockResolvedValue(undefined);
    routeSpies.assertRole.mockResolvedValue(undefined);
    routeSpies.verify.mockResolvedValue(undefined);
    routeSpies.revoke.mockResolvedValue({ id: CONNECTION_ID, state: "revoked", filesRemoved: false });
  });

  it("401s a non-board actor on list", async () => {
    const { db } = fakeDb();
    const res = await request(appWith(db, { type: "agent", companyId: COMPANY_ID }))
      .get(`/api/companies/${COMPANY_ID}/provider-connections`);

    expect(res.status).toBe(401);
    expect(routeSpies.assertCompanyAccess).not.toHaveBeenCalled();
  });

  it("lists only the requested company's connections after access and founder checks", async () => {
    const rows = [{ id: CONNECTION_ID, provider: "anthropic", state: "verified" }];
    const { db, where } = fakeDb(rows);
    const res = await request(appWith(db)).get(`/api/companies/${COMPANY_ID}/provider-connections`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    expect(routeSpies.assertCompanyAccess).toHaveBeenCalledWith(db, expect.anything(), COMPANY_ID);
    expect(routeSpies.assertRole).toHaveBeenCalledWith(db, expect.anything(), COMPANY_ID, "founder");
    expect(routeSpies.eq).toHaveBeenCalledWith(expect.anything(), COMPANY_ID);
    expect(where).toHaveBeenCalledWith(expect.objectContaining({ value: COMPANY_ID }));
  });

  it("returns 403 when company access is denied", async () => {
    routeSpies.assertCompanyAccess.mockRejectedValueOnce(forbidden("no company access"));
    const { db } = fakeDb();
    const res = await request(appWith(db)).get(`/api/companies/${OTHER_COMPANY_ID}/provider-connections`);

    expect(res.status).toBe(403);
    expect(routeSpies.assertRole).not.toHaveBeenCalled();
  });

  it("returns 403 when an accessible user is not a founder", async () => {
    routeSpies.assertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));
    const { db } = fakeDb();
    const res = await request(appWith(db)).get(`/api/companies/${COMPANY_ID}/provider-connections`);

    expect(res.status).toBe(403);
  });

  it("verifies a connection within the company authorized by the route", async () => {
    const { db } = fakeDb();
    const res = await request(appWith(db))
      .post(`/api/companies/${COMPANY_ID}/provider-connections/${CONNECTION_ID}/verify`);

    expect(res.status).toBe(204);
    expect(routeSpies.verify).toHaveBeenCalledWith(COMPANY_ID, CONNECTION_ID, "u1");
  });

  it("revokes a connection within the company authorized by the route", async () => {
    const { db } = fakeDb();
    const res = await request(appWith(db))
      .delete(`/api/companies/${COMPANY_ID}/provider-connections/${CONNECTION_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: CONNECTION_ID, state: "revoked", filesRemoved: false });
    expect(routeSpies.revoke).toHaveBeenCalledWith(COMPANY_ID, CONNECTION_ID, "u1");
  });

  it("returns 404 when the scoped revoke finds no connection", async () => {
    routeSpies.revoke.mockResolvedValueOnce(null);
    const { db } = fakeDb();
    const res = await request(appWith(db))
      .delete(`/api/companies/${COMPANY_ID}/provider-connections/${MISSING_CONNECTION_ID}`);

    expect(res.status).toBe(404);
  });

  it("returns 400 for malformed company and connection ids", async () => {
    const { db } = fakeDb();
    const badCompany = await request(appWith(db)).get("/api/companies/not-a-uuid/provider-connections");
    const badConnection = await request(appWith(db))
      .post(`/api/companies/${COMPANY_ID}/provider-connections/not-a-uuid/verify`);

    expect(badCompany.status).toBe(400);
    expect(badConnection.status).toBe(400);
    expect(routeSpies.verify).not.toHaveBeenCalled();
  });
});
