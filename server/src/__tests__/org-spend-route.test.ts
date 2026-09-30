import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";

const spies = vi.hoisted(() => ({
  canOrg: vi.fn(async () => true),
  getOrgSpend: vi.fn(async () => ({ totalCents: 0, currency: "USD" })),
}));

vi.mock("../services/organization-access.js", () => ({
  organizationAccessService: () => ({ canOrg: spies.canOrg }),
}));
vi.mock("../services/org-spend.js", () => ({ getOrgSpend: spies.getOrgSpend }));

import { orgSpendRoutes } from "../routes/org-spend.js";

const ORG_ID = "55555555-5555-4555-8555-555555555555";

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId: "user-1", companyIds: [] };
    next();
  });
  app.use("/api", orgSpendRoutes({ db: {} as never }));
  app.use(errorHandler);
  return app;
}

describe("organization spend route parameters", () => {
  it("accepts a UUID organization id", async () => {
    const res = await request(makeApp()).get(`/api/organizations/${ORG_ID}/spend`);

    expect(res.status).toBe(200);
    expect(spies.canOrg).toHaveBeenCalledWith(ORG_ID, "user-1", "org:spend:view");
    expect(spies.getOrgSpend).toHaveBeenCalledWith(expect.anything(), ORG_ID, expect.any(Date));
  });

  it("returns 400 for a malformed organization id before authorization or SQL", async () => {
    vi.clearAllMocks();
    const res = await request(makeApp()).get("/api/organizations/not-a-uuid/spend");

    expect(res.status).toBe(400);
    expect(spies.canOrg).not.toHaveBeenCalled();
    expect(spies.getOrgSpend).not.toHaveBeenCalled();
  });
});
