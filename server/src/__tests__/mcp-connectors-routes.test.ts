import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route imports only mocked service factories + loadConfig at runtime; it
// touches neither drizzle-orm nor @armyofagents/db directly (Db is a type-only
// import), so no table/operator stubs are needed here.

let deploymentMode = "authenticated";
vi.mock("../config.js", () => ({
  loadConfig: () => ({ deploymentMode }),
}));

const mockConnectorSvc = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByName: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listAgentIds: vi.fn(),
  agentIdsInCompany: vi.fn(),
  replaceAgents: vi.fn(),
}));

const mockSecretSvc = vi.hoisted(() => ({
  getByName: vi.fn(),
}));

const mockApprovalSvc = vi.hoisted(() => ({
  create: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  mcpConnectorService: () => mockConnectorSvc,
  secretService: () => mockSecretSvc,
  approvalService: () => mockApprovalSvc,
  logActivity: mockLogActivity,
}));

const mockGetEffectiveRole = vi.hoisted(() => vi.fn());
vi.mock("../services/permissions.js", () => ({
  permissionService: () => ({
    getEffectiveRole: mockGetEffectiveRole,
    isFounder: vi.fn(),
  }),
}));

import { mcpConnectorRoutes } from "../routes/mcp-connectors.js";
// The D7 gate lives in services/, not in this route module: it has two callers
// (BYO create + catalog install) and a route is the wrong place to source an
// authorization primitive from.
import { assertTransportAllowed } from "../services/mcp-connector-transport-gate.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY = "company-A";
const CONNECTOR_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_A = "22222222-2222-4222-8222-222222222222";
const AGENT_B = "33333333-3333-4333-8333-333333333333";
const FOUNDER_UUID = "44444444-4444-4444-8444-444444444444";

const founderActor = {
  type: "board" as const,
  source: "session" as const,
  userId: FOUNDER_UUID,
  companyIds: [COMPANY],
  isInstanceAdmin: false,
};

function actorWithRole(role: string) {
  mockGetEffectiveRole.mockResolvedValue(role);
  return founderActor;
}

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  // db stub: only `transaction` is exercised by the route (Finding 4's atomic
  // create). It runs the callback with a throwaway tx; the tx-scoped services are
  // module-mocked, so they ignore the tx value and return the same mocks.
  app.use("/api", mcpConnectorRoutes({ transaction: (fn: any) => fn({}) } as any));
  app.use(errorHandler);
  return app;
}

const goodHttp = {
  serverName: "notion",
  displayName: "Notion",
  transport: "http",
  url: "https://mcp.notion.example/v1",
};

const goodStdio = {
  serverName: "local-fs",
  displayName: "Local FS",
  transport: "stdio",
  command: "npx",
  // WS2: stdio packages must be exact-version pinned (assertStdioCommandSafe).
  args: ["-y", "fs-mcp@1.0.0"],
};

function postConnector(app: express.Express, body: unknown) {
  return request(app).post(`/api/companies/${COMPANY}/mcp-connectors`).send(body as object);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mcp-connectors routes — emergency creation barrier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode = "authenticated";
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.getByName.mockResolvedValue(null);
  });

  it("returns 403 and performs no write when connectors are globally disabled", async () => {
    vi.stubEnv("AOA_MCP_CONNECTORS_ENABLED", "false");

    const res = await postConnector(makeApp(founderActor), goodHttp);

    expect(res.status).toBe(403);
    expect(mockConnectorSvc.getByName).not.toHaveBeenCalled();
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
    expect(mockApprovalSvc.create).not.toHaveBeenCalled();
  });

  it("returns 403 and performs no write for a denylisted server name", async () => {
    vi.stubEnv("AOA_MCP_CONNECTOR_DENYLIST", "notion");

    const res = await postConnector(makeApp(founderActor), goodHttp);

    expect(res.status).toBe(403);
    expect(mockConnectorSvc.getByName).not.toHaveBeenCalled();
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });
});

describe("mcp-connectors routes — validation (load-bearing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode = "authenticated";
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.getByName.mockResolvedValue(null);
    mockConnectorSvc.create.mockImplementation(async (_c: string, input: any) => ({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      ...input,
    }));
    mockApprovalSvc.create.mockResolvedValue({ id: "approval-1" });
  });

  it.each([
    ["uppercase", "Notion"],
    ["underscore", "note_ion"],
    ["space", "note ion"],
    ["__proto__", "__proto__"],
    ["empty", ""],
  ])("rejects serverName with %s -> 400", async (_label, serverName) => {
    const res = await postConnector(makeApp(founderActor), { ...goodHttp, serverName });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  // FU-28 — a reserved AoA-owned server name (stripped at delivery, rejected by
  // the FU-25 auto-allow parser) must not be creatable as a connector.
  it.each([["aoa"], ["playwright"]])(
    "rejects reserved serverName %s -> 400",
    async (serverName) => {
      const res = await postConnector(makeApp(founderActor), { ...goodHttp, serverName });
      expect(res.status).toBe(400);
      expect(mockConnectorSvc.create).not.toHaveBeenCalled();
    },
  );

  it("rejects http without url -> 400", async () => {
    const { url: _url, ...noUrl } = goodHttp;
    const res = await postConnector(makeApp(founderActor), noUrl);
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("rejects http with command -> 400", async () => {
    const res = await postConnector(makeApp(founderActor), { ...goodHttp, command: "npx" });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("rejects stdio without command -> 400", async () => {
    const { command: _cmd, ...noCmd } = goodStdio;
    const res = await postConnector(makeApp(founderActor), noCmd);
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("rejects stdio with url -> 400", async () => {
    const res = await postConnector(makeApp(founderActor), {
      ...goodStdio,
      url: "https://x.example",
    });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  // FU-2 — `${...}` in `command` is REFUSED at create (the executable command is
  // not secret-substituted, so a placeholder would spawn literally). local_trusted
  // so the D7 gate does not pre-empt the 400 we are actually testing.
  it.each([
    ["a bare ${TOKEN} placeholder", "/opt/${TOKEN}/bin/srv"],
    ["an ${AOA_MCP_X_TOKEN} placeholder", "${AOA_MCP_X_TOKEN}"],
    ["a placeholder mid-path", "npx-${TOKEN}"],
  ])("rejects a stdio command containing %s -> 400, no write", async (_label, command) => {
    deploymentMode = "local_trusted";
    const res = await postConnector(makeApp(founderActor), { ...goodStdio, command });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  // WS2 (semantic change from the pre-validator policy): an absolute-path binary
  // is no longer an accepted launcher — only npx/uvx are (a bare path could run
  // any executable on the host, defeating the package-identity guarantee). Even
  // in local_trusted this is now rejected at the create chokepoint.
  it("rejects a stdio command that is not an allowed launcher (absolute path) -> 400", async () => {
    deploymentMode = "local_trusted";
    const res = await postConnector(makeApp(founderActor), {
      ...goodStdio,
      command: "/usr/local/bin/fs-mcp",
    });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("rejects args as a string -> 400", async () => {
    const res = await postConnector(makeApp(founderActor), { ...goodStdio, args: "not-an-array" });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("rejects headerTemplate with a non-string value -> 400", async () => {
    const res = await postConnector(makeApp(founderActor), {
      ...goodHttp,
      headerTemplate: { Authorization: 123 },
    });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("rejects envTemplate with a non-string value -> 400", async () => {
    const res = await postConnector(makeApp(founderActor), {
      ...goodStdio,
      envTemplate: { TOKEN: 123 },
    });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown top-level field -> 400 (strict)", async () => {
    const res = await postConnector(makeApp(founderActor), { ...goodHttp, evil: true });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("accepts a good http connector -> 201", async () => {
    const res = await postConnector(makeApp(founderActor), goodHttp);
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledTimes(1);
  });

  it("accepts a good stdio connector in local_trusted -> 201", async () => {
    // D7: stdio is host-executing, so it is admissible only when the host is the
    // founder's own machine. This is the exact case authenticated mode forbids.
    deploymentMode = "local_trusted";
    const res = await postConnector(makeApp(founderActor), goodStdio);
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledTimes(1);
  });

  // FU-19 follow-up — a BYO connector has no catalog provenance, so it persists a
  // null trust tier and the delivery-time D7 re-check correctly treats it as
  // non-exempt (dropped in authenticated).
  it("a BYO connector persists a null trust tier", async () => {
    deploymentMode = "local_trusted";
    await postConnector(makeApp(founderActor), goodStdio);
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ source: "byo", trustTier: null }),
    );
  });
});

describe("mcp-connectors routes — FINDING 1: only the connector's own ${TOKEN} is allowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode = "local_trusted";
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.getByName.mockResolvedValue(null);
    mockSecretSvc.getByName.mockResolvedValue({ id: "secret-1", name: "mcp:notion" });
    mockConnectorSvc.create.mockImplementation(async (_c: string, input: any) => ({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      ...input,
    }));
    mockApprovalSvc.create.mockResolvedValue({ id: "approval-1" });
  });

  // ── template VALUES ──────────────────────────────────────────────────────
  it.each([
    ["a real secret riding alongside ${TOKEN}", "Bearer ${TOKEN} sk-live-REAL"],
    ["an ambient foreign ${VAR}", "Bearer ${ANTHROPIC_API_KEY}"],
    ["a bare foreign ${VAR}", "${OPENAI_API_KEY}"],
    ["${TOKEN} with a trailing literal", "${TOKEN} extra"],
    ["a bare literal secret (no placeholder)", "sk-live-REAL"],
    ["a non-secret constant value (FU-20: placeholder-or-empty only)", "2"],
  ])("rejects a headerTemplate value that is %s -> 400, no write", async (_label, value) => {
    const res = await postConnector(makeApp(founderActor), {
      ...goodHttp,
      secretRef: "mcp:notion",
      headerTemplate: { Authorization: value },
    });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it.each([
    ["exactly ${TOKEN}", "${TOKEN}"],
    ["a Bearer scheme", "Bearer ${TOKEN}"],
    ["a hyphenated scheme", "Sentry-Bearer ${TOKEN}"],
    ["an empty value", ""],
  ])("accepts a legitimate headerTemplate value (%s) -> 201", async (_label, value) => {
    const res = await postConnector(makeApp(founderActor), {
      ...goodHttp,
      secretRef: "mcp:notion",
      headerTemplate: { Authorization: value },
    });
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign ${VAR} in envTemplate too -> 400", async () => {
    const res = await postConnector(makeApp(founderActor), {
      ...goodStdio,
      secretRef: "mcp:notion",
      envTemplate: { GH_TOKEN: "${AWS_SECRET_ACCESS_KEY}" },
    });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  // ── args ─────────────────────────────────────────────────────────────────
  it("rejects an arg carrying a foreign ${VAR} -> 400, no write", async () => {
    const res = await postConnector(makeApp(founderActor), {
      ...goodStdio,
      args: ["--token", "${ANTHROPIC_API_KEY}"],
    });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("accepts args carrying only bare literals and the own ${TOKEN} -> 201", async () => {
    const res = await postConnector(makeApp(founderActor), {
      ...goodStdio,
      secretRef: "mcp:notion",
      args: ["-y", "fs-mcp@1.0.0", "--token", "${TOKEN}", "--flag=${TOKEN}"],
    });
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledTimes(1);
  });

  // ── url userinfo ─────────────────────────────────────────────────────────
  it.each([
    ["basic-auth userinfo", "https://user:pass@mcp.example/v1"],
    ["a ${TOKEN} in the authority", "https://${TOKEN}@mcp.example/v1"],
  ])("rejects a url with %s -> 400, no write", async (_label, url) => {
    const res = await postConnector(makeApp(founderActor), { ...goodHttp, url });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("accepts a clean url with no userinfo -> 201", async () => {
    const res = await postConnector(makeApp(founderActor), {
      ...goodHttp,
      url: "https://mcp.notion.example/v1",
    });
    expect(res.status).toBe(201);
  });
});

describe("assertTransportAllowed — D7 stdio gate (unit truth table)", () => {
  it("stdio BYO in authenticated -> throws", () => {
    expect(() => assertTransportAllowed("stdio", "authenticated", "byo")).toThrow();
  });

  it("stdio BYO in local_trusted -> ok", () => {
    expect(() => assertTransportAllowed("stdio", "local_trusted", "byo")).not.toThrow();
  });

  it("http BYO in authenticated -> ok", () => {
    expect(() => assertTransportAllowed("http", "authenticated", "byo")).not.toThrow();
  });

  it("stdio + catalog in authenticated -> ok (verified-catalog exemption)", () => {
    // C4: the exemption is now tier-aware, so the tier must be stated. Before C4
    // this case passed with the tier omitted — that omission WAS the defect.
    expect(() => assertTransportAllowed("stdio", "authenticated", "catalog", "verified")).not.toThrow();
  });
});

describe("assertTransportAllowed — tier awareness (C4)", () => {
  it("allows a VERIFIED catalog stdio connector in authenticated mode", () => {
    expect(() => assertTransportAllowed("stdio", "authenticated", "catalog", "verified")).not.toThrow();
  });

  it("REJECTS an unverified catalog stdio connector in authenticated mode", () => {
    expect(() => assertTransportAllowed("stdio", "authenticated", "catalog", "community")).toThrow(/verified/i);
  });

  it("REJECTS a catalog stdio connector with no tier supplied (fail-closed)", () => {
    expect(() => assertTransportAllowed("stdio", "authenticated", "catalog", undefined)).toThrow();
  });

  it("still allows any stdio in local_trusted", () => {
    expect(() => assertTransportAllowed("stdio", "local_trusted", "catalog", "community")).not.toThrow();
  });

  it("still allows http regardless of tier", () => {
    expect(() => assertTransportAllowed("http", "authenticated", "catalog", "community")).not.toThrow();
  });

  it("rejects byo stdio in authenticated mode (unchanged)", () => {
    expect(() => assertTransportAllowed("stdio", "authenticated", "byo", undefined)).toThrow();
  });
});

describe("mcp-connectors routes — D7 transport policy (HTTP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.getByName.mockResolvedValue(null);
    mockConnectorSvc.create.mockImplementation(async (_c: string, input: any) => ({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      ...input,
    }));
    mockApprovalSvc.create.mockResolvedValue({ id: "approval-1" });
  });

  it("stdio BYO in authenticated -> 400, no write", async () => {
    deploymentMode = "authenticated";
    const res = await postConnector(makeApp(founderActor), goodStdio);
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("stdio BYO in local_trusted -> 201", async () => {
    deploymentMode = "local_trusted";
    const res = await postConnector(makeApp(founderActor), goodStdio);
    expect(res.status).toBe(201);
  });

  it("http BYO in authenticated -> 201", async () => {
    deploymentMode = "authenticated";
    const res = await postConnector(makeApp(founderActor), goodHttp);
    expect(res.status).toBe(201);
  });
});

describe("mcp-connectors routes — C3 client source is not trusted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.getByName.mockResolvedValue(null);
    mockConnectorSvc.create.mockImplementation(async (_c: string, input: any) => ({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      ...input,
    }));
    mockApprovalSvc.create.mockResolvedValue({ id: "approval-1" });
  });

  it("a spoofed source:catalog on an http create is stored as byo", async () => {
    deploymentMode = "authenticated";
    const res = await postConnector(makeApp(founderActor), { ...goodHttp, source: "catalog" });
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ source: "byo" }),
    );
  });

  it("a spoofed source:catalog cannot smuggle a stdio connector past D7", async () => {
    deploymentMode = "authenticated";
    const res = await postConnector(makeApp(founderActor), { ...goodStdio, source: "catalog" });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });
});

describe("mcp-connectors routes — secretRef existence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode = "authenticated";
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.getByName.mockResolvedValue(null);
    mockConnectorSvc.create.mockResolvedValue({ id: CONNECTOR_ID, serverName: "notion" });
    mockApprovalSvc.create.mockResolvedValue({ id: "approval-1" });
  });

  it("rejects a connector whose secretRef points at a missing secret -> 400", async () => {
    mockSecretSvc.getByName.mockResolvedValue(null);
    const res = await postConnector(makeApp(founderActor), { ...goodHttp, secretRef: "mcp:notion" });
    expect([400, 422]).toContain(res.status);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("accepts a connector whose secretRef exists -> 201", async () => {
    mockSecretSvc.getByName.mockResolvedValue({ id: "secret-1", name: "mcp:notion" });
    const res = await postConnector(makeApp(founderActor), { ...goodHttp, secretRef: "mcp:notion" });
    expect(res.status).toBe(201);
    expect(mockSecretSvc.getByName).toHaveBeenCalledWith(COMPANY, "mcp:notion");
  });
});

describe("mcp-connectors routes — deployment mode + approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.getByName.mockResolvedValue(null);
    mockConnectorSvc.create.mockImplementation(async (_c: string, input: any) => ({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      ...input,
    }));
    mockApprovalSvc.create.mockResolvedValue({ id: "approval-1" });
  });

  it("local_trusted -> connector active, no approval raised", async () => {
    deploymentMode = "local_trusted";
    const res = await postConnector(makeApp(founderActor), goodHttp);
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ status: "active" }),
    );
    expect(mockApprovalSvc.create).not.toHaveBeenCalled();
  });

  it("authenticated -> connector pending_approval + approval raised", async () => {
    deploymentMode = "authenticated";
    const res = await postConnector(makeApp(founderActor), goodHttp);
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ status: "pending_approval" }),
    );
    expect(mockApprovalSvc.create).toHaveBeenCalledTimes(1);
    expect(mockApprovalSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({
        type: "install_mcp_connector",
        status: "pending",
        payload: expect.objectContaining({ connectorId: CONNECTOR_ID }),
      }),
    );
  });
});

describe("mcp-connectors routes — POST response contract", () => {
  // `approvalId` is a LIVE CONTRACT, not an implementation detail: the settings
  // UI branches on it to decide whether to tell the founder their connector is
  // waiting on board approval
  // (ui/src/components/settings/sections/MCPConnectorsSection.tsx). Nothing else
  // in this suite asserted it, so the create-path refactor could have dropped it
  // silently and the only symptom would have been a missing notice in the UI.
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.getByName.mockResolvedValue(null);
    mockConnectorSvc.create.mockImplementation(async (_c: string, input: any) => ({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      ...input,
    }));
    mockApprovalSvc.create.mockResolvedValue({ id: "approval-1" });
  });

  it("authenticated: response carries the raised approval's id alongside the connector", async () => {
    deploymentMode = "authenticated";
    const res = await postConnector(makeApp(founderActor), goodHttp);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: CONNECTOR_ID,
      serverName: "notion",
      status: "pending_approval",
      approvalId: "approval-1",
    });
  });

  it("local_trusted: approvalId is present and null (the UI reads it, so it must exist)", async () => {
    deploymentMode = "local_trusted";
    const res = await postConnector(makeApp(founderActor), goodHttp);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("approvalId", null);
    expect(res.body.status).toBe("active");
  });

  it("authenticated: approvalId is null when the approval service returns nothing", async () => {
    deploymentMode = "authenticated";
    mockApprovalSvc.create.mockResolvedValue(undefined);
    const res = await postConnector(makeApp(founderActor), goodHttp);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("approvalId", null);
  });
});

describe("mcp-connectors routes — RBAC (founder-only writes)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode = "authenticated";
    mockConnectorSvc.getByName.mockResolvedValue(null);
    mockConnectorSvc.create.mockResolvedValue({ id: CONNECTOR_ID, serverName: "notion" });
    mockApprovalSvc.create.mockResolvedValue({ id: "approval-1" });
  });

  it("team_member POST -> 403", async () => {
    const res = await postConnector(makeApp(actorWithRole("team_member")), goodHttp);
    expect(res.status).toBe(403);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("team_lead POST -> 403", async () => {
    const res = await postConnector(makeApp(actorWithRole("team_lead")), goodHttp);
    expect(res.status).toBe(403);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("founder POST -> 201", async () => {
    const res = await postConnector(makeApp(actorWithRole("founder")), goodHttp);
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledTimes(1);
  });

  it("team_member DELETE -> 403", async () => {
    mockConnectorSvc.getById.mockResolvedValue({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      requiresSecret: false,
      secretRef: null,
    });
    const res = await request(makeApp(actorWithRole("team_member"))).delete(
      `/api/companies/${COMPANY}/mcp-connectors/${CONNECTOR_ID}`,
    );
    expect(res.status).toBe(403);
    expect(mockConnectorSvc.remove).not.toHaveBeenCalled();
  });

  it("list is allowed for any board member", async () => {
    mockGetEffectiveRole.mockResolvedValue("team_member");
    mockConnectorSvc.list.mockResolvedValue([{ id: CONNECTOR_ID }]);
    const res = await request(makeApp(founderActor)).get(`/api/companies/${COMPANY}/mcp-connectors`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("mcp-connectors routes — agent assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode = "authenticated";
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.getById.mockResolvedValue({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      requiresSecret: false,
      secretRef: null,
    });
    mockConnectorSvc.replaceAgents.mockResolvedValue(undefined);
  });

  it("replaces the enabled-agent set with company-owned agents -> 200", async () => {
    mockConnectorSvc.agentIdsInCompany.mockResolvedValue([AGENT_A, AGENT_B]);
    const res = await request(makeApp(founderActor))
      .put(`/api/companies/${COMPANY}/mcp-connectors/${CONNECTOR_ID}/agents`)
      .send({ agentIds: [AGENT_A, AGENT_B] });
    expect(res.status).toBe(200);
    expect(mockConnectorSvc.replaceAgents).toHaveBeenCalledWith(COMPANY, CONNECTOR_ID, [
      AGENT_A,
      AGENT_B,
    ]);
  });

  it("rejects an agent from another company -> 403, no write", async () => {
    // AGENT_B is foreign: agentIdsInCompany returns only AGENT_A.
    mockConnectorSvc.agentIdsInCompany.mockResolvedValue([AGENT_A]);
    const res = await request(makeApp(founderActor))
      .put(`/api/companies/${COMPANY}/mcp-connectors/${CONNECTOR_ID}/agents`)
      .send({ agentIds: [AGENT_A, AGENT_B] });
    expect(res.status).toBe(403);
    expect(mockConnectorSvc.replaceAgents).not.toHaveBeenCalled();
  });

  it("team_member agent-assignment -> 403", async () => {
    mockGetEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp(founderActor))
      .put(`/api/companies/${COMPANY}/mcp-connectors/${CONNECTOR_ID}/agents`)
      .send({ agentIds: [AGENT_A] });
    expect(res.status).toBe(403);
    expect(mockConnectorSvc.replaceAgents).not.toHaveBeenCalled();
  });
});

function patch(app: express.Express, body: unknown) {
  return request(app)
    .patch(`/api/companies/${COMPANY}/mcp-connectors/${CONNECTOR_ID}`)
    .send(body as object);
}

describe("mcp-connectors routes — patch narrowness + strict fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode = "authenticated";
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.getById.mockResolvedValue({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      requiresSecret: false,
      secretRef: null,
    });
    mockConnectorSvc.update.mockResolvedValue({ id: CONNECTOR_ID, status: "disabled" });
  });

  it("allows disabling via status -> 200", async () => {
    const res = await patch(makeApp(founderActor), { status: "disabled" });
    expect(res.status).toBe(200);
    expect(mockConnectorSvc.update).toHaveBeenCalledWith(CONNECTOR_ID, { status: "disabled" });
  });

  it("rejects editing transport-relevant fields -> 400 (strict)", async () => {
    const res = await patch(makeApp(founderActor), { url: "https://evil.example" });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.update).not.toHaveBeenCalled();
  });
});

describe("mcp-connectors routes — C2 PATCH cannot activate in authenticated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.getById.mockResolvedValue({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      requiresSecret: false,
      secretRef: null,
    });
    mockConnectorSvc.update.mockImplementation(async (_id: string, patchArg: any) => ({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      ...patchArg,
    }));
  });

  it("authenticated: pending->active via PATCH -> 400, no write", async () => {
    deploymentMode = "authenticated";
    const res = await patch(makeApp(founderActor), { status: "active" });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.update).not.toHaveBeenCalled();
  });

  it("authenticated: pending->pending_approval via PATCH -> 400, no write", async () => {
    deploymentMode = "authenticated";
    const res = await patch(makeApp(founderActor), { status: "pending_approval" });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.update).not.toHaveBeenCalled();
  });

  it("authenticated: two-hop pending->disabled->active is blocked at the second PATCH", async () => {
    deploymentMode = "authenticated";
    const first = await patch(makeApp(founderActor), { status: "disabled" });
    expect(first.status).toBe(200); // deactivation is always allowed
    const second = await patch(makeApp(founderActor), { status: "active" });
    expect(second.status).toBe(400); // re-activation via PATCH is refused
  });

  it("local_trusted: PATCH -> active is allowed (no governance gate) -> 200", async () => {
    deploymentMode = "local_trusted";
    const res = await patch(makeApp(founderActor), { status: "active" });
    expect(res.status).toBe(200);
    expect(mockConnectorSvc.update).toHaveBeenCalledWith(CONNECTOR_ID, { status: "active" });
  });
});

describe("mcp-connectors routes — FU-15 PATCH cannot activate an uncredentialed connector", () => {
  // Governance and credentials are ORTHOGONAL, and `local_trusted`'s PATCH freedom
  // is a decision about governance only. A connector that requires a secret it does
  // not have cannot authenticate no matter who flips it, so `active` there just
  // manufactures a broken connector that the delivery allowlist hands to agents.
  // This gate is therefore mode-INDEPENDENT — hence a case per deployment mode.
  const NEEDS_SECRET_UNBOUND = {
    id: CONNECTOR_ID,
    companyId: COMPANY,
    status: "needs_credentials",
    requiresSecret: true,
    secretRef: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.update.mockImplementation(async (_id: string, patchArg: any) => ({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      ...patchArg,
    }));
  });

  // DEPLOYMENT_MODES is exactly ["local_trusted", "authenticated"] — there is no
  // third mode today, so this covers every one of them.
  it.each(["local_trusted", "authenticated"])(
    "%s: PATCH -> active on a connector needing an unbound secret -> 400 naming CREDENTIALS, no write",
    async (mode) => {
      deploymentMode = mode;
      mockConnectorSvc.getById.mockResolvedValue(NEEDS_SECRET_UNBOUND);

      const res = await patch(makeApp(founderActor), { status: "active" });

      expect(res.status).toBe(400);
      expect(mockConnectorSvc.update).not.toHaveBeenCalled();
      // Asserting the MESSAGE, not just the code, is what makes the `authenticated`
      // leg meaningful: the C2 governance gate would also 400 here, so a bare
      // status assertion passes with this gate ablated. The credential gate runs
      // FIRST, so it must be the one that answers — in every mode.
      expect(JSON.stringify(res.body)).toMatch(/credential/i);
      expect(JSON.stringify(res.body)).toContain("/credentials");
    },
  );

  it("local_trusted: the 400 names the credential problem and points at the credentials endpoint", async () => {
    // In local_trusted the governance gate does NOT fire, so this proves the
    // credential gate is what refused — not the C2 rule wearing a different hat.
    deploymentMode = "local_trusted";
    mockConnectorSvc.getById.mockResolvedValue(NEEDS_SECRET_UNBOUND);

    const res = await patch(makeApp(founderActor), { status: "active" });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/credential/i);
    expect(JSON.stringify(res.body)).toContain("/credentials");
  });

  it("treats an empty-string secretRef as unbound -> 400", async () => {
    deploymentMode = "local_trusted";
    mockConnectorSvc.getById.mockResolvedValue({ ...NEEDS_SECRET_UNBOUND, secretRef: "" });

    const res = await patch(makeApp(founderActor), { status: "active" });

    expect(res.status).toBe(400);
    expect(mockConnectorSvc.update).not.toHaveBeenCalled();
  });

  it("local_trusted: PATCH -> active IS allowed once the required secret is bound", async () => {
    // The gate must refuse the unbound case only; it must not become a blanket
    // ban on activating credentialed connectors.
    deploymentMode = "local_trusted";
    mockConnectorSvc.getById.mockResolvedValue({
      ...NEEDS_SECRET_UNBOUND,
      secretRef: "mcp:notion",
    });

    const res = await patch(makeApp(founderActor), { status: "active" });

    expect(res.status).toBe(200);
    expect(mockConnectorSvc.update).toHaveBeenCalledWith(CONNECTOR_ID, { status: "active" });
  });

  it("deactivating an uncredentialed connector is still allowed -> 200", async () => {
    // The gate is activation-only. Disabling must never be blocked.
    deploymentMode = "local_trusted";
    mockConnectorSvc.getById.mockResolvedValue(NEEDS_SECRET_UNBOUND);

    const res = await patch(makeApp(founderActor), { status: "disabled" });

    expect(res.status).toBe(200);
    expect(mockConnectorSvc.update).toHaveBeenCalledWith(CONNECTOR_ID, { status: "disabled" });
  });

  it("local_trusted governance freedom is otherwise untouched: active -> disabled -> active on a connector needing no secret", async () => {
    deploymentMode = "local_trusted";
    mockConnectorSvc.getById.mockResolvedValue({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      status: "active",
      requiresSecret: false,
      secretRef: null,
    });

    const off = await patch(makeApp(founderActor), { status: "disabled" });
    expect(off.status).toBe(200);

    const on = await patch(makeApp(founderActor), { status: "active" });
    expect(on.status).toBe(200);
    expect(mockConnectorSvc.update).toHaveBeenLastCalledWith(CONNECTOR_ID, { status: "active" });
  });

  it("a displayName-only PATCH on an uncredentialed connector is unaffected -> 200", async () => {
    deploymentMode = "local_trusted";
    mockConnectorSvc.getById.mockResolvedValue(NEEDS_SECRET_UNBOUND);

    const res = await patch(makeApp(founderActor), { displayName: "Renamed" });

    expect(res.status).toBe(200);
    expect(mockConnectorSvc.update).toHaveBeenCalledWith(CONNECTOR_ID, { displayName: "Renamed" });
  });
});

describe("mcp-connectors routes — M2 PATCH is founder-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode = "authenticated";
    mockConnectorSvc.getById.mockResolvedValue({
      id: CONNECTOR_ID,
      companyId: COMPANY,
      requiresSecret: false,
      secretRef: null,
    });
    mockConnectorSvc.update.mockResolvedValue({ id: CONNECTOR_ID, status: "disabled" });
  });

  it("team_lead PATCH -> 403, no write", async () => {
    mockGetEffectiveRole.mockResolvedValue("team_lead");
    const res = await patch(makeApp(founderActor), { status: "disabled" });
    expect(res.status).toBe(403);
    expect(mockConnectorSvc.update).not.toHaveBeenCalled();
  });

  it("team_member PATCH -> 403, no write", async () => {
    mockGetEffectiveRole.mockResolvedValue("team_member");
    const res = await patch(makeApp(founderActor), { status: "disabled" });
    expect(res.status).toBe(403);
    expect(mockConnectorSvc.update).not.toHaveBeenCalled();
  });
});
