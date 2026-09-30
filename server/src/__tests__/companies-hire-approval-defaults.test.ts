import express from "express";
import request from "supertest";
import { describe, beforeEach, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";

// vi.hoisted ensures mockCreate is available inside the vi.mock factory
// even though vi.mock calls are hoisted to the top of the module.
const mockCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    id: "co-test",
    name: "TestCo",
    requireBoardApprovalForNewAgents: true,
  }),
);

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: mockCreate,
    // P3: the route creates atomically via `createWithOperator`. Delegate to
    // `mockCreate` (so its call-args assertions — the injected
    // requireBoardApprovalForNewAgents + requestedByUserId — still hold).
    createWithOperator: vi.fn(async (input: any, opts: any, ownerUserId: any, buildAccess: any) => {
      const company = await mockCreate(input, opts);
      const operatorId = await buildAccess(undefined).ensureRealOperator(company.id, ownerUserId);
      return { company, operatorId, created: true, committedActivity: null };
    }),
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
});
