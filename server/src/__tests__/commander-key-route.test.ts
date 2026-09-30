import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
}));
const mockAssertRole = vi.hoisted(() => vi.fn(async () => {}));
const mockPersist = vi.hoisted(() => vi.fn(async () => ({ secretId: "sec-1" })));
const mockLog = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../middleware/rbac.js", () => ({ assertRole: mockAssertRole }));
vi.mock("../routes/authz.js", () => ({ assertCompanyAccess: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({ create: vi.fn(), syncEnvBindingsForTarget: vi.fn() }) }));
vi.mock("../services/commander-key.js", () => ({ persistCommanderApiKey: mockPersist }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLog }));
import { errorHandler } from "../middleware/error-handler.js";
import { commanderKeyRoutes } from "../routes/commander-key.js";

function db(results: unknown[][]) {
  let i = 0;
  const handle: Record<string, unknown> = {
    // `.limit()` serves the pre-tx internal_agent_config id lookup; `.for()`
    // serves the in-tx `SELECT adapterConfig … FOR UPDATE` locked read the route
    // now issues inside the transaction (Codex round-12 P2). Both draw from the
    // same sequenced `results` array, in call order.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => results[i++] ?? [],
          for: async () => results[i++] ?? [],
        }),
      }),
    }),
  };
  // The route wraps the mutation + audit in one db.transaction; pass the handle
  // through so the callback runs (persist/logActivity are mocked out here).
  handle.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(handle);
  return handle as never;
}
function makeApp(
  dbInst: unknown,
  actor: Record<string, unknown> = { type: "board", userId: "u1" },
  opts: Parameters<typeof commanderKeyRoutes>[1] = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as { actor: unknown }).actor = actor as never; next(); });
  app.use("/api", commanderKeyRoutes(dbInst as never, opts));
  app.use(errorHandler);
  return app;
}
const url = "/api/companies/c1/internal-agent/commander-key";
const okDb = () => db([[{ agentId: "cmd" }], [{ adapterConfig: {} }]]);

describe("POST commander-key (Plan 3 T2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertRole.mockResolvedValue(undefined);
  });

  it("401 for a non-board actor", async () => {
    const res = await request(makeApp(okDb(), { type: "agent" })).post(url).send({ provider: "anthropic", value: "sk" });
    expect(res.status).toBe(401);
  });

  it("403 for a non-founder (assertRole throws)", async () => {
    mockAssertRole.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { status: 403, statusCode: 403 }));
    const res = await request(makeApp(okDb())).post(url).send({ provider: "anthropic", value: "sk" });
    expect(res.status).toBe(403);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("400 for an invalid provider", async () => {
    const res = await request(makeApp(okDb())).post(url).send({ provider: "gemini", value: "sk" });
    expect(res.status).toBe(400);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("400 for an empty value", async () => {
    const res = await request(makeApp(okDb())).post(url).send({ provider: "anthropic", value: "   " });
    expect(res.status).toBe(400);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("404 when no Commander agent is configured", async () => {
    const res = await request(makeApp(db([[]]))).post(url).send({ provider: "anthropic", value: "sk" });
    expect(res.status).toBe(404);
    expect(mockPersist).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("200 persists the key and returns the secretId (not the raw key)", async () => {
    const res = await request(makeApp(okDb())).post(url).send({ provider: "anthropic", value: "sk-ant-SECRET" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, secretId: "sec-1", verification: "verified" });
    expect(JSON.stringify(res.body)).not.toContain("sk-ant-SECRET");
    expect(mockPersist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyId: "c1", agentId: "cmd", provider: "anthropic", apiKey: "sk-ant-SECRET" }),
    );
  });

  it("does not replace the active key when the candidate is confirmed invalid", async () => {
    const res = await request(
      makeApp(okDb(), { type: "board", userId: "u1" }, {
        probeKey: async () => ({
          ok: false,
          code: "invalid_key",
          summary: "The provider rejected this API key.",
          remediation: "Check the key.",
          transient: false,
          retryAfter: null,
          supportId: "support-1",
        }),
      }),
    )
      .post(url)
      .send({ provider: "openai", value: "bad-secret" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "invalid_key", supportId: "support-1" });
    expect(JSON.stringify(res.body)).not.toContain("bad-secret");
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("never replaces the active key with a transiently unverified candidate", async () => {
    const probeKey = async () =>
      ({
        ok: false,
        code: "network",
        summary: "Provider unreachable.",
        remediation: "Check egress.",
        transient: true,
        retryAfter: null,
        supportId: "support-2",
      }) as const;
    const blocked = await request(
      makeApp(okDb(), { type: "board", userId: "u1" }, { probeKey }),
    )
      .post(url)
      .send({ provider: "openai", value: "candidate" });
    expect(blocked.status).toBe(503);
    expect(blocked.body.canSaveUnverified).toBe(false);
    expect(mockPersist).not.toHaveBeenCalled();

    const stillBlocked = await request(
      makeApp(okDb(), { type: "board", userId: "u1" }, { probeKey }),
    )
      .post(url)
      .send({ provider: "openai", value: "candidate", saveUnverified: true });
    expect(stillBlocked.status).toBe(503);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("audit-logs the credential save once, redacted (no raw key in details)", async () => {
    const res = await request(makeApp(okDb())).post(url).send({ provider: "anthropic", value: "sk-ant-SECRET" });
    expect(res.status).toBe(200);
    expect(mockLog).toHaveBeenCalledTimes(1);
    const input = mockLog.mock.calls[0][1] as {
      companyId: string;
      actorType: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      details: Record<string, unknown>;
    };
    expect(input).toMatchObject({
      companyId: "c1",
      actorType: "user",
      actorId: "u1",
      action: "commander.key.created",
      entityType: "secret",
      entityId: "sec-1",
    });
    expect(input.details).toMatchObject({ provider: "anthropic", secretId: "sec-1", operation: "created" });
    // Redaction proof: the raw pasted key never reaches the audit entry.
    expect(JSON.stringify(input)).not.toContain("sk-ant-SECRET");
  });

  it("does NOT audit-log when persistence throws (no success logged for a non-mutation)", async () => {
    mockPersist.mockRejectedValueOnce(new Error("vault unavailable"));
    const res = await request(makeApp(okDb())).post(url).send({ provider: "anthropic", value: "sk-ant-SECRET" });
    expect(res.status).toBe(500);
    expect(mockLog).not.toHaveBeenCalled();
  });
});
