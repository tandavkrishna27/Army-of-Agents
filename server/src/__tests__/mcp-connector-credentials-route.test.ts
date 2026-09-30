// Plan 3a Task 8 (C3) — POST /companies/:companyId/mcp-connectors/:id/credentials.
//
// THE GAP THIS CLOSES: `ConnectorPatch` was `{ displayName?, status? }` and
// `updateConnectorSchema` is `.strict()` on those two, so there was NO way to set
// `secretRef` after create — the central journey (install unconfigured → bind a
// credential → active) was unimplementable.
//
// THE SECURITY POINT: the resulting status is DERIVED from
// `resolveConnectorStatus`, never accepted from the caller. Binding a credential
// must not become a second activation bypass alongside the PATCH one the route
// already closes, must not resurrect a rejected (disabled) connector, and must
// not let a connector still awaiting board approval jump straight to active.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  updateIfStatus: vi.fn(),
  remove: vi.fn(),
  listAgentIds: vi.fn(),
  agentIdsInCompany: vi.fn(),
  replaceAgents: vi.fn(),
}));

const mockSecretSvc = vi.hoisted(() => ({ getByName: vi.fn() }));
const mockApprovalSvc = vi.hoisted(() => ({ create: vi.fn() }));
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

import { bindCredentialsSchema, mcpConnectorRoutes } from "../routes/mcp-connectors.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY = "company-A";
const CONNECTOR_ID = "11111111-1111-4111-8111-111111111111";
const FOUNDER_UUID = "44444444-4444-4444-8444-444444444444";
const SECRET_REF = "mcp:notion";

const founderActor = {
  type: "board" as const,
  source: "session" as const,
  userId: FOUNDER_UUID,
  companyIds: [COMPANY],
  isInstanceAdmin: false,
};

function makeApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", mcpConnectorRoutes({ transaction: (fn: any) => fn({}) } as never));
  app.use(errorHandler);
  return app;
}

function bind(app: express.Express, body: unknown, id = CONNECTOR_ID) {
  return request(app)
    .post(`/api/companies/${COMPANY}/mcp-connectors/${id}/credentials`)
    .send(body as object);
}

/** A stored connector row as the route will read it. */
function connectorRow(status: string, requiresSecret = true) {
  return { id: CONNECTOR_ID, companyId: COMPANY, status, requiresSecret, secretRef: null };
}

describe("bindCredentialsSchema — status is derived, never sent (C3)", () => {
  it("accepts a bare secretRef", () => {
    expect(bindCredentialsSchema.safeParse({ secretRef: SECRET_REF }).success).toBe(true);
  });

  it("REJECTS a caller-supplied status (would reopen the activation bypass)", () => {
    // `.strict()` rather than "silently ignore": an ignored field looks like it
    // worked, so a caller would believe they had activated the connector.
    expect(
      bindCredentialsSchema.safeParse({ secretRef: SECRET_REF, status: "active" }).success,
    ).toBe(false);
  });

  it("rejects an empty secretRef", () => {
    expect(bindCredentialsSchema.safeParse({ secretRef: "" }).success).toBe(false);
  });

  it("rejects a missing secretRef", () => {
    expect(bindCredentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects any other unknown field", () => {
    expect(
      bindCredentialsSchema.safeParse({ secretRef: SECRET_REF, requiresSecret: false }).success,
    ).toBe(false);
  });
});

describe("POST …/credentials — derived status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockSecretSvc.getByName.mockResolvedValue({ id: "secret-1", name: SECRET_REF });
    mockConnectorSvc.updateIfStatus.mockImplementation(
      async (id: string, _expected: string, patch: object) => ({ id, companyId: COMPANY, ...patch }),
    );
  });

  it("local_trusted: binding on a needs_credentials connector activates it", async () => {
    deploymentMode = "local_trusted";
    mockConnectorSvc.getById.mockResolvedValue(connectorRow("needs_credentials"));

    const res = await bind(makeApp(founderActor), { secretRef: SECRET_REF });

    expect(res.status).toBe(200);
    expect(mockConnectorSvc.updateIfStatus).toHaveBeenCalledWith(
      CONNECTOR_ID,
      expect.any(String),
      { secretRef: SECRET_REF, status: "active" },
    );
  });

  it("authenticated: binding on a needs_credentials connector activates it (approval already happened)", async () => {
    // In `authenticated` mode a connector can only REACH needs_credentials via
    // applyConnectorApproval, so this status is itself proof of board approval.
    deploymentMode = "authenticated";
    mockConnectorSvc.getById.mockResolvedValue(connectorRow("needs_credentials"));

    const res = await bind(makeApp(founderActor), { secretRef: SECRET_REF });

    expect(res.status).toBe(200);
    expect(mockConnectorSvc.updateIfStatus).toHaveBeenCalledWith(
      CONNECTOR_ID,
      expect.any(String),
      { secretRef: SECRET_REF, status: "active" },
    );
  });

  it("authenticated: binding must NOT bypass governance — a pending_approval connector stays pending_approval", async () => {
    deploymentMode = "authenticated";
    mockConnectorSvc.getById.mockResolvedValue(connectorRow("pending_approval"));

    const res = await bind(makeApp(founderActor), { secretRef: SECRET_REF });

    expect(res.status).toBe(200);
    expect(mockConnectorSvc.updateIfStatus).toHaveBeenCalledWith(
      CONNECTOR_ID,
      "pending_approval",
      { secretRef: SECRET_REF, status: "pending_approval" },
    );
    expect(mockConnectorSvc.updateIfStatus).not.toHaveBeenCalledWith(
      CONNECTOR_ID,
      expect.anything(),
      expect.objectContaining({ status: "active" }),
    );
  });

  it("binding must NOT resurrect a disabled connector — a rejected connector stays disabled", async () => {
    deploymentMode = "local_trusted";
    mockConnectorSvc.getById.mockResolvedValue(connectorRow("disabled"));

    const res = await bind(makeApp(founderActor), { secretRef: SECRET_REF });

    expect(res.status).toBe(200);
    expect(mockConnectorSvc.updateIfStatus).toHaveBeenCalledWith(
      CONNECTOR_ID,
      "disabled",
      { secretRef: SECRET_REF, status: "disabled" },
    );
  });

  it("rotating the secret on an already-active connector keeps it active", async () => {
    deploymentMode = "authenticated";
    mockConnectorSvc.getById.mockResolvedValue({
      ...connectorRow("active"),
      secretRef: "mcp:notion-old",
    });

    const res = await bind(makeApp(founderActor), { secretRef: SECRET_REF });

    expect(res.status).toBe(200);
    expect(mockConnectorSvc.updateIfStatus).toHaveBeenCalledWith(
      CONNECTOR_ID,
      expect.any(String),
      { secretRef: SECRET_REF, status: "active" },
    );
  });

  it("logs the binding as an activity entry", async () => {
    deploymentMode = "local_trusted";
    mockConnectorSvc.getById.mockResolvedValue(connectorRow("needs_credentials"));

    await bind(makeApp(founderActor), { secretRef: SECRET_REF });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY,
        action: "mcp_connector.credentials_bound",
        entityType: "mcp_connector",
        entityId: CONNECTOR_ID,
        details: { secretRef: SECRET_REF, status: "active" },
      }),
    );
  });
});

describe("POST …/credentials — validation + tenancy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode = "authenticated";
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockConnectorSvc.updateIfStatus.mockResolvedValue({ id: CONNECTOR_ID });
  });

  it("a secretRef naming no existing secret -> 400, no write", async () => {
    mockConnectorSvc.getById.mockResolvedValue(connectorRow("needs_credentials"));
    mockSecretSvc.getByName.mockResolvedValue(null);

    const res = await bind(makeApp(founderActor), { secretRef: "mcp:ghost" });

    expect(res.status).toBe(400);
    expect(mockConnectorSvc.updateIfStatus).not.toHaveBeenCalled();
  });

  it("a broker-managed OAuth secret cannot be rebound to another connector", async () => {
    mockConnectorSvc.getById.mockResolvedValue(connectorRow("needs_credentials"));
    mockSecretSvc.getByName.mockResolvedValue({
      id: "oauth-secret",
      name: "mcp:oauth:owner-connector",
      providerMetadata: {
        purpose: "mcp_oauth",
        ownerConnectorId: "owner-connector",
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
      },
    });

    const res = await bind(makeApp(founderActor), {
      secretRef: "mcp:oauth:owner-connector",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/broker-managed/i);
    expect(mockConnectorSvc.updateIfStatus).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("a connector belonging to another company -> 404, no secret lookup, no write", async () => {
    mockConnectorSvc.getById.mockResolvedValue({
      ...connectorRow("needs_credentials"),
      companyId: "company-OTHER",
    });

    const res = await bind(makeApp(founderActor), { secretRef: SECRET_REF });

    expect(res.status).toBe(404);
    expect(mockSecretSvc.getByName).not.toHaveBeenCalled();
    expect(mockConnectorSvc.updateIfStatus).not.toHaveBeenCalled();
  });

  it("a lost TOCTOU race -> 409, not a lie about the connector being missing", async () => {
    // The guarded UPDATE matched 0 rows: the board approved (or the founder
    // disabled) between our read and our write, so `nextStatus` is a stale
    // derivation. The damaging interleave is bind-landing-last in `authenticated`,
    // which would park the connector at pending_approval with the approval already
    // closed and no way back. 409 tells the founder to retry against the new state.
    mockConnectorSvc.getById.mockResolvedValue(connectorRow("needs_credentials"));
    mockSecretSvc.getByName.mockResolvedValue({ id: "secret-1", name: SECRET_REF });
    mockConnectorSvc.updateIfStatus.mockResolvedValue(null);

    const res = await bind(makeApp(founderActor), { secretRef: SECRET_REF });

    expect(res.status).toBe(409);
  });

  it("a missing connector -> 404, no write", async () => {
    mockConnectorSvc.getById.mockResolvedValue(null);

    const res = await bind(makeApp(founderActor), { secretRef: SECRET_REF });

    expect(res.status).toBe(404);
    expect(mockConnectorSvc.updateIfStatus).not.toHaveBeenCalled();
  });

  it("a caller-supplied status -> 400, no write (strict, not silently ignored)", async () => {
    mockConnectorSvc.getById.mockResolvedValue(connectorRow("pending_approval"));
    mockSecretSvc.getByName.mockResolvedValue({ id: "secret-1", name: SECRET_REF });

    const res = await bind(makeApp(founderActor), { secretRef: SECRET_REF, status: "active" });

    expect(res.status).toBe(400);
    expect(mockConnectorSvc.updateIfStatus).not.toHaveBeenCalled();
  });
});

describe("POST …/credentials — founder only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode = "authenticated";
    mockConnectorSvc.getById.mockResolvedValue(connectorRow("needs_credentials"));
    mockSecretSvc.getByName.mockResolvedValue({ id: "secret-1", name: SECRET_REF });
    mockConnectorSvc.updateIfStatus.mockResolvedValue({ id: CONNECTOR_ID });
  });

  it.each(["team_member", "team_lead"])("%s -> 403, no write", async (role) => {
    mockGetEffectiveRole.mockResolvedValue(role);

    const res = await bind(makeApp(founderActor), { secretRef: SECRET_REF });

    expect(res.status).toBe(403);
    expect(mockConnectorSvc.updateIfStatus).not.toHaveBeenCalled();
  });
});
