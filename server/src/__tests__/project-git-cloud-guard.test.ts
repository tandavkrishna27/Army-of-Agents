import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveGitRoot = vi.hoisted(() => vi.fn());
const mockGetBranches = vi.hoisted(() => vi.fn());
const mockGetCommitGraph = vi.hoisted(() => vi.fn());
vi.mock("../services/git.js", () => ({
  resolveGitRoot: mockResolveGitRoot,
  getBranches: mockGetBranches,
  getCommitGraph: mockGetCommitGraph,
}));

const mockAssertLocalWorkspaceCommandAllowed = vi.hoisted(() => vi.fn());
vi.mock("../services/local-workspace-command-guard.js", () => ({
  assertLocalWorkspaceCommandAllowed: mockAssertLocalWorkspaceCommandAllowed,
}));

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(() => ({})),
}));

vi.mock("../services/github-pr.js", () => ({
  GitHubPrError: class GitHubPrError extends Error {},
  parseGitHubRepoUrl: vi.fn(() => ({ owner: "acme", repo: "repo" })),
  resolveGitHubAuth: vi.fn(async () => "token"),
  enrichBranchPr: vi.fn(),
}));

vi.mock("../services/github-app.js", () => ({
  getInstallation: vi.fn(async () => null),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: vi.fn(() => ({ getByName: vi.fn(async () => null) })),
}));

import { projectGitRoutes } from "../routes/project-git.js";
import { enrichCache, graphCache } from "../services/project-git-cache.js";

function makeDb() {
  return {
    select: vi.fn(() => {
      const rows = [{
        cwd: "C:\\tenant-repo",
        repoUrl: "https://github.com/acme/repo",
      }];
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => Promise.resolve(rows)),
      };
      return chain;
    }),
  };
}

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "user-1" };
    next();
  });
  app.use("/api", projectGitRoutes(makeDb() as any));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  graphCache.clear();
  enrichCache.clear();
  mockAssertLocalWorkspaceCommandAllowed.mockReset();
  mockAssertLocalWorkspaceCommandAllowed.mockImplementation(() => {
    throw new Error("Refusing unsandboxed project Git command");
  });
});

describe("project Git cloud local-command refusal", () => {
  it("rejects graph generation before any local Git subprocess", async () => {
    const res = await request(makeApp())
      .get("/api/companies/company-1/projects/project-1/git/graph");

    expect(res.status).toBe(500);
    expect(mockAssertLocalWorkspaceCommandAllowed).toHaveBeenCalledWith(
      "project Git graph command",
    );
    expect(mockResolveGitRoot).not.toHaveBeenCalled();
    expect(mockGetBranches).not.toHaveBeenCalled();
    expect(mockGetCommitGraph).not.toHaveBeenCalled();
  });

  it("keeps API-only enrichment available without invoking local Git", async () => {
    const res = await request(makeApp())
      .get("/api/companies/company-1/projects/project-1/git/enrich");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasGitHubConnection: true, enrichments: [] });
    expect(mockAssertLocalWorkspaceCommandAllowed).toHaveBeenCalledWith(
      "project Git enrichment command",
    );
    expect(mockResolveGitRoot).not.toHaveBeenCalled();
    expect(mockGetBranches).not.toHaveBeenCalled();
    expect(mockGetCommitGraph).not.toHaveBeenCalled();
  });
});
