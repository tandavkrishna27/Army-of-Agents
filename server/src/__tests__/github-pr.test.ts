import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Octokit mock ----
const mockOctokit = vi.hoisted(() => ({
  users: { getAuthenticated: vi.fn() },
  pulls: {
    create: vi.fn(),
    list: vi.fn(),
    merge: vi.fn(),
    update: vi.fn(),
    requestReviewers: vi.fn(),
  },
  repos: { listCollaborators: vi.fn() },
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

// ---- service/index mock (secretService + logActivity) ----
const mockSvc = vi.hoisted(() => ({
  getByName: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  resolveSecretValue: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/index.js", () => ({
  secretService: () => mockSvc,
  logActivity: mockLogActivity,
}));

// The PR service imports `secretService` directly from ./secrets.js, not via
// services/index.js — mock that path too.
vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSvc,
}));

// ---- issueService mock ----
const mockIssueSvc = vi.hoisted(() => ({
  getById: vi.fn(),
  addComment: vi.fn(),
}));
vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueSvc,
}));

// ---- executionWorkspaceService mock ----
const mockWsSvc = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockWsSvc,
}));

const mockResolveGitRoot = vi.hoisted(() => vi.fn());
const mockRunGit = vi.hoisted(() => vi.fn());
const mockPush = vi.hoisted(() => vi.fn());
vi.mock("../services/git.js", () => ({
  resolveGitRoot: mockResolveGitRoot,
  runGit: mockRunGit,
  push: mockPush,
}));

const mockAssertLocalWorkspaceCommandAllowed = vi.hoisted(() => vi.fn());
vi.mock("../services/local-workspace-command-guard.js", () => ({
  assertLocalWorkspaceCommandAllowed: mockAssertLocalWorkspaceCommandAllowed,
}));

const mockGetInstallation = vi.hoisted(() => vi.fn());
const mockMintInstallationToken = vi.hoisted(() => vi.fn());
vi.mock("../services/github-app.js", () => ({
  getInstallation: mockGetInstallation,
  mintInstallationToken: mockMintInstallationToken,
}));

import { errorHandler } from "../middleware/index.js";
import { GITHUB_PAT_ACTIVITY_KINDS, GITHUB_PAT_SECRET_NAME } from "@armyofagents/shared";
import { githubRoutes } from "../routes/github.js";
import {
  GitHubPrError,
  createPullRequest,
  findPullRequestForBranch,
  parseGitHubRepoUrl,
  mergeWorkspacePr,
  closeWorkspacePr,
  reopenWorkspacePr,
  requestPrReview,
  resolveGitHubAuth,
} from "../services/github-pr.js";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", githubRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  source: "local_implicit",
  userId: "board-user",
  companyIds: null,
  isInstanceAdmin: true,
};

// -----------------------------------------------------------------------------
// Unit tests: parseGitHubRepoUrl
// -----------------------------------------------------------------------------

describe("parseGitHubRepoUrl", () => {
  it("parses https without .git", () => {
    expect(parseGitHubRepoUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses https with .git suffix", () => {
    expect(parseGitHubRepoUrl("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses https with trailing slash", () => {
    expect(parseGitHubRepoUrl("https://github.com/owner/repo/")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses ssh with .git suffix", () => {
    expect(parseGitHubRepoUrl("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses ssh without .git", () => {
    expect(parseGitHubRepoUrl("git@github.com:owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("throws GitHubPrError on non-GitHub URL", () => {
    try {
      parseGitHubRepoUrl("https://gitlab.com/owner/repo");
      throw new Error("expected parseGitHubRepoUrl to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubPrError);
      expect((err as GitHubPrError).status).toBe(400);
    }
  });
});

// -----------------------------------------------------------------------------
// Unit tests: createPullRequest service
// -----------------------------------------------------------------------------

describe("createPullRequest service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertLocalWorkspaceCommandAllowed.mockReset();
    mockResolveGitRoot.mockResolvedValue(null);
    mockRunGit.mockResolvedValue("");
    mockPush.mockResolvedValue({ pushed: true, remote: "origin", branch: "feature/x" });
    mockAssertLocalWorkspaceCommandAllowed.mockReturnValue(undefined);
  });

  const baseArgs = {
    companyId: "company-1",
    repoUrl: "https://github.com/owner/repo",
    base: "main",
    head: "feature/x",
    title: "Add feature",
    body: "Body",
    draft: false,
  };

  it("throws 412 when no PAT configured (with scopeHint)", async () => {
    mockSvc.getByName.mockResolvedValue(null);

    await expect(createPullRequest({} as any, baseArgs)).rejects.toMatchObject({
      status: 412,
      scopeHint: expect.stringContaining("Settings"),
    });
  });

  it("returns {url, number, state: 'open', draft} on success", async () => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_valid");
    mockOctokit.pulls.create.mockResolvedValue({
      data: {
        html_url: "https://github.com/owner/repo/pull/42",
        number: 42,
        state: "open",
        draft: false,
      },
    });

    const pr = await createPullRequest({} as any, baseArgs);

    expect(pr).toEqual({
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      state: "open",
      draft: false,
    });
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      base: "main",
      head: "feature/x",
      title: "Add feature",
      body: "Body",
      draft: false,
    });
  });

  it("maps Octokit 401 to GitHubPrError 401 with hint", async () => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_invalid");
    mockOctokit.pulls.create.mockRejectedValue({ status: 401 });

    try {
      await createPullRequest({} as any, baseArgs);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubPrError);
      expect((err as GitHubPrError).status).toBe(401);
      expect((err as GitHubPrError).scopeHint?.toLowerCase()).toContain("reconnect");
    }
  });

  it("maps Octokit 403 to GitHubPrError 403 with scope hint", async () => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_limited");
    mockOctokit.pulls.create.mockRejectedValue({ status: 403 });

    try {
      await createPullRequest({} as any, baseArgs);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubPrError);
      expect((err as GitHubPrError).status).toBe(403);
      expect((err as GitHubPrError).scopeHint).toContain("pull_requests");
    }
  });

  it("maps Octokit 404 to 'Repository not found: owner/repo'", async () => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_valid");
    mockOctokit.pulls.create.mockRejectedValue({ status: 404 });

    await expect(createPullRequest({} as any, baseArgs)).rejects.toMatchObject({
      status: 404,
      message: "Repository not found: owner/repo",
    });
  });

  it("maps Octokit 422 to message from response.data.message", async () => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_valid");
    mockOctokit.pulls.create.mockRejectedValue({
      status: 422,
      response: { data: { message: "No commits between main and feature/x" } },
    });

    await expect(createPullRequest({} as any, baseArgs)).rejects.toMatchObject({
      status: 422,
      message: "No commits between main and feature/x",
    });
  });
});

// -----------------------------------------------------------------------------
// Unit tests: createPullRequest — with reviewers/labels/milestone
// -----------------------------------------------------------------------------

describe("createPullRequest — with reviewers/labels/milestone", () => {
  const baseArgs = {
    companyId: "company-1",
    repoUrl: "https://github.com/myorg/myrepo",
    base: "main",
    head: "feat/my-task",
    title: "My PR",
    body: "description",
    draft: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.getByName.mockResolvedValue({ id: "secret-1", externalRef: "octocat" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_validtoken");
    mockOctokit.pulls.create.mockResolvedValue({
      data: { html_url: "https://github.com/myorg/myrepo/pull/42", number: 42, state: "open", draft: false },
    });
    mockOctokit.pulls.requestReviewers.mockResolvedValue({ data: {} });
    mockOctokit.issues.addLabels.mockResolvedValue({ data: [] });
    mockOctokit.issues.update.mockResolvedValue({ data: {} });
  });

  it("calls requestReviewers when reviewers provided", async () => {
    await createPullRequest({} as any, { ...baseArgs, reviewers: ["alice", "bob"] });
    expect(mockOctokit.pulls.requestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: ["alice", "bob"], pull_number: 42 }),
    );
  });

  it("does NOT call requestReviewers when reviewers is empty", async () => {
    await createPullRequest({} as any, { ...baseArgs, reviewers: [] });
    expect(mockOctokit.pulls.requestReviewers).not.toHaveBeenCalled();
  });

  it("calls issues.addLabels when labels provided", async () => {
    await createPullRequest({} as any, { ...baseArgs, labels: ["bug", "priority:high"] });
    expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["bug", "priority:high"], issue_number: 42 }),
    );
  });

  it("calls issues.update with milestone when milestoneNumber provided", async () => {
    await createPullRequest({} as any, { ...baseArgs, milestoneNumber: 3 });
    expect(mockOctokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ milestone: 3, issue_number: 42 }),
    );
  });

  it("does not call addLabels or milestone update when not provided", async () => {
    await createPullRequest({} as any, baseArgs);
    expect(mockOctokit.issues.addLabels).not.toHaveBeenCalled();
    expect(mockOctokit.issues.update).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Unit tests: findPullRequestForBranch service
// -----------------------------------------------------------------------------

describe("findPullRequestForBranch service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseArgs = {
    companyId: "company-1",
    repoUrl: "https://github.com/owner/repo",
    branchName: "feature/x",
  };

  it("finds an open PR for the workspace branch and returns its base ref", async () => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_valid");
    mockOctokit.pulls.list.mockResolvedValue({
      data: [
        {
          html_url: "https://github.com/owner/repo/pull/42",
          number: 42,
          state: "open",
          draft: false,
          merged_at: null,
          head: { ref: "feature/x" },
          base: { ref: "main" },
        },
      ],
    });

    const result = await findPullRequestForBranch({} as any, baseArgs);

    expect(result).toEqual({
      pr: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        state: "open",
        draft: false,
        createdAt: expect.any(String),
      },
      baseRef: "main",
    });
    expect(mockOctokit.pulls.list).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      state: "all",
      head: "owner:feature/x",
      per_page: 10,
      sort: "updated",
      direction: "desc",
    });
  });

  it("maps a closed PR with merged_at to merged", async () => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_valid");
    mockOctokit.pulls.list.mockResolvedValue({
      data: [
        {
          html_url: "https://github.com/owner/repo/pull/43",
          number: 43,
          state: "closed",
          draft: false,
          merged_at: "2026-05-16T08:00:00.000Z",
          head: { ref: "feature/x" },
          base: { ref: "main" },
        },
      ],
    });

    const result = await findPullRequestForBranch({} as any, baseArgs);

    expect(result.pr?.state).toBe("merged");
    expect(result.baseRef).toBe("main");
  });

  it("returns null metadata when GitHub has no PR for the branch", async () => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_valid");
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });

    await expect(findPullRequestForBranch({} as any, baseArgs)).resolves.toEqual({
      pr: null,
      baseRef: null,
    });
  });
});

// -----------------------------------------------------------------------------
// Route tests: POST /issues/:issueId/github-pr
// -----------------------------------------------------------------------------

describe("POST /issues/:issueId/github-pr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveGitRoot.mockResolvedValue(null);
    mockRunGit.mockResolvedValue("");
    mockPush.mockResolvedValue({ pushed: true, remote: "origin", branch: "feature/x" });
  });

  const happyIssue = {
    id: "issue-1",
    companyId: "company-1",
    title: "Add feature",
    description: "Issue description",
  };
  const happyWs = {
    id: "ws-1",
    companyId: "company-1",
    repoUrl: "https://github.com/acme/repo",
    branchName: "feature/x",
    metadata: null,
  };
  const validBody = {
    workspaceId: "11111111-1111-1111-1111-111111111111",
    title: "Add feature",
    body: "Body",
    base: "main",
    draft: false,
  };

  function mockHappyPath() {
    mockIssueSvc.getById.mockResolvedValue(happyIssue);
    mockWsSvc.getById.mockResolvedValue(happyWs);
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_valid");
    mockOctokit.pulls.create.mockResolvedValue({
      data: {
        html_url: "https://github.com/acme/repo/pull/42",
        number: 42,
        state: "open",
        draft: false,
      },
    });
    mockWsSvc.update.mockResolvedValue(happyWs);
    mockIssueSvc.addComment.mockResolvedValue({ id: "comment-1" });
  }

  it("happy path: 200 + persists workspace.metadata.pr + comments + logs activity", async () => {
    mockHappyPath();

    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "https://github.com/acme/repo/pull/42",
      number: 42,
      state: "open",
      draft: false,
    });

    // metadata.pr persisted
    expect(mockWsSvc.update).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          pr: expect.objectContaining({
            url: "https://github.com/acme/repo/pull/42",
            number: 42,
            state: "open",
            draft: false,
            createdAt: expect.any(String),
          }),
        }),
      }),
    );

    // comment posted
    expect(mockIssueSvc.addComment).toHaveBeenCalledWith(
      "issue-1",
      "Pull request created: https://github.com/acme/repo/pull/42",
      expect.objectContaining({ userId: "board-user" }),
    );

    // activity log
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: GITHUB_PAT_ACTIVITY_KINDS.PR_CREATED,
        entityType: "issue",
        entityId: "issue-1",
        details: expect.objectContaining({
          prUrl: "https://github.com/acme/repo/pull/42",
          prNumber: 42,
          workspaceId: "ws-1",
          draft: false,
        }),
      }),
    );
  });

  it("returns 404 when issue not found", async () => {
    mockIssueSvc.getById.mockResolvedValue(null);
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send(validBody);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
  });

  it("returns 404 when workspace not found", async () => {
    mockIssueSvc.getById.mockResolvedValue(happyIssue);
    mockWsSvc.getById.mockResolvedValue(null);
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send(validBody);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Workspace not found" });
  });

  it("returns 403 when workspace belongs to a different company than the issue", async () => {
    mockIssueSvc.getById.mockResolvedValue(happyIssue);
    mockWsSvc.getById.mockResolvedValue({ ...happyWs, companyId: "other-company" });
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send(validBody);
    expect(res.status).toBe(403);
  });

  it("returns 400 when workspace has no repoUrl", async () => {
    mockIssueSvc.getById.mockResolvedValue(happyIssue);
    mockWsSvc.getById.mockResolvedValue({ ...happyWs, repoUrl: null });
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send(validBody);
    expect(res.status).toBe(400);
  });

  it("returns 400 when workspace has no branchName and no head override", async () => {
    mockIssueSvc.getById.mockResolvedValue(happyIssue);
    mockWsSvc.getById.mockResolvedValue({ ...happyWs, branchName: null });
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send(validBody);
    expect(res.status).toBe(400);
  });

  it("uses head override when workspace.branchName is null", async () => {
    mockHappyPath();
    mockWsSvc.getById.mockResolvedValue({ ...happyWs, branchName: null });
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send({ ...validBody, head: "feature/from-client" });

    expect(res.status).toBe(200);
    // Verify Octokit was called with the client-provided head
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ head: "feature/from-client" }),
    );
  });

  it("cloud refusal skips all local Git while preserving API-only PR creation", async () => {
    mockHappyPath();
    mockWsSvc.getById.mockResolvedValue({ ...happyWs, cwd: "C:\\repo" });
    mockAssertLocalWorkspaceCommandAllowed.mockImplementationOnce(() => {
      throw new Error("Refusing unsandboxed workspace Git command");
    });

    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(mockAssertLocalWorkspaceCommandAllowed).toHaveBeenCalledTimes(1);
    expect(mockResolveGitRoot).not.toHaveBeenCalled();
    expect(mockRunGit).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ head: "feature/x" }),
    );
  });

  it("adds origin from workspace repoUrl before auto-pushing when local worktree has no remote", async () => {
    mockHappyPath();
    mockWsSvc.getById.mockResolvedValue({
      ...happyWs,
      cwd: "C:\\repo",
    });
    mockResolveGitRoot.mockResolvedValue("C:\\repo");
    mockRunGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        throw new Error("No such remote 'origin'");
      }
      if (args[0] === "remote" && args[1] === "add") {
        return "";
      }
      if (args[0] === "rev-parse") {
        throw new Error("no upstream configured");
      }
      return "";
    });

    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(mockRunGit).toHaveBeenCalledWith(
      ["remote", "add", "origin", "https://github.com/acme/repo"],
      "C:\\repo",
      { timeout: 5_000 },
    );
    expect(mockPush).toHaveBeenCalledWith(
      "C:\\repo",
      "origin",
      "feature/x",
      { pat: "ghp_valid" },
    );
  });

  it("returns 400 when body is missing title (zod fail)", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send({ ...validBody, title: "" });
    expect(res.status).toBe(400);
  });

  it("rejects non-board actor (assertBoard throws 403)", async () => {
    const app = createApp({
      type: "agent",
      agentId: "a1",
      companyId: "company-1",
    });
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send(validBody);
    expect(res.status).toBe(403);
  });

  it("rejects board actor from a different company (assertCompanyAccess throws 403)", async () => {
    mockIssueSvc.getById.mockResolvedValue(happyIssue);
    const app = createApp({
      type: "board",
      source: "session",
      userId: "user-x",
      companyIds: ["other-company"],
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send(validBody);
    expect(res.status).toBe(403);
  });

  it("surfaces 412 when PAT not configured", async () => {
    mockIssueSvc.getById.mockResolvedValue(happyIssue);
    mockWsSvc.getById.mockResolvedValue(happyWs);
    mockSvc.getByName.mockResolvedValue(null);
    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send(validBody);
    expect(res.status).toBe(412);
    expect(res.body.error).toContain("not configured");
    expect(res.body.hint).toContain("Settings");
  });

  it("forwards reviewers, labels, and milestoneNumber to createPullRequest", async () => {
    mockHappyPath();
    mockOctokit.pulls.requestReviewers.mockResolvedValue({ data: {} });
    mockOctokit.issues.addLabels.mockResolvedValue({ data: [] });
    mockOctokit.issues.update.mockResolvedValue({ data: {} });

    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/issues/issue-1/github-pr")
      .send({ ...validBody, reviewers: ["alice"], labels: ["bug"], milestoneNumber: 2 });

    expect(res.status).toBe(200);
    // reviewers forwarded → requestReviewers called by the service
    expect(mockOctokit.pulls.requestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: ["alice"] }),
    );
    // labels forwarded → addLabels called by the service
    expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["bug"] }),
    );
    // milestoneNumber forwarded → issues.update called by the service
    expect(mockOctokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ milestone: 2 }),
    );
  });
});

// -----------------------------------------------------------------------------
// Route tests: POST /execution-workspaces/:id/github-pr/sync
// -----------------------------------------------------------------------------

describe("POST /execution-workspaces/:id/github-pr/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const workspace = {
    id: "11111111-1111-1111-1111-111111111111",
    companyId: "company-1",
    repoUrl: "https://github.com/owner/repo",
    branchName: "feature/x",
    baseRef: null,
    metadata: null,
  };

  it("persists the existing GitHub PR, sync timestamp, and discovered base branch", async () => {
    mockWsSvc.getById.mockResolvedValue(workspace);
    mockWsSvc.update.mockResolvedValue(workspace);
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_valid");
    mockOctokit.pulls.list.mockResolvedValue({
      data: [
        {
          html_url: "https://github.com/owner/repo/pull/42",
          number: 42,
          state: "open",
          draft: false,
          merged_at: null,
          head: { ref: "feature/x" },
          base: { ref: "main" },
        },
      ],
    });

    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/execution-workspaces/11111111-1111-1111-1111-111111111111/github-pr/sync")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workspaceId: workspace.id,
      repoUrl: workspace.repoUrl,
      branchName: workspace.branchName,
      baseRef: "main",
      pr: expect.objectContaining({
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        state: "open",
        draft: false,
      }),
      githubLastSyncedAt: expect.any(String),
      githubSyncError: null,
      cached: false,
    });
    expect(mockWsSvc.update).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        baseRef: "main",
        metadata: expect.objectContaining({
          githubLastSyncedAt: expect.any(String),
          githubSyncError: null,
          noPrFound: false,
          pr: expect.objectContaining({
            url: "https://github.com/owner/repo/pull/42",
            number: 42,
          }),
        }),
      }),
    );
  });

  it("uses cached workspace metadata when recently synced and force is false", async () => {
    const syncedAt = new Date().toISOString();
    mockWsSvc.getById.mockResolvedValue({
      ...workspace,
      baseRef: "main",
      metadata: {
        githubLastSyncedAt: syncedAt,
        githubSyncError: null,
        noPrFound: false,
        pr: {
          url: "https://github.com/owner/repo/pull/42",
          number: 42,
          state: "open",
          draft: false,
          createdAt: syncedAt,
        },
      },
    });

    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/execution-workspaces/11111111-1111-1111-1111-111111111111/github-pr/sync")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(mockOctokit.pulls.list).not.toHaveBeenCalled();
    expect(mockWsSvc.update).not.toHaveBeenCalled();
  });

  it("records noPrFound and clears stale PR metadata when no PR exists", async () => {
    mockWsSvc.getById.mockResolvedValue({
      ...workspace,
      baseRef: "main",
      metadata: {
        pr: {
          url: "https://github.com/owner/repo/pull/1",
          number: 1,
          state: "open",
          draft: false,
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      },
    });
    mockWsSvc.update.mockResolvedValue(workspace);
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_valid");
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });

    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/execution-workspaces/11111111-1111-1111-1111-111111111111/github-pr/sync")
      .send({ force: true });

    expect(res.status).toBe(200);
    expect(res.body.pr).toBeNull();
    const updatePayload = mockWsSvc.update.mock.calls[0]![1] as { metadata: Record<string, unknown> };
    expect(updatePayload.metadata.noPrFound).toBe(true);
    expect(updatePayload.metadata.githubSyncError).toBeNull();
    expect(updatePayload.metadata).not.toHaveProperty("pr");
  });

  it("persists githubSyncError metadata when GitHub lookup fails", async () => {
    mockWsSvc.getById.mockResolvedValue(workspace);
    mockWsSvc.update.mockResolvedValue(workspace);
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_valid");
    mockOctokit.pulls.list.mockRejectedValue({ status: 500 });

    const app = createApp(boardActor);
    const res = await request(app)
      .post("/api/execution-workspaces/11111111-1111-1111-1111-111111111111/github-pr/sync")
      .send({ force: true });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("GitHub API error");
    expect(mockWsSvc.update).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        metadata: expect.objectContaining({
          githubLastSyncedAt: expect.any(String),
          githubSyncError: "GitHub API error",
        }),
      }),
    );
  });
});

// -----------------------------------------------------------------------------
// Task 11 follow-up: DELETE route logs entityId as UUID, not the string
// name.
// -----------------------------------------------------------------------------

describe("Task 11 follow-up: DELETE /companies/:companyId/github/pat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs activity with entityId = secret row UUID (not the 'github_pat' literal)", async () => {
    mockSvc.getByName.mockResolvedValue({
      id: "uuid-row-123",
      externalRef: "octocat",
    });
    mockSvc.delete.mockResolvedValue(true);
    const app = createApp(boardActor);

    const res = await request(app).delete("/api/companies/company-1/github/pat");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, removed: true });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: GITHUB_PAT_ACTIVITY_KINDS.DISCONNECTED,
        entityType: "secret",
        entityId: "uuid-row-123",
        details: expect.objectContaining({ githubUser: "octocat" }),
      }),
    );
    // Safety: entityId MUST NOT be the literal secret name
    const logCall = mockLogActivity.mock.calls[0]![1] as { entityId: string };
    expect(logCall.entityId).not.toBe(GITHUB_PAT_SECRET_NAME);
  });

  it("returns removed=false + does NOT log activity when no row existed", async () => {
    mockSvc.getByName.mockResolvedValue(null);
    const app = createApp(boardActor);

    const res = await request(app).delete("/api/companies/company-1/github/pat");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, removed: false });
    expect(mockSvc.delete).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Unit tests: mergeWorkspacePr
// -----------------------------------------------------------------------------

describe("mergeWorkspacePr", () => {
  beforeEach(() => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_validtoken");
    mockOctokit.pulls.merge.mockResolvedValue({
      data: { merged: true, sha: "abc123", message: "Pull Request successfully merged" },
    });
    mockOctokit.pulls.list.mockResolvedValue({
      data: [{ number: 42, html_url: "https://github.com/myorg/myrepo/pull/42" }],
    });
  });

  it("calls pulls.merge with squash method", async () => {
    await mergeWorkspacePr({} as any, {
      companyId: "company-1",
      repoUrl: "https://github.com/myorg/myrepo",
      prNumber: 42,
      mergeMethod: "squash",
    });
    expect(mockOctokit.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, merge_method: "squash", owner: "myorg", repo: "myrepo" }),
    );
  });

  it("throws GitHubPrError 412 when PAT not configured", async () => {
    mockSvc.getByName.mockResolvedValue(null);
    await expect(
      mergeWorkspacePr({} as any, {
        companyId: "company-1",
        repoUrl: "https://github.com/myorg/myrepo",
        prNumber: 42,
        mergeMethod: "merge",
      }),
    ).rejects.toMatchObject({ status: 412 });
  });
});

// -----------------------------------------------------------------------------
// Unit tests: closeWorkspacePr
// -----------------------------------------------------------------------------

describe("closeWorkspacePr", () => {
  beforeEach(() => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_validtoken");
    mockOctokit.pulls.update.mockResolvedValue({
      data: { number: 42, state: "closed", html_url: "https://github.com/myorg/myrepo/pull/42" },
    });
  });

  it("calls pulls.update with state=closed", async () => {
    await closeWorkspacePr({} as any, {
      companyId: "company-1",
      repoUrl: "https://github.com/myorg/myrepo",
      prNumber: 42,
    });
    expect(mockOctokit.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, state: "closed" }),
    );
  });
});

// -----------------------------------------------------------------------------
// Unit tests: reopenWorkspacePr
// -----------------------------------------------------------------------------

describe("reopenWorkspacePr", () => {
  beforeEach(() => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_validtoken");
    mockOctokit.pulls.update.mockResolvedValue({
      data: { number: 42, state: "open", html_url: "https://github.com/myorg/myrepo/pull/42" },
    });
  });

  it("calls pulls.update with state=open", async () => {
    await reopenWorkspacePr({} as any, {
      companyId: "company-1",
      repoUrl: "https://github.com/myorg/myrepo",
      prNumber: 42,
    });
    expect(mockOctokit.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, state: "open" }),
    );
  });
});

// -----------------------------------------------------------------------------
// Unit tests: requestPrReview
// -----------------------------------------------------------------------------

describe("requestPrReview", () => {
  beforeEach(() => {
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_validtoken");
    mockOctokit.pulls.requestReviewers.mockResolvedValue({ data: {} });
  });

  it("calls pulls.requestReviewers with the given logins", async () => {
    await requestPrReview({} as any, {
      companyId: "company-1",
      repoUrl: "https://github.com/myorg/myrepo",
      prNumber: 42,
      reviewers: ["alice", "bob"],
    });
    expect(mockOctokit.pulls.requestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, reviewers: ["alice", "bob"] }),
    );
  });
});

// -----------------------------------------------------------------------------
// Unit tests: resolveGitHubAuth — prefers App installation over PAT
// -----------------------------------------------------------------------------

describe("resolveGitHubAuth — prefers App installation over PAT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns installation token when App installation exists", async () => {
    mockGetInstallation.mockResolvedValue({ installationId: "12345", accountLogin: "myorg" });
    mockMintInstallationToken.mockResolvedValue("ghs_installation_token");

    const token = await resolveGitHubAuth({} as any, "company-1", "user-1");
    expect(token).toBe("ghs_installation_token");
    expect(mockMintInstallationToken).toHaveBeenCalledWith("12345");
    // PAT should NOT be fetched when App installation exists
    expect(mockSvc.getByName).not.toHaveBeenCalled();
  });

  it("falls back to PAT when no App installation", async () => {
    mockGetInstallation.mockResolvedValue(null);
    mockSvc.getByName.mockResolvedValue({ id: "secret-1" });
    mockSvc.resolveSecretValue.mockResolvedValue("ghp_pat_token");

    const token = await resolveGitHubAuth({} as any, "company-1", "user-1");
    expect(token).toBe("ghp_pat_token");
    expect(mockSvc.getByName).toHaveBeenCalled();
  });

  it("throws 412 when neither App installation nor PAT is configured", async () => {
    mockGetInstallation.mockResolvedValue(null);
    mockSvc.getByName.mockResolvedValue(null);

    await expect(resolveGitHubAuth({} as any, "company-1", "user-1")).rejects.toMatchObject({
      status: 412,
    });
  });
});
