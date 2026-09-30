import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetInstallUrl = vi.hoisted(() => vi.fn().mockReturnValue("https://github.com/apps/test-app/installations/new"));
const mockSaveInstallation = vi.hoisted(() => vi.fn());
const mockRemoveInstallation = vi.hoisted(() => vi.fn());
const mockGetInstallation = vi.hoisted(() => vi.fn());
const mockListInstallationRepositories = vi.hoisted(() => vi.fn());
const mockSignInstallState = vi.hoisted(() => vi.fn((c: string) => `signed:${c}`));
const mockVerifyInstallState = vi.hoisted(() => vi.fn());
// Mirrors the real ONBOARDING_RETURN_PATHS allowlist in services/github-app.ts
// so route-level tests can assert against the same fixed key→path mapping.
const ONBOARDING_RETURN_PATHS = vi.hoisted(() => ({
  integrations: "/?github=connected",
}));
const mockIsOnboardingReturnTarget = vi.hoisted(() =>
  vi.fn((v: unknown) => typeof v === "string" && Object.prototype.hasOwnProperty.call(ONBOARDING_RETURN_PATHS, v)),
);

vi.mock("../services/github-app.js", () => ({
  getInstallUrl: mockGetInstallUrl,
  saveInstallation: mockSaveInstallation,
  removeInstallation: mockRemoveInstallation,
  getInstallation: mockGetInstallation,
  listInstallationRepositories: mockListInstallationRepositories,
  signInstallState: mockSignInstallState,
  verifyInstallState: mockVerifyInstallState,
  isOnboardingReturnTarget: mockIsOnboardingReturnTarget,
  ONBOARDING_RETURN_PATHS,
}));

const mockOctokit = vi.hoisted(() => ({
  users: { getAuthenticated: vi.fn() },
  pulls: {
    create: vi.fn(),
    list: vi.fn(),
    merge: vi.fn(),
    update: vi.fn(),
    requestReviewers: vi.fn(),
  },
  repos: { listCollaborators: vi.fn(), listBranches: vi.fn() },
  issues: {
    addLabels: vi.fn(),
    update: vi.fn(),
    listLabelsForRepo: vi.fn(),
    listMilestones: vi.fn(),
  },
}));
vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

const mockSvc = vi.hoisted(() => ({
  getByName: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/index.js", () => ({
  secretService: () => mockSvc,
  logActivity: mockLogActivity,
}));

const mockWsSvc = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockWsSvc,
}));

const mockMergeWorkspacePr = vi.hoisted(() => vi.fn());
const mockCloseWorkspacePr = vi.hoisted(() => vi.fn());
const mockReopenWorkspacePr = vi.hoisted(() => vi.fn());
const mockRequestPrReview = vi.hoisted(() => vi.fn());

vi.mock("../services/github-pr.js", () => ({
  // NOTE: real constructor is (message: string, status: number, scopeHint?: string)
  // The parameter order below is intentional for the mock — do NOT use as reference for production code
  GitHubPrError: class GitHubPrError extends Error {
    constructor(public status: number, message: string, public scopeHint?: string) { super(message); }
  },
  parseGitHubRepoUrl: vi.fn((url: string) => {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!m) throw new Error("bad url");
    return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
  }),
  resolveGitHubAuth: vi.fn().mockResolvedValue("ghp_token"),
  createPullRequest: vi.fn(),
  findPullRequestForBranch: vi.fn(),
  mergeWorkspacePr: mockMergeWorkspacePr,
  closeWorkspacePr: mockCloseWorkspacePr,
  reopenWorkspacePr: mockReopenWorkspacePr,
  requestPrReview: mockRequestPrReview,
}));

import { errorHandler } from "../middleware/index.js";
import { GITHUB_PAT_ACTIVITY_KINDS, GITHUB_PAT_SECRET_NAME } from "@armyofagents/shared";
import { githubRoutes } from "../routes/github.js";
// Pulled from the mocked module above so tests can drive auth-error paths.
// NOTE: the mock's GitHubPrError ctor is (status, message, scopeHint?).
import {
  GitHubPrError,
  resolveGitHubAuth,
  findPullRequestForBranch,
} from "../services/github-pr.js";

function createApp(actor: any, db: any = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", githubRoutes(db as any));
  app.use(errorHandler);
  return app;
}

function createActivityDb(details: Record<string, unknown>) {
  const limit = vi.fn().mockResolvedValue([{ details }]);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, from, where, orderBy, limit };
}

const boardActor = {
  type: "board",
  source: "local_implicit",
  userId: "board-user",
  companyIds: null,
  isInstanceAdmin: true,
};

describe("github integration routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /companies/:companyId/github/pat", () => {
    it("saves a valid PAT and returns configured=true with githubUser", async () => {
      mockOctokit.users.getAuthenticated.mockResolvedValue({
        data: { login: "octocat" },
      });
      mockSvc.delete.mockResolvedValue(false);
      mockSvc.create.mockResolvedValue({ id: "secret-1" });

      const app = createApp(boardActor);
      const res = await request(app)
        .post("/api/companies/company-1/github/pat")
        .send({ pat: "ghp_validtoken" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ configured: true, githubUser: "octocat" });
      expect(mockOctokit.users.getAuthenticated).toHaveBeenCalledTimes(1);
      expect(mockSvc.delete).toHaveBeenCalledWith("company-1", GITHUB_PAT_SECRET_NAME);
      expect(mockSvc.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          name: GITHUB_PAT_SECRET_NAME,
          provider: "local_encrypted",
          value: "ghp_validtoken",
          externalRef: "octocat",
        }),
        { userId: "board-user", agentId: null },
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          action: GITHUB_PAT_ACTIVITY_KINDS.CONNECTED,
          entityType: "secret",
          entityId: "secret-1",
          details: { githubUser: "octocat" },
        }),
      );
      // Extra safety: PAT must not be in activity log details.
      const logCall = mockLogActivity.mock.calls[0]![1] as { details: unknown };
      expect(JSON.stringify(logCall.details)).not.toContain("ghp_validtoken");
    });

    it("returns 400 when Octokit rejects the PAT (does not persist)", async () => {
      mockOctokit.users.getAuthenticated.mockRejectedValue(new Error("401 unauthorized"));

      const app = createApp(boardActor);
      const res = await request(app)
        .post("/api/companies/company-1/github/pat")
        .send({ pat: "ghp_bogus" });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Invalid GitHub PAT" });
      expect(mockSvc.delete).not.toHaveBeenCalled();
      expect(mockSvc.create).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("re-save deletes the existing PAT before creating a new one", async () => {
      mockOctokit.users.getAuthenticated.mockResolvedValue({
        data: { login: "newuser" },
      });
      mockSvc.delete.mockResolvedValue(true); // existing row existed
      mockSvc.create.mockResolvedValue({ id: "secret-2" });

      const app = createApp(boardActor);
      const res = await request(app)
        .post("/api/companies/company-1/github/pat")
        .send({ pat: "ghp_new" });

      expect(res.status).toBe(200);
      // delete must be called before create
      const deleteOrder = mockSvc.delete.mock.invocationCallOrder[0]!;
      const createOrder = mockSvc.create.mock.invocationCallOrder[0]!;
      expect(deleteOrder).toBeLessThan(createOrder);
    });

    it("returns 400 when the request body is empty (zod parse failure)", async () => {
      const app = createApp(boardActor);
      const res = await request(app)
        .post("/api/companies/company-1/github/pat")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Invalid request body" });
      expect(mockOctokit.users.getAuthenticated).not.toHaveBeenCalled();
      expect(mockSvc.create).not.toHaveBeenCalled();
    });

    it("returns 400 when pat is empty string", async () => {
      const app = createApp(boardActor);
      const res = await request(app)
        .post("/api/companies/company-1/github/pat")
        .send({ pat: "" });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Invalid request body" });
    });
  });

  describe("DELETE /companies/:companyId/github/pat", () => {
    it("returns configured=false, removed=true when row existed + logs activity with secret UUID", async () => {
      mockSvc.getByName.mockResolvedValue({
        id: "secret-row-uuid",
        externalRef: "octocat",
      });
      mockSvc.delete.mockResolvedValue(true);
      const app = createApp(boardActor);
      const res = await request(app).delete("/api/companies/company-1/github/pat");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ configured: false, removed: true });
      expect(mockSvc.delete).toHaveBeenCalledWith("company-1", GITHUB_PAT_SECRET_NAME);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          action: GITHUB_PAT_ACTIVITY_KINDS.DISCONNECTED,
          entityType: "secret",
          entityId: "secret-row-uuid",
          details: { githubUser: "octocat" },
        }),
      );
      // entityId is the UUID, NOT the literal secret name
      const logCall = mockLogActivity.mock.calls[0]![1] as { entityId: string };
      expect(logCall.entityId).not.toBe(GITHUB_PAT_SECRET_NAME);
    });

    it("returns configured=false, removed=false when no row exists + does NOT log activity + does NOT call delete", async () => {
      mockSvc.getByName.mockResolvedValue(null);
      const app = createApp(boardActor);
      const res = await request(app).delete("/api/companies/company-1/github/pat");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ configured: false, removed: false });
      expect(mockSvc.delete).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });
  });

  describe("GET /companies/:companyId/github/pat/status", () => {
    it("returns configured=true with githubUser + createdAt when configured", async () => {
      const createdAt = new Date("2026-04-22T10:00:00Z");
      mockSvc.getByName.mockResolvedValue({
        id: "secret-1",
        status: "active",
        externalRef: "octocat",
        createdAt,
      });

      const app = createApp(boardActor);
      const res = await request(app).get(
        "/api/companies/company-1/github/pat/status",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        configured: true,
        githubUser: "octocat",
        createdAt: createdAt.toISOString(),
      });
      // Ensure we never leak PAT-like fields.
      expect(res.body).not.toHaveProperty("pat");
      expect(res.body).not.toHaveProperty("value");
    });

    it("returns configured=false when not configured", async () => {
      mockSvc.getByName.mockResolvedValue(null);

      const app = createApp(boardActor);
      const res = await request(app).get(
        "/api/companies/company-1/github/pat/status",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ configured: false });
    });

    it("returns githubUser=null when externalRef is missing", async () => {
      mockSvc.getByName.mockResolvedValue({
        id: "secret-1",
        status: "active",
        externalRef: null,
        createdAt: new Date("2026-04-22T10:00:00Z"),
      });

      const app = createApp(boardActor);
      const res = await request(app).get(
        "/api/companies/company-1/github/pat/status",
      );

      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.githubUser).toBeNull();
    });

    it("returns githubUser from connect activity when stored externalRef is missing", async () => {
      mockSvc.getByName.mockResolvedValue({
        id: "secret-1",
        status: "active",
        externalRef: null,
        createdAt: new Date("2026-04-22T10:00:00Z"),
      });
      const db = createActivityDb({ githubUser: "octocat" });

      const app = createApp(boardActor, db);
      const res = await request(app).get(
        "/api/companies/company-1/github/pat/status",
      );

      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.githubUser).toBe("octocat");
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it("returns configured=false when the stored PAT row is disabled", async () => {
      mockSvc.getByName.mockResolvedValue({
        id: "secret-1",
        status: "disabled",
        externalRef: "octocat",
        createdAt: new Date("2026-04-22T10:00:00Z"),
      });

      const app = createApp(boardActor);
      const res = await request(app).get(
        "/api/companies/company-1/github/pat/status",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ configured: false });
    });
  });

  describe("authorization", () => {
    it("rejects anonymous actor with 401", async () => {
      // R9a: assertBoard returns 401 (unauthorized) for an unauthenticated actor
      // (type "none"), matching assertCompanyAccess — no ordering workaround needed.
      const app = createApp({ type: "none" });
      const res = await request(app).get(
        "/api/companies/company-1/github/pat/status",
      );

      expect(res.status).toBe(401);
    });

    it("rejects agent actor for different company with 403", async () => {
      const app = createApp({
        type: "agent",
        agentId: "a1",
        companyId: "other-company",
      });
      const res = await request(app).get(
        "/api/companies/company-1/github/pat/status",
      );

      expect(res.status).toBe(403);
    });

    it("rejects non-board actor with 403 (assertBoard throws)", async () => {
      const app = createApp({
        type: "agent",
        agentId: "a1",
        companyId: "company-1",
      });
      const res = await request(app).post(
        "/api/companies/company-1/github/pat",
      ).send({ pat: "ghp_x" });

      expect(res.status).toBe(403);
      expect(mockSvc.create).not.toHaveBeenCalled();
    });

    it("rejects board actor from different company (non-admin) with 403", async () => {
      const app = createApp({
        type: "board",
        source: "session",
        userId: "user-x",
        companyIds: ["other-company"],
        isInstanceAdmin: false,
      });
      const res = await request(app).get(
        "/api/companies/company-1/github/pat/status",
      );

      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Repo metadata routes
// ---------------------------------------------------------------------------

describe("GET /execution-workspaces/:id/github/collaborators", () => {
  const ws = {
    id: "ws-1",
    companyId: "company-1",
    repoUrl: "https://github.com/myorg/myrepo",
    branchName: "feat/task",
    metadata: {},
  };

  beforeEach(() => {
    mockWsSvc.getById.mockResolvedValue(ws);
    mockOctokit.repos.listCollaborators.mockResolvedValue({
      data: [
        { login: "alice", avatar_url: "https://avatars.githubusercontent.com/alice" },
        { login: "bob", avatar_url: "https://avatars.githubusercontent.com/bob" },
      ],
    });
  });

  it("returns collaborator list camelCased", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/collaborators");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { login: "alice", avatarUrl: "https://avatars.githubusercontent.com/alice" },
      { login: "bob", avatarUrl: "https://avatars.githubusercontent.com/bob" },
    ]);
  });

  it("returns 404 when workspace not found", async () => {
    mockWsSvc.getById.mockResolvedValue(null);
    const app = createApp(boardActor);
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/collaborators");
    expect(res.status).toBe(404);
  });

  it("returns 400 when workspace has no repoUrl", async () => {
    mockWsSvc.getById.mockResolvedValue({ ...ws, repoUrl: null });
    const app = createApp(boardActor);
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/collaborators");
    expect(res.status).toBe(400);
  });
});

describe("GET /execution-workspaces/:id/github/labels", () => {
  const ws = { id: "ws-1", companyId: "company-1", repoUrl: "https://github.com/myorg/myrepo", metadata: {} };

  beforeEach(() => {
    mockWsSvc.getById.mockResolvedValue(ws);
    mockOctokit.issues.listLabelsForRepo.mockResolvedValue({
      data: [{ id: 1, name: "bug", color: "d73a4a" }, { id: 2, name: "enhancement", color: "a2eeef" }],
    });
  });

  it("returns label list", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/labels");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 1, name: "bug", color: "d73a4a" },
      { id: 2, name: "enhancement", color: "a2eeef" },
    ]);
  });
});

describe("GET /execution-workspaces/:id/github/milestones", () => {
  const ws = { id: "ws-1", companyId: "company-1", repoUrl: "https://github.com/myorg/myrepo", metadata: {} };

  beforeEach(() => {
    mockWsSvc.getById.mockResolvedValue(ws);
    mockOctokit.issues.listMilestones.mockResolvedValue({
      data: [
        { number: 1, title: "v1.0", open_issues: 3, due_on: "2026-06-01T00:00:00Z" },
        { number: 2, title: "v1.1", open_issues: 0, due_on: null },
      ],
    });
  });

  it("returns milestone list", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/milestones");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { number: 1, title: "v1.0", openIssues: 3, dueOn: "2026-06-01T00:00:00Z" },
      { number: 2, title: "v1.1", openIssues: 0, dueOn: null },
    ]);
  });
});

describe("GET /execution-workspaces/:id/github/branches", () => {
  const ws = { id: "ws-1", companyId: "company-1", repoUrl: "https://github.com/owner/repo", metadata: {} };

  beforeEach(() => {
    mockWsSvc.getById.mockResolvedValue(ws);
    mockOctokit.repos.listBranches.mockResolvedValue({
      data: [
        { name: "main", commit: { sha: "abc123" } },
        { name: "dev", commit: { sha: "def456" } },
      ],
    });
  });

  it("returns branch list", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/branches");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { name: "main", sha: "abc123" },
      { name: "dev", sha: "def456" },
    ]);
    expect(mockOctokit.repos.listBranches).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      per_page: 100,
    });
  });

  it("returns 400 when workspace has no repoUrl", async () => {
    mockWsSvc.getById.mockResolvedValue({ ...ws, repoUrl: null });
    const app = createApp(boardActor);
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/branches");
    expect(res.status).toBe(400);
  });

  it("returns 404 when workspace not found", async () => {
    mockWsSvc.getById.mockResolvedValue(null);
    const app = createApp(boardActor);
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/branches");
    expect(res.status).toBe(404);
  });

  it("returns 412 when GitHub not configured", async () => {
    (resolveGitHubAuth as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new GitHubPrError(412, "GitHub not configured"),
    );
    const app = createApp(boardActor);
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/branches");
    expect(res.status).toBe(412);
  });

  it("forwards a non-GitHubPrError status (503) from the GitHub API", async () => {
    mockOctokit.repos.listBranches.mockRejectedValueOnce({ status: 503 });
    const app = createApp(boardActor);
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/branches");
    expect(res.status).toBe(503);
  });

  it("falls back to 502 when a generic error has no status", async () => {
    mockOctokit.repos.listBranches.mockRejectedValueOnce(new Error("x"));
    const app = createApp(boardActor);
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/branches");
    expect(res.status).toBe(502);
  });

  it("rejects a non-board actor with 403", async () => {
    const app = createApp({
      type: "agent",
      agentId: "a1",
      companyId: "company-1",
    });
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/branches");
    expect(res.status).toBe(403);
  });

  it("rejects a board actor from a different company with 403", async () => {
    const app = createApp({
      type: "board",
      source: "session",
      userId: "user-x",
      companyIds: ["other-company"],
      isInstanceAdmin: false,
    });
    const res = await request(app).get("/api/execution-workspaces/ws-1/github/branches");
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Sync route — terminal-PR preservation
// ---------------------------------------------------------------------------

describe("POST /execution-workspaces/:id/github-pr/sync", () => {
  const mergedPr = {
    url: "https://github.com/myorg/myrepo/pull/5",
    number: 5,
    state: "merged" as const,
    createdAt: "2026-01-01T00:00:00Z",
    draft: false,
  };

  beforeEach(() => {
    mockWsSvc.update.mockResolvedValue({});
  });

  it("preserves a terminal (merged) PR when the branch lookup returns no PR", async () => {
    mockWsSvc.getById.mockResolvedValue({
      id: "ws-1",
      companyId: "company-1",
      repoUrl: "https://github.com/myorg/myrepo",
      branchName: "feat/task",
      baseRef: "main",
      metadata: { pr: mergedPr },
    });
    (findPullRequestForBranch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      pr: null,
      baseRef: null,
    });

    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/github-pr/sync")
      .send({ force: true });

    expect(res.status).toBe(200);
    // Response reflects the preserved merged PR.
    expect(res.body.pr).toMatchObject({ number: 5, state: "merged" });
    // The persisted metadata still carries the merged PR (NOT deleted).
    expect(mockWsSvc.update).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          pr: expect.objectContaining({ number: 5, state: "merged" }),
        }),
      }),
    );
  });

  it("clears a non-terminal (open) PR when the branch lookup returns no PR", async () => {
    mockWsSvc.getById.mockResolvedValue({
      id: "ws-1",
      companyId: "company-1",
      repoUrl: "https://github.com/myorg/myrepo",
      branchName: "feat/task",
      baseRef: "main",
      metadata: {
        pr: {
          url: "https://github.com/myorg/myrepo/pull/9",
          number: 9,
          state: "open",
          createdAt: "2026-01-01T00:00:00Z",
          draft: false,
        },
      },
    });
    (findPullRequestForBranch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      pr: null,
      baseRef: null,
    });

    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/github-pr/sync")
      .send({ force: true });

    expect(res.status).toBe(200);
    // The open PR is cleared from the response.
    expect(res.body.pr).toBeNull();
    // And the persisted metadata no longer has a `.pr` key.
    const updateArg = mockWsSvc.update.mock.calls.at(-1)?.[1] as {
      metadata: Record<string, unknown>;
    };
    expect(updateArg.metadata).not.toHaveProperty("pr");
  });
});

// ---------------------------------------------------------------------------
// PR action routes
// ---------------------------------------------------------------------------

describe("POST /execution-workspaces/:id/github-pr/merge", () => {
  const ws = {
    id: "ws-1",
    companyId: "company-1",
    repoUrl: "https://github.com/myorg/myrepo",
    branchName: "feat/task",
    baseRef: "main",
    metadata: { pr: { url: "https://github.com/myorg/myrepo/pull/42", number: 42, state: "open", createdAt: "2026-01-01T00:00:00Z", draft: false } },
  };

  beforeEach(() => {
    mockWsSvc.getById.mockResolvedValue(ws);
    mockWsSvc.update.mockResolvedValue({ ...ws });
    mockMergeWorkspacePr.mockResolvedValue({ sha: "abc123" });
  });

  it("calls mergeWorkspacePr and returns merged state", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/github-pr/merge")
      .send({ mergeMethod: "squash" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, prState: "merged" });
    expect(mockMergeWorkspacePr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prNumber: 42, mergeMethod: "squash" }),
    );
    expect(mockWsSvc.update).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ metadata: expect.objectContaining({ pr: expect.objectContaining({ state: "merged" }) }) }),
    );
  });

  it("returns 400 when workspace has no stored PR", async () => {
    mockWsSvc.getById.mockResolvedValue({ ...ws, metadata: {} });
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/github-pr/merge")
      .send({ mergeMethod: "merge" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid merge method", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/github-pr/merge")
      .send({ mergeMethod: "octopus" });
    expect(res.status).toBe(400);
  });
});

describe("POST /execution-workspaces/:id/github-pr/close", () => {
  const ws = {
    id: "ws-1",
    companyId: "company-1",
    repoUrl: "https://github.com/myorg/myrepo",
    metadata: { pr: { url: "https://github.com/myorg/myrepo/pull/42", number: 42, state: "open", createdAt: "2026-01-01T00:00:00Z", draft: false } },
  };

  beforeEach(() => {
    mockWsSvc.getById.mockResolvedValue(ws);
    mockWsSvc.update.mockResolvedValue({});
    mockCloseWorkspacePr.mockResolvedValue(undefined);
  });

  it("closes the PR and updates metadata state", async () => {
    const app = createApp(boardActor);
    const res = await request(app).post("/api/execution-workspaces/ws-1/github-pr/close");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, prState: "closed" });
    expect(mockWsSvc.update).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ metadata: expect.objectContaining({ pr: expect.objectContaining({ state: "closed" }) }) }),
    );
  });
});

describe("POST /execution-workspaces/:id/github-pr/reopen", () => {
  const ws = {
    id: "ws-1",
    companyId: "company-1",
    repoUrl: "https://github.com/myorg/myrepo",
    metadata: { pr: { url: "https://github.com/myorg/myrepo/pull/42", number: 42, state: "closed", createdAt: "2026-01-01T00:00:00Z", draft: false } },
  };

  beforeEach(() => {
    mockWsSvc.getById.mockResolvedValue(ws);
    mockWsSvc.update.mockResolvedValue({});
    mockReopenWorkspacePr.mockResolvedValue(undefined);
  });

  it("reopens the PR and updates metadata state", async () => {
    const app = createApp(boardActor);
    const res = await request(app).post("/api/execution-workspaces/ws-1/github-pr/reopen");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, prState: "open" });
    expect(mockWsSvc.update).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ metadata: expect.objectContaining({ pr: expect.objectContaining({ state: "open" }) }) }),
    );
  });
});

describe("POST /execution-workspaces/:id/github-pr/request-review", () => {
  const ws = {
    id: "ws-1",
    companyId: "company-1",
    repoUrl: "https://github.com/myorg/myrepo",
    metadata: { pr: { url: "https://github.com/myorg/myrepo/pull/42", number: 42, state: "open", createdAt: "2026-01-01T00:00:00Z", draft: false } },
  };

  beforeEach(() => {
    mockWsSvc.getById.mockResolvedValue(ws);
    mockRequestPrReview.mockResolvedValue(undefined);
  });

  it("calls requestPrReview with given reviewers", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/github-pr/request-review")
      .send({ reviewers: ["alice", "bob"] });
    expect(res.status).toBe(200);
    expect(mockRequestPrReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reviewers: ["alice", "bob"], prNumber: 42 }),
    );
  });

  it("returns 400 when reviewers is empty", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/github-pr/request-review")
      .send({ reviewers: [] });
    expect(res.status).toBe(400);
  });
});

describe("GET /companies/:companyId/github/app/install-url", () => {
  beforeEach(() => {
    mockSignInstallState.mockClear();
  });

  it("returns the GitHub App install URL", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/github/app/install-url");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: expect.stringContaining("github.com") });
  });

  it("passes the onboarding returnTo through to signInstallState when ?return= is an allowlisted key", async () => {
    const app = createApp(boardActor);
    await request(app)
      .get("/api/companies/company-1/github/app/install-url")
      .query({ return: "integrations" });
    expect(mockSignInstallState).toHaveBeenCalledWith("company-1", { returnTo: "integrations" });
  });

  it("silently drops an unrecognized ?return= value instead of forwarding it", async () => {
    const app = createApp(boardActor);
    await request(app)
      .get("/api/companies/company-1/github/app/install-url")
      .query({ return: "javascript:alert(1)" });
    expect(mockSignInstallState).toHaveBeenCalledWith("company-1", { returnTo: undefined });
  });
});

describe("GET /api/github/callback", () => {
  const installationData = {
    installationId: "12345",
    accountLogin: "myorg",
    accountType: "Organization",
  };

  // The callback builds its redirect origin from `AOA_AUTH_PUBLIC_BASE_URL`
  // (server/src/routes/github.ts) with a `http://localhost:5173` dev fallback.
  // `config.ts` loads that var via dotenv from the running instance's
  // `~/.aoa/instances/*/​.env`, and CI bootstrap writes it too — so without
  // isolation the assertions below would pick up the ambient public origin
  // (e.g. http://127.0.0.1:3100) instead of the intended fallback and flake.
  // Mirror the hermetic pattern in cli-auth-approval-url-origin.test.ts /
  // team-resend-invite-url.test.ts: clear the public-origin env keys per test
  // so these redirect assertions exercise the deterministic dev fallback, then
  // restore whatever the ambient environment had.
  const PUBLIC_URL_ENV_KEYS = [
    "AOA_AUTH_PUBLIC_BASE_URL",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_BASE_URL",
    "AOA_PUBLIC_URL",
  ];
  const savedPublicUrlEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of PUBLIC_URL_ENV_KEYS) {
      if (savedPublicUrlEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedPublicUrlEnv[key];
    }
  });

  beforeEach(() => {
    for (const key of PUBLIC_URL_ENV_KEYS) {
      savedPublicUrlEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Clear call history so the not.toHaveBeenCalled() assertions below don't see
    // calls leaked from earlier tests in this file (no global clearAllMocks here).
    mockSaveInstallation.mockClear();
    mockSaveInstallation.mockResolvedValue({ ...installationData, id: "inst-1", companyId: "company-1" });
    // Default: a valid signed state resolves to company-1 with no returnTo.
    // Forged-state test overrides to null; returnTo test overrides per-case.
    mockVerifyInstallState.mockReturnValue({ companyId: "company-1", returnTo: null });
  });

  it("saves installation and redirects to settings when the signed state carries no returnTo", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .get("/api/github/callback")
      .query({
        installation_id: "12345",
        setup_action: "install",
        state: "company-1",
      });
    // Should redirect (302) to settings page
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/settings");
    expect(res.headers.location).toContain("tab=github");
    expect(mockSaveInstallation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyId: "company-1", installationId: "12345" }),
    );
  });

  it("redirects an onboarding returnTo to the index gate (which resumes the in-flight tail), NOT the steady /home dashboard", async () => {
    mockVerifyInstallState.mockReturnValue({ companyId: "company-1", returnTo: "integrations" });
    const app = createApp(boardActor);
    const res = await request(app)
      .get("/api/github/callback")
      .query({ installation_id: "12345", setup_action: "install", state: "signed-with-return" });
    expect(res.status).toBe(302);
    // The index gate ("/") resolves the founder's unfinished first-run company
    // and routes to /onboarding, resuming the tail at the persisted step. The
    // steady /home dashboard has no onboarding-resume consumer, so returning
    // there would strand the founder (tail abandoned, firstRunCompleted unset).
    expect(res.headers.location).toBe("http://localhost:5173/?github=connected");
    expect(res.headers.location).not.toContain("/settings");
    expect(res.headers.location).not.toContain("/home");
    // Must NOT carry the company-id URL prefix — that hit the company-prefix
    // route, which bounces an unmatched prefix and drops the query.
    expect(res.headers.location).not.toContain("company-1");
  });

  it("does NOT honor a free-form/unsigned `return` query param on the callback itself — only the signed state's returnTo is trusted", async () => {
    // The signed state (mocked) carries no returnTo, but the request also
    // includes a raw `return` query param trying to redirect to the
    // onboarding path directly. This must be ignored — proving there is no
    // open-redirect vector via an unsigned parameter.
    mockVerifyInstallState.mockReturnValue({ companyId: "company-1", returnTo: null });
    const app = createApp(boardActor);
    const res = await request(app)
      .get("/api/github/callback")
      .query({
        installation_id: "12345",
        setup_action: "install",
        state: "signed-no-return",
        return: "integrations",
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/settings");
    expect(res.headers.location).not.toContain("/home");
  });

  it("returns 400 when installation_id is missing", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .get("/api/github/callback")
      .query({ setup_action: "install", state: "company-1" });
    expect(res.status).toBe(400);
  });

  it("redirects to an invalid_state error when state is missing", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .get("/api/github/callback")
      .query({ installation_id: "12345", setup_action: "install" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("github=invalid_state");
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it("redirects to invalid_state and does NOT save when the state signature is invalid (forged)", async () => {
    mockVerifyInstallState.mockReturnValue(null);
    const app = createApp(boardActor);
    const res = await request(app)
      .get("/api/github/callback")
      .query({ installation_id: "12345", setup_action: "install", state: "forged-or-tampered" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("github=invalid_state");
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });
});

describe("DELETE /companies/:companyId/github/app", () => {
  it("removes App installation and returns success", async () => {
    mockRemoveInstallation.mockResolvedValue(undefined);
    const app = createApp(boardActor);
    const res = await request(app).delete("/api/companies/company-1/github/app");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ removed: true });
    expect(mockRemoveInstallation).toHaveBeenCalledWith(expect.anything(), "company-1");
  });
});

describe("GET /companies/:companyId/github/app/status", () => {
  it("returns installed=true with account info when installation exists", async () => {
    mockGetInstallation.mockResolvedValue({
      installationId: "12345",
      accountLogin: "myorg",
      accountType: "Organization",
      createdAt: new Date("2026-05-01"),
    });
    const app = createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/github/app/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ installed: true, accountLogin: "myorg", accountType: "Organization" });
  });

  it("returns installed=false when no installation", async () => {
    mockGetInstallation.mockResolvedValue(null);
    const app = createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/github/app/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ installed: false });
  });
});

describe("GET /companies/:companyId/github/app/repositories", () => {
  it("returns the authorized repository list", async () => {
    const repos = [
      { name: "my-repo", fullName: "acme/my-repo", private: false, url: "https://github.com/acme/my-repo" },
      { name: "secret-repo", fullName: "acme/secret-repo", private: true, url: "https://github.com/acme/secret-repo" },
    ];
    mockListInstallationRepositories.mockResolvedValue(repos);
    const app = createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/github/app/repositories");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(repos);
    expect(mockListInstallationRepositories).toHaveBeenCalledWith(expect.anything(), "company-1");
  });

  it("returns an empty array when no installation is active", async () => {
    mockListInstallationRepositories.mockResolvedValue([]);
    const app = createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/github/app/repositories");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 502 when the service throws unexpectedly", async () => {
    mockListInstallationRepositories.mockRejectedValueOnce(new Error("GitHub API unavailable"));
    const app = createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/github/app/repositories");
    expect(res.status).toBe(502);
  });

  it("forwards a GitHubPrError status (412) from the service", async () => {
    mockListInstallationRepositories.mockRejectedValueOnce(
      new GitHubPrError(412, "GitHub App not installed"),
    );
    const app = createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/github/app/repositories");
    expect(res.status).toBe(412);
  });

  it("rejects a non-board actor with 403", async () => {
    const app = createApp({
      type: "agent",
      agentId: "a1",
      companyId: "company-1",
    });
    const res = await request(app).get("/api/companies/company-1/github/app/repositories");
    expect(res.status).toBe(403);
  });

  it("rejects a board actor from a different company with 403", async () => {
    const app = createApp({
      type: "board",
      source: "session",
      userId: "user-x",
      companyIds: ["other-company"],
      isInstanceAdmin: false,
    });
    const res = await request(app).get("/api/companies/company-1/github/app/repositories");
    expect(res.status).toBe(403);
  });
});
