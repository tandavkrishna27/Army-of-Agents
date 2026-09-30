import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  assertBoard: vi.fn(),
  assertCanManageInstanceSettings: vi.fn(),
  assertCompanyAccess: vi.fn(),
  environmentService: vi.fn(() => ({})),
  logActivity: vi.fn(async () => undefined),
  normalizeEnvConfigForPersistence: vi.fn(async (_companyId: string, value: unknown) => value),
  getLocalProbeTargetPath: vi.fn((config: Record<string, unknown>) => {
    const value = config.path ?? config.rootFolder;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }),
  probeEnvironmentConfig: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(),
}));

vi.mock("../routes/authz.js", () => ({
  assertBoard: mocks.assertBoard,
  assertCanManageInstanceSettings: mocks.assertCanManageInstanceSettings,
  assertCompanyAccess: mocks.assertCompanyAccess,
  getActorInfo: () => ({ actorId: "u-1", actorType: "user", agentId: null, runId: null }),
}));

vi.mock("../services/index.js", () => ({
  logActivity: mocks.logActivity,
}));

// Stub the service module to break the drizzle-orm ESM cycle
vi.mock("../services/environments.js", () => ({
  environmentService: mocks.environmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: vi.fn(() => ({
    normalizeEnvConfigForPersistence: mocks.normalizeEnvConfigForPersistence,
    syncEnvBindingsForTarget: mocks.syncEnvBindingsForTarget,
  })),
}));

vi.mock("../services/environment-probe.js", () => ({
  getLocalProbeTargetPath: mocks.getLocalProbeTargetPath,
  probeEnvironmentConfig: mocks.probeEnvironmentConfig,
}));

import { environmentRoutes } from "../routes/environments.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const envId = "22222222-2222-4222-8222-222222222222";

const mockEnv = {
  id: envId,
  companyId,
  name: "Production",
  envVars: { API_URL: "https://api.example.com" },
  connectionTarget: null,
  target: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function buildApp(mockSvc: unknown, opts: { withDb?: boolean; db?: unknown } = {}) {
  const app = express();
  app.use(express.json());
  app.use(environmentRoutes({ svc: mockSvc as never, db: opts.db as never ?? (opts.withDb ? ({} as never) : undefined) }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err === "object" && err && "status" in err ? Number((err as { status: unknown }).status) : 500;
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(Number.isFinite(status) ? status : 500).json({ error: message });
  });
  return app;
}

describe("environments routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertBoard.mockReturnValue(undefined);
    mocks.assertCanManageInstanceSettings.mockReturnValue(undefined);
    mocks.assertCompanyAccess.mockReturnValue(undefined);
    mocks.environmentService.mockReturnValue({});
    mocks.normalizeEnvConfigForPersistence.mockImplementation(async (_companyId: string, value: unknown) => value);
    mocks.probeEnvironmentConfig.mockResolvedValue({
      ok: true,
      driver: "local",
      summary: "Local environment configuration is valid.",
      checks: [{ name: "config", status: "passed", message: "Local runtime does not require provider config." }],
    });
  });
  afterEach(() => setDeploymentMode("local_trusted"));

  it("cloud_auth rejects local create and probe before service work", async () => {
    setDeploymentMode("cloud_auth");
    const svc = { create: vi.fn() };
    const app = buildApp(svc);
    const create = await request(app)
      .post(`/companies/${companyId}/environments`)
      .send({ name: "Local", driver: "local", config: {}, target: { type: "local" } });
    const probe = await request(app)
      .post(`/companies/${companyId}/environments/probe`)
      .send({ driver: "local", config: {} });
    expect(create.status).toBe(422);
    expect(probe.status).toBe(422);
    expect(create.body.error).toMatch(/E2B environments/i);
    expect(svc.create).not.toHaveBeenCalled();
    expect(mocks.probeEnvironmentConfig).not.toHaveBeenCalled();
  });

  it("cloud_auth allows exact E2B create and validates merged PATCH state", async () => {
    setDeploymentMode("cloud_auth");
    const e2bEnv = {
      ...mockEnv,
      driver: "sandbox",
      config: { provider: "e2b", template: "base" },
      target: null,
      executionTargetId: null,
    };
    const svc = {
      get: vi.fn(async () => e2bEnv),
      create: vi.fn(async () => e2bEnv),
      update: vi.fn(async (_companyId: string, _id: string, input: unknown) => ({ ...e2bEnv, ...(input as object) })),
    };
    const app = buildApp(svc);
    const create = await request(app)
      .post(`/companies/${companyId}/environments`)
      .send({ name: "Cloud", driver: "sandbox", config: { provider: "e2b", template: "base" }, target: null, executionTargetId: null });
    const patch = await request(app)
      .patch(`/companies/${companyId}/environments/${envId}`)
      .send({ name: "Cloud renamed" });
    expect(create.status).toBe(201);
    expect(patch.status).toBe(200);
    expect(svc.update).toHaveBeenCalled();
  });

  it("cloud_auth requires a partial PATCH to migrate the final state away from gVisor and pins", async () => {
    setDeploymentMode("cloud_auth");
    const svc = {
      get: vi.fn(async () => ({
        ...mockEnv,
        driver: "sandbox",
        config: { provider: "gvisor", runtime: "runsc" },
        executionTargetId: "11111111-1111-4111-8111-111111111111",
      })),
      update: vi.fn(async (_companyId: string, _id: string, input: unknown) => ({
        ...mockEnv,
        ...(input as object),
      })),
    };
    const app = buildApp(svc);
    const metadataOnly = await request(app)
      .patch(`/companies/${companyId}/environments/${envId}`)
      .send({ name: "Still unsafe" });
    expect(metadataOnly.status).toBe(422);
    expect(svc.update).not.toHaveBeenCalled();

    const migrated = await request(app)
      .patch(`/companies/${companyId}/environments/${envId}`)
      .send({ driver: "sandbox", config: { provider: "e2b", template: "base" }, target: null, executionTargetId: null });
    expect(migrated.status).toBe(200);
    expect(svc.update).toHaveBeenCalledOnce();
  });

  it.each([
    ["GET list", "get", `/companies/${companyId}/environments`, "list"],
    ["GET detail", "get", `/companies/${companyId}/environments/${envId}`, "get"],
    ["POST create", "post", `/companies/${companyId}/environments`, "create"],
    ["PATCH update", "patch", `/companies/${companyId}/environments/${envId}`, "update"],
    ["DELETE", "delete", `/companies/${companyId}/environments/${envId}`, "delete"],
  ] as const)("%s rejects non-board actors before service calls", async (_label, method, path, serviceMethod) => {
    mocks.assertBoard.mockImplementation(() => {
      throw Object.assign(new Error("Board access required"), { status: 403 });
    });
    const svc = {
      list: vi.fn(async () => [mockEnv]),
      get: vi.fn(async () => mockEnv),
      create: vi.fn(async () => mockEnv),
      update: vi.fn(async () => mockEnv),
      delete: vi.fn(async () => mockEnv),
    };
    const app = buildApp(svc);

    const req = request(app)[method](path);
    if (method === "post") req.send({ name: "Production", envVars: {} });
    if (method === "patch") req.send({ name: "Staging" });
    const res = await req;

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/board access required/i);
    expect(mocks.assertBoard).toHaveBeenCalled();
    expect(mocks.assertCompanyAccess).not.toHaveBeenCalled();
    expect(svc[serviceMethod]).not.toHaveBeenCalled();
  });

  // GET list
  it("GET /companies/:cid/environments returns 200 with list", async () => {
    const svc = {
      list: vi.fn(async () => [mockEnv]),
    };
    const app = buildApp(svc);
    const res = await request(app).get(`/companies/${companyId}/environments`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(envId);
    expect(svc.list).toHaveBeenCalledWith(companyId);
  });

  // GET detail — found
  it("GET /companies/:cid/environments/:id returns 200 with env", async () => {
    const svc = {
      get: vi.fn(async () => mockEnv),
    };
    const app = buildApp(svc);
    const res = await request(app).get(`/companies/${companyId}/environments/${envId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(envId);
    expect(res.body.name).toBe("Production");
    expect(svc.get).toHaveBeenCalledWith(companyId, envId);
  });

  // GET detail — not found
  it("GET /companies/:cid/environments/:id returns 404 when not found", async () => {
    const svc = {
      get: vi.fn(async () => null),
    };
    const app = buildApp(svc);
    const res = await request(app).get(`/companies/${companyId}/environments/missing`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // POST create — success
  it("POST /companies/:cid/environments returns 201 with created env", async () => {
    const normalizedEnv = { API_URL: { type: "plain", value: "https://api.example.com" } };
    mocks.normalizeEnvConfigForPersistence.mockResolvedValueOnce(normalizedEnv);
    const svc = {
      create: vi.fn(async () => mockEnv),
    };
    const app = buildApp(svc, { withDb: true });
    const res = await request(app)
      .post(`/companies/${companyId}/environments`)
      .send({ name: "Production", envVars: { API_URL: "https://api.example.com" } });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(envId);
    expect(svc.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ name: "Production", envVars: normalizedEnv }),
    );
    expect(mocks.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      companyId,
      { targetType: "environment", targetId: envId, pathPrefix: "env" },
      normalizedEnv,
    );
  });

  it("POST /companies/:cid/environments logs redacted environment creation activity", async () => {
    const normalizedEnv = {
      API_URL: { type: "plain", value: "https://api.example.com" },
      API_KEY: { type: "secret_ref", secretId: "33333333-3333-4333-8333-333333333333", version: "latest" },
    };
    mocks.normalizeEnvConfigForPersistence.mockResolvedValueOnce(normalizedEnv);
    const target = { type: "sandbox-docker", image: "node:22-bookworm" };
    const svc = {
      create: vi.fn(async () => ({ ...mockEnv, target })),
    };
    const app = buildApp(svc, { withDb: true });

    const res = await request(app)
      .post(`/companies/${companyId}/environments`)
      .send({
        name: "Production",
        envVars: {
          API_URL: "https://api.example.com",
          API_KEY: normalizedEnv.API_KEY,
        },
        target,
      });

    expect(res.status).toBe(201);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "user",
        actorId: "u-1",
        action: "environment.created",
        entityType: "environment",
        entityId: envId,
        details: expect.objectContaining({
          name: "Production",
          targetType: "sandbox-docker",
          envVarKeys: ["API_KEY", "API_URL"],
          secretBindingCount: 1,
        }),
      }),
    );
    const details = mocks.logActivity.mock.calls.at(-1)?.[1]?.details;
    expect(JSON.stringify(details)).not.toContain("https://api.example.com");
    expect(JSON.stringify(details)).not.toContain("33333333-3333-4333-8333-333333333333");
  });

  it("POST /companies/:cid/environments creates env and syncs bindings in one transaction", async () => {
    const tx = { tx: true };
    const txSvc = { create: vi.fn(async () => mockEnv) };
    const db = {
      transaction: vi.fn(async (callback: (innerTx: unknown) => Promise<unknown>) => callback(tx)),
    };
    const normalizedEnv = { API_KEY: { type: "secret_ref", secretId: "33333333-3333-4333-8333-333333333333", version: "latest" } };
    mocks.normalizeEnvConfigForPersistence.mockResolvedValueOnce(normalizedEnv);
    mocks.environmentService.mockImplementation((serviceDb: unknown) => (serviceDb === tx ? txSvc : {}));
    const txApp = buildApp(undefined, { db });

    const res = await request(txApp)
      .post(`/companies/${companyId}/environments`)
      .send({ name: "Production", envVars: { API_KEY: normalizedEnv.API_KEY } });

    expect(res.status).toBe(201);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.environmentService).toHaveBeenCalledWith(tx);
    expect(txSvc.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ name: "Production", envVars: normalizedEnv }),
    );
    expect(mocks.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      companyId,
      { targetType: "environment", targetId: envId, pathPrefix: "env" },
      normalizedEnv,
    );
  });

  it("POST /companies/:cid/environments rolls back create when binding sync fails", async () => {
    const tx = { tx: true };
    const txSvc = { create: vi.fn(async () => mockEnv) };
    const db = {
      transaction: vi.fn(async (callback: (innerTx: unknown) => Promise<unknown>) => callback(tx)),
    };
    mocks.environmentService.mockImplementation((serviceDb: unknown) => (serviceDb === tx ? txSvc : {}));
    mocks.syncEnvBindingsForTarget.mockRejectedValueOnce(Object.assign(new Error("Binding sync failed"), { status: 422 }));
    const txApp = buildApp(undefined, { db });

    const res = await request(txApp)
      .post(`/companies/${companyId}/environments`)
      .send({ name: "Production", envVars: { API_URL: "https://api.example.com" } });

    expect(res.status).toBe(422);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(txSvc.create).toHaveBeenCalled();
    expect(mocks.syncEnvBindingsForTarget).toHaveBeenCalled();
  });

  it("POST /companies/:cid/environments accepts a sandbox-docker target", async () => {
    const target = { type: "sandbox-docker", image: "node:22-bookworm" };
    const svc = {
      create: vi.fn(async () => ({ ...mockEnv, target })),
    };
    const app = buildApp(svc);
    const res = await request(app)
      .post(`/companies/${companyId}/environments`)
      .send({ name: "Docker", envVars: {}, target });
    expect(res.status).toBe(201);
    expect(res.body.target).toEqual(target);
    expect(svc.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ target }),
    );
  });

  it("POST /companies/:cid/environments/probe probes an unsaved E2B environment config", async () => {
    mocks.probeEnvironmentConfig.mockResolvedValueOnce({
      ok: true,
      driver: "sandbox",
      provider: "e2b",
      summary: "E2B sandbox created and workspace directory prepared.",
      metadata: {
        template: "base",
        timeoutMs: 60_000,
        sandboxId: "e2b-probe-1",
      },
    });
    const svc = {
      create: vi.fn(),
    };
    const app = buildApp(svc);

    const res = await request(app)
      .post(`/companies/${companyId}/environments/probe`)
      .send({
        driver: "sandbox",
        config: {
          provider: "e2b",
          credentialRef: "default",
          template: "base",
          timeoutMs: 60_000,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      driver: "sandbox",
      provider: "e2b",
      summary: "E2B sandbox created and workspace directory prepared.",
      metadata: {
        template: "base",
        timeoutMs: 60_000,
        sandboxId: "e2b-probe-1",
      },
    });
    expect(mocks.probeEnvironmentConfig).toHaveBeenCalledWith({
      companyId,
      driver: "sandbox",
      config: {
        provider: "e2b",
        credentialRef: "default",
        template: "base",
        timeoutMs: 60_000,
      },
    });
    expect(mocks.assertCanManageInstanceSettings).not.toHaveBeenCalled();
    expect(svc.create).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("secret-key");
  });

  it("POST /companies/:cid/environments/probe rejects non-admin local filesystem probes", async () => {
    mocks.assertCanManageInstanceSettings.mockImplementation(() => {
      throw Object.assign(new Error("Instance admin access required"), { status: 403 });
    });
    const app = buildApp({ create: vi.fn() });

    const res = await request(app)
      .post(`/companies/${companyId}/environments/probe`)
      .send({ driver: "local", config: { path: "/tmp/member-controlled" } });

    expect(res.status).toBe(403);
    expect(mocks.assertCanManageInstanceSettings).toHaveBeenCalled();
    expect(mocks.probeEnvironmentConfig).not.toHaveBeenCalled();
  });

  it("POST /companies/:cid/environments/probe preserves pathless local validation for non-admin members", async () => {
    mocks.assertCanManageInstanceSettings.mockImplementation(() => {
      throw Object.assign(new Error("Instance admin access required"), { status: 403 });
    });
    const app = buildApp({ create: vi.fn() });

    const res = await request(app)
      .post(`/companies/${companyId}/environments/probe`)
      .send({ driver: "local", config: {} });

    expect(res.status).toBe(200);
    expect(mocks.assertCanManageInstanceSettings).not.toHaveBeenCalled();
    expect(mocks.probeEnvironmentConfig).toHaveBeenCalledWith({
      companyId,
      driver: "local",
      config: {},
    });
  });

  it("POST /companies/:cid/environments/probe allows instance-admin local filesystem probes", async () => {
    const app = buildApp({ create: vi.fn() });

    const res = await request(app)
      .post(`/companies/${companyId}/environments/probe`)
      .send({ driver: "local", config: { path: "/tmp/admin-controlled" } });

    expect(res.status).toBe(200);
    expect(mocks.assertCanManageInstanceSettings).toHaveBeenCalled();
    expect(mocks.probeEnvironmentConfig).toHaveBeenCalledWith({
      companyId,
      driver: "local",
      config: { path: "/tmp/admin-controlled" },
    });
  });

  it("POST /companies/:cid/environments/probe returns 400 for raw E2B API keys", async () => {
    mocks.probeEnvironmentConfig.mockResolvedValueOnce({
      ok: false,
      driver: "sandbox",
      provider: "e2b",
      summary: "E2B sandbox configuration is invalid.",
      checks: [{
        name: "config",
        status: "failed",
        message: "E2B sandbox environments require an API key in config or E2B_API_KEY.",
      }],
    });
    const svc = {
      create: vi.fn(),
    };
    const app = buildApp(svc);

    const res = await request(app)
      .post(`/companies/${companyId}/environments/probe`)
      .send({ driver: "sandbox", config: { provider: "e2b", apiKey: "secret-key" } });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/unrecognized key/i);
    expect(mocks.probeEnvironmentConfig).not.toHaveBeenCalled();
    expect(svc.create).not.toHaveBeenCalled();
  });

  // POST create — invalid body (missing name)
  it("POST /companies/:cid/environments returns 400 on invalid body", async () => {
    const svc = {
      create: vi.fn(),
    };
    const app = buildApp(svc);
    const res = await request(app)
      .post(`/companies/${companyId}/environments`)
      .send({}); // missing required `name`
    expect(res.status).toBe(400);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("POST /companies/:cid/environments returns 400 on invalid target", async () => {
    const svc = {
      create: vi.fn(),
    };
    const app = buildApp(svc);
    const res = await request(app)
      .post(`/companies/${companyId}/environments`)
      .send({ name: "Broken", target: { type: "sandbox-docker" } });
    expect(res.status).toBe(400);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("POST /companies/:cid/environments rejects invalid env var names before create", async () => {
    mocks.normalizeEnvConfigForPersistence.mockRejectedValueOnce(
      Object.assign(new Error("Invalid environment variable name: 1BAD"), { status: 422 }),
    );
    const svc = {
      create: vi.fn(),
    };
    const app = buildApp(svc, { withDb: true });
    const res = await request(app)
      .post(`/companies/${companyId}/environments`)
      .send({ name: "Broken", envVars: { "1BAD": "value" } });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/invalid environment variable name/i);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("POST /companies/:cid/environments rejects invalid env binding shape before create", async () => {
    mocks.normalizeEnvConfigForPersistence.mockRejectedValueOnce(
      Object.assign(new Error("Invalid environment binding for key: API_URL"), { status: 422 }),
    );
    const svc = {
      create: vi.fn(),
    };
    const app = buildApp(svc, { withDb: true });
    const res = await request(app)
      .post(`/companies/${companyId}/environments`)
      .send({ name: "Broken", envVars: { API_URL: { type: "secret_ref", secretId: "not-a-uuid" } } });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/invalid environment binding for key: API_URL/i);
    expect(mocks.normalizeEnvConfigForPersistence).toHaveBeenCalledWith(
      companyId,
      { API_URL: { type: "secret_ref", secretId: "not-a-uuid" } },
      { strictMode: true },
    );
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("PATCH /companies/:cid/environments/:id rejects invalid env binding shape before update", async () => {
    mocks.normalizeEnvConfigForPersistence.mockRejectedValueOnce(
      Object.assign(new Error("Invalid environment binding for key: API_URL"), { status: 422 }),
    );
    const svc = {
      update: vi.fn(),
    };
    const app = buildApp(svc, { withDb: true });
    const res = await request(app)
      .patch(`/companies/${companyId}/environments/${envId}`)
      .send({ envVars: { API_URL: { type: "secret_ref", secretId: "not-a-uuid" } } });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/invalid environment binding for key: API_URL/i);
    expect(mocks.normalizeEnvConfigForPersistence).toHaveBeenCalledWith(
      companyId,
      { API_URL: { type: "secret_ref", secretId: "not-a-uuid" } },
      { strictMode: true },
    );
    expect(svc.update).not.toHaveBeenCalled();
  });

  // PATCH update — success
  it("PATCH /companies/:cid/environments/:id returns 200 with updated env", async () => {
    const normalizedEnv = { NODE_ENV: { type: "plain", value: "staging" } };
    mocks.normalizeEnvConfigForPersistence.mockResolvedValueOnce(normalizedEnv);
    const updated = { ...mockEnv, name: "Staging" };
    const svc = {
      update: vi.fn(async () => updated),
    };
    const app = buildApp(svc, { withDb: true });
    const res = await request(app)
      .patch(`/companies/${companyId}/environments/${envId}`)
      .send({ name: "Staging", envVars: { NODE_ENV: "staging" } });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Staging");
    expect(svc.update).toHaveBeenCalledWith(
      companyId,
      envId,
      expect.objectContaining({ name: "Staging", envVars: normalizedEnv }),
    );
    expect(mocks.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      companyId,
      { targetType: "environment", targetId: envId, pathPrefix: "env" },
      normalizedEnv,
    );
  });

  it("PATCH /companies/:cid/environments/:id logs redacted environment update activity", async () => {
    const normalizedEnv = {
      NODE_ENV: { type: "plain", value: "staging" },
      API_KEY: { type: "secret_ref", secretId: "33333333-3333-4333-8333-333333333333", version: "latest" },
    };
    mocks.normalizeEnvConfigForPersistence.mockResolvedValueOnce(normalizedEnv);
    const target = { type: "sandbox-docker", image: "node:22-bookworm" };
    const updated = { ...mockEnv, name: "Staging", target };
    const svc = {
      update: vi.fn(async () => updated),
    };
    const app = buildApp(svc, { withDb: true });

    const res = await request(app)
      .patch(`/companies/${companyId}/environments/${envId}`)
      .send({
        name: "Staging",
        envVars: {
          NODE_ENV: "staging",
          API_KEY: normalizedEnv.API_KEY,
        },
        target,
      });

    expect(res.status).toBe(200);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "user",
        actorId: "u-1",
        action: "environment.updated",
        entityType: "environment",
        entityId: envId,
        details: expect.objectContaining({
          name: "Staging",
          targetType: "sandbox-docker",
          changedFields: ["envVars", "name", "target"],
          envVarKeys: ["API_KEY", "NODE_ENV"],
          secretBindingCount: 1,
        }),
      }),
    );
    const details = mocks.logActivity.mock.calls.at(-1)?.[1]?.details;
    expect(JSON.stringify(details)).not.toContain("staging");
    expect(JSON.stringify(details)).not.toContain("33333333-3333-4333-8333-333333333333");
  });

  it("PATCH /companies/:cid/environments/:id accepts clearing target", async () => {
    const svc = {
      update: vi.fn(async () => ({ ...mockEnv, target: null })),
    };
    const app = buildApp(svc);
    const res = await request(app)
      .patch(`/companies/${companyId}/environments/${envId}`)
      .send({ target: null });
    expect(res.status).toBe(200);
    expect(res.body.target).toBeNull();
    expect(svc.update).toHaveBeenCalledWith(
      companyId,
      envId,
      expect.objectContaining({ target: null }),
    );
  });

  // PATCH update — not found
  it("PATCH /companies/:cid/environments/:id returns 404 when not found", async () => {
    const svc = {
      update: vi.fn(async () => null),
    };
    const app = buildApp(svc);
    const res = await request(app)
      .patch(`/companies/${companyId}/environments/missing`)
      .send({ name: "Staging" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // DELETE — success
  it("DELETE /companies/:cid/environments/:id returns 204", async () => {
    const svc = {
      delete: vi.fn(async () => mockEnv),
    };
    const app = buildApp(svc, { withDb: true });
    const res = await request(app).delete(`/companies/${companyId}/environments/${envId}`);
    expect(res.status).toBe(204);
    expect(svc.delete).toHaveBeenCalledWith(companyId, envId);
    expect(mocks.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      companyId,
      { targetType: "environment", targetId: envId, pathPrefix: "env" },
      {},
    );
  });

  it("DELETE /companies/:cid/environments/:id logs redacted environment deletion activity", async () => {
    const svc = {
      delete: vi.fn(async () => mockEnv),
    };
    const app = buildApp(svc, { withDb: true });

    const res = await request(app).delete(`/companies/${companyId}/environments/${envId}`);

    expect(res.status).toBe(204);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "user",
        actorId: "u-1",
        action: "environment.deleted",
        entityType: "environment",
        entityId: envId,
        details: expect.objectContaining({
          name: "Production",
          targetType: null,
          envVarKeys: ["API_URL"],
          secretBindingCount: 0,
        }),
      }),
    );
    const details = mocks.logActivity.mock.calls.at(-1)?.[1]?.details;
    expect(JSON.stringify(details)).not.toContain("https://api.example.com");
  });

  // DELETE — not found
  it("DELETE /companies/:cid/environments/:id returns 404 when service returns null", async () => {
    const svc = {
      delete: vi.fn(async () => null),
    };
    const app = buildApp(svc);
    const res = await request(app).delete(`/companies/${companyId}/environments/missing`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
