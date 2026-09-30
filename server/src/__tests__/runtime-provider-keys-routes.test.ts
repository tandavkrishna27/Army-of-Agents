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
  createWithSecret: vi.fn(),
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
    createWithSecret: mocks.createWithSecret,
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

  it("creates an E2B key in one step (with-secret) and never returns or logs the raw value", async () => {
    mocks.createWithSecret.mockResolvedValue({
      secret: { id: secretId, name: "Default E2B", provider: "local_encrypted" },
      providerKey: {
        id: "key-1",
        companyId,
        provider: "e2b",
        displayName: "Default E2B",
        secretId,
        isDefault: true,
      },
    });

    const res = await request(app())
      .post(`/companies/${companyId}/runtime-provider-keys/with-secret`)
      .send({ provider: "e2b", displayName: "Default E2B", value: "e2b_live_topsecret", isDefault: true });

    expect(res.status).toBe(201);
    // Response is the provider-key row only, and never carries the raw key back.
    expect(res.body.id).toBe("key-1");
    expect(JSON.stringify(res.body)).not.toContain("e2b_live_topsecret");
    // ★ Codex P1: the board actor is threaded through so the secret gets a creator.
    expect(mocks.createWithSecret).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        provider: "e2b",
        displayName: "Default E2B",
        value: "e2b_live_topsecret",
        isDefault: true,
      }),
      expect.objectContaining({ userId: "u-1" }),
    );
    // ★ Codex P1: BOTH secret.created and runtime_provider_key.created are recorded,
    // and NEITHER carries the raw value.
    const secretCreated = mocks.logActivity.mock.calls.find(
      ([, entry]) => (entry as { action?: string }).action === "secret.created",
    );
    const keyCreated = mocks.logActivity.mock.calls.find(
      ([, entry]) => (entry as { action?: string }).action === "runtime_provider_key.created",
    );
    expect(secretCreated).toBeTruthy();
    expect(keyCreated).toBeTruthy();
    expect(JSON.stringify(mocks.logActivity.mock.calls)).not.toContain("e2b_live_topsecret");
  });

  it("applies schema defaults (provider e2b, isDefault true) for a minimal with-secret payload", async () => {
    mocks.createWithSecret.mockResolvedValue({
      secret: { id: secretId, name: "Minimal", provider: "local_encrypted" },
      providerKey: {
        id: "key-2",
        companyId,
        provider: "e2b",
        displayName: "Minimal",
        secretId,
        isDefault: true,
      },
    });

    const res = await request(app())
      .post(`/companies/${companyId}/runtime-provider-keys/with-secret`)
      .send({ displayName: "Minimal", value: "e2b_live_min" });

    expect(res.status).toBe(201);
    expect(mocks.createWithSecret).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        provider: "e2b",
        displayName: "Minimal",
        value: "e2b_live_min",
        isDefault: true,
      }),
      expect.objectContaining({ userId: "u-1" }),
    );
  });

  it("rejects a with-secret payload missing the raw value", async () => {
    const res = await request(app())
      .post(`/companies/${companyId}/runtime-provider-keys/with-secret`)
      .send({ provider: "e2b", displayName: "No value" });

    expect(res.status).toBe(400);
    expect(mocks.createWithSecret).not.toHaveBeenCalled();
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
