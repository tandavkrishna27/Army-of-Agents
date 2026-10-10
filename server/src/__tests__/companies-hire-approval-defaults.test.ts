import express from "express";
import request from "supertest";
import { describe, beforeEach, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";

// vi.hoisted ensures mockCreate is available inside the vi.mock factory
// even though vi.mock calls are hoisted to the top of the module.
const mockCompany = vi.hoisted(() => ({
    id: "co-test",
    name: "TestCo",
    requireBoardApprovalForNewAgents: true,
    agentExecutionSetupState: "pending",
}));
const mockCreate = vi.hoisted(() => vi.fn().mockResolvedValue(mockCompany));
const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(mockCompany));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn().mockResolvedValue([mockCompany]),
    stats: vi.fn(),
    getById: vi.fn().mockResolvedValue(mockCompany),
    create: mockCreate,
    // P3: the route creates atomically via `createWithOperator`. Delegate to
    // `mockCreate` (so its call-args assertions — the injected
    // requireBoardApprovalForNewAgents + requestedByUserId — still hold).
    createWithOperator: vi.fn(async (input: any, opts: any, ownerUserId: any, buildAccess: any) => {
      const company = await mockCreate(input, opts);
      const operatorId = await buildAccess(undefined).ensureRealOperator(company.id, ownerUserId);
      return { company, operatorId, created: true, committedActivity: null };
    }),
    update: mockUpdate,
    archive: vi.fn().mockResolvedValue(mockCompany),
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
    ensureMembership: vi.fn().mockResolvedValue(undefined),
    ensureRealOperator: vi.fn().mockResolvedValue("operator-user-id"),
  }),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

function makeApp(deploymentMode: "local_trusted" | "authenticated") {
  const app = express();
  app.use(express.json());
  // Simulate a local_implicit actor (the actor that passes the instance-admin gate
  // in the POST /companies handler). In local_trusted deployments this actor is
  // auto-injected by actorMiddleware; in tests we set it directly.
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: false,
      userId: null,
      companyIds: [],
    };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any, { deploymentMode }));
  return app;
}

describe("POST /api/companies — requireBoardApprovalForNewAgents default by deployment mode", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  it("local_trusted → injects requireBoardApprovalForNewAgents=false (single-user / team trust boundary = loopback)", async () => {
    const app = makeApp("local_trusted");
    const res = await request(app)
      .post("/api/companies")
      .send({ name: "TestCo" });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("agentExecutionSetupState");
    expect(mockCreate).toHaveBeenCalledOnce();
    // T2.3: create() now also receives per-create options — the founder id
    // attributed to the crew's marketplace install operation. This harness's
    // actor is `local_implicit` with userId null, which is a legitimate
    // no-user case (the bootstrap falls back to a synthetic system actor).
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ requireBoardApprovalForNewAgents: false }),
      expect.objectContaining({ requestedByUserId: null }),
    );
  });

  it("authenticated → injects requireBoardApprovalForNewAgents=true (multi-human board accountability)", async () => {
    const app = makeApp("authenticated");
    const res = await request(app)
      .post("/api/companies")
      .send({ name: "TestCo" });

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledOnce();
    // T2.3: create() now also receives per-create options — the founder id
    // attributed to the crew's marketplace install operation. This harness's
    // actor is `local_implicit` with userId null, which is a legitimate
    // no-user case (the bootstrap falls back to a synthetic system actor).
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ requireBoardApprovalForNewAgents: true }),
      expect.objectContaining({ requestedByUserId: null }),
    );
  });

  it("strips client-supplied execution setup state from create and update payloads", async () => {
    const app = makeApp("local_trusted");
    const created = await request(app).post("/api/companies").send({
      name: "TestCo",
      agentExecutionSetupState: "ready",
    });
    expect(created.status).toBe(201);
    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty("agentExecutionSetupState");

    const updated = await request(app).patch("/api/companies/co-test").send({
      name: "TestCo",
      agentExecutionSetupState: "ready",
    });
    expect(updated.status).toBe(200);
    expect(mockUpdate.mock.calls[0]?.[1]).not.toHaveProperty("agentExecutionSetupState");
  });

  it("omits the internal state from list, detail, update, and archive responses", async () => {
    const app = makeApp("local_trusted");
    for (const response of [
      await request(app).get("/api/companies"),
      await request(app).get("/api/companies/co-test"),
      await request(app).patch("/api/companies/co-test").send({ name: "TestCo" }),
      await request(app).post("/api/companies/co-test/archive"),
    ]) {
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain("agentExecutionSetupState");
    }
  });
});
