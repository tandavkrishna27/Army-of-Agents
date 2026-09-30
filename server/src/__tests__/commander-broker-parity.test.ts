import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";

// Same rationale as mcp-cross-tenant / mcp-agent-actor: pass REAL
// @armyofagents/db + drizzle-orm through (the ~90-tool internal registry
// references many schema tables), and mock ONLY ../services/index.js (server.ts's
// service-factory source) with noop factories so route construction does not
// spin real service objects against a real DB pool. createServiceContainer
// (used by resolveCommanderBrokerToolContext) imports the REAL per-domain
// service factories from ../<domain>.js, not ../services/index.js — so it is
// unaffected by this mock and constructs cheaply over the stub db.
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
import { errorHandler } from "../middleware/error-handler.js";
import {
  createToolRegistry,
  filterAuthorizedToolsForContext,
} from "../services/internal-agent/tool-registry.js";
import { resolveCommanderBrokerToolContext } from "../mcp/broker-tool-context.js";
import type { ToolContext } from "../services/internal-agent/types.js";

const CONFIG = {
  enabledCapabilities: ["system_actions", "memory_management", "discussion_processing"],
  commanderToolPermissions: {},
  runtimeApprovalsEnabled: true,
};

// Minimal drizzle-select stub for resolveCommanderBrokerToolContext's single
// `.select().from().where().limit()` config read.
function dbWithConfig(row: unknown) {
  const rows = row ? [row] : [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(rows);
  chain.then = (r: (x: unknown[]) => unknown) => Promise.resolve(rows).then(r);
  return chain;
}

describe("commander broker ⇄ in-process superset parity (spec §4 caveat c)", () => {
  it("the broker-served commander tool surface equals the in-process surface", async () => {
    const brokerCtx = await resolveCommanderBrokerToolContext({
      db: dbWithConfig(CONFIG) as never,
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      conversationId: "conv1",
    });

    // The in-process bridge context (mcp-bridge.ts:357-377) with the SAME config.
    const inProcessCtx: ToolContext = {
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      enabledCapabilities: CONFIG.enabledCapabilities,
      agentKind: undefined,
      toolAllowlist: [],
      actorType: "commander",
      commanderToolPermissions: {},
      runtimeApprovalsEnabled: true,
      db: {} as never,
      services: {} as never,
    };

    const registry = createToolRegistry();
    const brokerNames = filterAuthorizedToolsForContext(registry, brokerCtx)
      .map((t) => t.name)
      .sort();
    const inProcNames = filterAuthorizedToolsForContext(registry, inProcessCtx)
      .map((t) => t.name)
      .sort();
    expect(brokerNames).toEqual(inProcNames);
    expect(brokerNames.length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Route-level F1 proofs — drive the REAL MCP route (mcpServerRoutes) with an
// injected commander actor, mirroring mcp-cross-tenant.test.ts's harness. The
// FIRST is the mandatory F1 same-company allow (200 + tools>0 — proves the
// assertCompanyAccess commander branch actually ADMITS a same-company Commander
// broker call, not merely that cross-company is rejected). The SECOND is the §4
// caveat-b cross-company rejection.
// -----------------------------------------------------------------------------
function buildApp(actor: Record<string, unknown>, db: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  const touchClient = vi.fn().mockResolvedValue(null);
  const getById = vi.fn().mockResolvedValue({ id: "company-A", mcpEnabled: true });
  app.use(
    "/api",
    mcpServerRoutes(db as never, {
      companiesSvc: { getById, update: vi.fn() } as never,
      mcpSvc: {
        touchClient,
        getStatus: vi.fn(),
        listKeys: vi.fn(),
        createKey: vi.fn(),
        requireOwnedKey: vi.fn(),
        revokeKey: vi.fn(),
        listClients: vi.fn(),
      } as never,
      // Commander never reaches resolveScope's broker branch, but the route
      // resolves scope for every request — return a founder scope like the
      // sibling harnesses.
      resolveScope: async (_companyId: string, a: { userId: string }) => ({
        kind: "founder" as const,
        userId: a.userId,
      }),
    }),
  );
  app.use(errorHandler);
  return { app, getById };
}

function commanderActor(companyId: string) {
  return {
    type: "commander",
    source: "commander_jwt",
    companyId,
    userId: "u1",
    userRole: "founder",
    conversationId: "conv1",
    turnId: "run1",
    runId: "run1",
  };
}

describe("MCP broker — commander actor route dispatch (F1 + spec §4 caveat b)", () => {
  beforeEach(() => setDeploymentMode("cloud_auth"));
  afterEach(() => setDeploymentMode("local_trusted"));

  it("ALLOWS a SAME-company commander JWT through the real MCP route (F1 — 200/allow, not 403) and lists tools", async () => {
    // Before the assertCompanyAccess commander branch this 403'd in cloud_auth:
    // the commander actor carries no org/company membership arrays and fell into
    // the cloud board branch. Now it is admitted and the broker serves the full
    // internal registry filtered for the commander context.
    const { app } = buildApp(commanderActor("company-A"), dbWithConfig(CONFIG));
    const res = await request(app)
      .post("/api/companies/company-A/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    const names = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(names.length).toBeGreaterThan(0);
  });

  it("REJECTS a commander JWT whose company_id != URL companyId (403, spec §4 caveat b)", async () => {
    const { app } = buildApp(commanderActor("company-A"), dbWithConfig(CONFIG));
    const res = await request(app)
      .post("/api/companies/company-B/mcp")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    expect(res.status).toBe(403);
    // Robust to which company-scope guard fires first: ensureProtocolAccess's own
    // companyId check ("... another company") is defense-in-depth in front of the
    // assertCompanyAccess commander branch ("Commander JWT cannot access another
    // company"); both messages contain "another company". The function-level test
    // (authz-commander-company-access) pins the assertCompanyAccess branch message.
    expect(res.body.error.message).toMatch(/another company/i);
  });
});
