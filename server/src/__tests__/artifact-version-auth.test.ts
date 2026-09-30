import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  addVersion: vi.fn(),
  getCompanyById: vi.fn(),
  getEffectiveRole: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/permissions.js", () => ({
  permissionService: () => ({ getEffectiveRole: mocks.getEffectiveRole }),
}));

vi.mock("../services/index.js", () => ({
  artifactService: () => ({
    list: vi.fn(),
    getById: mocks.getById,
    create: vi.fn(),
    update: vi.fn(),
    addVersion: mocks.addVersion,
    archive: vi.fn(),
    unarchive: vi.fn(),
    getIssueCompanyId: vi.fn(),
    getByIssueId: vi.fn(),
  }),
  companyService: () => ({ getById: mocks.getCompanyById }),
  permissionService: () => ({ getEffectiveRole: mocks.getEffectiveRole }),
  logActivity: mocks.logActivity,
}));

import { errorHandler } from "../middleware/error-handler.js";
import { artifactRoutes } from "../routes/artifacts.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";

function boardActor() {
  return {
    type: "board",
    source: "session",
    userId: "founder-1",
    companyIds: [companyId],
    isInstanceAdmin: false,
  };
}

function makeApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", artifactRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("artifact version route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveRole.mockResolvedValue("founder");
    mocks.getCompanyById.mockResolvedValue({ id: companyId, mcpEnabled: true });
    mocks.getById.mockResolvedValue({ id: artifactId, companyId, title: "Launch report" });
    mocks.addVersion.mockImplementation(async (_id, data) => ({
      id: "33333333-3333-4333-8333-333333333333",
      artifactId,
      versionNumber: 2,
      ...data,
    }));
  });

  it("allows a board founder to publish through the ordinary REST route", async () => {
    const res = await request(makeApp(boardActor()))
      .post(`/api/artifacts/${artifactId}/versions`)
      .send({ source: "founder", content: "v2" });

    expect(res.status).toBe(201);
    expect(mocks.addVersion).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ source: "founder" }),
    );
  });

  it.each([
    {
      type: "agent",
      source: "agent_key",
      agentId: "agent-1",
      companyId,
    },
    {
      type: "mcp",
      source: "mcp_key",
      userId: "founder-1",
      companyId,
      keyId: "key-1",
    },
  ])("rejects non-board callers on the ordinary REST route", async (actor) => {
    const res = await request(makeApp(actor))
      .post(`/api/artifacts/${artifactId}/versions`)
      .send({ source: "agent", content: "v2" });

    expect(res.status).toBe(403);
    expect(mocks.addVersion).not.toHaveBeenCalled();
  });

  it("allows a founder-owned MCP key on the MCP-labelled REST route and forces the source", async () => {
    const res = await request(makeApp({
      type: "mcp",
      source: "mcp_key",
      userId: "founder-1",
      companyId,
      keyId: "key-1",
    }))
      .post(`/api/mcp/artifacts/${artifactId}/versions`)
      .send({ sourceDetail: "docs-publisher", content: "v2" });

    expect(res.status).toBe(201);
    expect(mocks.getEffectiveRole).toHaveBeenCalledWith(companyId, "founder-1");
    expect(mocks.addVersion).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ source: "mcp", sourceDetail: "docs-publisher" }),
    );
  });

  it("rejects a non-founder MCP key on the MCP-labelled REST route", async () => {
    mocks.getEffectiveRole.mockResolvedValue("team_member");

    const res = await request(makeApp({
      type: "mcp",
      source: "mcp_key",
      userId: "member-1",
      companyId,
      keyId: "key-2",
    }))
      .post(`/api/mcp/artifacts/${artifactId}/versions`)
      .send({ sourceDetail: "docs-publisher", content: "v2" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Founder authority required");
    expect(mocks.addVersion).not.toHaveBeenCalled();
  });

  it("rejects a founder-owned MCP key when external MCP is disabled", async () => {
    mocks.getCompanyById.mockResolvedValue({ id: companyId, mcpEnabled: false });

    const res = await request(makeApp({
      type: "mcp",
      source: "mcp_key",
      userId: "founder-1",
      companyId,
      keyId: "key-1",
    }))
      .post(`/api/mcp/artifacts/${artifactId}/versions`)
      .send({ sourceDetail: "docs-publisher", content: "v2" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("MCP server is disabled for this company");
    expect(mocks.getEffectiveRole).not.toHaveBeenCalled();
    expect(mocks.addVersion).not.toHaveBeenCalled();
  });

  it("rejects an MCP key when its company no longer exists", async () => {
    mocks.getCompanyById.mockResolvedValue(null);

    const res = await request(makeApp({
      type: "mcp",
      source: "mcp_key",
      userId: "founder-1",
      companyId,
      keyId: "key-1",
    }))
      .post(`/api/mcp/artifacts/${artifactId}/versions`)
      .send({ sourceDetail: "docs-publisher", content: "v2" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Company not found");
    expect(mocks.getEffectiveRole).not.toHaveBeenCalled();
    expect(mocks.addVersion).not.toHaveBeenCalled();
  });

  it("allows a board founder on the MCP-labelled route when external MCP is disabled", async () => {
    mocks.getCompanyById.mockResolvedValue({ id: companyId, mcpEnabled: false });

    const res = await request(makeApp(boardActor()))
      .post(`/api/mcp/artifacts/${artifactId}/versions`)
      .send({ sourceDetail: "board-publisher", content: "v2" });

    expect(res.status).toBe(201);
    expect(mocks.getCompanyById).not.toHaveBeenCalled();
    expect(mocks.getEffectiveRole).toHaveBeenCalledWith(companyId, "founder-1");
    expect(mocks.addVersion).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ source: "mcp", sourceDetail: "board-publisher" }),
    );
  });

  it("rejects an agent on the MCP-labelled REST route", async () => {
    const res = await request(makeApp({
      type: "agent",
      source: "agent_key",
      agentId: "agent-1",
      companyId,
    }))
      .post(`/api/mcp/artifacts/${artifactId}/versions`)
      .send({ sourceDetail: "agent", content: "v2" });

    expect(res.status).toBe(403);
    expect(mocks.addVersion).not.toHaveBeenCalled();
  });
});
