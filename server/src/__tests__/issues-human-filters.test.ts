import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(),
  memoryLifecycleService: () => ({}),
  projectService: () => ({}),
  routineService: () => ({}),
  goalService: () => ({}),
}));

vi.mock("../services/documents.js", () => ({
  documentService: () => ({}),
}));

vi.mock("../services/eager-workspace.js", () => ({
  createEagerWorkspaceForIssue: vi.fn(),
}));

vi.mock("../services/issue-context-bundles.js", () => ({
  listIssueContextBundlesForIssue: vi.fn(),
  setIssueContextBundleItemIncluded: vi.fn(),
}));

import { issueRoutes } from "../routes/issues.js";

const companyId = "11111111-1111-4111-8111-111111111111";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue human filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
  });

  it("forwards createdByUserId through the company issue list route", async () => {
    const app = createApp({
      type: "board",
      userId: "user-board",
      source: "session",
      companyIds: [companyId],
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ createdByUserId: "user-creator", taskScope: "all" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        createdByUserId: "user-creator",
        taskScope: "all",
      }),
    );
  });

  it("resolves createdByUserId=me for board actors", async () => {
    const app = createApp({
      type: "board",
      userId: "user-board",
      source: "session",
      companyIds: [companyId],
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ createdByUserId: "me" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ createdByUserId: "user-board" }),
    );
  });

  it("rejects createdByUserId=me for non-board actors", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ createdByUserId: "me" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("createdByUserId=me requires board authentication");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("keeps service created-by filtering company-scoped and hidden-safe", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "../services/issues.ts"), "utf8");

    expect(source).toContain("createdByUserId?: string");
    expect(source).toContain("eq(issues.companyId, companyId)");
    expect(source).toContain("eq(issues.createdByUserId, filters.createdByUserId)");
    expect(source).toContain("isNull(issues.hiddenAt)");
  });
});
