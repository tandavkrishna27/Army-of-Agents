import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { errorHandler } from "../middleware/index.js";
import { dependencyRoutes } from "../routes/dependencies.js";

// Wiring test (no DB): proves dependencies.ts resolves the `:issueId` param via
// the COMPANY-SCOPED lookup (`getByIdentifierInCompany(:companyId, rawId)`),
// not the global `getByIdentifier`. This is the Codex PR #316 round-6 fix — two
// orgs' companies can both own `ACM-1`, so the URL company must scope the
// resolve. The normalizer builds its own issueService(db), so we mock the
// module.

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getByIdentifierInCompany: vi.fn(),
}));

const mockDependencyService = vi.hoisted(() => ({
  getDependencies: vi.fn().mockResolvedValue([]),
  getDependents: vi.fn().mockResolvedValue([]),
  addDependency: vi.fn(),
  removeDependency: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/index.js", () => ({
  dependencyService: () => mockDependencyService,
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const RESOLVED_ISSUE_ID = "22222222-2222-4222-8222-222222222222";

function createApp(actor: Record<string, unknown> = {
  type: "board" as const,
  userId: "user-a",
  source: "session",
  companyIds: [COMPANY_A],
  operator: false,
  isInstanceAdmin: false,
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", dependencyRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("dependencies routes — company-scoped identifier resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDeploymentMode("local_trusted");
  });

  it.each([
    ["anonymous", { type: "none", source: "none" }, 401],
    [
      "cross-tenant board",
      {
        type: "board",
        userId: "user-b",
        source: "session",
        companyIds: [],
        operator: false,
        isInstanceAdmin: false,
      },
      403,
    ],
    [
      "cross-tenant agent",
      {
        type: "agent",
        agentId: "agent-b",
        companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      403,
    ],
    [
      "cross-tenant MCP key",
      {
        type: "mcp",
        source: "mcp_key",
        userId: "user-b",
        companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      },
      403,
    ],
  ])(
    "rejects %s before identifier lookup, with no existing-versus-absent oracle",
    async (_label, actor, expectedStatus) => {
      mockIssueService.getByIdentifierInCompany.mockResolvedValue({
        id: RESOLVED_ISSUE_ID,
        companyId: COMPANY_A,
        identifier: "ACM-1",
      });

      for (const identifier of ["ACM-1", "ACM-999", RESOLVED_ISSUE_ID]) {
        const res = await request(createApp(actor)).get(
          `/api/companies/${COMPANY_A}/issues/${identifier}/dependencies`,
        );
        expect(res.status, `${identifier}: ${JSON.stringify(res.body)}`).toBe(expectedStatus);
      }

      expect(mockIssueService.getByIdentifierInCompany).not.toHaveBeenCalled();
      expect(mockDependencyService.getDependencies).not.toHaveBeenCalled();
    },
  );

  it("allows an active cloud MCP scope to resolve inside its company", async () => {
    setDeploymentMode("cloud_auth");
    mockIssueService.getByIdentifierInCompany.mockResolvedValue({
      id: RESOLVED_ISSUE_ID,
      companyId: COMPANY_A,
      identifier: "ACM-1",
    });

    const res = await request(createApp({
      type: "mcp",
      source: "mcp_key",
      userId: "user-a",
      companyId: COMPANY_A,
      companyIds: [COMPANY_A],
    })).get(`/api/companies/${COMPANY_A}/issues/ACM-1/dependencies`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.getByIdentifierInCompany).toHaveBeenCalledWith(COMPANY_A, "ACM-1");
  });

  it("resolves an identifier via getByIdentifierInCompany(:companyId, id), never the global lookup", async () => {
    mockIssueService.getByIdentifierInCompany.mockResolvedValue({
      id: RESOLVED_ISSUE_ID,
      companyId: COMPANY_A,
      identifier: "ACM-1",
    });

    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_A}/issues/ACM-1/dependencies`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Scoped resolve was used with the URL company id.
    expect(mockIssueService.getByIdentifierInCompany).toHaveBeenCalledWith(
      COMPANY_A,
      "ACM-1",
    );
    // The unscoped global resolve was NOT used.
    expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
    // The resolved UUID (not the raw identifier) reached the service.
    expect(mockDependencyService.getDependencies).toHaveBeenCalledWith(
      COMPANY_A,
      RESOLVED_ISSUE_ID,
    );
  });

  it("passes a raw UUID through unchanged (non-identifier fast-path, no lookup)", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY_A}/issues/${RESOLVED_ISSUE_ID}/dependencies`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.getByIdentifierInCompany).not.toHaveBeenCalled();
    expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
    expect(mockDependencyService.getDependencies).toHaveBeenCalledWith(
      COMPANY_A,
      RESOLVED_ISSUE_ID,
    );
  });
});
