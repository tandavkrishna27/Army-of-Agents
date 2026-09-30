/**
 * API route tests for workspace-git.ts endpoints.
 *
 * Uses vi.mock to stub services and git operations,
 * supertest for HTTP-level assertions.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock git.ts service functions ----
const mockGetStatus = vi.hoisted(() => vi.fn());
const mockGetLog = vi.hoisted(() => vi.fn());
const mockCommit = vi.hoisted(() => vi.fn());
const mockPush = vi.hoisted(() => vi.fn());
const mockResolveGitRoot = vi.hoisted(() => vi.fn());
const mockGetCachedStatus = vi.hoisted(() => vi.fn());
const mockSetCachedStatus = vi.hoisted(() => vi.fn());
const mockInvalidateStatusCache = vi.hoisted(() => vi.fn());

vi.mock("../services/git.js", () => ({
  getStatus: mockGetStatus,
  getLog: mockGetLog,
  commit: mockCommit,
  push: mockPush,
  resolveGitRoot: mockResolveGitRoot,
  getCachedStatus: mockGetCachedStatus,
  setCachedStatus: mockSetCachedStatus,
  invalidateStatusCache: mockInvalidateStatusCache,
}));

// ---- Mock executionWorkspaceService ----
const mockWsSvc = vi.hoisted(() => ({
  getById: vi.fn(),
}));
vi.mock("../services/index.js", () => ({
  executionWorkspaceService: () => mockWsSvc,
  secretService: () => ({
    getByName: vi.fn().mockResolvedValue(null),
    resolveSecretValue: vi.fn(),
  }),
}));

// ---- Mock workspace-authz ----
vi.mock("../services/workspace-authz.js", () => ({
  assertCanControlWorkspace: vi.fn(),
}));

const mockAssertLocalWorkspaceCommandAllowed = vi.hoisted(() => vi.fn());
vi.mock("../services/local-workspace-command-guard.js", () => ({
  assertLocalWorkspaceCommandAllowed: mockAssertLocalWorkspaceCommandAllowed,
}));

// ---- Mock authz (assertCompanyAccess) ----
vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
}));

import { errorHandler } from "../middleware/index.js";
import { workspaceGitRoutes } from "../routes/workspace-git.js";

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function createApp(actor: unknown = boardActor, db: unknown = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", workspaceGitRoutes(db as any));
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

const mockWorkspace = {
  id: "ws-1",
  companyId: "company-1",
  projectId: "project-1",
  cwd: "/tmp/test-workspace",
  branchName: "feature/test",
  providerType: "local_fs",
  repoUrl: null,
  baseRef: "main",
  status: "active",
  metadata: {},
};

function createSequenceDb(rows: unknown[][]) {
  const select = vi.fn(() => {
    const result = rows.shift() ?? [];
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(result)),
      orderBy: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  });
  return { select };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertLocalWorkspaceCommandAllowed.mockReset();
  mockWsSvc.getById.mockResolvedValue(mockWorkspace);
  mockResolveGitRoot.mockResolvedValue("/tmp/test-workspace");
  mockGetCachedStatus.mockReturnValue(null);
  mockAssertLocalWorkspaceCommandAllowed.mockReturnValue(undefined);
});

describe("cloud local-Git refusal chokepoint", () => {
  it("rejects status, log, commit, and push before resolving or invoking Git", async () => {
    mockAssertLocalWorkspaceCommandAllowed.mockImplementation(() => {
      throw new Error("Refusing unsandboxed workspace Git command");
    });
    const app = createApp();

    const responses = await Promise.all([
      request(app).get("/api/execution-workspaces/ws-1/git/status"),
      request(app).get("/api/execution-workspaces/ws-1/git/log"),
      request(app)
        .post("/api/execution-workspaces/ws-1/git/commit")
        .send({ message: "safe message", files: ["file.txt"] }),
      request(app)
        .post("/api/execution-workspaces/ws-1/git/push")
        .send({ remote: "origin", branch: "main" }),
    ]);

    expect(responses.map((res) => res.status)).toEqual([500, 500, 500, 500]);
    expect(mockAssertLocalWorkspaceCommandAllowed).toHaveBeenCalledTimes(4);
    expect(mockResolveGitRoot).not.toHaveBeenCalled();
    expect(mockGetStatus).not.toHaveBeenCalled();
    expect(mockGetLog).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /execution-workspaces/:id/git/status
// ---------------------------------------------------------------------------

describe("GET /execution-workspaces/:id/git/status", () => {
  it("returns live git status when no cache", async () => {
    const statusResult = {
      branch: "main",
      detachedHead: false,
      remote: null,
      ahead: null,
      behind: null,
      files: [],
      clean: true,
    };
    mockGetStatus.mockResolvedValue(statusResult);

    const app = createApp();
    const res = await request(app).get("/api/execution-workspaces/ws-1/git/status");

    expect(res.status).toBe(200);
    expect(res.body.gitAvailable).toBe(true);
    expect(res.body.branch).toBe("main");
    expect(res.body.clean).toBe(true);
    expect(mockSetCachedStatus).toHaveBeenCalledWith("ws-1", statusResult);
  });

  it("returns cached status when available", async () => {
    const cachedResult = {
      branch: "cached-branch",
      detachedHead: false,
      remote: null,
      ahead: null,
      behind: null,
      files: [],
      clean: true,
    };
    mockGetCachedStatus.mockReturnValue(cachedResult);

    const app = createApp();
    const res = await request(app).get("/api/execution-workspaces/ws-1/git/status");

    expect(res.status).toBe(200);
    expect(res.body.branch).toBe("cached-branch");
    // getStatus should not be called when cache hit
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown workspace", async () => {
    mockWsSvc.getById.mockResolvedValue(null);

    const app = createApp();
    const res = await request(app).get("/api/execution-workspaces/unknown/git/status");

    expect(res.status).toBe(404);
  });

  it("returns gitAvailable=false when no cwd", async () => {
    mockWsSvc.getById.mockResolvedValue({ ...mockWorkspace, cwd: null });

    const app = createApp();
    const res = await request(app).get("/api/execution-workspaces/ws-1/git/status");

    expect(res.status).toBe(200);
    expect(res.body.gitAvailable).toBe(false);
  });

  it("returns gitAvailable=false when not a git repo", async () => {
    mockResolveGitRoot.mockResolvedValue(null);

    const app = createApp();
    const res = await request(app).get("/api/execution-workspaces/ws-1/git/status");

    expect(res.status).toBe(200);
    expect(res.body.gitAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /execution-workspaces/:id/git/log
// ---------------------------------------------------------------------------

describe("GET /execution-workspaces/:id/git/log", () => {
  it("returns log entries with default limit", async () => {
    const logEntries = [
      { hash: "abc", shortHash: "abc", message: "test", author: "A", timestamp: "2026-01-01" },
    ];
    mockGetLog.mockResolvedValue(logEntries);

    const app = createApp();
    const res = await request(app).get("/api/execution-workspaces/ws-1/git/log");

    expect(res.status).toBe(200);
    expect(res.body.gitAvailable).toBe(true);
    expect(res.body.entries).toHaveLength(1);
    expect(mockGetLog).toHaveBeenCalledWith("/tmp/test-workspace", 5);
  });

  it("respects limit query parameter", async () => {
    mockGetLog.mockResolvedValue([]);

    const app = createApp();
    const res = await request(app).get("/api/execution-workspaces/ws-1/git/log?limit=10");

    expect(res.status).toBe(200);
    expect(mockGetLog).toHaveBeenCalledWith("/tmp/test-workspace", 10);
  });

  it("clamps limit to 50", async () => {
    mockGetLog.mockResolvedValue([]);

    const app = createApp();
    await request(app).get("/api/execution-workspaces/ws-1/git/log?limit=100");

    expect(mockGetLog).toHaveBeenCalledWith("/tmp/test-workspace", 50);
  });
});

// ---------------------------------------------------------------------------
// POST /execution-workspaces/:id/git/commit
// ---------------------------------------------------------------------------

describe("POST /execution-workspaces/:id/git/commit", () => {
  it("commits with valid message and files", async () => {
    const commitResult = {
      hash: "abc123",
      message: "test commit",
      filesCommitted: ["file.txt"],
      skippedFiles: [],
    };
    mockCommit.mockResolvedValue(commitResult);

    const app = createApp();
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/git/commit")
      .send({ message: "test commit", files: ["file.txt"] });

    expect(res.status).toBe(200);
    expect(res.body.hash).toBe("abc123");
    expect(mockInvalidateStatusCache).toHaveBeenCalledWith("ws-1");
  });

  it("rejects missing message", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/git/commit")
      .send({ files: ["file.txt"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
  });

  it("rejects empty files array", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/git/commit")
      .send({ message: "msg", files: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/files/i);
  });

  it("returns 400 for path traversal errors", async () => {
    mockCommit.mockRejectedValue(new Error('Invalid file path: "../etc/passwd" escapes the repository root'));

    const app = createApp();
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/git/commit")
      .send({ message: "hack", files: ["../etc/passwd"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/escapes/);
  });

  it("returns 400 for repository-root pathspec errors", async () => {
    mockCommit.mockRejectedValue(new Error('Invalid file path: "." targets the repository root'));

    const app = createApp();
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/git/commit")
      .send({ message: "root", files: ["."] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/repository root/);
  });

  it("returns 400 for detached HEAD", async () => {
    mockCommit.mockRejectedValue(new Error("Cannot commit in detached HEAD state"));

    const app = createApp();
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/git/commit")
      .send({ message: "msg", files: ["file.txt"] });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /execution-workspaces/:id/git/push
// ---------------------------------------------------------------------------

describe("POST /execution-workspaces/:id/git/push", () => {
  it("pushes successfully", async () => {
    const pushResult = { pushed: true, remote: "origin", branch: "main" };
    mockPush.mockResolvedValue(pushResult);

    const app = createApp();
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/git/push")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.pushed).toBe(true);
    expect(mockInvalidateStatusCache).toHaveBeenCalledWith("ws-1");
  });

  it("returns 400 when no remote configured", async () => {
    mockPush.mockRejectedValue(new Error("No remote configured. Add a remote with `git remote add origin <url>`."));

    const app = createApp();
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/git/push")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No remote configured/);
  });

  it("returns 400 for detached HEAD", async () => {
    mockPush.mockRejectedValue(new Error("Cannot push in detached HEAD state"));

    const app = createApp();
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/git/push")
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid push remote", async () => {
    mockPush.mockRejectedValue(new Error("Invalid remote: remote must be a configured remote name"));

    const app = createApp();
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/git/push")
      .send({ remote: "https://attacker.example/repo.git" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/remote/i);
  });

  it("returns 400 for invalid push branch", async () => {
    mockPush.mockRejectedValue(new Error("Invalid branch name: main;touch-owned"));

    const app = createApp();
    const res = await request(app)
      .post("/api/execution-workspaces/ws-1/git/push")
      .send({ branch: "main;touch-owned" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/branch/i);
  });
});

// ---------------------------------------------------------------------------
// GET /execution-workspaces/:id/git/safety
// ---------------------------------------------------------------------------

describe("GET /execution-workspaces/:id/git/safety", () => {
  it("returns the planned safety shape with linked task, active run, and action confirmations", async () => {
    const db = createSequenceDb([
      [{ id: "issue-1", companyId: "company-1", title: "Fix auth bug", status: "in_progress", identifier: "ENG-99", assigneeAgentId: "agent-1", checkoutRunId: null, executionRunId: null }],
      [{ id: "run-1", status: "running", agentId: "agent-1", startedAt: "2026-05-15T10:00:00.000Z", createdAt: "2026-05-15T09:59:00.000Z" }],
    ]);

    const app = createApp(boardActor, db);
    const res = await request(app).get("/api/execution-workspaces/ws-1/git/safety");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      task: {
        id: "issue-1",
        title: "Fix auth bug",
        status: "in_progress",
        identifier: "ENG-99",
      },
      activeRun: {
        id: "run-1",
        status: "running",
        startedAt: "2026-05-15T10:00:00.000Z",
      },
      requiresConfirmation: {
        commit: true,
        push: true,
        createPr: true,
      },
    });
    expect(res.body).not.toHaveProperty("issue");
    expect(res.body).not.toHaveProperty("shouldWarn");
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/task is not complete/i),
        expect.stringMatching(/agent run/i),
      ]),
    );
  });

  it("does not warn when the linked task is done and no run is active", async () => {
    const db = createSequenceDb([
      [{ id: "issue-1", companyId: "company-1", title: "Done task", status: "done", identifier: "ENG-99", assigneeAgentId: "agent-1", checkoutRunId: null, executionRunId: null }],
      [],
    ]);

    const app = createApp(boardActor, db);
    const res = await request(app).get("/api/execution-workspaces/ws-1/git/safety");

    expect(res.status).toBe(200);
    expect(res.body.requiresConfirmation).toEqual({
      commit: false,
      push: false,
      createPr: false,
    });
    expect(res.body.activeRun).toBeNull();
    expect(res.body.task.status).toBe("done");
  });

  it("requires PR confirmation for an incomplete task even when no run is active", async () => {
    const db = createSequenceDb([
      [{ id: "issue-1", companyId: "company-1", title: "Review me", status: "in_review", identifier: "ENG-99", assigneeAgentId: "agent-1", checkoutRunId: null, executionRunId: null }],
      [],
    ]);

    const app = createApp(boardActor, db);
    const res = await request(app).get("/api/execution-workspaces/ws-1/git/safety");

    expect(res.status).toBe(200);
    expect(res.body.activeRun).toBeNull();
    expect(res.body.requiresConfirmation).toEqual({
      commit: false,
      push: false,
      createPr: true,
    });
  });

  it("requires confirmation when a linked task has an active execution run but no current assignee", async () => {
    const db = createSequenceDb([
      [{ id: "issue-1", companyId: "company-1", title: "Running without assignee", status: "in_progress", identifier: "ENG-100", assigneeAgentId: null, checkoutRunId: null, executionRunId: "run-2" }],
      [{ id: "run-2", status: "running", agentId: "agent-old", startedAt: "2026-05-15T11:00:00.000Z", createdAt: "2026-05-15T10:59:00.000Z" }],
    ]);

    const app = createApp(boardActor, db);
    const res = await request(app).get("/api/execution-workspaces/ws-1/git/safety");

    expect(res.status).toBe(200);
    expect(res.body.activeRun).toMatchObject({ id: "run-2", status: "running" });
    expect(res.body.requiresConfirmation).toEqual({
      commit: true,
      push: true,
      createPr: true,
    });
  });

  it("evaluates safety across all tasks linked to a reused workspace", async () => {
    const db = createSequenceDb([
      [
        { id: "issue-done", companyId: "company-1", title: "Done task", status: "done", identifier: "ENG-1", assigneeAgentId: null, checkoutRunId: null, executionRunId: null },
        { id: "issue-running", companyId: "company-1", title: "Still running", status: "in_progress", identifier: "ENG-2", assigneeAgentId: "agent-2", checkoutRunId: null, executionRunId: "run-2" },
      ],
      [{ id: "run-2", status: "running", agentId: "agent-2", startedAt: "2026-05-15T11:00:00.000Z", createdAt: "2026-05-15T10:59:00.000Z" }],
    ]);

    const app = createApp(boardActor, db);
    const res = await request(app).get("/api/execution-workspaces/ws-1/git/safety");

    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({
      id: "issue-running",
      status: "in_progress",
      identifier: "ENG-2",
    });
    expect(res.body.activeRun).toMatchObject({ id: "run-2", status: "running" });
    expect(res.body.requiresConfirmation).toEqual({
      commit: true,
      push: true,
      createPr: true,
    });
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/task is not complete/i),
        expect.stringMatching(/agent run/i),
      ]),
    );
  });
});
