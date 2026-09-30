import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mocks = vi.hoisted(() => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../routes/authz.js", () => ({
  assertBoard: mocks.assertBoard,
  assertCompanyAccess: mocks.assertCompanyAccess,
}));

vi.mock("../services/runtime-provider-keys.js", () => ({
  runtimeProviderKeyService: vi.fn(() => ({
    getById: mocks.getById,
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    remove: mocks.remove,
  })),
}));

vi.mock("../services/index.js", () => ({
  secretService: vi.fn(() => ({
    listProviders: vi.fn(() => []),
    listProviderConfigs: vi.fn(async () => []),
  })),
  logActivity: mocks.logActivity,
}));

import { secretRoutes } from "../routes/secrets.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const secretId = "22222222-2222-4222-8222-222222222222";

function app() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "session",
      userId: "u-1",
      companyIds: [companyId],
      isInstanceAdmin: false,
    } as never;
    next();
  });
  app.use(secretRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("runtime provider key routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertBoard.mockReturnValue(undefined);
    mocks.assertCompanyAccess.mockReturnValue(undefined);
  });

  it("lists provider keys for a company", async () => {
    mocks.list.mockResolvedValue([{ id: "key-1", provider: "e2b", displayName: "Default E2B", secretId }]);

    const res = await request(app()).get(`/companies/${companyId}/runtime-provider-keys`);

    expect(res.status).toBe(200);
    expect(mocks.assertCompanyAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), companyId);
    expect(mocks.list).toHaveBeenCalledWith(companyId);
  });

  it("creates an E2B provider key and never returns material", async () => {
    mocks.create.mockResolvedValue({
      id: "key-1",
      companyId,
      provider: "e2b",
      displayName: "Default E2B",
      secretId,
      isDefault: true,
    });

    const res = await request(app())
      .post(`/companies/${companyId}/runtime-provider-keys`)
      .send({ provider: "e2b", displayName: "Default E2B", secretId, isDefault: true });

    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain("sk-e2b");
    expect(mocks.create).toHaveBeenCalledWith(companyId, expect.objectContaining({
      provider: "e2b",
      displayName: "Default E2B",
      secretId,
      isDefault: true,
    }));
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "runtime_provider_key.created",
        details: expect.objectContaining({ provider: "e2b", displayName: "Default E2B" }),
      }),
    );
  });

  it("rejects invalid provider key payloads", async () => {
    const res = await request(app())
      .post(`/companies/${companyId}/runtime-provider-keys`)
      .send({ provider: "unknown", displayName: "Nope", secretId });

    expect(res.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("updates a provider key after checking company access", async () => {
    mocks.getById.mockResolvedValue({ id: "key-1", companyId, provider: "e2b" });
    mocks.update.mockResolvedValue({
      id: "key-1",
      companyId,
      provider: "e2b",
      displayName: "Team E2B",
      secretId,
      isDefault: false,
    });

    const res = await request(app())
      .patch("/runtime-provider-keys/key-1")
      .send({ displayName: "Team E2B" });

    expect(res.status).toBe(200);
    expect(mocks.assertCompanyAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), companyId);
    expect(mocks.update).toHaveBeenCalledWith("key-1", { displayName: "Team E2B" });
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "runtime_provider_key.updated" }),
    );
  });

  it("deletes a provider key after checking company access", async () => {
    mocks.getById.mockResolvedValue({ id: "key-1", companyId, provider: "e2b" });
    mocks.remove.mockResolvedValue({ id: "key-1" });

    const res = await request(app()).delete("/runtime-provider-keys/key-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mocks.remove).toHaveBeenCalledWith("key-1");
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "runtime_provider_key.deleted" }),
    );
  });
});
