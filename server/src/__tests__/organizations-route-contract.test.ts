import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/error-handler.js";

const routeSpies = vi.hoisted(() => ({
  createSelfServeOrganization: vi.fn(),
  listOrgMemberships: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("../services/organizations.js", () => ({
  createSelfServeOrganization: routeSpies.createSelfServeOrganization,
}));
vi.mock("../services/organization-access.js", () => ({
  organizationAccessService: () => ({
    listOrgMemberships: routeSpies.listOrgMemberships,
  }),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: routeSpies.loggerInfo },
}));

import { organizationRoutes } from "../routes/organizations.js";

const boardActor = {
  type: "board",
  source: "session",
  userId: "user-1",
  companyIds: [],
  organizationIds: ["org-1"],
};

function makeApp(actor: unknown) {
  const db = { marker: "db" };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api/organizations", organizationRoutes(db as never));
  app.use(errorHandler);
  return { app, db };
}

describe("organization routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeSpies.createSelfServeOrganization.mockResolvedValue({
      organization: {
        id: "org-new",
        name: "Acme",
        slug: "acme",
        status: "active",
        plan: "beta",
      },
      created: true,
    });
    routeSpies.listOrgMemberships.mockResolvedValue([]);
  });

  it("creates an organization for the signed-in board user and makes that user the owner", async () => {
    const { app, db } = makeApp(boardActor);
    const res = await request(app).post("/api/organizations").send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "org-new", name: "Acme" });
    expect(routeSpies.createSelfServeOrganization).toHaveBeenCalledWith(
      db,
      { name: "Acme", ownerUserId: "user-1", creationRequestId: undefined },
      expect.any(Function),
    );
    expect(routeSpies.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "organization.create",
        organizationId: "org-new",
        ownerUserId: "user-1",
      }),
      "self-serve organization created",
    );
  });

  it("forwards a valid request id and rejects a malformed one", async () => {
    const { app, db } = makeApp(boardActor);
    const creationRequestId = "d259a6f1-d10a-4f79-a057-d47d3ef11152";
    const valid = await request(app)
      .post("/api/organizations")
      .send({ name: "Acme", creationRequestId });
    expect(valid.status).toBe(201);
    expect(routeSpies.createSelfServeOrganization).toHaveBeenCalledWith(
      db,
      { name: "Acme", ownerUserId: "user-1", creationRequestId },
      expect.any(Function),
    );

    routeSpies.createSelfServeOrganization.mockClear();
    const invalid = await request(app)
      .post("/api/organizations")
      .send({ name: "Acme", creationRequestId: "not-a-uuid" });
    expect(invalid.status).toBe(400);
    expect(routeSpies.createSelfServeOrganization).not.toHaveBeenCalled();
  });

  it("rejects organization creation without a signed-in board user", async () => {
    const { app } = makeApp({ ...boardActor, userId: null });
    const res = await request(app).post("/api/organizations").send({ name: "Acme" });

    expect(res.status).toBe(403);
    expect(routeSpies.createSelfServeOrganization).not.toHaveBeenCalled();
  });

  it("rejects caller-controlled slug and plan fields", async () => {
    const { app } = makeApp(boardActor);

    const slugResponse = await request(app)
      .post("/api/organizations")
      .send({ name: "Acme", slug: "caller-slug" });
    const planResponse = await request(app)
      .post("/api/organizations")
      .send({ name: "Acme", plan: "enterprise" });

    expect(slugResponse.status).toBe(400);
    expect(planResponse.status).toBe(400);
    expect(routeSpies.createSelfServeOrganization).not.toHaveBeenCalled();
  });

  it.each([
    ["blank", "   "],
    ["NUL-containing", "Acme\0Corp"],
    ["newline-containing", "Acme\nCorp"],
    ["escape-containing", "Acme\u001bCorp"],
    ["bidi-override-containing", "Acme\u202eCorp"],
    ["zero-width-space-containing", "Acme\u200bCorp"],
    ["line-separator-containing", "Acme\u2028Corp"],
    ["paragraph-separator-containing", "Acme\u2029Corp"],
    ["invisible-function-containing", "Acme\u2061Corp"],
    ["joiner-only", "\u200C\u200D"],
    ["oversized", "a".repeat(101)],
  ])("rejects a %s organization name before persistence", async (_label, name) => {
    const { app } = makeApp(boardActor);

    const res = await request(app).post("/api/organizations").send({ name });

    expect(res.status).toBe(400);
    expect(routeSpies.createSelfServeOrganization).not.toHaveBeenCalled();
  });

  it("rejects agent actors from organization routes", async () => {
    const { app } = makeApp({ type: "agent", companyId: "co1" });
    const res = await request(app).get("/api/organizations");

    expect(res.status).toBe(403);
    expect(routeSpies.listOrgMemberships).not.toHaveBeenCalled();
  });

  it("lists only memberships resolved for the signed-in user", async () => {
    const memberships = [{
      id: "m1",
      organizationId: "org-1",
      organizationName: "Acme Holdings",
      organizationSlug: "acme-holdings",
      userId: "user-1",
      role: "owner",
      status: "active",
    }];
    routeSpies.listOrgMemberships.mockResolvedValueOnce(memberships);
    const { app } = makeApp(boardActor);
    const res = await request(app).get("/api/organizations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(memberships);
    expect(res.body[0]).toMatchObject({
      organizationName: "Acme Holdings",
      organizationSlug: "acme-holdings",
    });
    expect(routeSpies.listOrgMemberships).toHaveBeenCalledWith("user-1");
  });

  it("returns an empty scoped list for a board actor with no user identity", async () => {
    const { app } = makeApp({ ...boardActor, userId: null });
    const res = await request(app).get("/api/organizations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(routeSpies.listOrgMemberships).not.toHaveBeenCalled();
  });
});
