import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// U2c: server.ts now also imports the internal-agent tool registry
// (mcp-bridge.ts / tool-registry.js), whose ~90 tools reference many more
// schema tables (agents, internalAgentConfig, heartbeatRuns, ...) — several
// with module-scope `sql` usage (e.g. heartbeat.ts) — than this file's old
// hand-enumerated table list covered. A hand-enumerated allowlist can't keep
// up with that surface, and Vitest's `vi.mock` factory validates named
// exports against the literal keys on the returned object (a dynamic
// catch-all Proxy doesn't satisfy it — only its OWN enumerable keys count).
// `../services/index.js` below is already fully mocked with noop factories,
// which was the actual reason `@armyofagents/db`/`drizzle-orm` needed
// stubbing (real service construction hitting a real DB pool). With that
// path cut, passing the REAL `@armyofagents/db` (real Drizzle table defs) and
// REAL `drizzle-orm` (real query-builder operators) through unmodified is
// both simpler and correct — this file's fake inline `ctx.db` stub objects
// only need the operator calls to not throw, and real operators do that job
// better than hand-rolled ones. Verified: all tests in this file still pass.
vi.mock("@armyofagents/db", async (importOriginal) => {
  return await importOriginal<Record<string, unknown>>();
});

vi.mock("drizzle-orm", async (importOriginal) => {
  return await importOriginal<Record<string, unknown>>();
});

vi.mock("../services/index.js", () => {
  const noopFactory = () => ({});
  return {
    accessService: noopFactory,
    agentService: noopFactory,
    artifactService: noopFactory,
    companyService: noopFactory,
    debriefService: noopFactory,
    extractionService: noopFactory,
    goalService: noopFactory,
    issueService: noopFactory,
    memoryService: noopFactory,
    mcpService: noopFactory,
    permissionService: noopFactory,
    projectService: noopFactory,
    approvalService: noopFactory,
    issueApprovalService: noopFactory,
    logActivity: vi.fn().mockResolvedValue(undefined),
  };
});

import { mcpServerRoutes } from "../mcp/server.js";

type Agent = { id: string; companyId: string; status: string; name?: string };
type Project = { id: string; companyId: string; type: "department" | "project"; name?: string };
type Task = {
  id: string;
  companyId: string;
  projectId: string | null;
  title?: string;
  status?: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  responsibleUserId?: string | null;
};
type Comment = {
  id: string;
  companyId: string;
  issueId: string;
  body: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdAt?: Date;
};

function buildApp(options?: {
  actor?: Record<string, unknown>;
  resolveScope?: (
    companyId: string,
    actor: { source: string; userId: string },
  ) => Promise<any>;
  resolveRole?: (companyId: string, userId: string) => Promise<string>;
  resolveScopedAgentIds?: (companyId: string, scope: any) => Promise<Set<string> | null>;
  agents?: Agent[];
  projects?: Project[];
  tasks?: Task[];
  comments?: Comment[];
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor =
      options?.actor ??
      ({
        type: "mcp",
        source: "mcp_key",
        userId: "user-1",
        companyId: "company-1",
        keyId: "key-1",
      } as const);
    next();
  });

  const agentList = options?.agents ?? [];
  const projectList = options?.projects ?? [];
  const taskList = options?.tasks ?? [];
  const commentList = options?.comments ?? [];

  app.use(
    "/api",
    mcpServerRoutes({} as any, {
      companiesSvc: {
        getById: vi.fn().mockResolvedValue({
          id: "company-1",
          mcpEnabled: true,
        }),
        update: vi.fn(),
      } as any,
      mcpSvc: {
        touchClient: vi.fn().mockResolvedValue(null),
        getStatus: vi.fn(),
        listKeys: vi.fn(),
        createKey: vi.fn(),
        requireOwnedKey: vi.fn(),
        revokeKey: vi.fn(),
        listClients: vi.fn(),
      } as any,
      resolveScope:
        options?.resolveScope ??
        (async (_companyId, actor) => ({ kind: "founder", userId: actor.userId })),
      resolveRole: options?.resolveRole ?? (async () => "founder"),
      resolveScopedAgentIds:
        options?.resolveScopedAgentIds ?? (async () => null),
      issuesSvc: {
        list: vi.fn().mockImplementation(async (companyId: string, filters?: any) => {
          let rows = taskList.filter((t) => t.companyId === companyId);
          if (filters?.status) rows = rows.filter((t) => t.status === filters.status);
          if (filters?.projectId) rows = rows.filter((t) => t.projectId === filters.projectId);
          if (filters?.assigneeAgentId)
            rows = rows.filter((t) => t.assigneeAgentId === filters.assigneeAgentId);
          if (filters?.assigneeUserId)
            rows = rows.filter((t) => t.assigneeUserId === filters.assigneeUserId);
          if (filters?.responsibleUserId)
            rows = rows.filter((t) => t.responsibleUserId === filters.responsibleUserId);
          if (filters?.q) {
            const needle = filters.q.toLowerCase();
            rows = rows.filter((t) => (t.title ?? "").toLowerCase().includes(needle));
          }
          return rows;
        }),
        getById: vi
          .fn()
          .mockImplementation(async (id: string) => taskList.find((t) => t.id === id) ?? null),
        update: vi.fn(),
        listComments: vi
          .fn()
          .mockImplementation(async (issueId: string) =>
            commentList.filter((c) => c.issueId === issueId),
          ),
        getComment: vi
          .fn()
          .mockImplementation(async (commentId: string) =>
            commentList.find((c) => c.id === commentId) ?? null,
          ),
      } as any,
      goalsSvc: {
        list: vi.fn().mockResolvedValue([]),
        getById: vi.fn().mockResolvedValue(null),
      } as any,
      memorySvc: {
        list: vi.fn().mockResolvedValue([]),
        getById: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      } as any,
      artifactsSvc: {
        list: vi.fn().mockResolvedValue([]),
        getById: vi.fn().mockResolvedValue(null),
        addVersion: vi.fn(),
      } as any,
      debriefsSvc: {
        create: vi.fn(),
      } as any,
      extractionSvc: {
        extractFromDebrief: vi.fn(),
      } as any,
      permissionsSvc: {
        canAccessEntity: vi.fn().mockResolvedValue(true),
        canAccessMemory: vi.fn().mockResolvedValue(true),
      } as any,
      agentsSvc: {
        list: vi.fn().mockImplementation(async (companyId: string) =>
          agentList.filter((a) => a.companyId === companyId),
        ),
        getById: vi
          .fn()
          .mockImplementation(async (id: string) => agentList.find((a) => a.id === id) ?? null),
      } as any,
      projectsSvc: {
        list: vi
          .fn()
          .mockImplementation(async (companyId: string) =>
            projectList.filter((p) => p.companyId === companyId),
          ),
        getById: vi
          .fn()
          .mockImplementation(async (id: string) => projectList.find((p) => p.id === id) ?? null),
      } as any,
    }),
  );

  return { app };
}

async function callTool(app: express.Express, name: string, args: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/companies/company-1/mcp")
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return res;
}

describe("MCP read tools", () => {
  describe("tools/list exposes the new read tools", () => {
    it("lists me, list-agents, get-agent, list-projects, get-project, and task read tools", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/api/companies/company-1/mcp")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      expect(res.status).toBe(200);
      const names = res.body.result.tools.map((t: any) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "me",
          "list-agents",
          "get-agent",
          "list-projects",
          "get-project",
          "list-tasks",
          "get-heartbeat-context",
          "list-task-comments",
          "get-task-comment",
        ]),
      );
    });
  });

  describe("me", () => {
    it("returns authenticated user info including role", async () => {
      const { app } = buildApp();
      const res = await callTool(app, "me", {});
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.userId).toBe("user-1");
      expect(payload.companyId).toBe("company-1");
      expect(payload.role).toBe("founder");
    });

    it("reports scoped role for non-founder users", async () => {
      const { app } = buildApp({
        resolveScope: async (_cid, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["project-1"]),
        }),
        resolveRole: async () => "team_member",
      });
      const res = await callTool(app, "me", {});
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.role).toBe("team_member");
    });
  });

  describe("list-agents", () => {
    it("returns agents for the caller's company", async () => {
      const { app } = buildApp({
        agents: [
          { id: "agent-1", companyId: "company-1", status: "active" },
          { id: "agent-2", companyId: "company-1", status: "active" },
          { id: "agent-X", companyId: "other-company", status: "active" },
        ],
      });
      const res = await callTool(app, "list-agents", {});
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toHaveLength(2);
      expect(payload.every((a: any) => a.companyId === "company-1")).toBe(true);
    });

    it("filters by status when provided", async () => {
      const { app } = buildApp({
        agents: [
          { id: "agent-1", companyId: "company-1", status: "active" },
          { id: "agent-2", companyId: "company-1", status: "idle" },
        ],
      });
      const res = await callTool(app, "list-agents", { status: "active" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toHaveLength(1);
      expect(payload[0].id).toBe("agent-1");
    });

    it("scoped user sees only agents linked to their projects", async () => {
      const { app } = buildApp({
        resolveScope: async (_cid, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["project-1"]),
        }),
        resolveScopedAgentIds: async () => new Set(["agent-1"]),
        agents: [
          { id: "agent-1", companyId: "company-1", status: "active" },
          { id: "agent-2", companyId: "company-1", status: "active" },
        ],
      });
      const res = await callTool(app, "list-agents", {});
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toHaveLength(1);
      expect(payload[0].id).toBe("agent-1");
    });
  });

  describe("get-agent", () => {
    it("returns an agent by id when caller has access", async () => {
      const { app } = buildApp({
        agents: [{ id: "agent-1", companyId: "company-1", status: "active", name: "Coder" }],
      });
      const res = await callTool(app, "get-agent", { agentId: "agent-1" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.id).toBe("agent-1");
    });

    it("returns 404 when the agent is in another company", async () => {
      const { app } = buildApp({
        agents: [{ id: "agent-X", companyId: "other-company", status: "active" }],
      });
      const res = await callTool(app, "get-agent", { agentId: "agent-X" });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/i);
    });
  });

  describe("list-projects", () => {
    it("returns both departments and projects for the caller's company", async () => {
      const { app } = buildApp({
        projects: [
          { id: "dept-1", companyId: "company-1", type: "department", name: "Engineering" },
          { id: "proj-1", companyId: "company-1", type: "project", name: "Launch" },
          { id: "other", companyId: "other-company", type: "project", name: "Hidden" },
        ],
      });
      const res = await callTool(app, "list-projects", {});
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toHaveLength(2);
      expect(payload.some((p: any) => p.type === "department")).toBe(true);
      expect(payload.some((p: any) => p.type === "project")).toBe(true);
    });

    it("scoped user sees only projects in their scope", async () => {
      const { app } = buildApp({
        resolveScope: async (_cid, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-1"]),
        }),
        projects: [
          { id: "proj-1", companyId: "company-1", type: "project" },
          { id: "proj-2", companyId: "company-1", type: "project" },
        ],
      });
      const res = await callTool(app, "list-projects", {});
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toHaveLength(1);
      expect(payload[0].id).toBe("proj-1");
    });
  });

  describe("get-project", () => {
    it("returns a project by id when caller has access", async () => {
      const { app } = buildApp({
        projects: [{ id: "proj-1", companyId: "company-1", type: "project", name: "Launch" }],
      });
      const res = await callTool(app, "get-project", { projectId: "proj-1" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.id).toBe("proj-1");
    });

    it("returns 404 when the project is in another company", async () => {
      const { app } = buildApp({
        projects: [{ id: "other", companyId: "other-company", type: "project" }],
      });
      const res = await callTool(app, "get-project", { projectId: "other" });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/i);
    });

    it("returns 404 when scoped user queries a project outside their scope", async () => {
      const { app } = buildApp({
        resolveScope: async (_cid, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-1"]),
        }),
        projects: [
          { id: "proj-1", companyId: "company-1", type: "project" },
          { id: "proj-2", companyId: "company-1", type: "project" },
        ],
      });
      const res = await callTool(app, "get-project", { projectId: "proj-2" });
      expect(res.status).toBe(404);
    });
  });

  describe("list-tasks", () => {
    it("returns tasks in the caller's company", async () => {
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", status: "todo", title: "A" },
          { id: "t-2", companyId: "company-1", projectId: "proj-2", status: "in_progress", title: "B" },
        ],
      });
      const res = await callTool(app, "list-tasks", {});
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toHaveLength(2);
    });

    it("filters by status and projectId", async () => {
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", status: "todo" },
          { id: "t-2", companyId: "company-1", projectId: "proj-1", status: "in_progress" },
          { id: "t-3", companyId: "company-1", projectId: "proj-2", status: "todo" },
        ],
      });
      const res = await callTool(app, "list-tasks", { status: "todo", projectId: "proj-1" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toHaveLength(1);
      expect(payload[0].id).toBe("t-1");
    });

    it("filters by assigneeAgentId and search query", async () => {
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", title: "Fix login bug", assigneeAgentId: "agent-1" },
          { id: "t-2", companyId: "company-1", projectId: "proj-1", title: "Other work", assigneeAgentId: "agent-2" },
        ],
      });
      const byAgent = await callTool(app, "list-tasks", { assigneeAgentId: "agent-1" });
      expect(JSON.parse(byAgent.body.result.content[0].text)).toHaveLength(1);

      const bySearch = await callTool(app, "list-tasks", { q: "login" });
      const searchPayload = JSON.parse(bySearch.body.result.content[0].text);
      expect(searchPayload).toHaveLength(1);
      expect(searchPayload[0].id).toBe("t-1");
    });

    it("filters by responsibleUserId", async () => {
      const { app } = buildApp({
        tasks: [
          {
            id: "t-1",
            companyId: "company-1",
            projectId: "proj-1",
            title: "Owned by user 2",
            responsibleUserId: "user-2",
          },
          {
            id: "t-2",
            companyId: "company-1",
            projectId: "proj-1",
            title: "Owned by user 3",
            responsibleUserId: "user-3",
          },
        ],
      });
      const res = await callTool(app, "list-tasks", { responsibleUserId: "user-2" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toHaveLength(1);
      expect(payload[0].id).toBe("t-1");
    });

    it("scoped user sees only tasks in their projects", async () => {
      const { app } = buildApp({
        resolveScope: async (_cid, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-1"]),
        }),
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", status: "todo" },
          { id: "t-2", companyId: "company-1", projectId: "proj-2", status: "todo" },
        ],
      });
      const res = await callTool(app, "list-tasks", {});
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toHaveLength(1);
      expect(payload[0].id).toBe("t-1");
    });
  });

  describe("get-heartbeat-context", () => {
    it("returns { task, recentComments } capped at 10", async () => {
      const comments: Comment[] = Array.from({ length: 15 }, (_, i) => ({
        id: `c-${i}`,
        companyId: "company-1",
        issueId: "t-1",
        body: `comment ${i}`,
        createdAt: new Date(2026, 3, 21, 12, i),
      }));
      const { app } = buildApp({
        tasks: [{ id: "t-1", companyId: "company-1", projectId: "proj-1", title: "X" }],
        comments,
      });
      const res = await callTool(app, "get-heartbeat-context", { taskId: "t-1" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.task.id).toBe("t-1");
      expect(Array.isArray(payload.recentComments)).toBe(true);
      expect(payload.recentComments.length).toBe(10);
    });

    it("returns 404 when task is in another company", async () => {
      const { app } = buildApp({
        tasks: [{ id: "t-X", companyId: "other-company", projectId: "proj-X" }],
      });
      const res = await callTool(app, "get-heartbeat-context", { taskId: "t-X" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when scoped user queries task outside their scope", async () => {
      const { app } = buildApp({
        resolveScope: async (_cid, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-1"]),
        }),
        tasks: [{ id: "t-2", companyId: "company-1", projectId: "proj-2" }],
      });
      const res = await callTool(app, "get-heartbeat-context", { taskId: "t-2" });
      expect(res.status).toBe(404);
    });
  });

  describe("list-task-comments", () => {
    it("returns comments for an accessible task", async () => {
      const { app } = buildApp({
        tasks: [{ id: "t-1", companyId: "company-1", projectId: "proj-1" }],
        comments: [
          { id: "c-1", companyId: "company-1", issueId: "t-1", body: "first" },
          { id: "c-2", companyId: "company-1", issueId: "t-1", body: "second" },
        ],
      });
      const res = await callTool(app, "list-task-comments", { taskId: "t-1" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toHaveLength(2);
    });

    it("returns 404 when task is in another company", async () => {
      const { app } = buildApp({
        tasks: [{ id: "t-X", companyId: "other-company", projectId: null }],
      });
      const res = await callTool(app, "list-task-comments", { taskId: "t-X" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for scoped user when task is outside their scope", async () => {
      const { app } = buildApp({
        resolveScope: async (_cid, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-1"]),
        }),
        tasks: [{ id: "t-2", companyId: "company-1", projectId: "proj-2" }],
      });
      const res = await callTool(app, "list-task-comments", { taskId: "t-2" });
      expect(res.status).toBe(404);
    });
  });

  describe("get-task-comment", () => {
    it("returns a single comment when caller has access to its task", async () => {
      const { app } = buildApp({
        tasks: [{ id: "t-1", companyId: "company-1", projectId: "proj-1" }],
        comments: [{ id: "c-1", companyId: "company-1", issueId: "t-1", body: "hello" }],
      });
      const res = await callTool(app, "get-task-comment", { commentId: "c-1" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.id).toBe("c-1");
    });

    it("returns 404 when comment is in another company", async () => {
      const { app } = buildApp({
        tasks: [{ id: "t-X", companyId: "other-company", projectId: null }],
        comments: [{ id: "c-X", companyId: "other-company", issueId: "t-X", body: "x" }],
      });
      const res = await callTool(app, "get-task-comment", { commentId: "c-X" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when scoped user queries a comment outside their scope", async () => {
      const { app } = buildApp({
        resolveScope: async (_cid, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-1"]),
        }),
        tasks: [{ id: "t-2", companyId: "company-1", projectId: "proj-2" }],
        comments: [{ id: "c-2", companyId: "company-1", issueId: "t-2", body: "blocked" }],
      });
      const res = await callTool(app, "get-task-comment", { commentId: "c-2" });
      expect(res.status).toBe(404);
    });
  });
});
