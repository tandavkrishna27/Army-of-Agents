/**
 * @fileoverview Tasks 11 + 12 — the OAuth connector broker's two HTTP routes:
 * `POST …/:id/oauth/start` (discovery + DCR + PKCE + signed state) and
 * `GET /mcp-connectors/oauth/callback` (state verify + atomic single-use claim +
 * code exchange + secret store + connector bind).
 *
 * The routes call `db.insert/select/update` directly on the DB injected into
 * `mcpConnectorRoutes(db, opts)`, so a module-level `vi.mock("@armyofagents/db")`
 * would NOT intercept them — this file builds a capable fake `db` instead.
 */

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let deploymentMode = "authenticated";
vi.mock("../config.js", () => ({
  loadConfig: () => ({
    deploymentMode,
    port: 3100,
    authPublicBaseUrl: "https://app.test",
  }),
}));

const mockConnectorSvc = vi.hoisted(() => ({
  getById: vi.fn(),
  getByName: vi.fn(),
  create: vi.fn(),
  updateIfStatus: vi.fn(),
}));
const mockSecretSvc = vi.hoisted(() => ({
  getByName: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
  resolveByName: vi.fn(),
  commitPreparedMcpOAuthSecret: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockInsertActivity = vi.hoisted(() => vi.fn());
const mockPublishActivity = vi.hoisted(() => vi.fn());
const mockPrepareSecret = vi.hoisted(() => vi.fn());
vi.mock("../services/index.js", () => ({
  mcpConnectorService: () => mockConnectorSvc,
  secretService: () => mockSecretSvc,
  logActivity: mockLogActivity,
  insertActivity: mockInsertActivity,
  publishActivity: mockPublishActivity,
  prepareMcpOAuthSecretVersion: mockPrepareSecret,
  approvalService: () => ({ create: vi.fn() }),
}));
const mockGetEffectiveRole = vi.hoisted(() => vi.fn());
vi.mock("../services/permissions.js", () => ({
  permissionService: () => ({
    getEffectiveRole: mockGetEffectiveRole,
    isFounder: vi.fn(),
  }),
}));
const mockOauth = vi.hoisted(() => {
  class OAuthRequestError extends Error {
    kind = "http";
  }
  return {
    OAuthRequestError,
    discoverOAuthServer: vi.fn(),
    registerOAuthClient: vi.fn(),
    generatePkce: vi.fn(),
    signOAuthState: vi.fn(),
    buildAuthorizeUrl: vi.fn(),
    exchangeAuthorizationCode: vi.fn(),
    verifyOAuthState: vi.fn(),
  };
});
vi.mock("../services/mcp-connector-oauth.js", () => mockOauth);

import { mcpConnectorRoutes } from "../routes/mcp-connectors.js";
import { errorHandler } from "../middleware/index.js";
import {
  deriveOAuthBundleKey,
  encodeOAuthBundle,
} from "../services/mcp-connector-oauth-bundle.js";

const COMPANY = "company-A";
const FOUNDER_UUID = "44444444-4444-4444-8444-444444444444";
const OPAQUE_USER_ID = "user_better_auth_01j4opaque";
const founderActor = {
  type: "board" as const,
  source: "session" as const,
  userId: FOUNDER_UUID,
  companyIds: [COMPANY],
  isInstanceAdmin: false,
};
const CATALOG = [
  {
    id: "notion-hosted",
    serverName: "notion",
    displayName: "Notion (hosted)",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    requiresOAuth: true,
    oauth: { scopes: ["default"] },
    trust: { tier: "verified" },
  },
];
const callbackFlow = () => ({
  id: "flow1",
  connectorId: "conn1",
  companyId: COMPANY,
  catalogEntryId: "notion-hosted",
  oauthPolicyVersion: 1,
  status: "pending",
  pkceVerifier: "ver",
  clientId: "cid",
  redirectUri: "https://app.test/api/mcp-connectors/oauth/callback",
  authorizationEndpoint: "https://mcp.notion.com/authorize",
  tokenEndpoint: "https://mcp.notion.com/token",
  resource: "https://mcp.notion.com/mcp",
  scopes: ["default"],
  expiresAt: new Date(Date.now() + 60_000),
  startedByUserId: FOUNDER_UUID,
});
const oauthConnector = () => ({
  id: "conn1",
  companyId: COMPANY,
  serverName: "notion",
  status: "needs_credentials",
  source: "catalog",
  catalogEntryId: "notion-hosted",
  oauthPolicyVersion: 1,
  transport: "http",
  url: "https://mcp.notion.com/mcp",
});

// Capture DB writes/reads; the routes call these on the injected db.
const mockFlowInsert = vi.fn();
const mockCatalogLoad = vi.fn();
const mockFlowSelect = vi.fn().mockResolvedValue([]); // select().from().where().limit()
const mockFlowClaim = vi.fn().mockResolvedValue([{ id: "flow1" }]); // update().set().where().returning()
const mockFlowUpdate = vi.fn(); // captures every update().set(...) payload
const mockLockedFlowSelect = vi.fn();
const mockLockedConnectorSelect = vi.fn();
const mockDbExecute = vi.fn().mockResolvedValue([]);
function fakeDb() {
  // `where()` is awaited for fire-and-forget status flips AND chained to `.returning()` for the
  // atomic claim, so make it BOTH a thenable and expose `.returning()`. `set()` now returns this
  // object directly (so the payload can be captured via mockFlowUpdate first), so it also exposes
  // a self-returning `.where()` — the route always chains `.set(...).where(...)`, with or without
  // a trailing `.returning()`.
  const whereResult: any = {
    where: () => whereResult,
    returning: () => mockFlowClaim(),
    then: (r: any) => Promise.resolve().then(r),
    catch: () => Promise.resolve(),
  };
  const db: any = {
    insert: () => ({
      values: (v: any) => {
        mockFlowInsert(v);
        return Promise.resolve();
      },
    }),
    select: () => {
      const chain: any = {};
      chain.from = (table: any) => {
        chain.table = table;
        return chain;
      };
      chain.where = () => chain;
      chain.limit = () => mockFlowSelect();
      chain.for = () =>
        "serverName" in chain.table
          ? mockLockedConnectorSelect()
          : mockLockedFlowSelect();
      return chain;
    },
    update: () => ({
      set: (v: any) => {
        mockFlowUpdate(v);
        return whereResult;
      },
    }),
    execute: mockDbExecute,
  };
  db.transaction = (fn: any) => fn(db);
  return db as never;
}
function makeApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    mcpConnectorRoutes(fakeDb(), { catalog: { load: mockCatalogLoad } })
  );
  app.use(errorHandler);
  return app;
}
beforeEach(() => {
  vi.clearAllMocks();
  mockPublishActivity.mockReset();
  mockDbExecute.mockResolvedValue([]);
  vi.unstubAllEnvs();
  deploymentMode = "local_trusted";
  mockCatalogLoad.mockResolvedValue({ entries: CATALOG, stale: false });
  mockGetEffectiveRole.mockResolvedValue("founder");
  mockFlowSelect.mockResolvedValue([]);
  mockFlowClaim.mockResolvedValue([{ id: "flow1" }]);
  mockLockedFlowSelect.mockResolvedValue([
    { ...callbackFlow(), status: "claimed" },
  ]);
  mockLockedConnectorSelect.mockResolvedValue([oauthConnector()]);
  mockFlowUpdate.mockReset();
  mockPrepareSecret.mockResolvedValue({ prepared: true });
  mockSecretSvc.commitPreparedMcpOAuthSecret.mockResolvedValue({
    id: "sec1",
    latestVersion: 1,
  });
  mockInsertActivity.mockResolvedValue({ companyId: COMPANY, payload: {} });
  // `resolveConsentSecret()` (../services/mcp-connector-consent.js) is NOT part of
  // the mocked `mcp-connector-oauth.js` module, so /oauth/start's fail-fast guard
  // calls the REAL implementation, which reads env at call time. Keep a secret
  // present by default so the existing start tests exercise the happy path; the
  // "no signing secret" test below deletes both vars itself and restores them.
  process.env.BETTER_AUTH_SECRET ||= "test-secret";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("authenticated start preserves an opaque Better Auth user id and does not reload the remote catalog", async () => {
  deploymentMode = "authenticated";
  const opaqueFounder = { ...founderActor, userId: OPAQUE_USER_ID };
  mockConnectorSvc.getById.mockResolvedValue({
    id: "conn1",
    companyId: COMPANY,
    serverName: "notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    requiresSecret: true,
    secretRef: null,
    status: "needs_credentials",
    source: "catalog",
    catalogEntryId: "notion-hosted",
    oauthPolicyVersion: 1,
  });
  mockOauth.discoverOAuthServer.mockResolvedValue({
    issuer: "https://mcp.notion.com",
    authorizationEndpoint: "https://mcp.notion.com/authorize",
    tokenEndpoint: "https://mcp.notion.com/token",
    registrationEndpoint: "https://mcp.notion.com/register",
    scopesSupported: ["default"],
    codeChallengeMethods: ["S256"],
  });
  mockOauth.registerOAuthClient.mockResolvedValue({ clientId: "cid" });
  mockOauth.generatePkce.mockReturnValue({
    verifier: "ver",
    challenge: "chal",
  });
  mockOauth.signOAuthState.mockReturnValue("STATE");
  mockOauth.buildAuthorizeUrl.mockReturnValue("https://as/authorize?x=1");
  mockPublishActivity.mockImplementation(() => {
    throw new Error("listener failed");
  });

  const res = await request(makeApp(opaqueFounder))
    .post(`/api/companies/${COMPANY}/mcp-connectors/conn1/oauth/start`)
    .send({});
  expect(res.status).toBe(200);
  expect(res.body.authorizeUrl).toBe("https://as/authorize?x=1");
  expect(mockFlowInsert).toHaveBeenCalledWith(
    expect.objectContaining({
      connectorId: "conn1",
      state: "STATE",
      clientId: "cid",
      startedByUserId: OPAQUE_USER_ID,
    })
  );
  expect(mockDbExecute).toHaveBeenCalledTimes(1);
  expect(mockInsertActivity).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: "mcp_connector.oauth_started",
      entityId: "conn1",
    })
  );
  expect(mockPublishActivity).toHaveBeenCalledTimes(1);
  expect(mockCatalogLoad).not.toHaveBeenCalled();
});

it("registers a new OAuth client when the server callback URI changed", async () => {
  deploymentMode = "authenticated";
  mockConnectorSvc.getById.mockResolvedValue({
    ...oauthConnector(),
    secretRef: "mcp:oauth:conn1",
  });
  mockOauth.discoverOAuthServer.mockResolvedValue({
    issuer: "https://mcp.notion.com",
    authorizationEndpoint: "https://mcp.notion.com/authorize",
    tokenEndpoint: "https://mcp.notion.com/token",
    registrationEndpoint: "https://mcp.notion.com/register",
    scopesSupported: ["default"],
    codeChallengeMethods: ["S256"],
  });
  mockOauth.registerOAuthClient.mockResolvedValue({ clientId: "new-client" });
  mockOauth.generatePkce.mockReturnValue({
    verifier: "ver",
    challenge: "chal",
  });
  mockOauth.signOAuthState.mockReturnValue("STATE");
  mockOauth.buildAuthorizeUrl.mockReturnValue(
    "https://mcp.notion.com/authorize?x=1"
  );
  const key = deriveOAuthBundleKey(process.env.BETTER_AUTH_SECRET!);
  mockSecretSvc.resolveByName.mockResolvedValue(
    encodeOAuthBundle(
      {
        companyId: COMPANY,
        connectorId: "conn1",
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
        secretName: "mcp:oauth:conn1",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Date.now() + 60_000,
        issuer: "https://mcp.notion.com",
        tokenEndpoint: "https://mcp.notion.com/token",
        clientId: "old-client",
        redirectUri: "https://old.example/api/mcp-connectors/oauth/callback",
        scopes: ["default"],
        resource: "https://mcp.notion.com/mcp",
      },
      key
    )
  );

  const res = await request(makeApp(founderActor))
    .post(`/api/companies/${COMPANY}/mcp-connectors/conn1/oauth/start`)
    .send({});

  expect(res.status).toBe(200);
  expect(mockOauth.registerOAuthClient).toHaveBeenCalledWith(
    "https://mcp.notion.com/register",
    "https://app.test/api/mcp-connectors/oauth/callback",
    undefined
  );
  expect(mockFlowInsert).toHaveBeenCalledWith(
    expect.objectContaining({ clientId: "new-client" })
  );
});

it("rejects oauth/start on a non-OAuth connector (Fix 11)", async () => {
  mockConnectorSvc.getById.mockResolvedValue({
    id: "conn2",
    companyId: COMPANY,
    serverName: "linear",
    transport: "http",
    url: "https://x/mcp",
    requiresSecret: true,
    secretRef: "mcp:linear",
    status: "active",
    source: "catalog",
  });
  const res = await request(makeApp(founderActor))
    .post(`/api/companies/${COMPANY}/mcp-connectors/conn2/oauth/start`)
    .send({});
  expect(res.status).toBe(400);
  expect(mockFlowInsert).not.toHaveBeenCalled();
});

it("rejects oauth/start on a BYO connector even when its serverName collides with a catalog OAuth entry (final-review Fix 2)", async () => {
  // A BYO connector named "notion" would otherwise pass the OLD gate — which only
  // checked the catalog entry matched by serverName — and get its secret rotated
  // by the callback even though it was never installed from the catalog.
  mockConnectorSvc.getById.mockResolvedValue({
    id: "conn3",
    companyId: COMPANY,
    serverName: "notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    requiresSecret: true,
    secretRef: "mcp:notion",
    status: "active",
    source: "byo",
  });
  const res = await request(makeApp(founderActor))
    .post(`/api/companies/${COMPANY}/mcp-connectors/conn3/oauth/start`)
    .send({});
  expect(res.status).toBe(400);
  expect(mockFlowInsert).not.toHaveBeenCalled();
});

it.each(["team_lead", "team_member"])("%s is forbidden", async (role) => {
  mockGetEffectiveRole.mockResolvedValue(role);
  mockConnectorSvc.getById.mockResolvedValue({
    id: "conn1",
    companyId: COMPANY,
    serverName: "notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
  });
  const res = await request(makeApp(founderActor))
    .post(`/api/companies/${COMPANY}/mcp-connectors/conn1/oauth/start`)
    .send({});
  expect(res.status).toBe(403);
});

it("requires a browser session to start OAuth outside local_trusted", async () => {
  deploymentMode = "authenticated";
  const apiKeyActor = { ...founderActor, source: "api_key" };
  const res = await request(makeApp(apiKeyActor))
    .post(`/api/companies/${COMPANY}/mcp-connectors/conn1/oauth/start`)
    .send({});
  expect(res.status).toBe(403);
  expect(mockConnectorSvc.getById).not.toHaveBeenCalled();
});

it("rejects oauth/start on a disabled connector (#3)", async () => {
  mockConnectorSvc.getById.mockResolvedValue({
    id: "conn1",
    companyId: COMPANY,
    serverName: "notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    requiresSecret: true,
    secretRef: null,
    status: "disabled",
  });
  const res = await request(makeApp(founderActor))
    .post(`/api/companies/${COMPANY}/mcp-connectors/conn1/oauth/start`)
    .send({});
  expect(res.status).toBe(400);
  expect(mockFlowInsert).not.toHaveBeenCalled();
});

it("returns a clear 400 (not a 500) when no signing secret is configured", async () => {
  // Delete BOTH env vars `resolveConsentSecret()` checks — the route calls the
  // REAL function (it's outside the mocked `mcp-connector-oauth.js` module), so
  // this reproduces the actual "no signing secret configured" deployment state
  // instead of asserting against a mock.
  const savedBetter = process.env.BETTER_AUTH_SECRET;
  const savedAgent = process.env.AOA_AGENT_JWT_SECRET;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.AOA_AGENT_JWT_SECRET;
  try {
    // OAuth + catalog connector, same shape as the happy-path start test above —
    // this must reach the new guard, not get rejected by an earlier gate.
    mockConnectorSvc.getById.mockResolvedValue({
      id: "conn1",
      companyId: COMPANY,
      serverName: "notion",
      transport: "http",
      url: "https://mcp.notion.com/mcp",
      requiresSecret: true,
      secretRef: null,
      status: "needs_credentials",
      source: "catalog",
      catalogEntryId: "notion-hosted",
      oauthPolicyVersion: 1,
    });
    const res = await request(makeApp(founderActor))
      .post(`/api/companies/${COMPANY}/mcp-connectors/conn1/oauth/start`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signing secret/i);
    expect(mockFlowInsert).not.toHaveBeenCalled();
    expect(mockOauth.discoverOAuthServer).not.toHaveBeenCalled();
  } finally {
    if (savedBetter === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = savedBetter;
    if (savedAgent === undefined) delete process.env.AOA_AGENT_JWT_SECRET;
    else process.env.AOA_AGENT_JWT_SECRET = savedAgent;
  }
});

it("callback exchanges the code, stores the secret, binds the connector, redirects", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: "company-A",
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([callbackFlow()]);
  mockConnectorSvc.getById.mockResolvedValue(oauthConnector());
  mockOauth.exchangeAuthorizationCode.mockResolvedValue({
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 3600,
  });
  mockSecretSvc.getByName.mockResolvedValue(null);
  mockConnectorSvc.updateIfStatus.mockResolvedValue({
    id: "conn1",
    status: "active",
  });

  const res = await request(makeApp(null)) // no actor — browser redirect
    .get(`/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`);
  expect(res.status).toBe(302);
  expect(mockPrepareSecret).toHaveBeenCalledWith(
    expect.objectContaining({
      companyId: COMPANY,
      owner: expect.objectContaining({
        connectorId: "conn1",
        catalogEntryId: "notion-hosted",
      }),
    })
  );
  expect(mockSecretSvc.commitPreparedMcpOAuthSecret).toHaveBeenCalled();
  expect(mockConnectorSvc.updateIfStatus).toHaveBeenCalledWith(
    "conn1",
    "needs_credentials",
    expect.objectContaining({ secretRef: "mcp:oauth:conn1", status: "active" })
  );
});

it("callback rejects an invalid state", async () => {
  mockOauth.verifyOAuthState.mockReturnValue(null);
  const res = await request(makeApp(null)).get(
    `/api/mcp-connectors/oauth/callback?code=c&state=bad`
  );
  expect(res.status).toBe(400);
});

it("rejects a callback completed by a different browser session", async () => {
  deploymentMode = "authenticated";
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: COMPANY,
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([callbackFlow()]);
  const otherFounder = {
    ...founderActor,
    userId: "55555555-5555-4555-8555-555555555555",
  };
  const res = await request(makeApp(otherFounder)).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );
  expect(res.status).toBe(403);
  expect(mockFlowUpdate).not.toHaveBeenCalled();
});

it("returns 401 when an authenticated deployment callback has no browser session", async () => {
  deploymentMode = "authenticated";
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: COMPANY,
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([callbackFlow()]);

  const res = await request(makeApp({ type: "none" })).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );

  expect(res.status).toBe(401);
  expect(mockFlowUpdate).not.toHaveBeenCalled();
  expect(mockOauth.exchangeAuthorizationCode).not.toHaveBeenCalled();
});

it("returns 403 when the starting user no longer has access to the flow company", async () => {
  deploymentMode = "authenticated";
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: COMPANY,
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([callbackFlow()]);
  const wrongCompany = { ...founderActor, companyIds: ["company-B"] };

  const res = await request(makeApp(wrongCompany)).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );

  expect(res.status).toBe(403);
  expect(mockFlowUpdate).not.toHaveBeenCalled();
  expect(mockOauth.exchangeAuthorizationCode).not.toHaveBeenCalled();
});

it("records provider denial and redirects with access_denied", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: COMPANY,
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([callbackFlow()]);
  const res = await request(makeApp(null)).get(
    `/api/mcp-connectors/oauth/callback?error=access_denied&state=STATE`
  );
  expect(res.status).toBe(302);
  expect(res.headers.location).toContain("reason=access_denied");
  expect(
    mockFlowUpdate.mock.calls.some(([value]) => value?.status === "failed")
  ).toBe(true);
  expect(mockOauth.exchangeAuthorizationCode).not.toHaveBeenCalled();
});

it("callback is single-use: a lost atomic claim -> 400, no exchange (Fix 6)", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: "company-A",
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([
    {
      id: "flow1",
      connectorId: "conn1",
      companyId: "company-A",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    },
  ]);
  mockFlowClaim.mockResolvedValue([]); // another concurrent callback already claimed it
  const res = await request(makeApp(null)).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );
  expect(res.status).toBe(400);
  expect(mockOauth.exchangeAuthorizationCode).not.toHaveBeenCalled();
});

it("reverts the flow to failed and redirects with a stable reason when exchange throws", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: "company-A",
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([callbackFlow()]);
  mockConnectorSvc.getById.mockResolvedValue(oauthConnector());
  mockOauth.exchangeAuthorizationCode.mockRejectedValue(
    new Error("invalid_grant")
  );
  const res = await request(makeApp(null)).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );
  expect(res.status).toBe(302);
  expect(res.headers.location).toContain("reason=token_exchange_failed");
  expect(mockSecretSvc.commitPreparedMcpOAuthSecret).not.toHaveBeenCalled();
  expect(mockFlowUpdate.mock.calls.some(([v]) => v?.status === "failed")).toBe(
    true
  );
});

it("rejects an expired flow", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: "company-A",
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([
    {
      id: "flow1",
      connectorId: "conn1",
      companyId: "company-A",
      status: "pending",
      expiresAt: new Date(Date.now() - 1000),
    },
  ]);
  const res = await request(makeApp(null)).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );
  expect(res.status).toBe(400);
  expect(mockOauth.exchangeAuthorizationCode).not.toHaveBeenCalled();
});

it("rejects when the state's connectorId doesn't match the flow row", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "OTHER",
    companyId: "company-A",
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([
    {
      id: "flow1",
      connectorId: "conn1",
      companyId: "company-A",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    },
  ]);
  const res = await request(makeApp(null)).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );
  expect(res.status).toBe(400);
});

it("rotates the existing secret on re-authorization (Fix 12 path)", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: "company-A",
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([callbackFlow()]);
  mockConnectorSvc.getById.mockResolvedValue(oauthConnector());
  mockOauth.exchangeAuthorizationCode.mockResolvedValue({
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 3600,
  });
  mockSecretSvc.getByName.mockResolvedValue({
    id: "sec1",
    name: "mcp:oauth:conn1",
    latestVersion: 2,
  });
  mockConnectorSvc.updateIfStatus.mockResolvedValue({
    id: "conn1",
    status: "active",
  });
  const res = await request(makeApp(null)).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );
  expect(res.status).toBe(302);
  expect(mockPrepareSecret).toHaveBeenCalledWith(
    expect.objectContaining({ expectedLatestVersion: 2 })
  );
  expect(mockSecretSvc.commitPreparedMcpOAuthSecret).toHaveBeenCalled();
});

it("rolls back and redirects when the connector bind matches 0 rows", async () => {
  // A concurrent status change (e.g. board approval/rejection racing the callback)
  // can make updateIfStatus's guarded WHERE match nothing. The secret was already
  // created/rotated at that point — but binding it to the connector never happened,
  // so completing the flow and logging a success activity would be a lying audit
  // trail: the record says "authorized", the connector row disagrees.
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: "company-A",
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([callbackFlow()]);
  mockConnectorSvc.getById.mockResolvedValue(oauthConnector());
  mockOauth.exchangeAuthorizationCode.mockResolvedValue({
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 3600,
  });
  mockSecretSvc.getByName.mockResolvedValue(null);
  mockConnectorSvc.updateIfStatus.mockResolvedValue(null); // guarded WHERE matched 0 rows

  const res = await request(makeApp(null)).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );

  expect(res.status).toBe(302);
  expect(res.headers.location).toContain("reason=connector_changed");
  expect(mockFlowUpdate.mock.calls.some(([v]) => v?.status === "failed")).toBe(
    true
  );
  expect(
    mockFlowUpdate.mock.calls.some(([v]) => v?.status === "completed")
  ).toBe(false);
  expect(mockPublishActivity).not.toHaveBeenCalled();
});

it("rechecks the emergency denylist inside the commit transaction", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: COMPANY,
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([callbackFlow()]);
  mockConnectorSvc.getById.mockResolvedValue(oauthConnector());
  mockOauth.exchangeAuthorizationCode.mockImplementation(async () => {
    // Simulate an operator blocking the provider after the pre-exchange check
    // but before the transaction obtains its row locks.
    vi.stubEnv("AOA_MCP_CONNECTOR_DENYLIST", "notion");
    return { accessToken: "at", refreshToken: "rt", expiresIn: 3600 };
  });
  mockSecretSvc.getByName.mockResolvedValue(null);

  const res = await request(makeApp(null)).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );

  expect(res.status).toBe(302);
  expect(res.headers.location).toContain("reason=policy_blocked");
  expect(mockSecretSvc.commitPreparedMcpOAuthSecret).not.toHaveBeenCalled();
  expect(mockInsertActivity).not.toHaveBeenCalled();
  expect(mockPublishActivity).not.toHaveBeenCalled();
});

it("rejects a connector disabled after exchange and before the locked commit", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: COMPANY,
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([callbackFlow()]);
  mockConnectorSvc.getById.mockResolvedValue(oauthConnector());
  mockOauth.exchangeAuthorizationCode.mockResolvedValue({
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 3600,
  });
  mockLockedConnectorSelect.mockResolvedValue([
    { ...oauthConnector(), status: "disabled" },
  ]);

  const res = await request(makeApp(null)).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );

  expect(res.status).toBe(302);
  expect(res.headers.location).toContain("reason=connector_changed");
  expect(mockSecretSvc.commitPreparedMcpOAuthSecret).not.toHaveBeenCalled();
  expect(mockPublishActivity).not.toHaveBeenCalled();
});

it("keeps a committed callback successful when live activity publication throws", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({
    connectorId: "conn1",
    companyId: COMPANY,
    nonce: "n",
    exp: Date.now() + 60_000,
  });
  mockFlowSelect.mockResolvedValue([callbackFlow()]);
  mockConnectorSvc.getById.mockResolvedValue(oauthConnector());
  mockOauth.exchangeAuthorizationCode.mockResolvedValue({
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 3600,
  });
  mockSecretSvc.getByName.mockResolvedValue(null);
  mockConnectorSvc.updateIfStatus.mockResolvedValue({
    id: "conn1",
    status: "active",
  });
  mockPublishActivity.mockImplementation(() => {
    throw new Error("listener failed");
  });

  const res = await request(makeApp(null)).get(
    `/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`
  );

  expect(res.status).toBe(302);
  expect(res.headers.location).toContain("oauthResult=completed");
  expect(mockSecretSvc.commitPreparedMcpOAuthSecret).toHaveBeenCalledTimes(1);
  expect(mockInsertActivity).toHaveBeenCalledTimes(1);
  expect(mockPublishActivity).toHaveBeenCalledTimes(1);
  expect(
    mockFlowUpdate.mock.calls.some(([value]) => value?.status === "failed")
  ).toBe(false);
});
