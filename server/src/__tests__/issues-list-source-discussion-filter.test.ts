import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const companyId = "11111111-1111-4111-8111-111111111111";

/**
 * The GET /companies/:cid/issues route must translate the `crewBoard=true`
 * query param into the service's `taskScope:'crew'` filter (2026-06-02 unified
 * crew/org scope, T-A: the route maps the legacy `crewBoard=true` param to the
 * new `taskScope='crew'`). The service then applies the crew-assignee predicate
 * (assignee is an active `kind='aoa'` agent) and opts into a LEFT JOIN against
 * `discussions` to populate `Issue.sourceThreadTitle`. This route-level test
 * only verifies the param→filter wiring (the service is mocked); the predicate
 * itself is covered in crew-board-filter.test.ts. Other values for the param
 * must NOT trigger the crew scope — we treat it strictly as the literal string
 * "true". An explicit `taskScope` query param (org|crew|all) is also accepted
 * and wins over `crewBoard`.
 */

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  listLabels: vi.fn(),
  getLabelById: vi.fn(),
  createLabel: vi.fn(),
  deleteLabel: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  getComment: vi.fn(),
  createAttachment: vi.fn(),
  listAttachments: vi.fn(),
  getAttachmentById: vi.fn(),
  removeAttachment: vi.fn(),
  findMentionedAgents: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getAncestors: vi.fn(),
  staleCount: vi.fn(),
  countUnreadTouchedByUser: vi.fn(),
  markRead: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const noopService = vi.hoisted(() => () => ({}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: noopService,
  goalService: noopService,
  heartbeatService: noopService,
  issueApprovalService: noopService,
  issueService: () => mockIssueService,
  logActivity: vi.fn(),
  projectService: noopService,
  routineService: noopService,
}));

vi.mock("../services/documents.js", () => ({
  documentService: noopService,
}));

const { issueRoutes } = await import("../routes/issues.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/issues — crewBoard → taskScope='crew' wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.list.mockResolvedValue([]);
  });

  it("translates crewBoard=true into taskScope='crew' when the query param is the literal 'true'", async () => {
    await request(createApp()).get(
      `/api/companies/${companyId}/issues?crewBoard=true`,
    );
    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
    expect(mockIssueService.list.mock.calls[0][1]).toMatchObject({
      taskScope: "crew",
    });
    // Legacy boolean is no longer forwarded — the route normalizes to taskScope.
    expect(mockIssueService.list.mock.calls[0][1]).not.toHaveProperty("crewBoard");
  });

  it("does not set a scope filter when neither param is present (service applies its own org default)", async () => {
    await request(createApp()).get(`/api/companies/${companyId}/issues`);
    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
    expect(mockIssueService.list.mock.calls[0][1]).not.toHaveProperty("crewBoard");
    expect(mockIssueService.list.mock.calls[0][1]).not.toHaveProperty("taskScope");
  });

  it("ignores non-'true' values for crewBoard", async () => {
    await request(createApp()).get(
      `/api/companies/${companyId}/issues?crewBoard=1`,
    );
    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
    expect(mockIssueService.list.mock.calls[0][1]).not.toHaveProperty("crewBoard");
    expect(mockIssueService.list.mock.calls[0][1]).not.toHaveProperty("taskScope");
  });

  it("accepts an explicit taskScope query param (org|crew|all)", async () => {
    for (const scope of ["org", "crew", "all"] as const) {
      vi.clearAllMocks();
      mockIssueService.list.mockResolvedValue([]);
      await request(createApp()).get(
        `/api/companies/${companyId}/issues?taskScope=${scope}`,
      );
      expect(mockIssueService.list.mock.calls[0][1]).toMatchObject({ taskScope: scope });
    }
  });

  it("ignores a junk taskScope value (leaves scope unset → service default)", async () => {
    await request(createApp()).get(
      `/api/companies/${companyId}/issues?taskScope=bogus`,
    );
    expect(mockIssueService.list.mock.calls[0][1]).not.toHaveProperty("taskScope");
  });

  it("an explicit taskScope wins over crewBoard=true", async () => {
    await request(createApp()).get(
      `/api/companies/${companyId}/issues?crewBoard=true&taskScope=all`,
    );
    expect(mockIssueService.list.mock.calls[0][1]).toMatchObject({ taskScope: "all" });
    expect(mockIssueService.list.mock.calls[0][1]).not.toHaveProperty("crewBoard");
  });

  it("returns the service result list unchanged (server preserves sourceThreadTitle from the JOIN)", async () => {
    const fakeRow = {
      id: "issue-1",
      title: "Hero copy",
      sourceDiscussionId: "thread-A",
      sourceThreadTitle: "Plan landing page redesign",
      status: "todo",
    };
    mockIssueService.list.mockResolvedValue([fakeRow]);

    const res = await request(createApp()).get(
      `/api/companies/${companyId}/issues?crewBoard=true`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "issue-1",
      sourceDiscussionId: "thread-A",
      sourceThreadTitle: "Plan landing page redesign",
    });
  });

  it("passes assigneeAgentId through to the service alongside the crew scope", async () => {
    const agentId = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
    await request(createApp()).get(
      `/api/companies/${companyId}/issues?crewBoard=true&assigneeAgentId=${agentId}`,
    );
    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
    expect(mockIssueService.list.mock.calls[0][1]).toMatchObject({
      taskScope: "crew",
      assigneeAgentId: agentId,
    });
  });

  it("does NOT set a scope when the old sourceDiscussionIdNotNull param is used (old param is ignored)", async () => {
    await request(createApp()).get(
      `/api/companies/${companyId}/issues?sourceDiscussionIdNotNull=true`,
    );
    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
    // The old param must not accidentally activate any crew scope.
    expect(mockIssueService.list.mock.calls[0][1]).not.toHaveProperty("crewBoard");
    expect(mockIssueService.list.mock.calls[0][1]).not.toHaveProperty("taskScope");
    expect(mockIssueService.list.mock.calls[0][1]).not.toHaveProperty("sourceDiscussionIdNotNull");
  });
});
