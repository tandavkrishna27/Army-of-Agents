// server/src/__tests__/mcp-run-currency-gate.test.ts — DAT-007 item #1, slice 2 (Tier 2).
//
// Route-level proof of the /mcp fence-bound currency MOUNT (server.ts). With the flag on, a
// distributed run-JWT agent actor's request is gated by the injected currency resolver: a
// "deny" yields the coarse 403 on EVERY method (initialize / tools/list / tools/call, since the
// gate sits before the method split), an "admit" falls through, and a resolver throw fails
// CLOSED. With the flag off, or for a non-agent / no-signedRunId actor, the resolver is never
// consulted (byte-identical legacy). The resolver is injected as a STUB — the real DB query is
// proven in the Tier-3 integration test. The deny/admit/skip differential is the anti-vacuity
// control: all three can pass together only if the mount fires correctly and only when scoped.
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirror mcp-agent-actor.test.ts: pass REAL @armyofagents/db + drizzle-orm through (the noop
// ../services/index.js mock is what keeps real service construction off a real DB).
vi.mock("@armyofagents/db", async (importOriginal) => await importOriginal<Record<string, unknown>>());
vi.mock("drizzle-orm", async (importOriginal) => await importOriginal<Record<string, unknown>>());
vi.mock("../services/index.js", () => {
  const noopFactory = () => ({});
  return {
    agentService: noopFactory, artifactService: noopFactory, companyService: noopFactory,
    debriefService: noopFactory, extractionService: noopFactory, goalService: noopFactory,
    issueService: noopFactory, memoryService: noopFactory, mcpService: noopFactory,
    permissionService: noopFactory, accessService: noopFactory, projectService: noopFactory,
    approvalService: noopFactory, issueApprovalService: noopFactory,
    logActivity: vi.fn().mockResolvedValue(undefined),
  };
});

import { mcpServerRoutes } from "../mcp/server.js";

const FLAG = "AOA_DISTRIBUTED_EXECUTION_ENABLED";
const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

const DISTRIBUTED_AGENT = {
  type: "agent",
  source: "agent_jwt",
  companyId: "company-1",
  agentId: "agent-42",
  runId: "run-99",
  signedRunId: "run-99",
};

function buildApp(actor: Record<string, unknown>, resolveDistributedRunCurrency?: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use(
    "/api",
    mcpServerRoutes({} as never, {
      companiesSvc: {
        getById: vi.fn().mockResolvedValue({ id: "company-1", mcpEnabled: true }),
        update: vi.fn(),
      } as never,
      mcpSvc: {
        getStatus: vi.fn(), listKeys: vi.fn(), createKey: vi.fn(), revokeKey: vi.fn(),
        listClients: vi.fn(), touchClient: vi.fn().mockResolvedValue(undefined), requireOwnedKey: vi.fn(),
      } as never,
      resolveScope: async () => ({ kind: "founder" as const, userId: "agent-1" }),
      resolveRole: async () => "team_member",
      resolveScopedAgentIds: async () => null,
      ...(resolveDistributedRunCurrency
        ? { resolveDistributedRunCurrency: resolveDistributedRunCurrency as never }
        : {}),
    }),
  );
  return app;
}

describe("DAT-007 item #1 — /mcp fence-bound currency gate (route mount)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[FLAG];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  it("flag ON + distributed agent + resolver 'deny' → coarse 403 on initialize, tools/list, AND tools/call", async () => {
    process.env[FLAG] = "1";
    const resolve = vi.fn().mockResolvedValue("deny");
    const app = buildApp(DISTRIBUTED_AGENT, resolve);
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      const params = method === "tools/call" ? { name: "noop", arguments: {} } : {};
      const res = await request(app).post("/api/companies/company-1/mcp").send(rpc(method, params));
      expect(res.status).toBe(403);
    }
    // keyed on the SIGNED run id, with the URL company and the agent id
    expect(resolve).toHaveBeenCalledWith({ signedRunId: "run-99", companyId: "company-1", agentId: "agent-42" });
  });

  it("flag ON + distributed agent + resolver 'admit' → falls through (200 on initialize)", async () => {
    process.env[FLAG] = "1";
    const resolve = vi.fn().mockResolvedValue("admit");
    const app = buildApp(DISTRIBUTED_AGENT, resolve);
    const res = await request(app).post("/api/companies/company-1/mcp").send(rpc("initialize"));
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("flag ON + BOARD actor → currency resolver NEVER consulted (source scoping, edge 2)", async () => {
    // The gate is scoped to protocolActor.source === "agent"; a board actor never reaches it
    // (whatever the board-auth pipeline decides its status is), so the resolver is not consulted.
    process.env[FLAG] = "1";
    const resolve = vi.fn().mockResolvedValue("deny");
    const app = buildApp({ type: "board", source: "board", userId: "u-1", companyId: "company-1" }, resolve);
    await request(app).post("/api/companies/company-1/mcp").send(rpc("initialize"));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("flag ON + agent WITHOUT signedRunId → resolver NEVER consulted (edge 3, agent-API-key)", async () => {
    process.env[FLAG] = "1";
    const resolve = vi.fn().mockResolvedValue("deny");
    const app = buildApp({ type: "agent", source: "agent_jwt", companyId: "company-1", agentId: "agent-42" }, resolve);
    const res = await request(app).post("/api/companies/company-1/mcp").send(rpc("initialize"));
    expect(res.status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("flag OFF (unset) + distributed agent → resolver NEVER consulted (byte-identical legacy)", async () => {
    delete process.env[FLAG];
    const resolve = vi.fn().mockResolvedValue("deny");
    const app = buildApp(DISTRIBUTED_AGENT, resolve);
    const res = await request(app).post("/api/companies/company-1/mcp").send(rpc("initialize"));
    expect(res.status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("flag ON + resolver THROWS → fails CLOSED (non-2xx), never swallowed to admit (Correction A)", async () => {
    process.env[FLAG] = "1";
    const resolve = vi.fn().mockRejectedValue(new Error("kernel db unreachable"));
    const app = buildApp(DISTRIBUTED_AGENT, resolve);
    const res = await request(app).post("/api/companies/company-1/mcp").send(rpc("initialize"));
    expect(res.status).not.toBe(200);
  });
});
