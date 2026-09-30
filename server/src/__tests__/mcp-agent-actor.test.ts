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

interface BuildAppOptions {
  actor: Record<string, unknown>;
  /** Override the company returned by companiesSvc.getById. */
  company?: { id: string; mcpEnabled?: boolean } | null;
}

function buildApp(opts: BuildAppOptions) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: Record<string, unknown> }).actor = opts.actor;
    next();
  });

  const company = opts.company === undefined
    ? { id: "company-1", mcpEnabled: true }
    : opts.company;

  app.use(
    "/api",
    mcpServerRoutes({} as never, {
      companiesSvc: {
        getById: vi.fn().mockResolvedValue(company),
        update: vi.fn(),
      } as never,
      mcpSvc: {
        getStatus: vi.fn(),
        listKeys: vi.fn(),
        createKey: vi.fn(),
        revokeKey: vi.fn(),
        listClients: vi.fn(),
        touchClient: vi.fn().mockResolvedValue(undefined),
        requireOwnedKey: vi.fn(),
      } as never,
      resolveScope: async () => ({ kind: "founder" as const, userId: "agent-1" }),
      resolveRole: async () => "team_member",
      resolveScopedAgentIds: async () => null,
    }),
  );

  return app;
}

const initializeRpc = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { clientInfo: { name: "test-client", version: "1.0.0" } },
};

describe("MCP server — agent actor type", () => {
  it("authenticates an agent actor with companyId + agentId on initialize", async () => {
    const app = buildApp({
      actor: {
        type: "agent",
        source: "agent_jwt",
        companyId: "company-1",
        agentId: "agent-42",
        runId: "run-99",
      },
    });

    const res = await request(app)
      .post("/api/companies/company-1/mcp")
      .send(initializeRpc);

    expect(res.status).toBe(200);
    expect(res.body.result?.serverInfo?.name).toBe("aoa-mcp");
    expect(res.body.error).toBeUndefined();
  });

  it("rejects an agent actor whose JWT companyId does not match the URL companyId", async () => {
    const app = buildApp({
      actor: {
        type: "agent",
        source: "agent_jwt",
        companyId: "company-OTHER",
        agentId: "agent-42",
      },
    });

    const res = await request(app)
      .post("/api/companies/company-1/mcp")
      .send(initializeRpc);

    expect(res.status).not.toBe(200);
    // Either 403 (forbidden) — the company-mismatch path lights up
    // before the route handler emits its own error envelope.
    expect([401, 403]).toContain(res.status);
  });

  it("allows an agent actor to call MCP even when company.mcpEnabled is false (internal access)", async () => {
    // mcpEnabled gates EXTERNAL clients (mcp Bearer keys). Internal
    // agents authenticate via run JWT and should reach MCP regardless
    // of the founder's external-MCP toggle.
    const app = buildApp({
      actor: {
        type: "agent",
        source: "agent_jwt",
        companyId: "company-1",
        agentId: "agent-42",
      },
      company: { id: "company-1", mcpEnabled: false },
    });

    const res = await request(app)
      .post("/api/companies/company-1/mcp")
      .send(initializeRpc);

    expect(res.status).toBe(200);
    expect(res.body.result?.serverInfo?.name).toBe("aoa-mcp");
  });

  it("blocks an external mcp actor when company.mcpEnabled is false", async () => {
    // Sanity check the inverse: external mcp actors ARE still gated by
    // the toggle (this is the existing behavior pre-Phase-1).
    const app = buildApp({
      actor: {
        type: "mcp",
        source: "mcp_key",
        userId: "user-1",
        companyId: "company-1",
        keyId: "key-1",
      },
      company: { id: "company-1", mcpEnabled: false },
    });

    const res = await request(app)
      .post("/api/companies/company-1/mcp")
      .send(initializeRpc);

    expect(res.status).not.toBe(200);
    expect([401, 403]).toContain(res.status);
  });

  it("rejects a 'none' actor (no auth)", async () => {
    const app = buildApp({
      actor: { type: "none", source: "anonymous" },
    });

    const res = await request(app)
      .post("/api/companies/company-1/mcp")
      .send(initializeRpc);

    expect(res.status).toBe(401);
  });
});
