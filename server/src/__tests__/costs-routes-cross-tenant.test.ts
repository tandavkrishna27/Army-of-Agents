import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("@armyofagents/db", () => ({
  companies: makeTableProxy("companies"),
  costEvents: makeTableProxy("cost_events"),
  budgetPolicies: makeTableProxy("budget_policies"),
  agents: makeTableProxy("agents"),
}));

const mockCompanyService = vi.hoisted(() => ({
  update: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  stats: vi.fn(),
}));

const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn(),
  byAgent: vi.fn(),
  byProject: vi.fn(),
  byModel: vi.fn(),
  byBiller: vi.fn(),
  listForAgent: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
  listPolicies: vi.fn(),
  getPolicyByScope: vi.fn(),
  listIncidents: vi.fn(),
  resolveIncident: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  costService: () => mockCostService,
  companyService: () => mockCompanyService,
  agentService: () => mockAgentService,
  logActivity: vi.fn(),
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: () => mockBudgetService,
}));

import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/index.js";

const companyAActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "user-A",
  companyIds: ["company-A"],
  isInstanceAdmin: false,
};

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", costRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("PATCH /companies/:companyId/budgets cross-tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("403 for foreign-company actor", async () => {
    const res = await request(makeApp(companyAActor))
      .patch("/api/companies/company-B/budgets")
      .send({ budgetMonthlyCents: 100000 });
    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
  });

  it("200 for own-company actor (regression guard)", async () => {
    mockCompanyService.update.mockResolvedValue({
      id: "company-A",
      budgetMonthlyCents: 100000,
    });
    mockBudgetService.upsertPolicy.mockResolvedValue({});
    const res = await request(makeApp(companyAActor))
      .patch("/api/companies/company-A/budgets")
      .send({ budgetMonthlyCents: 100000 });
    expect(res.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalledWith("company-A", {
      budgetMonthlyCents: 100000,
    });
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalled();
  });
});
