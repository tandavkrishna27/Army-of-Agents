import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mockHumanContextService = vi.hoisted(() => ({
  getBundle: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  humanCapabilitiesService: () => ({}),
  humanContextService: () => mockHumanContextService,
  humanDiscoveryService: () => ({}),
  logActivity: vi.fn(),
  teamService: () => ({}),
}));

import { teamRoutes } from "../routes/team.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const targetUserId = "target-user-1";

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

describe("GET /companies/:companyId/team/users/:userId/agent-context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHumanContextService.getBundle.mockResolvedValue({
      companyId,
      userId: targetUserId,
      generatedAt: new Date("2026-07-08T10:00:00.000Z"),
      identity: {
        userId: targetUserId,
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        title: "Product Strategist",
        bio: null,
        location: null,
        timezone: null,
        socialLinks: [],
      },
      authority: {
        role: "team_lead",
        departmentId: "dept-product",
        departmentName: "Product",
        reportsToUserId: "founder-1",
        reportsToName: "Grace Founder",
        isSystemAdmin: false,
        explicitGrants: [],
      },
      responsibility: {
        directHumanReports: [],
        directAgentTrees: [],
        assignedTaskCount: 0,
        createdTaskCount: 0,
      },
      capabilities: [],
      markdown: "## Capability Documents",
    });
  });

  it("lets a board company member preview the human context bundle", async () => {
    const app = createApp({
      type: "board",
      userId: "founder-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/team/users/${targetUserId}/agent-context`)
      .expect(200);

    expect(mockHumanContextService.getBundle).toHaveBeenCalledWith(companyId, targetUserId, "founder-1");
    expect(res.body.bundle.identity.displayName).toBe("Ada Lovelace");
    expect(res.body.bundle.markdown).toContain("## Capability Documents");
  });

  it("rejects cross-company preview attempts", async () => {
    const app = createApp({
      type: "board",
      userId: "founder-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    await request(app)
      .get(`/api/companies/${otherCompanyId}/team/users/${targetUserId}/agent-context`)
      .expect(403);

    expect(mockHumanContextService.getBundle).not.toHaveBeenCalled();
  });

  it("rejects non-board actors", async () => {
    const app = createApp({ type: "agent", companyId, agentId: "agent-1" });

    await request(app)
      .get(`/api/companies/${companyId}/team/users/${targetUserId}/agent-context`)
      .expect(403);

    expect(mockHumanContextService.getBundle).not.toHaveBeenCalled();
  });
});
