import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => ({}),
}));

import { activityRoutes } from "../routes/activity.js";

const companyId = "11111111-1111-4111-8111-111111111111";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("activity human filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActivityService.list.mockResolvedValue([]);
    mockActivityService.create.mockResolvedValue({ id: "activity-1" });
  });

  it("forwards actorType and actorId through the company activity list route", async () => {
    const app = createApp({
      type: "board",
      userId: "user-board",
      source: "session",
      companyIds: [companyId],
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/activity`)
      .query({ actorType: "user", actorId: "user-1" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId,
      actorType: "user",
      actorId: "user-1",
      agentId: undefined,
      entityType: undefined,
      entityId: undefined,
    });
  });

  it("composes actor filters with entity filters", async () => {
    const app = createApp({
      type: "board",
      userId: "user-board",
      source: "session",
      companyIds: [companyId],
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/activity`)
      .query({
        actorType: "user",
        actorId: "user-1",
        entityType: "issue",
        entityId: "issue-1",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId,
      actorType: "user",
      actorId: "user-1",
      agentId: undefined,
      entityType: "issue",
      entityId: "issue-1",
    });
  });

  it("keeps service actor filters composed with hidden issue suppression", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "../services/activity.ts"), "utf8");

    expect(source).toContain("actorType?:");
    expect(source).toContain("actorId?: string");
    expect(source).toContain("eq(activityLog.actorType, filters.actorType)");
    expect(source).toContain("eq(activityLog.actorId, filters.actorId)");
    expect(source).toContain("isNull(issues.hiddenAt)");
  });

  it.each([
    {
      action: "marketplace.reconciliation_started",
      entityType: "issue",
    },
    {
      action: "issue.created",
      entityType: "marketplace_reconciliation",
    },
  ])(
    "rejects service-reserved marketplace reconciliation audit events",
    async ({ action, entityType }) => {
      const app = createApp({
        type: "board",
        userId: "user-board",
        source: "session",
        companyIds: [companyId],
      });

      const res = await request(app)
        .post(`/api/companies/${companyId}/activity`)
        .send({
          actorType: "user",
          actorId: "user-board",
          action,
          entityType,
          entityId: "22222222-2222-4222-8222-222222222222",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(mockActivityService.create).not.toHaveBeenCalled();
    },
  );
});
