import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { feedbackRoutes } from "../routes/feedback.js";
import { forbidden, notFound } from "../errors.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

const mockVotesService = vi.hoisted(() => ({
  getById: vi.fn(),
  recordVote: vi.fn(),
  listVotes: vi.fn(),
  dismissVote: vi.fn(),
  voteSummaryForTarget: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockListExports = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockBuildBundle = vi.hoisted(() => vi.fn());
const mockWriteBundleLocally = vi.hoisted(() => vi.fn());
const mockShareFeedbackBundle = vi.hoisted(() => vi.fn());

vi.mock("../services/feedback-votes.js", () => ({
  feedbackVotesService: () => mockVotesService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/feedback-bundles.js", () => ({
  buildBundle: mockBuildBundle,
  listExports: mockListExports,
}));

vi.mock("../services/feedback-share-client.js", () => ({
  writeBundleLocally: mockWriteBundleLocally,
  shareFeedbackBundle: mockShareFeedbackBundle,
  FEEDBACK_LOCAL_EXPORT_DIR_NAME: ".aoa/feedback-exports",
}));

// InstanceSettingsService is a real call in feedback.ts; stub it out so route
// setup doesn't try to touch drizzle at import time.
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ feedbackDataSharingPreference: "not_allowed" }),
  }),
}));

// Silence pino during tests — middleware/logger loads fs.mkdirSync which is
// fine, but this keeps the test output quiet.
vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  httpLogger: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "55555555-5555-5555-5555-555555555555";
const ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const VOTE_ID = "44444444-4444-4444-4444-444444444444";
const USER_A = "user-a";
const USER_B = "user-b";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", feedbackRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(
  overrides: Partial<{
    userId: string;
    companyIds: string[];
    isInstanceAdmin: boolean;
    source: string;
  }> = {},
) {
  return {
    type: "board" as const,
    userId: overrides.userId ?? USER_A,
    source: overrides.source ?? "session",
    companyIds: overrides.companyIds ?? [COMPANY_A],
    // Operator-plane authority mirrors a genuine operator (actorMiddleware mints
    // operator alongside isInstanceAdmin); the operator-plane routes read it.
    operator: overrides.isInstanceAdmin ?? false,
    isInstanceAdmin: overrides.isInstanceAdmin ?? false,
  };
}

// ── POST /issues/:id/feedback-votes ──────────────────────────────────────────

describe("feedback routes — POST /issues/:id/feedback-votes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a vote and returns 201", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_A,
      identifier: "ENG-1",
    });
    mockVotesService.recordVote.mockResolvedValue({
      id: VOTE_ID,
      companyId: COMPANY_A,
      issueId: ISSUE_ID,
      targetType: "issue_comment",
      targetId: TARGET_ID,
      authorUserId: USER_A,
      vote: "up",
      reason: null,
    });

    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/feedback-votes`)
      .send({
        targetType: "issue_comment",
        targetId: TARGET_ID,
        vote: "up",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.id).toBe(VOTE_ID);
    expect(mockVotesService.recordVote).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      authorUserId: USER_A,
      issueId: ISSUE_ID,
      targetType: "issue_comment",
      targetId: TARGET_ID,
      vote: "up",
      reason: undefined,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const [, activity] = mockLogActivity.mock.calls[0];
    expect(activity.action).toBe("issue.feedback_vote_saved");
    expect(activity.entityId).toBe(ISSUE_ID);
    expect(activity.details).toMatchObject({
      vote: "up",
      hasReason: false,
      targetType: "issue_comment",
    });
  });

  it("passes trimmed reason to service on downvote", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: COMPANY_A, identifier: "ENG-1" });
    mockVotesService.recordVote.mockResolvedValue({
      id: VOTE_ID,
      targetType: "issue_comment",
      targetId: TARGET_ID,
      vote: "down",
      reason: "missed the mark",
    });

    const app = createApp(boardActor());
    await request(app)
      .post(`/api/issues/${ISSUE_ID}/feedback-votes`)
      .send({
        targetType: "issue_comment",
        targetId: TARGET_ID,
        vote: "down",
        reason: "  missed the mark  ",
      });

    const [{ reason }] = mockVotesService.recordVote.mock.calls[0];
    // Zod .trim() runs before service is called.
    expect(reason).toBe("missed the mark");
  });

  it("returns 404 when issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/feedback-votes`)
      .send({ targetType: "issue_comment", targetId: TARGET_ID, vote: "up" });
    expect(res.status).toBe(404);
    expect(mockVotesService.recordVote).not.toHaveBeenCalled();
  });

  it("rejects agent actor (403) — only board can vote", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: COMPANY_A });
    const app = createApp({
      type: "agent" as const,
      source: "agent-key",
      agentId: "some-agent",
      companyId: COMPANY_A,
    });
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/feedback-votes`)
      .send({ targetType: "issue_comment", targetId: TARGET_ID, vote: "up" });
    expect(res.status).toBe(403);
    expect(mockVotesService.recordVote).not.toHaveBeenCalled();
  });

  it("forbids cross-company access", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: COMPANY_A });
    const app = createApp(boardActor({ companyIds: [COMPANY_B] }));
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/feedback-votes`)
      .send({ targetType: "issue_comment", targetId: TARGET_ID, vote: "up" });
    expect(res.status).toBe(403);
    expect(mockVotesService.recordVote).not.toHaveBeenCalled();
  });

  it("rejects invalid target type (400 validation)", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: COMPANY_A });
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/feedback-votes`)
      .send({ targetType: "bogus", targetId: TARGET_ID, vote: "up" });
    expect(res.status).toBe(400);
    expect(mockVotesService.recordVote).not.toHaveBeenCalled();
  });

  it("rejects non-uuid targetId (400 validation)", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: COMPANY_A });
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/feedback-votes`)
      .send({ targetType: "issue_comment", targetId: "not-uuid", vote: "up" });
    expect(res.status).toBe(400);
  });
});

// ── GET /issues/:id/feedback-votes ───────────────────────────────────────────

describe("feedback routes — GET /issues/:id/feedback-votes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the current user's votes for this issue", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: COMPANY_A });
    mockVotesService.listVotes.mockResolvedValue([
      { id: VOTE_ID, vote: "up", authorUserId: USER_A, issueId: ISSUE_ID },
    ]);

    const app = createApp(boardActor());
    const res = await request(app).get(`/api/issues/${ISSUE_ID}/feedback-votes`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockVotesService.listVotes).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      issueId: ISSUE_ID,
      authorUserId: USER_A,
    });
  });

  it("resolves issue identifiers before listing the current user's votes", async () => {
    mockIssueService.getByIdentifier.mockResolvedValueOnce({
      id: ISSUE_ID,
      companyId: COMPANY_A,
      identifier: "VQA-3",
    });
    mockIssueService.getById.mockResolvedValueOnce({ id: ISSUE_ID, companyId: COMPANY_A });
    mockVotesService.listVotes.mockResolvedValueOnce([]);

    const app = createApp(boardActor({ userId: USER_A, companyIds: [COMPANY_A] }));
    const res = await request(app).get("/api/issues/VQA-3/feedback-votes");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("VQA-3", [COMPANY_A]);
    expect(mockVotesService.listVotes).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      issueId: ISSUE_ID,
      authorUserId: USER_A,
    });
  });

  it("returns 404 when issue is unknown", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const app = createApp(boardActor());
    const res = await request(app).get(`/api/issues/${ISSUE_ID}/feedback-votes`);
    expect(res.status).toBe(404);
  });

  it("rejects non-board actor with 403", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: COMPANY_A });
    const app = createApp({
      type: "agent" as const,
      source: "agent-key",
      agentId: "some-agent",
      companyId: COMPANY_A,
    });
    const res = await request(app).get(`/api/issues/${ISSUE_ID}/feedback-votes`);
    expect(res.status).toBe(403);
  });
});

// ── GET /issues/:id/feedback-votes/summary ──────────────────────────────────

describe("feedback routes — GET /issues/:id/feedback-votes/summary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns aggregate ups/downs for a target", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: COMPANY_A });
    mockVotesService.voteSummaryForTarget.mockResolvedValue({ ups: 3, downs: 1, total: 4 });

    const app = createApp(boardActor());
    const res = await request(app)
      .get(`/api/issues/${ISSUE_ID}/feedback-votes/summary`)
      .query({ targetType: "issue_comment", targetId: TARGET_ID });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ups: 3, downs: 1, total: 4 });
    expect(mockVotesService.voteSummaryForTarget).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      issueId: ISSUE_ID,
      targetType: "issue_comment",
      targetId: TARGET_ID,
    });
  });

  it("requires targetType + targetId query params", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: COMPANY_A });
    const app = createApp(boardActor());
    const res = await request(app).get(`/api/issues/${ISSUE_ID}/feedback-votes/summary`);
    expect(res.status).toBe(400);
  });
});

// ── DELETE /feedback-votes/:voteId ──────────────────────────────────────────

describe("feedback routes — DELETE /feedback-votes/:voteId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dismisses the caller's own vote with 204", async () => {
    mockVotesService.getById.mockResolvedValue({
      id: VOTE_ID,
      companyId: COMPANY_A,
      authorUserId: USER_A,
    });
    mockVotesService.dismissVote.mockResolvedValue(undefined);
    const app = createApp(boardActor({ userId: USER_A }));
    const res = await request(app).delete(`/api/feedback-votes/${VOTE_ID}`);
    expect(res.status).toBe(204);
    expect(mockVotesService.dismissVote).toHaveBeenCalledWith(VOTE_ID, USER_A);
  });

  it("propagates service 403 when caller is not the vote's author", async () => {
    mockVotesService.getById.mockResolvedValue({
      id: VOTE_ID,
      companyId: COMPANY_A,
      authorUserId: USER_A,
    });
    mockVotesService.dismissVote.mockRejectedValue(forbidden("Only the vote's author can dismiss it"));
    const app = createApp(boardActor({ userId: USER_B }));
    const res = await request(app).delete(`/api/feedback-votes/${VOTE_ID}`);
    expect(res.status).toBe(403);
  });

  it("returns 404 when the vote does not exist", async () => {
    mockVotesService.getById.mockResolvedValue(null);
    const app = createApp(boardActor());
    const res = await request(app).delete(`/api/feedback-votes/${VOTE_ID}`);
    expect(res.status).toBe(404);
    expect(mockVotesService.dismissVote).not.toHaveBeenCalled();
  });

  it("returns 403 when actor's company differs from vote's company (cross-tenant)", async () => {
    mockVotesService.getById.mockResolvedValue({
      id: VOTE_ID,
      companyId: COMPANY_A,
      authorUserId: USER_A,
    });
    const app = createApp(boardActor({ userId: USER_A, companyIds: [COMPANY_B] }));
    const res = await request(app).delete(`/api/feedback-votes/${VOTE_ID}`);
    expect(res.status).toBe(403);
    expect(mockVotesService.dismissVote).not.toHaveBeenCalled();
  });

  it("rejects non-board actors", async () => {
    const app = createApp({
      type: "agent" as const,
      source: "agent-key",
      agentId: "some-agent",
      companyId: COMPANY_A,
    });
    const res = await request(app).delete(`/api/feedback-votes/${VOTE_ID}`);
    expect(res.status).toBe(403);
    expect(mockVotesService.dismissVote).not.toHaveBeenCalled();
  });
});

// ── GET /feedback/exports (F.4 — admin bundle history) ───────────────────────

describe("feedback routes — GET /feedback/exports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDeploymentMode("local_trusted");
  });
  afterEach(() => setDeploymentMode("local_trusted"));

  const sampleRow = {
    id: "export-1",
    exportId: "fbexp_0123456789abcdef01234567",
    companyId: COMPANY_A,
    issueId: ISSUE_ID,
    projectId: null,
    authorUserId: USER_A,
    vote: "down",
    status: "local_only",
    destination: null,
    createdAt: new Date("2026-04-22T10:23:00Z"),
    sizeBytes: 4200,
  };

  it("returns the list for local_implicit actors (single-user local mode)", async () => {
    mockListExports.mockResolvedValue([sampleRow]);
    const app = createApp(boardActor({ source: "local_implicit" }));
    const res = await request(app).get("/api/feedback/exports");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "export-1",
      exportId: "fbexp_0123456789abcdef01234567",
      vote: "down",
      status: "local_only",
      sizeBytes: 4200,
    });
  });

  it("returns the list for instance admin actors", async () => {
    mockListExports.mockResolvedValue([]);
    const app = createApp(boardActor({ source: "session", isInstanceAdmin: true }));
    const res = await request(app).get("/api/feedback/exports");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rejects cloud operators before reading cross-tenant export history", async () => {
    setDeploymentMode("cloud_auth");
    const app = createApp(boardActor({ source: "session", isInstanceAdmin: true }));
    const res = await request(app).get("/api/feedback/exports");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/multi-tenant/i);
    expect(mockListExports).not.toHaveBeenCalled();
  });

  it("passes ?limit=3 through to listExports", async () => {
    mockListExports.mockResolvedValue([]);
    const app = createApp(boardActor({ source: "local_implicit" }));
    await request(app).get("/api/feedback/exports?limit=3");
    expect(mockListExports).toHaveBeenCalledWith(expect.anything(), { limit: 3 });
  });

  it("omits limit when not provided (service falls back to default)", async () => {
    mockListExports.mockResolvedValue([]);
    const app = createApp(boardActor({ source: "local_implicit" }));
    await request(app).get("/api/feedback/exports");
    expect(mockListExports).toHaveBeenCalledWith(expect.anything(), { limit: undefined });
  });

  it("rejects non-admin board users with 403", async () => {
    const app = createApp(boardActor({ source: "session", isInstanceAdmin: false }));
    const res = await request(app).get("/api/feedback/exports");
    expect(res.status).toBe(403);
    expect(mockListExports).not.toHaveBeenCalled();
  });

  it("rejects agent actors with 403 (instance admin scope only)", async () => {
    const app = createApp({
      type: "agent" as const,
      source: "agent-key",
      agentId: "some-agent",
      companyId: COMPANY_A,
    });
    const res = await request(app).get("/api/feedback/exports");
    expect(res.status).toBe(403);
    expect(mockListExports).not.toHaveBeenCalled();
  });
});
