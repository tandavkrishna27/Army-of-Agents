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

const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(), summary: vi.fn(), byAgent: vi.fn(), byProject: vi.fn(),
  byModel: vi.fn(), byBiller: vi.fn(), listForAgent: vi.fn(),
}));
const mockCompanyService = vi.hoisted(() => ({
  update: vi.fn(), getById: vi.fn(), list: vi.fn(), create: vi.fn(), archive: vi.fn(), remove: vi.fn(), stats: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(), listPolicies: vi.fn(), getPolicyByScope: vi.fn(), listIncidents: vi.fn(), resolveIncident: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn(), update: vi.fn() }));

vi.mock("../services/index.js", () => ({
  costService: () => mockCostService,
  companyService: () => mockCompanyService,
  agentService: () => mockAgentService,
  logActivity: vi.fn(),
}));
vi.mock("../services/budgets.js", () => ({ budgetService: () => mockBudgetService }));

import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/index.js";

// An agent in company-B (the victim agent's company).
const AGENT_B = { id: "agent-B", companyId: "company-B", budgetMonthlyCents: 500000 };

// A founder-created MCP key scoped to company-A (the attacker's company).
const mcpActorCompanyA = { type: "mcp" as const, source: "mcp_key" as const, userId: "founder-A", companyId: "company-A" };
// A board founder for company-B (legitimate path — regression guard).
const boardActorCompanyB = { type: "board" as const, source: "session" as const, userId: "user-B", companyIds: ["company-B"], isInstanceAdmin: false };
// The agent itself (legitimate self-budget path — regression guard).
const agentSelfB = { type: "agent" as const, agentId: "agent-B", companyId: "company-B" };
// A different agent (existing self-scope 403 — regression guard).
const agentOtherB = { type: "agent" as const, agentId: "agent-OTHER", companyId: "company-B" };

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", costRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("PATCH /agents/:agentId/budgets authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(AGENT_B);
    mockAgentService.update.mockResolvedValue({ ...AGENT_B, budgetMonthlyCents: 0 });
    mockBudgetService.upsertPolicy.mockResolvedValue({});
  });

  it("403 for an MCP token (cross-tenant + non-board governance write) and writes nothing", async () => {
    const res = await request(makeApp(mcpActorCompanyA))
      .patch("/api/agents/agent-B/budgets")
      .send({ budgetMonthlyCents: 0 });
    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
  });

  it("200 for the board founder of the agent's own company (regression guard)", async () => {
    const res = await request(makeApp(boardActorCompanyB))
      .patch("/api/agents/agent-B/budgets")
      .send({ budgetMonthlyCents: 0 });
    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith("agent-B", { budgetMonthlyCents: 0 });
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalled();
  });

  it("403 for a board actor of a DIFFERENT company (cross-tenant)", async () => {
    const boardActorCompanyA = { type: "board" as const, source: "session" as const, userId: "user-A", companyIds: ["company-A"], isInstanceAdmin: false };
    const res = await request(makeApp(boardActorCompanyA))
      .patch("/api/agents/agent-B/budgets")
      .send({ budgetMonthlyCents: 0 });
    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("200 for the agent setting its OWN budget (regression guard)", async () => {
    const res = await request(makeApp(agentSelfB))
      .patch("/api/agents/agent-B/budgets")
      .send({ budgetMonthlyCents: 0 });
    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  it("403 for an agent token targeting a DIFFERENT agent (existing self-scope)", async () => {
    const res = await request(makeApp(agentOtherB))
      .patch("/api/agents/agent-B/budgets")
      .send({ budgetMonthlyCents: 0 });
    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
