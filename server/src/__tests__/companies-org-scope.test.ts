import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANIZATION_ID, type DeploymentMode } from "@armyofagents/shared";
import { setDeploymentMode } from "../config/deployment-mode.js";

const list = vi.fn();
const create = vi.fn();
const stats = vi.fn().mockResolvedValue({});
const canOrg = vi.fn();

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    ensureRealOperator: vi.fn().mockResolvedValue("operator-user-id"),
  }),
  companyPortabilityService: () => ({}),
  companyService: () => ({
    list,
    create,
    // P3: the route creates atomically via `createWithOperator`. Delegate to
    // `create` (so the organizationId-stamping assertions still hold) and
    // provision the operator via the passed access factory.
    createWithOperator: async (input: any, opts: any, ownerUserId: any, buildAccess: any) => {
      const company = await create(input, opts);
      const operatorId = await buildAccess(undefined).ensureRealOperator(company.id, ownerUserId);
      return { company, operatorId, created: true, committedActivity: null };
    },
    stats,
    getById: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));
// organizationAccessService lives in its OWN module (../services/organization-access.js),
// NOT ../services/index.js — mock the real import path.
vi.mock("../services/organization-access.js", () => ({
  organizationAccessService: () => ({ canOrg }),
}));
// These run as best-effort `.catch(...)` side-effects inside POST / — they MUST
// return a resolved promise (a bare vi.fn() returns undefined, and `.catch` on
// undefined throws -> 500).
vi.mock("../services/internal-agent/aoa-skills-seeder.js", () => ({
  seedAoaNativeSkills: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/team.js", () => ({
  materializeCompanyProfileFromGlobal: vi.fn().mockResolvedValue(undefined),
  ensureCompanyProfileFromGlobal: vi.fn().mockResolvedValue(undefined),
}));

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";

function makeApp(actor: any, deploymentMode: DeploymentMode = "cloud_auth") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    (req as any).tenant = { organizationId: null };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any, { deploymentMode }));
  app.use(errorHandler);
  return app;
}

const ORG_1 = "00000000-0000-0000-0000-0000000000a1";
const ORG_2 = "00000000-0000-0000-0000-0000000000b2";

const sessionActor = (over: Record<string, unknown> = {}) => ({
  type: "board",
  source: "session",
  userId: "u",
  companyIds: [],
  organizationIds: [ORG_1],
  operator: false,
  isInstanceAdmin: false,
  ...over,
});

describe("companies org scope (cloud_auth)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stats.mockResolvedValue({});
    setDeploymentMode("cloud_auth");
  });

  it("GET /: pushes the actor's companyIds into the service (SQL scope, no JS post-filter)", async () => {
    list.mockResolvedValue([{ id: "c1" }]);
    const actor = sessionActor({ companyIds: ["c1"], operator: true });
    const res = await request(makeApp(actor)).get("/api/companies");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(["c1"]);
    expect(res.body.map((c: any) => c.id)).toEqual(["c1"]);
  });

  it("GET /: an actor with zero memberships passes the empty allow-set through (degrade-to-none)", async () => {
    list.mockResolvedValue([]);
    const actor = sessionActor({ companyIds: [] });
    const res = await request(makeApp(actor)).get("/api/companies");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith([]);
    expect(res.body).toEqual([]);
  });

  it("GET /stats: pushes the actor's companyIds into the service (SQL scope, no JS post-filter)", async () => {
    stats.mockResolvedValue({ c1: { total: 1 } });
    const actor = sessionActor({ companyIds: ["c1"], operator: true });
    const res = await request(makeApp(actor)).get("/api/companies/stats");
    expect(res.status).toBe(200);
    expect(stats).toHaveBeenCalledWith(["c1"]);
    expect(Object.keys(res.body)).toEqual(["c1"]);
  });

  it("POST /: 403 when canOrg('company:create') is false", async () => {
    canOrg.mockResolvedValue(false);
    const actor = sessionActor();
    const res = await request(makeApp(actor))
      .post("/api/companies")
      .send({ name: "New Co", organizationId: ORG_1 });
    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
    expect(canOrg).toHaveBeenCalledWith(ORG_1, "u", "company:create");
  });

  it("POST /: org-owner passes and organizationId is stamped on create", async () => {
    canOrg.mockResolvedValue(true);
    create.mockResolvedValue({ id: "c-new", name: "New Co", organizationId: ORG_1 });
    const actor = sessionActor();
    const res = await request(makeApp(actor))
      .post("/api/companies")
      .send({ name: "New Co", organizationId: ORG_1 });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_1 }),
      expect.anything(),
    );
  });

  it("POST / (follow-up): create-another with NO body org lands in the founder's OWN org (not the sentinel)", async () => {
    canOrg.mockResolvedValue(true);
    create.mockResolvedValue({ id: "c-new", name: "Second Co", organizationId: ORG_1 });
    const actor = sessionActor({ organizationIds: [ORG_1] });
    const res = await request(makeApp(actor))
      .post("/api/companies")
      .send({ name: "Second Co" }); // no organizationId
    expect(res.status).toBe(201);
    // authorized against, and stamped with, the founder's own org — NOT the default sentinel.
    expect(canOrg).toHaveBeenCalledWith(ORG_1, "u", "company:create");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_1 }),
      expect.anything(),
    );
    const stamped = create.mock.calls[0][0].organizationId;
    expect(stamped).not.toBe(DEFAULT_ORGANIZATION_ID);
  });

  it("POST / (follow-up): 403 when the actor belongs to multiple orgs and omits organizationId (ambiguous)", async () => {
    const actor = sessionActor({ organizationIds: [ORG_1, ORG_2] });
    const res = await request(makeApp(actor)).post("/api/companies").send({ name: "Ambiguous Co" });
    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
    expect(canOrg).not.toHaveBeenCalled();
  });

  it("POST / (follow-up): 403 when the actor belongs to no organization", async () => {
    const actor = sessionActor({ organizationIds: [] });
    const res = await request(makeApp(actor)).post("/api/companies").send({ name: "Orphan Co" });
    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("companies org scope (self-hosted unchanged)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stats.mockResolvedValue({});
  });

  it("authenticated local_implicit create stamps the DEFAULT sentinel and never calls canOrg", async () => {
    setDeploymentMode("authenticated");
    create.mockResolvedValue({ id: "c-legacy", name: "Legacy Co" });
    const actor = {
      type: "board",
      source: "local_implicit",
      userId: null,
      companyIds: [],
      isInstanceAdmin: false,
    };
    const res = await request(makeApp(actor, "authenticated"))
      .post("/api/companies")
      .send({ name: "Legacy Co" });
    expect(res.status).toBe(201);
    expect(canOrg).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: DEFAULT_ORGANIZATION_ID }),
      expect.anything(),
    );
  });

  it("authenticated instance_admin still sees the full company list (unscoped service call)", async () => {
    setDeploymentMode("authenticated");
    list.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    const actor = {
      type: "board",
      source: "session",
      userId: "op",
      companyIds: [],
      isInstanceAdmin: true,
    };
    const res = await request(makeApp(actor, "authenticated")).get("/api/companies");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith("unscoped"); // explicit unscoped operator view
    expect(res.body.map((c: any) => c.id)).toEqual(["c1", "c2"]);
  });

  it("authenticated instance_admin sees full stats (unscoped service call)", async () => {
    setDeploymentMode("authenticated");
    stats.mockResolvedValue({ c1: { total: 1 }, c2: { total: 9 } });
    const actor = {
      type: "board",
      source: "session",
      userId: "op",
      companyIds: [],
      isInstanceAdmin: true,
    };
    const res = await request(makeApp(actor, "authenticated")).get("/api/companies/stats");
    expect(res.status).toBe(200);
    expect(stats).toHaveBeenCalledWith("unscoped"); // explicit unscoped operator view
    expect(Object.keys(res.body)).toEqual(["c1", "c2"]);
  });
});
