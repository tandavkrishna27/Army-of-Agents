import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mockHumanDiscoveryService = vi.hoisted(() => ({
  search: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  humanCapabilitiesService: () => ({}),
  humanContextService: () => ({}),
  humanDiscoveryService: () => mockHumanDiscoveryService,
  logActivity: vi.fn(),
  teamService: () => ({}),
}));

import { teamRoutes } from "../routes/team.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", teamRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/team/humans/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHumanDiscoveryService.search.mockResolvedValue({
      companyId,
      query: "product strategy",
      results: [
        {
          userId: "user-1",
          email: "ada@example.com",
          displayName: "Ada Lovelace",
          avatarUrl: null,
          title: "Product Strategist",
          role: "team_lead",
          departmentId: "dept-product",
          departmentName: "Product",
          reportsToUserId: "founder-1",
          reportsToName: "Grace Founder",
          matchedFields: ["identity", "capability_document"],
          snippets: [
            {
              field: "capability_document",
              label: "Skills",
              value: "product strategy and enterprise routing",
              documentId: "doc-1",
              filename: "skills.md",
            },
          ],
          responsibilitySummary: {
            directHumanReportCount: 0,
            directAgentTreeCount: 1,
            assignedTaskCount: 2,
            createdTaskCount: 3,
          },
        },
      ],
    });
  });

  it("lets a board company member search humans", async () => {
    const app = createApp({
      type: "board",
      userId: "founder-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/team/humans/search?q=product%20strategy&role=team_lead&limit=10`)
      .expect(200);

    expect(mockHumanDiscoveryService.search).toHaveBeenCalledWith(companyId, {
      q: "product strategy",
      role: "team_lead",
      limit: 10,
    });
    expect(res.body.results[0].displayName).toBe("Ada Lovelace");
    expect(res.body.results[0].snippets[0].filename).toBe("skills.md");
    expect(res.body.results[0].responsibilitySummary.assignedTaskCount).toBe(2);
  });

  it("rejects missing or invalid queries", async () => {
    const app = createApp({
      type: "board",
      userId: "founder-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    await request(app).get(`/api/companies/${companyId}/team/humans/search`).expect(400);
    await request(app).get(`/api/companies/${companyId}/team/humans/search?q=x&limit=51`).expect(400);
    expect(mockHumanDiscoveryService.search).not.toHaveBeenCalled();
  });

  it("rejects cross-company and non-board actors", async () => {
    const boardApp = createApp({
      type: "board",
      userId: "founder-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    await request(boardApp)
      .get(`/api/companies/${otherCompanyId}/team/humans/search?q=product`)
      .expect(403);

    const agentApp = createApp({ type: "agent", companyId, agentId: "agent-1" });
    await request(agentApp)
      .get(`/api/companies/${companyId}/team/humans/search?q=product`)
      .expect(403);

    expect(mockHumanDiscoveryService.search).not.toHaveBeenCalled();
  });
});
