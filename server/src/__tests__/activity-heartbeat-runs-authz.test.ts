import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mockActivityService = vi.hoisted(() => ({
  companyIdForRun: vi.fn(),
  issuesForRun: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => ({}),
}));

import { activityRoutes } from "../routes/activity.js";

const RUN_ID = "run-1";
const RUN_COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const RUN_ISSUES = [
  { issueId: "i-1", identifier: "PAP-1", title: "t", status: "todo", priority: "medium" },
];

function createApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", activityRoutes({} as never));
  app.use(errorHandler);
  return app;
}

// self-hosted board branch of assertCompanyAccess (tenantIsolationEnforced() is
// false in tests) authorizes iff companyIds includes the resource's company —
// DB-free and deterministic, matching activity-human-filters.test.ts.
const memberActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "u1",
  companyIds: [RUN_COMPANY],
  isInstanceAdmin: false,
};
const nonMemberActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "u2",
  companyIds: [OTHER_COMPANY],
  isInstanceAdmin: false,
};

describe("GET /heartbeat-runs/:runId/issues — company authz (M1 IDOR fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActivityService.companyIdForRun.mockResolvedValue(RUN_COMPANY);
    mockActivityService.issuesForRun.mockResolvedValue(RUN_ISSUES);
  });

  it("a member of the run's company gets the issues (regression floor)", async () => {
    const res = await request(createApp(memberActor)).get(`/api/heartbeat-runs/${RUN_ID}/issues`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(RUN_ISSUES);
    expect(mockActivityService.issuesForRun).toHaveBeenCalledWith(RUN_ID);
  });

  it("an actor NOT in the run's company is 403 and never sees the issues", async () => {
    const res = await request(createApp(nonMemberActor)).get(`/api/heartbeat-runs/${RUN_ID}/issues`);
    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller is 401 (assertCompanyAccess floor)", async () => {
    const res = await request(createApp({ type: "none" })).get(`/api/heartbeat-runs/${RUN_ID}/issues`);
    expect(res.status).toBe(401);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("a missing run is 404 and never reaches issuesForRun", async () => {
    mockActivityService.companyIdForRun.mockResolvedValue(null);
    const res = await request(createApp(memberActor)).get(`/api/heartbeat-runs/${RUN_ID}/issues`);
    expect(res.status).toBe(404);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("source contract: resolves run company -> assertCompanyAccess -> issuesForRun (covers cloud_auth path too)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "../routes/activity.ts"), "utf8");
    expect(source).toMatch(
      /\/heartbeat-runs\/:runId\/issues[\s\S]*await svc\.companyIdForRun\(runId\)[\s\S]*await assertCompanyAccess\(db, req, companyId\)[\s\S]*await svc\.issuesForRun\(runId\)/,
    );
  });
});
