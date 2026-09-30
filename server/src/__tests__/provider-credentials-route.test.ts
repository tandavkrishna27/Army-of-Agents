import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  agentProviderCredentialBindings: makeTableProxy("agent_provider_credential_bindings"),
  agents: makeTableProxy("agents"),
  providerCredentials: makeTableProxy("provider_credentials"),
}));

const mockAssertRole = vi.hoisted(() => vi.fn(async () => {}));
const mockAssertCompanyAccess = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn(async () => {}));
const mockRemoveCredentialHome = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../middleware/rbac.js", () => ({ assertRole: mockAssertRole }));
vi.mock("../routes/authz.js", () => ({ assertCompanyAccess: mockAssertCompanyAccess }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
vi.mock("../services/provider-credentials.js", () => ({
  removeScopedSubscriptionCredentialHome: mockRemoveCredentialHome,
}));

import { errorHandler } from "../middleware/error-handler.js";
import { providerCredentialRoutes } from "../routes/provider-credentials.js";

type FakeDbOptions = {
  select?: unknown[][];
  update?: unknown[][];
  insert?: unknown[][];
};

function query(result: unknown[], calls: string[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.where = () => chain;
  chain.limit = async () => result;
  chain.for = async (mode: string) => {
    calls.push(`for:${mode}`);
    return result;
  };
  chain.set = () => chain;
  chain.values = () => chain;
  chain.onConflictDoUpdate = () => chain;
  chain.returning = async () => result;
  chain.then = (
    resolve: (value: unknown[]) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function fakeDb(options: FakeDbOptions = {}) {
  const select = [...(options.select ?? [])];
  const update = [...(options.update ?? [])];
  const insert = [...(options.insert ?? [])];
  const calls: string[] = [];
  const handle: Record<string, any> = {
    select: () => {
      calls.push("select");
      return query(select.shift() ?? [], calls);
    },
    update: () => {
      calls.push("update");
      return query(update.shift() ?? [], calls);
    },
    insert: () => {
      calls.push("insert");
      return query(insert.shift() ?? [], calls);
    },
    execute: async () => {
      calls.push("execute");
      return [];
    },
  };
  handle.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    calls.push("transaction");
    return fn(handle);
  };
  return { db: handle as never, calls, handle };
}

function makeApp(
  db: unknown,
  actor: Record<string, unknown> = { type: "board", userId: "user-1" },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", providerCredentialRoutes(db as never));
  app.use(errorHandler);
  return app;
}

const credentialsUrl = "/api/companies/company-1/provider-credentials";
const bindingsUrl =
  "/api/companies/company-1/agents/agent-1/provider-credential-bindings";
const bindUrl =
  "/api/companies/company-1/agents/agent-1/provider-credential-binding";
const bindingUrl = `${bindUrl}/binding-1`;
const credentialUrl = `${credentialsUrl}/credential-1`;

describe("provider credential routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertRole.mockResolvedValue(undefined);
    mockRemoveCredentialHome.mockResolvedValue(true);
    process.env.AOA_EXECUTION_TARGET_ID = "target-1";
  });

  it.each([
    ["GET credentials", "get", credentialsUrl, undefined],
    ["GET bindings", "get", bindingsUrl, undefined],
    ["POST binding", "post", bindUrl, { credentialId: "credential-1" }],
    ["DELETE binding", "delete", bindingUrl, undefined],
    ["DELETE credential", "delete", credentialUrl, { confirmation: "credential-1" }],
  ] as const)("%s rejects non-board actors", async (_label, method, url, body) => {
    const agent = request(makeApp(fakeDb().db, { type: "agent", agentId: "agent-x" }));
    const pending = method === "get" ? agent.get(url) : agent[method](url);
    const response = body ? await pending.send(body) : await pending;
    expect(response.status).toBe(401);
    expect(mockAssertRole).not.toHaveBeenCalled();
  });

  it.each([
    ["GET credentials", "get", credentialsUrl, undefined],
    ["GET bindings", "get", bindingsUrl, undefined],
    ["POST binding", "post", bindUrl, { credentialId: "credential-1" }],
    ["DELETE binding", "delete", bindingUrl, undefined],
    ["DELETE credential", "delete", credentialUrl, { confirmation: "credential-1" }],
  ] as const)("%s rejects a non-founder", async (_label, method, url, body) => {
    mockAssertRole.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { status: 403, expose: true }),
    );
    const founder = request(makeApp(fakeDb().db));
    const pending = method === "get" ? founder.get(url) : founder[method](url);
    const response = body ? await pending.send(body) : await pending;
    expect(response.status).toBe(403);
  });

  it("enforces company access before reading or mutating credential records", async () => {
    mockAssertCompanyAccess.mockImplementationOnce(() => {
      throw Object.assign(new Error("company access denied"), { status: 403, expose: true });
    });
    const listingDb = fakeDb();
    const listing = await request(makeApp(listingDb.db)).get(credentialsUrl);
    expect(listing.status).toBe(403);
    expect(listingDb.calls).not.toContain("select");

    mockAssertCompanyAccess.mockImplementationOnce(() => {
      throw Object.assign(new Error("company access denied"), { status: 403, expose: true });
    });
    const mutationDb = fakeDb();
    const mutation = await request(makeApp(mutationDb.db))
      .post(bindUrl)
      .send({ credentialId: "credential-1" });
    expect(mutation.status).toBe(403);
    expect(mutationDb.calls).not.toContain("transaction");
  });

  it("lists only the company-scoped credential metadata contract", async () => {
    const row = {
      id: "credential-1",
      provider: "openai",
      ownerUserId: "user-1",
      executionTargetId: "target-1",
      kind: "personal_subscription",
      state: "verified",
      verifiedAt: new Date().toISOString(),
      revokedAt: null,
      suspendedAt: null,
    };
    const { db } = fakeDb({ select: [[row]] });
    const response = await request(makeApp(db)).get(credentialsUrl);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([row]);
    expect(mockAssertCompanyAccess).toHaveBeenCalled();
    expect(mockAssertRole).toHaveBeenCalledWith(expect.anything(), expect.anything(), "company-1", "founder");
  });

  it("discovers agent bindings, including revoked rows and credential state", async () => {
    const binding = {
      id: "binding-1",
      credentialId: "credential-1",
      provider: "openai",
      ownerUserId: "user-1",
      executionTargetId: "target-1",
      credentialState: "verified",
      approvedByUserId: "founder-1",
      approvedAt: new Date().toISOString(),
      revokedAt: null,
    };
    const { db } = fakeDb({ select: [[{ id: "agent-1" }], [binding]] });
    const response = await request(makeApp(db)).get(bindingsUrl);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([binding]);
  });

  it("returns a stable 404 contract when binding discovery targets a foreign/missing agent", async () => {
    const { db } = fakeDb({ select: [[]] });
    const response = await request(makeApp(db)).get(bindingsUrl);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: "Agent not found",
      details: { code: "agent_not_found" },
    });
  });

  it("requires credentialId before opening a transaction", async () => {
    const { db, calls } = fakeDb();
    const response = await request(makeApp(db)).post(bindUrl).send({ credentialId: " " });
    expect(response.status).toBe(400);
    expect(calls).not.toContain("transaction");
  });

  it("returns stable errors for cross-company/missing and unverified credentials", async () => {
    const missing = fakeDb({
      select: [[], [{ id: "credential-1", provider: "openai", state: "verified" }]],
    });
    const missingResponse = await request(makeApp(missing.db))
      .post(bindUrl)
      .send({ credentialId: "credential-1" });
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.body).toEqual({
      error: "Agent or credential not found",
      details: { code: "agent_or_credential_not_found" },
    });

    const unverified = fakeDb({
      select: [
        [{ id: "agent-1" }],
        [{ id: "credential-1", provider: "openai", state: "pending" }],
      ],
    });
    const unverifiedResponse = await request(makeApp(unverified.db))
      .post(bindUrl)
      .send({ credentialId: "credential-1" });
    expect(unverifiedResponse.status).toBe(422);
    expect(unverifiedResponse.body).toEqual({
      error: "Only verified credentials can be bound",
      details: { code: "credential_not_verified" },
    });
  });

  it("approves a verified binding under a serialized transaction and audits it", async () => {
    const { db, calls, handle } = fakeDb({
      select: [
        [{ id: "agent-1" }],
        [{ id: "credential-1", provider: "openai", state: "verified" }],
        [],
      ],
      insert: [[{ id: "binding-1" }]],
    });
    const response = await request(makeApp(db))
      .post(bindUrl)
      .send({ credentialId: "credential-1" });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: "binding-1" });
    expect(calls).toContain("execute");
    expect(mockLogActivity).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({
        companyId: "company-1",
        action: "provider_credential.binding.approved",
        entityId: "binding-1",
      }),
    );
  });

  it("returns 404 for an absent binding and atomically audits a successful revoke", async () => {
    const absent = fakeDb({ update: [[]] });
    const missing = await request(makeApp(absent.db)).delete(bindingUrl);
    expect(missing.status).toBe(404);
    expect(mockLogActivity).not.toHaveBeenCalled();

    const success = fakeDb({ update: [[{ id: "binding-1" }]] });
    const revoked = await request(makeApp(success.db)).delete(bindingUrl);
    expect(revoked.status).toBe(204);
    expect(mockLogActivity).toHaveBeenCalledWith(
      success.handle,
      expect.objectContaining({
        action: "provider_credential.binding.revoked",
        entityId: "binding-1",
      }),
    );
  });

  it("fails the binding-revoke transaction when its required audit write fails", async () => {
    mockLogActivity.mockRejectedValueOnce(new Error("activity store unavailable"));
    const attempted = fakeDb({ update: [[{ id: "binding-1" }]] });
    const response = await request(makeApp(attempted.db)).delete(bindingUrl);
    expect(response.status).toBe(500);
    expect(attempted.calls).toContain("transaction");
    expect(mockLogActivity).toHaveBeenCalledWith(attempted.handle, expect.anything());
  });

  it("rejects credential revocation confirmation, unsupported kinds, and wrong targets", async () => {
    const confirmation = await request(makeApp(fakeDb().db))
      .delete(credentialUrl)
      .send({ confirmation: "wrong" });
    expect(confirmation.status).toBe(400);

    const companyKey = fakeDb({
      select: [[{
        id: "credential-1",
        provider: "openai",
        ownerUserId: "user-1",
        executionTargetId: "target-1",
        kind: "company_api_key",
      }]],
    });
    const unsupported = await request(makeApp(companyKey.db))
      .delete(credentialUrl)
      .send({ confirmation: "credential-1" });
    expect(unsupported.status).toBe(422);

    const foreignTarget = fakeDb({
      select: [[{
        id: "credential-1",
        provider: "anthropic",
        ownerUserId: "user-1",
        executionTargetId: "target-2",
        kind: "personal_subscription",
      }]],
    });
    const mismatch = await request(makeApp(foreignTarget.db))
      .delete(credentialUrl)
      .send({ confirmation: "credential-1" });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe("credential_target_mismatch");
  });

  it("returns 404 without touching files when the credential is absent or cross-company", async () => {
    const missing = fakeDb({ select: [[]] });
    const response = await request(makeApp(missing.db))
      .delete(credentialUrl)
      .send({ confirmation: "credential-1" });
    expect(response.status).toBe(404);
    expect(mockRemoveCredentialHome).not.toHaveBeenCalled();
    expect(missing.calls).not.toContain("transaction");
  });

  it("revokes the logical credential and bindings before removing only its scoped files", async () => {
    const credential = {
      id: "credential-1",
      provider: "openai",
      ownerUserId: "user-1",
      executionTargetId: "target-1",
      kind: "personal_subscription",
    };
    const success = fakeDb({ select: [[credential]], update: [[], []] });
    const response = await request(makeApp(success.db))
      .delete(credentialUrl)
      .send({ confirmation: "credential-1" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: "credential-1",
      state: "revoked",
      filesRemoved: true,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      success.handle,
      expect.objectContaining({
        action: "provider_credential.revoked",
        entityId: "credential-1",
      }),
    );
    expect(mockRemoveCredentialHome).toHaveBeenCalledWith({
      companyId: "company-1",
      userId: "user-1",
      provider: "openai",
      executionTargetId: "target-1",
    });
  });

  it("surfaces scoped filesystem cleanup failure only after the audited logical revoke", async () => {
    mockRemoveCredentialHome.mockRejectedValueOnce(new Error("filesystem unavailable"));
    const credential = {
      id: "credential-1",
      provider: "anthropic",
      ownerUserId: "user-1",
      executionTargetId: "target-1",
      kind: "personal_subscription",
    };
    const attempted = fakeDb({ select: [[credential]], update: [[], []] });
    const response = await request(makeApp(attempted.db))
      .delete(credentialUrl)
      .send({ confirmation: "credential-1" });
    expect(response.status).toBe(500);
    expect(mockLogActivity).toHaveBeenCalledWith(
      attempted.handle,
      expect.objectContaining({ action: "provider_credential.revoked" }),
    );
  });
});
