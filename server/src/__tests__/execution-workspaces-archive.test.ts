import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock drizzle + db package ---

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };

  return {
    executionWorkspaces: makeTable("execution_workspaces"),
    issues: makeTable("issues"),
    projects: makeTable("projects"),
    projectWorkspaces: makeTable("project_workspaces"),
    workspaceRuntimeServices: makeTable("workspace_runtime_services"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _type: "and", args }),
  eq: (col: unknown, value: unknown) => ({ _type: "eq", col, value }),
  inArray: (col: unknown, values: unknown[]) => ({ _type: "inArray", col, values }),
  isNotNull: (col: unknown) => ({ _type: "isNotNull", col }),
  ne: (col: unknown, value: unknown) => ({ _type: "ne", col, value }),
  or: (...args: unknown[]) => ({ _type: "or", args }),
}));

// --- Mock services ---

const mockSvc = vi.hoisted(() => ({
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  loadEffectiveRuntimeServicesByExecutionWorkspace: vi.fn(),
  update: vi.fn(),
  updateIfVersion: vi.fn(),
  archiveIfVersion: vi.fn(),
  list: vi.fn(),
  listSummaries: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  createRecorder: vi.fn(() => ({ record: vi.fn(), finalize: vi.fn() })),
}));

const mockInstanceSettings = vi.hoisted(() => ({
  getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockStopRuntimeServices = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockStartRuntimeServices = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockAreRuntimeServicesTrackedLocally = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockBuildWorkspaceRuntimeDesiredStatePatch = vi.hoisted(() =>
  vi.fn().mockReturnValue({ desiredState: "stopped", serviceStates: null }),
);
const mockResolveConfiguredRuntimeServiceIndexForRow = vi.hoisted(() =>
  vi.fn().mockReturnValue(null),
);
const mockListConfiguredRuntimeServiceEntries = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockCleanupArtifacts = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ cleaned: true, warnings: [] }),
);
const mockEnsurePersistedWorkspace = vi.hoisted(() => vi.fn());
const mockDbSelectRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
const mockWorkspaceConfigPatchHasShellCommands = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockAssertCloudWorkspaceCommandConfigurationAllowed = vi.hoisted(() => vi.fn());
const MockRuntimeServiceActivationFenceError = vi.hoisted(() => class extends Error {
  cleanupArtifactsAllowed = true;
});

// Capture db.update(...).set(...).where(...) calls for shared-workspace detach assertion
const mockDbUpdateIssues = vi.hoisted(() => {
  const setFn = vi.fn();
  const whereFn = vi.fn();
  const update = vi.fn((_table: unknown) => ({
    set: (patch: unknown) => {
      setFn(patch);
      return { where: whereFn };
    },
  }));
  return { update, setFn, whereFn };
});

vi.mock("../services/index.js", () => ({
  executionWorkspaceService: () => mockSvc,
  instanceSettingsService: () => mockInstanceSettings,
  workspaceOperationService: () => mockWorkspaceOperationService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  RuntimeServiceActivationFenceError: MockRuntimeServiceActivationFenceError,
  areRuntimeServicesTrackedLocally: mockAreRuntimeServicesTrackedLocally,
  buildWorkspaceRuntimeDesiredStatePatch: mockBuildWorkspaceRuntimeDesiredStatePatch,
  stopRuntimeServicesForExecutionWorkspace: mockStopRuntimeServices,
  ensurePersistedExecutionWorkspaceAvailable: mockEnsurePersistedWorkspace,
  listConfiguredRuntimeServiceEntries: mockListConfiguredRuntimeServiceEntries,
  refreshPersistedRuntimeServiceRows: vi.fn(({ rows }) => rows),
  resolveConfiguredRuntimeServiceIndexForRow: mockResolveConfiguredRuntimeServiceIndexForRow,
  startRuntimeServicesForWorkspaceControl: mockStartRuntimeServices,
  cleanupExecutionWorkspaceArtifacts: mockCleanupArtifacts,
  withRuntimeControlLocks: async (_keys: unknown, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock("../services/execution-workspace-policy.js", () => ({
  parseProjectExecutionWorkspacePolicy: vi.fn().mockReturnValue(null),
}));

vi.mock("../services/workspace-authz.js", () => ({
  assertCanConfigureWorkspaceShellCommands: vi.fn().mockResolvedValue(undefined),
  assertCanControlWorkspace: vi.fn().mockResolvedValue(undefined),
  workspaceConfigPatchHasShellCommands: mockWorkspaceConfigPatchHasShellCommands,
}));

vi.mock("../routes/projects.js", () => ({
  assertCloudWorkspaceCommandConfigurationAllowed: mockAssertCloudWorkspaceCommandConfigurationAllowed,
}));

import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

function buildExistingWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    companyId: "co-1",
    projectId: "proj-1",
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "feature-x",
    status: "active",
    cwd: null,
    repoUrl: null,
    baseRef: null,
    branchName: null,
    providerType: "adapter_managed",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildReadiness(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-1",
    state: "ready",
    blockingReasons: [],
    warnings: [],
    linkedIssues: [],
    plannedActions: [],
    isDestructiveCloseAllowed: true,
    isSharedWorkspace: false,
    isProjectPrimaryWorkspace: false,
    git: null,
    runtimeServices: [],
    ...overrides,
  };
}

function buildRuntimeServiceRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "svc-1",
    companyId: "co-1",
    projectId: "proj-1",
    projectWorkspaceId: null,
    executionWorkspaceId: "ws-1",
    issueId: null,
    scopeType: "execution_workspace",
    scopeId: "ws-1",
    serviceName: "web",
    status: "running",
    lifecycle: "shared",
    reuseKey: "reuse-1",
    command: "pnpm dev",
    cwd: "C:\\repo",
    port: 5173,
    url: "http://127.0.0.1:5173",
    provider: "local_process",
    providerRef: null,
    processOwnerId: "owner-a",
    ownerAgentId: null,
    startedByRunId: null,
    lastUsedAt: now,
    startedAt: now,
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy",
    healthCheckedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createApp() {
  const db = {
    update: mockDbUpdateIssues.update,
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(mockDbSelectRows.rows));
      return chain;
    }),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: ["co-1"],
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes(db as any));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}

beforeEach(() => {
  process.env.AOA_RUNTIME_PROCESS_OWNER_ID = "owner-a";
});

afterEach(() => {
  delete process.env.AOA_RUNTIME_PROCESS_OWNER_ID;
});

describe("PATCH /api/execution-workspaces/:id — archive flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbSelectRows.rows = [];
    mockInstanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    process.env.AOA_RUNTIME_PROCESS_OWNER_ID = "owner-a";
    mockSvc.loadEffectiveRuntimeServicesByExecutionWorkspace.mockResolvedValue([]);
    mockSvc.updateIfVersion.mockImplementation(async (id, _expected, patch) => await mockSvc.update(id, patch));
    mockSvc.archiveIfVersion.mockImplementation(
      async ({ id, patch }) => await mockSvc.update(id, { ...patch, status: "archived" }),
    );
    mockStopRuntimeServices.mockResolvedValue(undefined);
    mockStartRuntimeServices.mockResolvedValue([]);
    mockEnsurePersistedWorkspace.mockReset();
    mockAreRuntimeServicesTrackedLocally.mockReturnValue(true);
    mockCleanupArtifacts.mockResolvedValue({ cleaned: true, warnings: [] });
    mockWorkspaceConfigPatchHasShellCommands.mockReturnValue(false);
  });

  it("returns 409 with blockingReasons when readiness.state === 'blocked'", async () => {
    const existing = buildExistingWorkspace({ mode: "isolated_workspace" });
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.getCloseReadiness.mockResolvedValue(
      buildReadiness({
        state: "blocked",
        blockingReasons: ["This workspace is still linked to an open task."],
      }),
    );

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/ws-1`)
      .send({ status: "archived" });

    expect(res.status).toBe(409);
    expect(res.body.blockingReasons).toEqual([
      "This workspace is still linked to an open task.",
    ]);
    expect(res.body.error).toBe("This workspace is still linked to an open task.");
    expect(mockSvc.update).not.toHaveBeenCalled();
  });

  it("detaches linked issues before cleanup when workspace is shared_workspace", async () => {
    const existing = buildExistingWorkspace({ mode: "shared_workspace" });
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.getCloseReadiness.mockResolvedValue(
      buildReadiness({ state: "ready_with_warnings", isSharedWorkspace: true }),
    );
    mockSvc.update.mockResolvedValue({ ...existing, status: "archived" });

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/ws-1`)
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(mockSvc.archiveIfVersion).toHaveBeenCalledWith(expect.objectContaining({
      id: "ws-1",
      companyId: "co-1",
      detachLinkedIssues: true,
    }));
    // archive still proceeds
    expect(mockSvc.update).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ status: "archived" }),
    );
    expect(mockStopRuntimeServices).toHaveBeenCalledWith(expect.objectContaining({
      executionWorkspaceId: "ws-1",
      workspaceCwd: null,
      preserveProjectWorkspaceServices: true,
    }));
  });

  it("applies the cloud execution-policy gate before persisting shell-command config", async () => {
    const existing = buildExistingWorkspace();
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.update.mockResolvedValue(existing);
    mockWorkspaceConfigPatchHasShellCommands.mockReturnValue(true);

    await request(createApp())
      .patch("/api/execution-workspaces/ws-1")
      .send({ config: { provisionCommand: "pnpm install" } });

    expect(mockAssertCloudWorkspaceCommandConfigurationAllowed).toHaveBeenCalledOnce();
  });

  it("does not detach linked issues for isolated_workspace archives", async () => {
    const existing = buildExistingWorkspace({ mode: "isolated_workspace" });
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.getCloseReadiness.mockResolvedValue(buildReadiness());
    mockSvc.update.mockResolvedValue({ ...existing, status: "archived" });

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/ws-1`)
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(mockSvc.archiveIfVersion).toHaveBeenCalledWith(expect.objectContaining({
      detachLinkedIssues: false,
    }));
    expect(mockSvc.update).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ status: "archived" }),
    );
  });

  it("proceeds with archive when readiness.state is 'ready'", async () => {
    const existing = buildExistingWorkspace();
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.getCloseReadiness.mockResolvedValue(buildReadiness({ state: "ready" }));
    mockSvc.update.mockResolvedValue({ ...existing, status: "archived" });

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/ws-1`)
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(mockStopRuntimeServices).toHaveBeenCalled();
    expect(mockCleanupArtifacts).toHaveBeenCalled();
  });

  it("proceeds with archive when readiness.state is 'ready_with_warnings'", async () => {
    const existing = buildExistingWorkspace();
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.getCloseReadiness.mockResolvedValue(
      buildReadiness({ state: "ready_with_warnings", warnings: ["dirty files"] }),
    );
    mockSvc.update.mockResolvedValue({ ...existing, status: "archived" });

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/ws-1`)
      .send({ status: "archived" });

    expect(res.status).toBe(200);
  });

  it("rejects public attempts to reopen a workspace", async () => {
    const existing = buildExistingWorkspace();
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.update.mockResolvedValue({ ...existing, status: "idle" });

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/ws-1`)
      .send({ status: "idle" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockSvc.getCloseReadiness).not.toHaveBeenCalled();
    expect(mockSvc.update).not.toHaveBeenCalled();
  });

  it("passes through archive update when workspace already archived (no-op on readiness)", async () => {
    const existing = buildExistingWorkspace({ status: "archived" });
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.update.mockResolvedValue(existing);

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/ws-1`)
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    // readiness check is skipped for already-archived workspaces
    expect(mockSvc.getCloseReadiness).not.toHaveBeenCalled();
  });

  it("rejects public metadata writes that could forge filesystem ownership", async () => {
    const existing = buildExistingWorkspace({
      metadata: {
        config: { provisionCommand: "pnpm install" },
        other: "original",
      },
    });
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.update.mockResolvedValue({ ...existing, status: "idle" });

    const res = await request(createApp())
      .patch(`/api/execution-workspaces/ws-1`)
      .send({ metadata: { other: "updated" } });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockSvc.update).not.toHaveBeenCalled();
  });
});

describe("GET /api/execution-workspaces/:id/runtime-services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbSelectRows.rows = [];
    mockInstanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
  });

  it("returns preview fields for proxyable runtime services", async () => {
    mockSvc.getById.mockResolvedValue(buildExistingWorkspace());
    mockDbSelectRows.rows = [buildRuntimeServiceRow()];

    const res = await request(createApp())
      .get(`/api/execution-workspaces/ws-1/runtime-services`);

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: "svc-1",
      url: "http://127.0.0.1:5173",
      previewUrl: "/preview/services/svc-1/",
      previewAccess: "local",
      localTargetUrl: "http://127.0.0.1:5173/",
      healthCheckedAt: null,
    }));
  });

  it("omits preview URLs for unsafe runtime service targets", async () => {
    mockSvc.getById.mockResolvedValue(buildExistingWorkspace());
    mockDbSelectRows.rows = [buildRuntimeServiceRow({
      url: "https://example.com",
    })];

    const res = await request(createApp())
      .get(`/api/execution-workspaces/ws-1/runtime-services`);

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(expect.objectContaining({
      url: "https://example.com",
      previewUrl: null,
      previewAccess: null,
      localTargetUrl: null,
    }));
  });
});

describe("POST /api/execution-workspaces/:id/runtime-services/stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbSelectRows.rows = [];
    mockInstanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockSvc.loadEffectiveRuntimeServicesByExecutionWorkspace.mockResolvedValue([]);
    mockSvc.updateIfVersion.mockImplementation(async (id, _expected, patch) => await mockSvc.update(id, patch));
    mockStopRuntimeServices.mockResolvedValue(undefined);
    mockStartRuntimeServices.mockResolvedValue([]);
    mockEnsurePersistedWorkspace.mockReset();
    mockListConfiguredRuntimeServiceEntries.mockReturnValue([]);
    mockBuildWorkspaceRuntimeDesiredStatePatch.mockReturnValue({ desiredState: "stopped", serviceStates: null });
    mockResolveConfiguredRuntimeServiceIndexForRow.mockReturnValue(null);
    mockAreRuntimeServicesTrackedLocally.mockReturnValue(true);
    process.env.AOA_RUNTIME_PROCESS_OWNER_ID = "owner-a";
  });

  it("does not archive when the workspace generation changed after readiness", async () => {
    const existing = buildExistingWorkspace();
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.getCloseReadiness.mockResolvedValue(buildReadiness());
    mockSvc.archiveIfVersion.mockResolvedValue(null);

    const res = await request(createApp())
      .patch("/api/execution-workspaces/ws-1")
      .send({ status: "archived" });

    expect(res.status).toBe(409);
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
    expect(mockCleanupArtifacts).not.toHaveBeenCalled();
  });

  it.each(["archived", "cleanup_failed"])("rejects runtime activation for a %s workspace", async (status) => {
    const existing = buildExistingWorkspace({
      status,
      cwd: "C:/tmp/ws-1",
      config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } },
    });
    mockSvc.getById.mockResolvedValue(existing);

    const res = await request(createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/start")
      .send({});

    expect(res.status).toBe(409);
    expect(mockEnsurePersistedWorkspace).not.toHaveBeenCalled();
    expect(mockStartRuntimeServices).not.toHaveBeenCalled();
  });

  it("rejects activation when config changed between the initial and activation reads", async () => {
    const existing = buildExistingWorkspace({
      cwd: "C:/tmp/ws-1",
      config: { workspaceRuntime: { services: [{ name: "old", command: "pnpm dev" }] } },
      updatedAt: new Date("2026-08-03T00:00:00Z"),
    });
    const changed = {
      ...existing,
      config: { workspaceRuntime: { services: [{ name: "new", command: "pnpm start" }] } },
      updatedAt: new Date("2026-08-03T00:00:01Z"),
    };
    mockSvc.getById.mockResolvedValueOnce(existing).mockResolvedValueOnce(changed);

    const res = await request(createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/start")
      .send({});

    expect(res.status).toBe(409);
    expect(mockEnsurePersistedWorkspace).not.toHaveBeenCalled();
    expect(mockStartRuntimeServices).not.toHaveBeenCalled();
  });

  it("cleans recreated artifacts when the atomic activation commit is rejected", async () => {
    const active = buildExistingWorkspace({
      mode: "shared_workspace",
      cwd: "C:/repo/.aoa/worktrees/ws-1",
      providerType: "git_worktree",
      providerRef: "C:/repo/.aoa/worktrees/ws-1",
      projectWorkspaceId: "project-workspace-1",
      config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } },
      metadata: { createdByRuntime: true },
    });
    mockSvc.getById.mockResolvedValue(active);
    mockListConfiguredRuntimeServiceEntries.mockReturnValue([{ name: "web", command: "pnpm dev" }]);
    mockEnsurePersistedWorkspace.mockResolvedValue({
      baseCwd: "C:/repo",
      source: "project_primary",
      projectId: "proj-1",
      workspaceId: "project-workspace-1",
      repoUrl: null,
      repoRef: null,
      strategy: "git_worktree",
      cwd: "C:/repo/.aoa/worktrees/ws-1",
      branchName: "feature-x",
      worktreePath: "C:/repo/.aoa/worktrees/ws-1",
      warnings: [],
      created: true,
    });
    mockSvc.updateIfVersion.mockResolvedValue(null);
    mockStartRuntimeServices.mockImplementation(async (input) => {
      if (!(await input.commitGuard())) throw new MockRuntimeServiceActivationFenceError();
      return [];
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/start")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
    expect(mockCleanupArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      workspace: expect.objectContaining({
        id: "ws-1",
        providerRef: "C:/repo/.aoa/worktrees/ws-1",
      }),
    }));
  });

  it("returns conflict when the in-batch desired-state CAS loses a concurrent mutation", async () => {
    const active = buildExistingWorkspace({
      cwd: "C:/tmp/ws-1",
      config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } },
    });
    mockSvc.getById.mockResolvedValue(active);
    mockListConfiguredRuntimeServiceEntries.mockReturnValue([{ name: "web", command: "pnpm dev" }]);
    mockEnsurePersistedWorkspace.mockResolvedValue({
      baseCwd: "C:/tmp/ws-1",
      source: "task_session",
      projectId: "proj-1",
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      strategy: "project_primary",
      cwd: "C:/tmp/ws-1",
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
    });
    mockSvc.updateIfVersion.mockResolvedValue(null);
    mockStartRuntimeServices.mockImplementation(async (input) => {
      if (!(await input.commitGuard())) throw new MockRuntimeServiceActivationFenceError();
      return [];
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/start")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
  });

  it("accepts a persisted effective runtime service id instead of relying on getById embedding services", async () => {
    const existing = buildExistingWorkspace({
      cwd: "C:/tmp/ws-1",
      config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } },
      metadata: { config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } } },
    });
    const runtimeServiceId = "00000000-0000-4000-8000-000000000001";
    const service = {
      id: runtimeServiceId,
      companyId: "co-1",
      projectId: "proj-1",
      projectWorkspaceId: null,
      executionWorkspaceId: "ws-1",
      issueId: null,
      scopeType: "execution_workspace",
      scopeId: "ws-1",
      serviceName: "web",
      status: "running",
      lifecycle: "shared",
      reuseKey: null,
      command: "pnpm dev",
      cwd: "C:/tmp/ws-1",
      port: 3200,
      url: "http://127.0.0.1:3200",
      provider: "local_process",
      providerRef: "12345",
      processOwnerId: "owner-a",
      ownerAgentId: null,
      startedByRunId: null,
      lastUsedAt: new Date(),
      startedAt: new Date(),
      stoppedAt: null,
      stopPolicy: null,
      healthStatus: "healthy",
      healthCheckedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.loadEffectiveRuntimeServicesByExecutionWorkspace.mockResolvedValue([service]);
    mockDbSelectRows.rows = [service];
    mockSvc.update.mockResolvedValue(existing);

    const res = await request(createApp())
      .post(`/api/execution-workspaces/ws-1/runtime-services/stop`)
      .send({ runtimeServiceId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockStopRuntimeServices).toHaveBeenCalledWith(expect.objectContaining({
      executionWorkspaceId: "ws-1",
      runtimeServiceIds: [runtimeServiceId],
    }));
  });

  it.each([
    { status: "running", providerRef: null },
    { status: "stopped", providerRef: "4242" },
  ])("refuses archive before mutation when a local process owner is unavailable ($status)", async (state) => {
    const existing = buildExistingWorkspace({ mode: "isolated_workspace" });
    const service = buildRuntimeServiceRow(state);
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.getCloseReadiness.mockResolvedValue(buildReadiness({
      state: "ready_with_warnings",
      runtimeServices: [service],
    }));
    mockDbSelectRows.rows = [service];
    mockAreRuntimeServicesTrackedLocally.mockReturnValue(false);

    const res = await request(createApp())
      .patch("/api/execution-workspaces/ws-1")
      .send({ status: "archived" });

    expect(res.status).toBe(409);
    expect(mockSvc.update).not.toHaveBeenCalled();
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
    expect(mockCleanupArtifacts).not.toHaveBeenCalled();
  });

  it("returns conflict before mutating desired state for a foreign-owner local service", async () => {
    const existing = buildExistingWorkspace({
      cwd: "C:/tmp/ws-1",
      config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } },
      metadata: { config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } } },
    });
    const service = buildRuntimeServiceRow({
      id: "00000000-0000-4000-8000-000000000099",
      provider: "local_process",
      status: "running",
    });
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.loadEffectiveRuntimeServicesByExecutionWorkspace.mockResolvedValue([service]);
    mockDbSelectRows.rows = [service];
    mockAreRuntimeServicesTrackedLocally.mockReturnValue(false);
    mockResolveConfiguredRuntimeServiceIndexForRow.mockReturnValue(0);

    const res = await request(createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/stop")
      .send({ runtimeServiceId: service.id });

    expect(res.status).toBe(409);
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
    expect(mockSvc.update).not.toHaveBeenCalled();
  });

  it("returns conflict when restart targets a terminal foreign row that retains a PID", async () => {
    const existing = buildExistingWorkspace({
      cwd: "C:/tmp/ws-1",
      config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } },
      metadata: { config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } } },
    });
    const service = buildRuntimeServiceRow({
      id: "00000000-0000-4000-8000-000000000098",
      provider: "local_process",
      status: "stopped",
      providerRef: "4242",
      cwd: "C:/tmp/ws-1",
    });
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.loadEffectiveRuntimeServicesByExecutionWorkspace.mockResolvedValue([service]);
    mockDbSelectRows.rows = [service];
    mockAreRuntimeServicesTrackedLocally.mockReturnValue(false);
    mockResolveConfiguredRuntimeServiceIndexForRow.mockReturnValue(0);
    mockResolveConfiguredRuntimeServiceIndexForRow.mockReturnValue(0);

    const res = await request(createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/restart")
      .send({ runtimeServiceId: service.id });

    expect(res.status).toBe(409);
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
    expect(mockSvc.update).not.toHaveBeenCalled();
  });

  it("stops only the runtime row mapped to a selected serviceIndex", async () => {
    const existing = buildExistingWorkspace({
      cwd: "C:/tmp/ws-1",
      config: { workspaceRuntime: { services: [{ name: "web" }, { name: "api" }] } },
      metadata: { config: { workspaceRuntime: { services: [{ name: "web" }, { name: "api" }] } } },
    });
    const web = buildRuntimeServiceRow({ id: "00000000-0000-4000-8000-000000000010", serviceName: "web" });
    const api = buildRuntimeServiceRow({ id: "00000000-0000-4000-8000-000000000011", serviceName: "api" });
    mockListConfiguredRuntimeServiceEntries.mockReturnValue([{ name: "web" }, { name: "api" }]);
    mockResolveConfiguredRuntimeServiceIndexForRow.mockImplementation(({ row }: any) =>
      row.serviceName === "web" ? 0 : 1,
    );
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.loadEffectiveRuntimeServicesByExecutionWorkspace.mockResolvedValue([web, api]);
    mockDbSelectRows.rows = [web, api];
    mockSvc.update.mockResolvedValue(existing);

    const res = await request(createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/stop")
      .send({ serviceIndex: 0 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockStopRuntimeServices).toHaveBeenCalledWith(expect.objectContaining({
      runtimeServiceIds: [web.id],
    }));
    expect(res.body.runtimeServiceCount).toBe(1);
  });

  it("stops every raw PID-bearing row mapped to the selected serviceIndex", async () => {
    const existing = buildExistingWorkspace({
      cwd: "C:/tmp/ws-1",
      config: { workspaceRuntime: { services: [{ name: "web" }] } },
      metadata: { config: { workspaceRuntime: { services: [{ name: "web" }] } } },
    });
    const visible = buildRuntimeServiceRow({ id: "00000000-0000-4000-8000-000000000040" });
    const hidden = buildRuntimeServiceRow({ id: "00000000-0000-4000-8000-000000000041" });
    mockListConfiguredRuntimeServiceEntries.mockReturnValue([{ name: "web" }]);
    mockResolveConfiguredRuntimeServiceIndexForRow.mockReturnValue(0);
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.loadEffectiveRuntimeServicesByExecutionWorkspace.mockResolvedValue([visible]);
    mockDbSelectRows.rows = [visible, hidden];
    mockSvc.update.mockResolvedValue(existing);

    const res = await request(createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/stop")
      .send({ serviceIndex: 0 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockStopRuntimeServices).toHaveBeenCalledWith(expect.objectContaining({
      runtimeServiceIds: [visible.id, hidden.id],
    }));
  });

  it("blocks indexed control when PID-bearing rows map ambiguously", async () => {
    const duplicateServices = [
      { name: "web", command: "pnpm dev" },
      { name: "web", command: "pnpm dev" },
    ];
    const existing = buildExistingWorkspace({
      cwd: "C:/tmp/ws-1",
      config: { workspaceRuntime: { services: duplicateServices } },
      metadata: { config: { workspaceRuntime: { services: duplicateServices } } },
    });
    const foreign = buildRuntimeServiceRow({
      id: "00000000-0000-4000-8000-000000000012",
      processOwnerId: "owner-b",
      providerRef: "4242",
    });
    mockListConfiguredRuntimeServiceEntries.mockReturnValue(duplicateServices);
    mockResolveConfiguredRuntimeServiceIndexForRow.mockReturnValue(null);
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.loadEffectiveRuntimeServicesByExecutionWorkspace.mockResolvedValue([]);
    mockDbSelectRows.rows = [foreign];

    const res = await request(createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/restart")
      .send({ serviceIndex: 0 });

    expect(res.status).toBe(409);
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
    expect(mockStartRuntimeServices).not.toHaveBeenCalled();
  });

  it("blocks start when a hidden raw PID-bearing row is not locally owned", async () => {
    const existing = buildExistingWorkspace({
      cwd: "C:/tmp/ws-1",
      config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } },
      metadata: { config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } } },
    });
    const newerStopped = buildRuntimeServiceRow({
      id: "00000000-0000-4000-8000-000000000020",
      status: "stopped",
      providerRef: null,
      updatedAt: new Date("2026-08-03T02:00:00Z"),
    });
    const olderForeign = buildRuntimeServiceRow({
      id: "00000000-0000-4000-8000-000000000021",
      status: "running",
      providerRef: "4242",
      processOwnerId: "owner-b",
      updatedAt: new Date("2026-08-03T01:00:00Z"),
    });
    mockSvc.getById.mockResolvedValue(existing);
    // Presentation reads have already deduplicated away olderForeign.
    mockSvc.loadEffectiveRuntimeServicesByExecutionWorkspace.mockResolvedValue([newerStopped]);
    // Raw safety query still sees it.
    mockDbSelectRows.rows = [olderForeign];
    mockAreRuntimeServicesTrackedLocally.mockReturnValue(false);

    const res = await request(createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/start")
      .send({});

    expect(res.status).toBe(409);
    expect(mockStartRuntimeServices).not.toHaveBeenCalled();
    expect(mockSvc.update).not.toHaveBeenCalled();
  });

  it("blocks restart by runtimeServiceId when a changed hidden row cannot be mapped", async () => {
    const existing = buildExistingWorkspace({
      cwd: "C:/tmp/ws-1",
      config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } },
      metadata: { config: { workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] } } },
    });
    const selected = buildRuntimeServiceRow({
      id: "00000000-0000-4000-8000-000000000030",
      status: "stopped",
      providerRef: null,
      command: "pnpm dev",
      cwd: "C:/tmp/ws-1",
    });
    const hiddenForeign = buildRuntimeServiceRow({
      id: "00000000-0000-4000-8000-000000000031",
      status: "running",
      providerRef: "4242",
      processOwnerId: "owner-b",
      command: "npm run old-dev",
      cwd: "C:/tmp/old-ws",
    });
    mockListConfiguredRuntimeServiceEntries.mockReturnValue([{ name: "web", command: "pnpm dev" }]);
    mockResolveConfiguredRuntimeServiceIndexForRow.mockImplementation(({ row }: any) =>
      row.id === selected.id ? 0 : null,
    );
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.loadEffectiveRuntimeServicesByExecutionWorkspace.mockResolvedValue([selected]);
    mockDbSelectRows.rows = [hiddenForeign];

    const res = await request(createApp())
      .post("/api/execution-workspaces/ws-1/runtime-services/restart")
      .send({ runtimeServiceId: selected.id });

    expect(res.status).toBe(409);
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
    expect(mockStartRuntimeServices).not.toHaveBeenCalled();
  });

  it("persists stopped desired state for a mappable configured service id", async () => {
    const existing = buildExistingWorkspace({
      cwd: "C:/tmp/ws-1",
      config: {
        workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] },
        desiredState: "running",
        serviceStates: { "0": "running" },
      },
      metadata: {
        config: {
          workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] },
          desiredState: "running",
          serviceStates: { "0": "running" },
        },
      },
    });
    const runtimeServiceId = "00000000-0000-4000-8000-000000000001";
    const service = buildRuntimeServiceRow({
      id: runtimeServiceId,
      command: "pnpm dev",
      cwd: "C:/tmp/ws-1",
    });
    mockSvc.getById.mockResolvedValue(existing);
    mockSvc.loadEffectiveRuntimeServicesByExecutionWorkspace.mockResolvedValue([service]);
    mockDbSelectRows.rows = [service];
    mockResolveConfiguredRuntimeServiceIndexForRow.mockReturnValue(0);
    mockBuildWorkspaceRuntimeDesiredStatePatch.mockReturnValue({
      desiredState: "stopped",
      serviceStates: { "0": "stopped" },
    });
    mockSvc.update.mockResolvedValue(existing);

    const res = await request(createApp())
      .post(`/api/execution-workspaces/ws-1/runtime-services/stop`)
      .send({ runtimeServiceId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockBuildWorkspaceRuntimeDesiredStatePatch).toHaveBeenCalledWith(expect.objectContaining({
      action: "stop",
      serviceIndex: 0,
    }));
    expect(mockSvc.update).toHaveBeenCalledWith("ws-1", expect.objectContaining({
      metadata: expect.objectContaining({
        config: expect.objectContaining({
          desiredState: "stopped",
          serviceStates: { "0": "stopped" },
        }),
      }),
    }));
  });
});
