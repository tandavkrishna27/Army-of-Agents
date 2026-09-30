import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// memory.write delegates to writeMemoryAndIndex (not ctx.services.memory.create),
// so mock it to assert the handler reaches the write for an agent actor.
const { mockWriteMemoryAndIndex } = vi.hoisted(() => ({
  mockWriteMemoryAndIndex: vi.fn(),
}));
vi.mock("../services/memory-write.js", () => ({
  writeMemoryAndIndex: mockWriteMemoryAndIndex,
  enqueueMemoryEmbedding: vi.fn().mockResolvedValue(undefined),
}));

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
type Goal = { id: string; companyId: string; title?: string };
type Comment = { id: string; companyId: string; issueId: string; body: string };

function buildApp(options?: {
  actor?: Record<string, unknown>;
  resolveScope?: (
    companyId: string,
    actor: { source: string; userId: string },
  ) => Promise<any>;
  resolveRole?: (companyId: string, userId: string) => Promise<string>;
  projects?: Project[];
  tasks?: Task[];
  goals?: Goal[];
  canAccessEntity?: (
    companyId: string,
    userId: string,
    entityType: string,
    action: string,
    context?: any,
  ) => Promise<boolean>;
  canAssignTasks?: ReturnType<typeof vi.fn>;
  hasAgentPermission?: ReturnType<typeof vi.fn>;
  createImpl?: (companyId: string, data: any) => Promise<any>;
  updateImpl?: (id: string, data: any) => Promise<any>;
  addCommentImpl?: (
    issueId: string,
    body: string,
    actor: { agentId?: string; userId?: string },
  ) => Promise<any>;
  memoryCreate?: ReturnType<typeof vi.fn>;
  canAccessMemory?: ReturnType<typeof vi.fn>;
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

  const projectList = options?.projects ?? [];
  const taskList = options?.tasks ?? [];
  const goalList = options?.goals ?? [];

  const memoryCreate =
    options?.memoryCreate ??
    vi.fn().mockImplementation(async (companyId: string, data: any) => ({
      id: "new-memory-id",
      companyId,
      status: "pending",
      title: data.title,
      layer: data.layer,
      agentId: data.agentId ?? null,
    }));

  const createImpl =
    options?.createImpl ??
    (async (companyId: string, data: any) => ({
      id: "new-task-id",
      companyId,
      projectId: data.projectId ?? null,
      title: data.title,
      description: data.description ?? null,
      status: data.status ?? "backlog",
      priority: data.priority ?? "medium",
      responsibleUserId: data.responsibleUserId ?? null,
    }));

  const updateImpl =
    options?.updateImpl ??
    (async (id: string, data: any) => {
      const existing = taskList.find((t) => t.id === id);
      if (!existing) return null;
      return { ...existing, ...data };
    });

  const addCommentImpl =
    options?.addCommentImpl ??
    (async (issueId: string, body: string, _actor) => ({
      id: "new-comment-id",
      companyId: taskList.find((t) => t.id === issueId)?.companyId ?? "company-1",
      issueId,
      body,
    }));

  app.use(
    "/api",
    mcpServerRoutes({} as any, {
      companiesSvc: {
        getById: vi.fn().mockResolvedValue({ id: "company-1", mcpEnabled: true }),
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
      resolveScopedAgentIds: async () => null,
      issuesSvc: {
        list: vi.fn().mockResolvedValue([]),
        getById: vi
          .fn()
          .mockImplementation(async (id: string) => taskList.find((t) => t.id === id) ?? null),
        create: vi.fn().mockImplementation(createImpl),
        update: vi.fn().mockImplementation(updateImpl),
        addComment: vi.fn().mockImplementation(addCommentImpl),
        listComments: vi.fn().mockResolvedValue([]),
        getComment: vi.fn().mockResolvedValue(null),
      } as any,
      goalsSvc: {
        list: vi.fn().mockResolvedValue([]),
        getById: vi
          .fn()
          .mockImplementation(async (id: string) => goalList.find((g) => g.id === id) ?? null),
      } as any,
      memorySvc: {
        list: vi.fn().mockResolvedValue([]),
        getById: vi.fn().mockResolvedValue(null),
        create: memoryCreate,
        approve: vi
          .fn()
          .mockImplementation(async (_companyId: string, id: string) => ({
            id,
            status: "approved",
          })),
      } as any,
      artifactsSvc: {
        list: vi.fn().mockResolvedValue([]),
        getById: vi.fn().mockResolvedValue(null),
        addVersion: vi.fn(),
      } as any,
      debriefsSvc: { create: vi.fn() } as any,
      extractionSvc: { extractFromDebrief: vi.fn() } as any,
      permissionsSvc: {
        canAccessEntity:
          options?.canAccessEntity ??
          vi.fn().mockResolvedValue(true),
        canAccessMemory:
          options?.canAccessMemory ?? vi.fn().mockResolvedValue(true),
      } as any,
      accessSvc: {
        canUser: options?.canAssignTasks ?? vi.fn().mockResolvedValue(true),
        hasPermission: options?.hasAgentPermission ?? vi.fn().mockResolvedValue(true),
      } as any,
      agentsSvc: {
        list: vi.fn().mockResolvedValue([]),
        getById: vi.fn().mockResolvedValue(null),
      } as any,
      projectsSvc: {
        list: vi.fn().mockResolvedValue(projectList),
        getById: vi
          .fn()
          .mockImplementation(async (id: string) => projectList.find((p) => p.id === id) ?? null),
      } as any,
    }),
  );

  return { app, memoryCreate };
}

async function callTool(
  app: express.Express,
  name: string,
  args: Record<string, unknown> = {},
) {
  return request(app)
    .post("/api/companies/company-1/mcp")
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

describe("MCP write tools", () => {
  describe("tools/list exposes the new write tools", () => {
    it("lists create-task, update-task, and add-task-comment", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/api/companies/company-1/mcp")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      expect(res.status).toBe(200);
      const names = res.body.result.tools.map((t: any) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(["create-task", "update-task", "add-task-comment"]),
      );
    });
  });

  describe("create-task", () => {
    it("founder can create a task directly", async () => {
      const { app } = buildApp({
        projects: [{ id: "proj-1", companyId: "company-1", type: "department" }],
      });
      const res = await callTool(app, "create-task", {
        title: "Fix login bug",
        projectId: "proj-1",
        description: "Investigate 401 errors",
      });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.id).toBeTruthy();
      expect(payload.title).toBe("Fix login bug");
    });

    it("passes the human caller as responsible fallback when creating an unassigned task", async () => {
      const createImpl = vi.fn().mockResolvedValue({
        id: "new-task-id",
        title: "Operator-owned task",
        companyId: "company-1",
        projectId: null,
        responsibleUserId: "user-1",
      });
      const { app } = buildApp({ createImpl });

      const res = await callTool(app, "create-task", { title: "Operator-owned task" });

      expect(res.status).toBe(200);
      expect(createImpl).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ responsibleFallbackUserId: "user-1" }),
      );
    });

    it("does NOT route through Discussion pipeline (Decision #14 revised)", async () => {
      const debriefCreate = vi.fn().mockResolvedValue({ id: "debrief-1" });
      const extractFromDebrief = vi.fn().mockResolvedValue(undefined);
      const issueCreate = vi.fn().mockResolvedValue({
        id: "new-task-id",
        title: "Direct",
        projectId: null,
        companyId: "company-1",
      });

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = {
          type: "mcp",
          source: "mcp_key",
          userId: "user-1",
          companyId: "company-1",
          keyId: "key-1",
        };
        next();
      });
      app.use(
        "/api",
        mcpServerRoutes({} as any, {
          companiesSvc: {
            getById: vi.fn().mockResolvedValue({ id: "company-1", mcpEnabled: true }),
          } as any,
          mcpSvc: { touchClient: vi.fn().mockResolvedValue(null) } as any,
          resolveScope: async (_c, actor) => ({ kind: "founder", userId: actor.userId }),
          resolveRole: async () => "founder",
          resolveScopedAgentIds: async () => null,
          issuesSvc: {
            list: vi.fn().mockResolvedValue([]),
            getById: vi.fn().mockResolvedValue(null),
            create: issueCreate,
            update: vi.fn(),
            addComment: vi.fn(),
            listComments: vi.fn().mockResolvedValue([]),
            getComment: vi.fn().mockResolvedValue(null),
          } as any,
          goalsSvc: { list: vi.fn().mockResolvedValue([]), getById: vi.fn() } as any,
          memorySvc: { list: vi.fn(), getById: vi.fn(), create: vi.fn() } as any,
          artifactsSvc: { list: vi.fn(), getById: vi.fn(), addVersion: vi.fn() } as any,
          debriefsSvc: { create: debriefCreate } as any,
          extractionSvc: { extractFromDebrief } as any,
          permissionsSvc: {
            canAccessEntity: vi.fn().mockResolvedValue(true),
            canAccessMemory: vi.fn().mockResolvedValue(true),
          } as any,
          agentsSvc: { list: vi.fn(), getById: vi.fn() } as any,
          projectsSvc: { list: vi.fn(), getById: vi.fn().mockResolvedValue(null) } as any,
        }),
      );
      const res = await callTool(app, "create-task", { title: "Direct" });
      expect(res.status).toBe(200);
      expect(issueCreate).toHaveBeenCalledTimes(1);
      expect(debriefCreate).not.toHaveBeenCalled();
      expect(extractFromDebrief).not.toHaveBeenCalled();
    });

    it("team_lead can create a task in their department", async () => {
      const { app } = buildApp({
        resolveScope: async (_c, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-lead"]),
        }),
        resolveRole: async () => "team_lead",
        projects: [{ id: "proj-lead", companyId: "company-1", type: "department" }],
      });
      const res = await callTool(app, "create-task", {
        title: "PM task",
        projectId: "proj-lead",
      });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.id).toBeTruthy();
    });

    it("team_member cannot create in a project outside their scope", async () => {
      const { app } = buildApp({
        resolveScope: async (_c, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-mine"]),
        }),
        resolveRole: async () => "team_member",
        projects: [
          { id: "proj-mine", companyId: "company-1", type: "project" },
          { id: "proj-other", companyId: "company-1", type: "project" },
        ],
      });
      const res = await callTool(app, "create-task", {
        title: "Forbidden",
        projectId: "proj-other",
      });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/scope|forbidden|permission/i);
    });

    it("rejects creation against a project in another company (404)", async () => {
      const { app } = buildApp({
        projects: [{ id: "proj-other-co", companyId: "other-company", type: "project" }],
      });
      const res = await callTool(app, "create-task", {
        title: "Cross-tenant",
        projectId: "proj-other-co",
      });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/i);
    });

    it("returns 403 when role cannot create tasks (canAccessEntity=false)", async () => {
      const { app } = buildApp({
        resolveScope: async (_c, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-1"]),
        }),
        resolveRole: async () => "team_member",
        projects: [{ id: "proj-1", companyId: "company-1", type: "department" }],
        canAccessEntity: vi.fn().mockResolvedValue(false),
      });
      const res = await callTool(app, "create-task", {
        title: "Blocked by role",
        projectId: "proj-1",
      });
      expect(res.status).toBe(403);
    });

    it("passes responsibleUserId through to issue creation", async () => {
      const createSpy = vi.fn(async (companyId: string, data: any) => ({
        id: "new-task-id",
        companyId,
        projectId: data.projectId ?? null,
        title: data.title,
        responsibleUserId: data.responsibleUserId ?? null,
      }));
      const { app } = buildApp({ createImpl: createSpy });

      const res = await callTool(app, "create-task", {
        title: "Coordinate launch handoff",
        responsibleUserId: "user-2",
      });

      expect(res.status).toBe(200);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ responsibleUserId: "user-2" }),
      );
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.responsibleUserId).toBe("user-2");
    });

    it("rejects explicit responsibleUserId when caller lacks task assign permission", async () => {
      const createSpy = vi.fn(async (companyId: string, data: any) => ({
        id: "new-task-id",
        companyId,
        title: data.title,
        responsibleUserId: data.responsibleUserId ?? null,
      }));
      const canAssignTasks = vi.fn().mockResolvedValue(false);
      const { app } = buildApp({ createImpl: createSpy, canAssignTasks });

      const res = await callTool(app, "create-task", {
        title: "Coordinate launch handoff",
        responsibleUserId: "user-2",
      });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/tasks:assign|assign/i);
      expect(createSpy).not.toHaveBeenCalled();
      expect(canAssignTasks).toHaveBeenCalledWith("company-1", "user-1", "tasks:assign");
    });

    it("allows omitted responsibleUserId when caller lacks task assign permission", async () => {
      const createSpy = vi.fn(async (companyId: string, data: any) => ({
        id: "new-task-id",
        companyId,
        title: data.title,
        responsibleUserId: data.responsibleUserId ?? null,
      }));
      const canAssignTasks = vi.fn().mockResolvedValue(false);
      const { app } = buildApp({ createImpl: createSpy, canAssignTasks });

      const res = await callTool(app, "create-task", {
        title: "Write launch checklist",
      });

      expect(res.status).toBe(200);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(canAssignTasks).not.toHaveBeenCalled();
    });

    it("allows local trusted board actor to explicitly set responsibleUserId", async () => {
      const createSpy = vi.fn(async (companyId: string, data: any) => ({
        id: "new-task-id",
        companyId,
        title: data.title,
        responsibleUserId: data.responsibleUserId ?? null,
      }));
      const canAssignTasks = vi.fn().mockResolvedValue(false);
      const { app } = buildApp({
        actor: { type: "board", source: "local_implicit" },
        createImpl: createSpy,
        canAssignTasks,
      });

      const res = await callTool(app, "create-task", {
        title: "Coordinate launch handoff",
        responsibleUserId: "user-2",
      });

      expect(res.status).toBe(200);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ responsibleUserId: "user-2" }),
      );
      expect(canAssignTasks).not.toHaveBeenCalled();
    });

    it("rejects agent explicit responsibleUserId set when missing tasks:assign", async () => {
      const createSpy = vi.fn();
      const hasAgentPermission = vi.fn().mockResolvedValue(false);
      const { app } = buildApp({
        actor: {
          type: "agent",
          source: "agent",
          userId: "agent-1",
          companyId: "company-1",
          agentId: "agent-1",
          runId: "run-1",
        },
        createImpl: createSpy,
        hasAgentPermission,
      });

      const res = await callTool(app, "create-task", {
        title: "Coordinate launch handoff",
        responsibleUserId: "user-2",
      });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/tasks:assign|assign/i);
      expect(createSpy).not.toHaveBeenCalled();
      expect(hasAgentPermission).toHaveBeenCalledWith(
        "company-1",
        "agent",
        "agent-1",
        "tasks:assign",
      );
    });
  });

  describe("update-task", () => {
    it("founder can update title, status, priority", async () => {
      const { app } = buildApp({
        tasks: [
          {
            id: "t-1",
            companyId: "company-1",
            projectId: "proj-1",
            title: "Old",
            status: "todo",
          },
        ],
      });
      const res = await callTool(app, "update-task", {
        taskId: "t-1",
        title: "Updated title",
        status: "in_progress",
        priority: "high",
      });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.title).toBe("Updated title");
      expect(payload.status).toBe("in_progress");
    });

    it("rejects cross-company update (404)", async () => {
      const { app } = buildApp({
        tasks: [{ id: "t-x", companyId: "other-company", projectId: "proj-x" }],
      });
      const res = await callTool(app, "update-task", {
        taskId: "t-x",
        status: "done",
      });
      expect(res.status).toBe(404);
    });

    it("rejects moving a task onto another company's project (404) and does not update", async () => {
      const updateSpy = vi.fn(async (id: string, data: any) => ({
        id,
        companyId: "company-1",
        projectId: data.projectId ?? "proj-mine",
      }));
      const { app } = buildApp({
        // Task belongs to our company; the target project belongs to another.
        tasks: [{ id: "t-1", companyId: "company-1", projectId: "proj-mine" }],
        projects: [
          { id: "proj-mine", companyId: "company-1", type: "department" },
          { id: "proj-foreign", companyId: "other-company", type: "project" },
        ],
        updateImpl: updateSpy,
      });
      const res = await callTool(app, "update-task", {
        taskId: "t-1",
        projectId: "proj-foreign",
      });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/i);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("allows moving a task onto a same-company project", async () => {
      const { app } = buildApp({
        tasks: [{ id: "t-1", companyId: "company-1", projectId: "proj-mine" }],
        projects: [
          { id: "proj-mine", companyId: "company-1", type: "department" },
          { id: "proj-target", companyId: "company-1", type: "project" },
        ],
      });
      const res = await callTool(app, "update-task", {
        taskId: "t-1",
        projectId: "proj-target",
      });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.projectId).toBe("proj-target");
    });

    it("scoped user cannot update task outside their scope (404)", async () => {
      const { app } = buildApp({
        resolveScope: async (_c, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-mine"]),
        }),
        resolveRole: async () => "team_member",
        tasks: [{ id: "t-other", companyId: "company-1", projectId: "proj-other" }],
      });
      const res = await callTool(app, "update-task", {
        taskId: "t-other",
        status: "done",
      });
      expect(res.status).toBe(404);
    });

    it("returns 403 when role cannot update task", async () => {
      const { app } = buildApp({
        resolveScope: async (_c, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-1"]),
        }),
        resolveRole: async () => "team_member",
        tasks: [{ id: "t-1", companyId: "company-1", projectId: "proj-1" }],
        canAccessEntity: vi.fn().mockResolvedValue(false),
      });
      const res = await callTool(app, "update-task", {
        taskId: "t-1",
        status: "in_progress",
      });
      expect(res.status).toBe(403);
    });

    it("preserves responsibleUserId: null when clearing responsible human", async () => {
      const updateSpy = vi.fn(async (id: string, data: any) => ({
        id,
        companyId: "company-1",
        projectId: "proj-1",
        responsibleUserId: Object.prototype.hasOwnProperty.call(data, "responsibleUserId")
          ? data.responsibleUserId
          : "user-2",
      }));
      const { app } = buildApp({
        tasks: [
          {
            id: "t-1",
            companyId: "company-1",
            projectId: "proj-1",
            responsibleUserId: "user-2",
          },
        ],
        updateImpl: updateSpy,
      });

      const res = await callTool(app, "update-task", {
        taskId: "t-1",
        responsibleUserId: null,
      });

      expect(res.status).toBe(200);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0]?.[1]).toHaveProperty("responsibleUserId", null);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.responsibleUserId).toBeNull();
    });

    it("rejects clearing responsibleUserId when caller lacks task assign permission", async () => {
      const updateSpy = vi.fn();
      const canAssignTasks = vi.fn().mockResolvedValue(false);
      const { app } = buildApp({
        tasks: [
          {
            id: "t-1",
            companyId: "company-1",
            projectId: "proj-1",
            responsibleUserId: "user-2",
          },
        ],
        updateImpl: updateSpy,
        canAssignTasks,
      });

      const res = await callTool(app, "update-task", {
        taskId: "t-1",
        responsibleUserId: null,
      });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/tasks:assign|assign/i);
      expect(updateSpy).not.toHaveBeenCalled();
      expect(canAssignTasks).toHaveBeenCalledWith("company-1", "user-1", "tasks:assign");
    });

    it("allows local trusted board actor to explicitly clear responsibleUserId", async () => {
      const updateSpy = vi.fn(async (id: string, data: any) => ({
        id,
        companyId: "company-1",
        projectId: "proj-1",
        responsibleUserId: Object.prototype.hasOwnProperty.call(data, "responsibleUserId")
          ? data.responsibleUserId
          : "user-2",
      }));
      const canAssignTasks = vi.fn().mockResolvedValue(false);
      const { app } = buildApp({
        actor: { type: "board", source: "local_implicit" },
        tasks: [
          {
            id: "t-1",
            companyId: "company-1",
            projectId: "proj-1",
            responsibleUserId: "user-2",
          },
        ],
        updateImpl: updateSpy,
        canAssignTasks,
      });

      const res = await callTool(app, "update-task", {
        taskId: "t-1",
        responsibleUserId: null,
      });

      expect(res.status).toBe(200);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0]?.[1]).toHaveProperty("responsibleUserId", null);
      expect(canAssignTasks).not.toHaveBeenCalled();
    });

    it("rejects agent explicit responsibleUserId clear when missing tasks:assign", async () => {
      const updateSpy = vi.fn();
      const hasAgentPermission = vi.fn().mockResolvedValue(false);
      const { app } = buildApp({
        actor: {
          type: "agent",
          source: "agent",
          userId: "agent-1",
          companyId: "company-1",
          agentId: "agent-1",
          runId: "run-1",
        },
        tasks: [
          {
            id: "t-1",
            companyId: "company-1",
            projectId: "proj-1",
            responsibleUserId: "user-2",
          },
        ],
        updateImpl: updateSpy,
        hasAgentPermission,
      });

      const res = await callTool(app, "update-task", {
        taskId: "t-1",
        responsibleUserId: null,
      });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/tasks:assign|assign/i);
      expect(updateSpy).not.toHaveBeenCalled();
      expect(hasAgentPermission).toHaveBeenCalledWith(
        "company-1",
        "agent",
        "agent-1",
        "tasks:assign",
      );
    });
  });

  describe("add-task-comment", () => {
    it("adds a comment to an accessible task", async () => {
      const { app } = buildApp({
        tasks: [{ id: "t-1", companyId: "company-1", projectId: "proj-1" }],
      });
      const res = await callTool(app, "add-task-comment", {
        taskId: "t-1",
        body: "Looking into this now",
      });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.id).toBeTruthy();
      expect(payload.body).toBe("Looking into this now");
    });

    it("rejects cross-company comment (404)", async () => {
      const { app } = buildApp({
        tasks: [{ id: "t-x", companyId: "other-company", projectId: null }],
      });
      const res = await callTool(app, "add-task-comment", {
        taskId: "t-x",
        body: "nope",
      });
      expect(res.status).toBe(404);
    });

    it("scoped user cannot comment outside their scope (404)", async () => {
      const { app } = buildApp({
        resolveScope: async (_c, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-mine"]),
        }),
        resolveRole: async () => "team_member",
        tasks: [{ id: "t-other", companyId: "company-1", projectId: "proj-other" }],
      });
      const res = await callTool(app, "add-task-comment", {
        taskId: "t-other",
        body: "blocked",
      });
      expect(res.status).toBe(404);
    });

    it("team_member CAN comment on a task in their scope (read access suffices)", async () => {
      const { app } = buildApp({
        resolveScope: async (_c, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-1"]),
        }),
        resolveRole: async () => "team_member",
        tasks: [{ id: "t-1", companyId: "company-1", projectId: "proj-1" }],
      });
      const res = await callTool(app, "add-task-comment", {
        taskId: "t-1",
        body: "I can comment",
      });
      expect(res.status).toBe(200);
    });
  });

  describe("memory.retain — linked-entity company ownership", () => {
    // memory.retain's zod schema requires UUIDs for the FK fields, so these
    // ids must be syntactically valid UUIDs to reach the handler logic.
    const UUID = {
      taskForeign: "00000000-0000-4000-8000-000000000001",
      taskMine: "00000000-0000-4000-8000-000000000002",
      goalForeign: "00000000-0000-4000-8000-000000000003",
      goalMine: "00000000-0000-4000-8000-000000000004",
      projForeign: "00000000-0000-4000-8000-000000000005",
      projMine: "00000000-0000-4000-8000-000000000006",
      deptForeign: "00000000-0000-4000-8000-000000000007",
    };

    const agentActor = {
      type: "agent",
      source: "agent",
      userId: "agent-1",
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    } as const;

    it("rejects a foreign taskId on the org-scope path (404) and does NOT create memory", async () => {
      const { app, memoryCreate } = buildApp({
        tasks: [{ id: UUID.taskForeign, companyId: "other-company", projectId: UUID.projForeign }],
      });
      const res = await callTool(app, "memory.retain", {
        title: "Sneaky",
        content: "Cross-tenant link",
        category: "context",
        layer: "domain",
        sourceContext: "test",
        taskId: UUID.taskForeign,
      });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/i);
      expect(memoryCreate).not.toHaveBeenCalled();
    });

    it("rejects a foreign taskId on the personal/working-scope path (404) and does NOT create memory", async () => {
      const { app, memoryCreate } = buildApp({
        actor: agentActor,
        tasks: [{ id: UUID.taskForeign, companyId: "other-company", projectId: UUID.projForeign }],
      });
      const res = await callTool(app, "memory.retain", {
        title: "Sneaky",
        content: "Cross-tenant link",
        category: "context",
        layer: "working",
        sourceContext: "test",
        scopeToSelf: true,
        taskId: UUID.taskForeign,
      });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/i);
      expect(memoryCreate).not.toHaveBeenCalled();
    });

    it("rejects a foreign goalId (404) and does NOT create memory", async () => {
      const { app, memoryCreate } = buildApp({
        goals: [{ id: UUID.goalForeign, companyId: "other-company" }],
      });
      const res = await callTool(app, "memory.retain", {
        title: "Sneaky goal",
        content: "Cross-tenant goal link",
        category: "context",
        layer: "domain",
        sourceContext: "test",
        goalId: UUID.goalForeign,
      });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/i);
      expect(memoryCreate).not.toHaveBeenCalled();
    });

    it("rejects a foreign projectId (404) and does NOT create memory", async () => {
      const { app, memoryCreate } = buildApp({
        projects: [{ id: UUID.projForeign, companyId: "other-company", type: "project" }],
      });
      const res = await callTool(app, "memory.retain", {
        title: "Sneaky project",
        content: "Cross-tenant project link",
        category: "context",
        layer: "domain",
        sourceContext: "test",
        projectId: UUID.projForeign,
      });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/i);
      expect(memoryCreate).not.toHaveBeenCalled();
    });

    it("rejects a foreign departmentId (404) and does NOT create memory", async () => {
      const { app, memoryCreate } = buildApp({
        projects: [{ id: UUID.deptForeign, companyId: "other-company", type: "department" }],
      });
      const res = await callTool(app, "memory.retain", {
        title: "Sneaky dept",
        content: "Cross-tenant department link",
        category: "context",
        layer: "domain",
        sourceContext: "test",
        departmentId: UUID.deptForeign,
      });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/i);
      expect(memoryCreate).not.toHaveBeenCalled();
    });

    it("allows same-company linked entities and creates the memory item", async () => {
      const { app, memoryCreate } = buildApp({
        tasks: [{ id: UUID.taskMine, companyId: "company-1", projectId: UUID.projMine }],
        goals: [{ id: UUID.goalMine, companyId: "company-1" }],
        projects: [{ id: UUID.projMine, companyId: "company-1", type: "project" }],
      });
      const res = await callTool(app, "memory.retain", {
        title: "Valid",
        content: "All same-company links",
        category: "context",
        layer: "domain",
        sourceContext: "test",
        taskId: UUID.taskMine,
        goalId: UUID.goalMine,
        projectId: UUID.projMine,
      });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.id).toBeTruthy();
      expect(memoryCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("memory.write — agent actor RBAC bypass (P2)", () => {
    beforeEach(() => {
      mockWriteMemoryAndIndex.mockReset();
    });

    const agentActor = {
      type: "agent",
      source: "agent",
      userId: "agent-1",
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    } as const;

    it("an agent actor can write memory even when user-RBAC denies (item is pending)", async () => {
      mockWriteMemoryAndIndex.mockResolvedValue({
        id: "mem-agent-1",
        status: "pending",
        source: "agent",
        title: "Learned X",
      });
      // canAccessMemory checks USER roles; for an agent actor userId is the agent
      // id with no roles, so it would deny — the handler must bypass it.
      const denyMemory = vi.fn().mockResolvedValue(false);
      const { app } = buildApp({ actor: agentActor, canAccessMemory: denyMemory });

      const res = await callTool(app, "memory.write", {
        title: "Learned X",
        content: "during the task",
        category: "context",
        layer: "domain",
        sourceContext: "task run",
      });

      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.status).toBe("pending");
      expect(mockWriteMemoryAndIndex).toHaveBeenCalledTimes(1);
      // RBAC must NOT have been consulted for the agent actor.
      expect(denyMemory).not.toHaveBeenCalled();
    });

    it("a non-agent (mcp) actor is still 403'd when user-RBAC denies", async () => {
      mockWriteMemoryAndIndex.mockResolvedValue({ id: "mem-2", status: "pending" });
      const denyMemory = vi.fn().mockResolvedValue(false);
      // Default actor is an mcp_key actor (not an agent).
      const { app } = buildApp({ canAccessMemory: denyMemory });

      const res = await callTool(app, "memory.write", {
        title: "Learned X",
        content: "during the task",
        category: "context",
        layer: "domain",
        sourceContext: "task run",
      });

      expect(res.status).toBe(403);
      expect(mockWriteMemoryAndIndex).not.toHaveBeenCalled();
    });
  });
});
