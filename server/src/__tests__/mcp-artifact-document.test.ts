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
    accessService: noopFactory,
    projectService: noopFactory,
    approvalService: noopFactory,
    issueApprovalService: noopFactory,
    logActivity: vi.fn().mockResolvedValue(undefined),
  };
});

import { mcpServerRoutes } from "../mcp/server.js";

type Task = {
  id: string;
  companyId: string;
  projectId: string | null;
  title?: string;
  artifactId?: string | null;
};

type ArtifactVersion = {
  id: string;
  artifactId: string;
  versionNumber: number;
  source: string;
  sourceDetail?: string | null;
  changelog?: string | null;
  parentVersionId?: string | null;
  content?: string | null;
  fileUrl?: string | null;
};

type Artifact = {
  id: string;
  companyId: string;
  title: string;
  type: string;
  currentVersionId?: string | null;
  versions: ArtifactVersion[];
};

function buildApp(options?: {
  actor?: Record<string, unknown>;
  resolveScope?: (
    companyId: string,
    actor: { source: string; userId: string },
  ) => Promise<any>;
  resolveRole?: (companyId: string, userId: string) => Promise<string>;
  tasks?: Task[];
  artifacts?: Artifact[];
  canAccessEntity?: (
    companyId: string,
    userId: string,
    entityType: string,
    action: string,
    context?: any,
  ) => Promise<boolean>;
  createArtifact?: (
    companyId: string,
    createdById: string,
    data: any,
  ) => Promise<any>;
  addVersion?: (artifactId: string, data: any) => Promise<any>;
  updateIssue?: (id: string, data: any) => Promise<any>;
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

  const taskList = options?.tasks ?? [];
  const artifactList = options?.artifacts ?? [];
  const addVersionFn =
    options?.addVersion ??
    vi.fn().mockImplementation(async (artifactId: string, data: any) => {
      const art = artifactList.find((a) => a.id === artifactId);
      const nextNumber =
        (art?.versions.reduce((max, v) => Math.max(max, v.versionNumber), 0) ?? 0) + 1;
      return {
        id: `ver-new-${nextNumber}`,
        artifactId,
        versionNumber: nextNumber,
        source: data.source,
        sourceDetail: data.sourceDetail ?? null,
        changelog: data.changelog ?? null,
        parentVersionId: data.parentVersionId ?? null,
        content: data.content ?? null,
        fileUrl: data.fileUrl ?? null,
      };
    });
  const createArtifactFn =
    options?.createArtifact ??
    vi.fn().mockImplementation(async (companyId: string, _createdById: string, data: any) => ({
      id: "art-new",
      companyId,
      title: data.title,
      type: data.type,
      currentVersionId: "ver-new-1",
      versions: [
        {
          id: "ver-new-1",
          artifactId: "art-new",
          versionNumber: 1,
          source: data.source ?? "mcp",
          sourceDetail: data.sourceDetail ?? null,
          changelog: data.changelog ?? null,
          content: data.content ?? null,
          fileUrl: data.fileUrl ?? null,
        },
      ],
    }));
  const updateIssueFn =
    options?.updateIssue ??
    vi.fn().mockImplementation(async (id: string, data: any) => {
      const existing = taskList.find((t) => t.id === id);
      if (!existing) return null;
      return { ...existing, ...data };
    });

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
        create: vi.fn(),
        update: updateIssueFn,
        addComment: vi.fn(),
        listComments: vi.fn().mockResolvedValue([]),
        getComment: vi.fn().mockResolvedValue(null),
      } as any,
      goalsSvc: { list: vi.fn().mockResolvedValue([]), getById: vi.fn().mockResolvedValue(null) } as any,
      memorySvc: {
        list: vi.fn().mockResolvedValue([]),
        getById: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      } as any,
      artifactsSvc: {
        list: vi.fn().mockResolvedValue(artifactList),
        getById: vi
          .fn()
          .mockImplementation(async (id: string) => artifactList.find((a) => a.id === id) ?? null),
        create: createArtifactFn,
        addVersion: addVersionFn,
      } as any,
      debriefsSvc: { create: vi.fn() } as any,
      extractionSvc: { extractFromDebrief: vi.fn() } as any,
      permissionsSvc: {
        canAccessEntity: options?.canAccessEntity ?? vi.fn().mockResolvedValue(true),
        canAccessMemory: vi.fn().mockResolvedValue(true),
      } as any,
      agentsSvc: {
        list: vi.fn().mockResolvedValue([]),
        getById: vi.fn().mockResolvedValue(null),
      } as any,
      projectsSvc: {
        list: vi.fn().mockResolvedValue([]),
        getById: vi.fn().mockResolvedValue(null),
      } as any,
    }),
  );

  return { app, addVersionFn, createArtifactFn, updateIssueFn };
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

describe("MCP task-document tools (artifact mapping)", () => {
  describe("tools/list exposes the 5 document tools", () => {
    it("lists upsert/list/get/list-revisions/restore task-document tools", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/api/companies/company-1/mcp")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      expect(res.status).toBe(200);
      const names = res.body.result.tools.map((t: any) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "upsert-task-document",
          "list-task-documents",
          "get-task-document",
          "list-task-document-revisions",
          "restore-task-document-revision",
        ]),
      );
    });
  });

  describe("upsert-task-document", () => {
    it("creates a new artifact + first version when task has no document yet", async () => {
      const { app, createArtifactFn, updateIssueFn } = buildApp({
        tasks: [
          {
            id: "t-1",
            companyId: "company-1",
            projectId: "proj-1",
            artifactId: null,
            title: "Spec",
          },
        ],
      });
      const res = await callTool(app, "upsert-task-document", {
        taskId: "t-1",
        title: "Spec doc",
        body: "# Initial spec\n\nbody",
        changeSummary: "first draft",
      });
      expect(res.status).toBe(200);
      expect(createArtifactFn).toHaveBeenCalledTimes(1);
      expect(updateIssueFn).toHaveBeenCalledWith(
        "t-1",
        expect.objectContaining({ artifactId: "art-new" }),
      );
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.artifactId).toBe("art-new");
      expect(payload.version.versionNumber).toBe(1);
    });

    it("adds a new immutable version when task already has a document artifact", async () => {
      const existingArt: Artifact = {
        id: "art-1",
        companyId: "company-1",
        title: "Existing doc",
        type: "document",
        currentVersionId: "ver-1",
        versions: [
          {
            id: "ver-1",
            artifactId: "art-1",
            versionNumber: 1,
            source: "mcp",
            content: "v1 body",
          },
        ],
      };
      const { app, addVersionFn, createArtifactFn, updateIssueFn } = buildApp({
        tasks: [
          {
            id: "t-1",
            companyId: "company-1",
            projectId: "proj-1",
            artifactId: "art-1",
          },
        ],
        artifacts: [existingArt],
      });
      const res = await callTool(app, "upsert-task-document", {
        taskId: "t-1",
        body: "v2 body",
        changeSummary: "second rev",
      });
      expect(res.status).toBe(200);
      expect(addVersionFn).toHaveBeenCalledWith(
        "art-1",
        expect.objectContaining({ source: "mcp", content: "v2 body" }),
      );
      expect(createArtifactFn).not.toHaveBeenCalled();
      expect(updateIssueFn).not.toHaveBeenCalled();
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.artifactId).toBe("art-1");
      expect(payload.version.versionNumber).toBe(2);
    });

    it("returns 404 for a task in another company", async () => {
      const { app } = buildApp({
        tasks: [
          { id: "t-x", companyId: "other-company", projectId: "proj-x" },
        ],
      });
      const res = await callTool(app, "upsert-task-document", {
        taskId: "t-x",
        body: "nope",
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 when scoped user targets a task outside their scope", async () => {
      const { app } = buildApp({
        resolveScope: async (_c, actor) => ({
          kind: "scoped",
          userId: actor.userId,
          projectIds: new Set(["proj-mine"]),
        }),
        resolveRole: async () => "team_member",
        tasks: [{ id: "t-other", companyId: "company-1", projectId: "proj-other" }],
      });
      const res = await callTool(app, "upsert-task-document", {
        taskId: "t-other",
        body: "blocked",
      });
      expect(res.status).toBe(404);
    });

    it("returns 403 when role lacks artifact update permission", async () => {
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", artifactId: null },
        ],
        canAccessEntity: vi.fn().mockResolvedValue(false),
      });
      const res = await callTool(app, "upsert-task-document", {
        taskId: "t-1",
        body: "blocked",
      });
      expect(res.status).toBe(403);
    });
  });

  describe("list-task-documents", () => {
    it("returns [] when the task has no artifact", async () => {
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", artifactId: null },
        ],
      });
      const res = await callTool(app, "list-task-documents", { taskId: "t-1" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toEqual([]);
    });

    it("returns the single document artifact when present", async () => {
      const art: Artifact = {
        id: "art-1",
        companyId: "company-1",
        title: "Doc",
        type: "document",
        versions: [
          { id: "ver-1", artifactId: "art-1", versionNumber: 1, source: "mcp" },
        ],
      };
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", artifactId: "art-1" },
        ],
        artifacts: [art],
      });
      const res = await callTool(app, "list-task-documents", { taskId: "t-1" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toHaveLength(1);
      expect(payload[0].id).toBe("art-1");
    });

    it("returns 404 for a task in another company", async () => {
      const { app } = buildApp({
        tasks: [{ id: "t-x", companyId: "other-company", projectId: "p" }],
      });
      const res = await callTool(app, "list-task-documents", { taskId: "t-x" });
      expect(res.status).toBe(404);
    });
  });

  describe("get-task-document", () => {
    it("returns artifact + latest version (content + metadata)", async () => {
      const art: Artifact = {
        id: "art-1",
        companyId: "company-1",
        title: "Doc",
        type: "document",
        currentVersionId: "ver-2",
        versions: [
          { id: "ver-2", artifactId: "art-1", versionNumber: 2, source: "mcp", content: "v2" },
          { id: "ver-1", artifactId: "art-1", versionNumber: 1, source: "mcp", content: "v1" },
        ],
      };
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", artifactId: "art-1" },
        ],
        artifacts: [art],
      });
      const res = await callTool(app, "get-task-document", { taskId: "t-1" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.artifact.id).toBe("art-1");
      expect(payload.latestVersion.versionNumber).toBe(2);
      expect(payload.latestVersion.content).toBe("v2");
    });

    it("returns 404 when task has no artifact", async () => {
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", artifactId: null },
        ],
      });
      const res = await callTool(app, "get-task-document", { taskId: "t-1" });
      expect(res.status).toBe(404);
    });
  });

  describe("list-task-document-revisions", () => {
    it("returns all versions ordered ascending by versionNumber (immutable history)", async () => {
      const art: Artifact = {
        id: "art-1",
        companyId: "company-1",
        title: "Doc",
        type: "document",
        versions: [
          { id: "ver-3", artifactId: "art-1", versionNumber: 3, source: "mcp" },
          { id: "ver-1", artifactId: "art-1", versionNumber: 1, source: "mcp" },
          { id: "ver-2", artifactId: "art-1", versionNumber: 2, source: "mcp" },
        ],
      };
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", artifactId: "art-1" },
        ],
        artifacts: [art],
      });
      const res = await callTool(app, "list-task-document-revisions", { taskId: "t-1" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.map((v: any) => v.versionNumber)).toEqual([1, 2, 3]);
    });

    it("returns [] when task has no artifact", async () => {
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", artifactId: null },
        ],
      });
      const res = await callTool(app, "list-task-document-revisions", { taskId: "t-1" });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload).toEqual([]);
    });
  });

  describe("restore-task-document-revision", () => {
    it("creates a NEW version with content copied from the target (never mutates old)", async () => {
      const target: ArtifactVersion = {
        id: "ver-1",
        artifactId: "art-1",
        versionNumber: 1,
        source: "mcp",
        content: "original body",
        fileUrl: null,
      };
      const latest: ArtifactVersion = {
        id: "ver-2",
        artifactId: "art-1",
        versionNumber: 2,
        source: "mcp",
        content: "edits",
      };
      const art: Artifact = {
        id: "art-1",
        companyId: "company-1",
        title: "Doc",
        type: "document",
        versions: [latest, target],
      };
      const { app, addVersionFn } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", artifactId: "art-1" },
        ],
        artifacts: [art],
      });
      const res = await callTool(app, "restore-task-document-revision", {
        taskId: "t-1",
        revisionId: "ver-1",
      });
      expect(res.status).toBe(200);
      expect(addVersionFn).toHaveBeenCalledWith(
        "art-1",
        expect.objectContaining({
          source: "mcp",
          content: "original body",
          parentVersionId: "ver-1",
        }),
      );
      // Immutability: the old version object passed in was not modified
      expect(target.content).toBe("original body");
      expect(target.versionNumber).toBe(1);
      // New version has versionNumber > max existing
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.version.versionNumber).toBe(3);
      expect(payload.restoredFromVersionId).toBe("ver-1");
    });

    it("returns 404 when task has no artifact", async () => {
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", artifactId: null },
        ],
      });
      const res = await callTool(app, "restore-task-document-revision", {
        taskId: "t-1",
        revisionId: "11111111-1111-1111-1111-111111111111",
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 when revisionId does not belong to the task's artifact", async () => {
      const art: Artifact = {
        id: "art-1",
        companyId: "company-1",
        title: "Doc",
        type: "document",
        versions: [
          { id: "ver-1", artifactId: "art-1", versionNumber: 1, source: "mcp", content: "a" },
        ],
      };
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", artifactId: "art-1" },
        ],
        artifacts: [art],
      });
      const res = await callTool(app, "restore-task-document-revision", {
        taskId: "t-1",
        revisionId: "99999999-9999-9999-9999-999999999999",
      });
      expect(res.status).toBe(404);
    });

    it("returns 403 when role lacks artifact update permission", async () => {
      const art: Artifact = {
        id: "art-1",
        companyId: "company-1",
        title: "Doc",
        type: "document",
        versions: [
          { id: "ver-1", artifactId: "art-1", versionNumber: 1, source: "mcp", content: "a" },
        ],
      };
      const { app } = buildApp({
        tasks: [
          { id: "t-1", companyId: "company-1", projectId: "proj-1", artifactId: "art-1" },
        ],
        artifacts: [art],
        canAccessEntity: vi.fn().mockResolvedValue(false),
      });
      const res = await callTool(app, "restore-task-document-revision", {
        taskId: "t-1",
        revisionId: "ver-1",
      });
      expect(res.status).toBe(403);
    });
  });
});
