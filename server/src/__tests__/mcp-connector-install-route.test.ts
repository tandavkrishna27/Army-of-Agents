/**
 * @fileoverview Task 11 — the catalog install route.
 *
 * This is the FIRST code path in the codebase that can construct a connector with
 * `source: "catalog"`, and therefore the first that can reach the D7 catalog
 * exemption at all. Every assertion here exists because the route is the only
 * thing standing between a curated CDN file and a process spawned on the AoA host.
 *
 * THE SINGLE MOST IMPORTANT TEST IN THIS FILE is
 * "a VALID consent token does NOT rescue an unverified stdio install from D7".
 * D7 is authorization ("may this deployment run host code at all"); consent is a
 * UX/TOCTOU binding ("were these the exact bytes you were shown"). Neither
 * substitutes for the other, and an implementation that checked consent first and
 * treated a good token as sufficient would pass almost every other test here.
 */

import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpConnectorCatalogEntrySchema, type McpConnectorCatalogEntry } from "@armyofagents/shared";

let deploymentMode = "local_trusted";
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

// The REAL gate, wrapped in a spy. Mocking it away would delete the property
// under test; wrapping it lets us assert BOTH that it still refuses and that it
// is invoked with the catalog provenance + tier on every install path.
vi.mock("../services/mcp-connector-transport-gate.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/mcp-connector-transport-gate.js")>();
  return { assertTransportAllowed: vi.fn(actual.assertTransportAllowed) };
});

import {
  mcpConnectorRoutes,
  installFromCatalogSchema,
  entryToCreateInput,
} from "../routes/mcp-connectors.js";
import { assertTransportAllowed } from "../services/mcp-connector-transport-gate.js";
import {
  mintConsentToken,
  CONSENT_TOKEN_TTL_MS,
} from "../services/mcp-connector-consent.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY = "company-A";
const CONNECTOR_ID = "11111111-1111-4111-8111-111111111111";
const FOUNDER_UUID = "44444444-4444-4444-8444-444444444444";

// `resolveConsentSecret()` reads this. Set for the whole file and restored after,
// so we never leak a signing secret into a sibling suite's environment.
const SECRET = "install-route-test-secret";
const priorAuthSecret = process.env.BETTER_AUTH_SECRET;
const priorJwtSecret = process.env.AOA_AGENT_JWT_SECRET;
const priorConnectorDenylist = process.env.AOA_MCP_CONNECTOR_DENYLIST;
process.env.BETTER_AUTH_SECRET = SECRET;

afterAll(() => {
  if (priorAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = priorAuthSecret;
  if (priorJwtSecret === undefined) delete process.env.AOA_AGENT_JWT_SECRET;
  else process.env.AOA_AGENT_JWT_SECRET = priorJwtSecret;
  if (priorConnectorDenylist === undefined) delete process.env.AOA_MCP_CONNECTOR_DENYLIST;
  else process.env.AOA_MCP_CONNECTOR_DENYLIST = priorConnectorDenylist;
});

const founderActor = {
  type: "board" as const,
  source: "session" as const,
  userId: FOUNDER_UUID,
  companyIds: [COMPANY],
  isInstanceAdmin: false,
};

/**
 * Fixtures go through the REAL schema so they carry the same defaults a live
 * `connectors.json` entry would (notably `args: []` and `trust: {tier:"community"}`).
 * A hand-rolled literal would let the route pass against a shape the CDN can
 * never actually produce.
 */
const entry = (raw: unknown): McpConnectorCatalogEntry =>
  McpConnectorCatalogEntrySchema.parse(raw);

const verifiedHttp = entry({
  id: "notion",
  displayName: "Notion",
  serverName: "notion",
  transport: "http",
  url: "https://mcp.notion.example/mcp",
  headerTemplateKeys: ["Authorization"],
  requiresSecret: true,
  trust: { tier: "verified" },
});

const verifiedStdio = entry({
  id: "fs",
  displayName: "Local FS",
  serverName: "local-fs",
  transport: "stdio",
  command: "npx",
  // WS2: stdio packages must be exact-version pinned (assertStdioCommandSafe).
  args: ["-y", "fs-mcp@1.0.0"],
  trust: { tier: "verified" },
});

const unverifiedStdio = entry({
  id: "acme",
  displayName: "Acme DB",
  serverName: "acme",
  transport: "stdio",
  command: "npx",
  args: ["-y", "acme-db-tool@1.0.0"],
  envTemplateKeys: ["ACME_TOKEN"],
  trust: { tier: "community" },
});

// An OAuth-only hosted server (the Notion `mcp.notion.com` live finding): a valid
// catalog entry that can be SHOWN but not installed until the Plan 4 broker lands.
const oauthHttp = entry({
  id: "notion-hosted",
  displayName: "Notion (hosted)",
  serverName: "notion",
  transport: "http",
  url: "https://mcp.notion.com/mcp",
  requiresOAuth: true,
  trust: { tier: "verified" },
});

const unsupportedOauthHttp = entry({
  id: "sentry-hosted",
  displayName: "Sentry (hosted)",
  serverName: "sentry",
  transport: "http",
  url: "https://mcp.sentry.dev/mcp",
  requiresOAuth: true,
  trust: { tier: "verified" },
});

const CATALOG = [verifiedHttp, verifiedStdio, unverifiedStdio];

function makeApp(actor: unknown, entries: McpConnectorCatalogEntry[] = CATALOG, stale = false) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use(
    "/api",
    mcpConnectorRoutes({ transaction: (fn: any) => fn({}) } as never, {
      catalog: { load: async () => ({ entries: [...entries], stale }) },
    }),
  );
  app.use(errorHandler);
  return app;
}

function install(app: express.Express, body: unknown) {
  return request(app)
    .post(`/api/companies/${COMPANY}/mcp-connectors/install`)
    .send(body as object);
}

function getCatalog(app: express.Express) {
  return request(app).get(`/api/companies/${COMPANY}/mcp-connectors/catalog`);
}

/** A token for the argv the founder was actually shown. */
function tokenFor(e: McpConnectorCatalogEntry, nowMs = Date.now()) {
  return mintConsentToken(SECRET, e.id, { command: e.command ?? "", args: e.args }, nowMs);
}

/**
 * The D7 refusal's distinctive opening phrase (mcp-connector-transport-gate.ts).
 * Matching on it — rather than on a bare 400, or on a word like "verified" that
 * BOTH refusals happen to contain — is what makes "which gate answered?" a real
 * assertion instead of a coincidence.
 */
const D7_REFUSAL = /Only remote HTTP connectors/;

beforeEach(() => {
  vi.clearAllMocks();
  deploymentMode = "local_trusted";
  delete process.env.AOA_MCP_CONNECTOR_DENYLIST;
  mockGetEffectiveRole.mockResolvedValue("founder");
  mockConnectorSvc.getByName.mockResolvedValue(null);
  mockConnectorSvc.create.mockImplementation(async (_c: string, input: Record<string, unknown>) => ({
    id: CONNECTOR_ID,
    companyId: COMPANY,
    ...input,
  }));
  mockApprovalSvc.create.mockResolvedValue({ id: "approval-1" });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("installFromCatalogSchema", () => {
  it("accepts an entryId, with or without a consent token", () => {
    expect(installFromCatalogSchema.safeParse({ entryId: "notion" }).success).toBe(true);
    expect(
      installFromCatalogSchema.safeParse({ entryId: "acme", consentToken: "1.ab" }).success,
    ).toBe(true);
  });

  it("keeps consentToken on the parsed output (an undeclared field would be STRIPPED, deleting the gate)", () => {
    const parsed = installFromCatalogSchema.parse({ entryId: "acme", consentToken: "1.ab" });
    expect(parsed.consentToken).toBe("1.ab");
  });

  it("rejects an unknown key -> .strict() (not silent stripping)", () => {
    expect(installFromCatalogSchema.safeParse({ entryId: "x", sneaky: true }).success).toBe(false);
  });

  it.each([
    ["source", { source: "catalog" }],
    ["status", { status: "active" }],
    ["requiresSecret", { requiresSecret: false }],
    ["trust", { trust: { tier: "verified" } }],
    ["transport", { transport: "http" }],
    ["command", { command: "rm" }],
    ["args", { args: ["-rf", "/"] }],
    ["serverName", { serverName: "evil" }],
    ["secretRef", { secretRef: "mcp:notion" }],
  ])("rejects an injected %s field", (_label, extra) => {
    expect(installFromCatalogSchema.safeParse({ entryId: "x", ...extra }).success).toBe(false);
  });

  it("rejects a missing or empty entryId", () => {
    expect(installFromCatalogSchema.safeParse({}).success).toBe(false);
    expect(installFromCatalogSchema.safeParse({ entryId: "" }).success).toBe(false);
  });

  it("rejects an empty consentToken (a blank string must not read as 'supplied')", () => {
    expect(installFromCatalogSchema.safeParse({ entryId: "x", consentToken: "" }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Pure mapper
// ---------------------------------------------------------------------------

const ACTOR = { actorType: "user" as const, actorId: FOUNDER_UUID, agentId: null };

describe("entryToCreateInput", () => {
  it("maps header KEYS to an empty-valued template, never a value", () => {
    const r = entryToCreateInput(verifiedHttp, "co1", "local_trusted", ACTOR);
    expect(r.headerTemplate).toEqual({ Authorization: "" });
  });

  it("maps env KEYS to an empty-valued template, never a value", () => {
    const r = entryToCreateInput(unverifiedStdio, "co1", "local_trusted", ACTOR);
    expect(r.envTemplate).toEqual({ ACME_TOKEN: "" });
  });

  it("every template value is the empty string — the catalog never carries a secret (D5)", () => {
    const r = entryToCreateInput(verifiedHttp, "co1", "local_trusted", ACTOR);
    expect(Object.values(r.headerTemplate ?? {})).toEqual([""]);
    expect(Object.values(r.envTemplate ?? {})).toEqual([]);
  });

  // P1 (Codex) — a credentialed non-Authorization header / stdio env key must
  // carry the literal `${TOKEN}` placeholder (buildConnectorSpecs rewrites it to
  // the connector's `${AOA_MCP_*_TOKEN}` ref), else the connector installs
  // "active" but runs UNAUTHENTICATED. `${TOKEN}` is a placeholder, never a
  // value — D5 stays intact.
  it("credentialed CUSTOM header key gets the ${TOKEN} placeholder (not empty)", () => {
    const e = entry({
      id: "acme-http",
      displayName: "Acme",
      serverName: "acme-http",
      transport: "http",
      url: "https://acme.example/mcp",
      headerTemplateKeys: ["X-Api-Key"],
      requiresSecret: true,
      trust: { tier: "verified" },
    });
    const r = entryToCreateInput(e, "co1", "local_trusted", ACTOR);
    expect(r.headerTemplate).toEqual({ "X-Api-Key": "${TOKEN}" });
    // D5: the placeholder is not a real secret value.
    expect(JSON.stringify(r.headerTemplate)).not.toMatch(/sk-|secret|token-[0-9a-f]/i);
  });

  it("credentialed stdio env key gets the ${TOKEN} placeholder (not empty)", () => {
    const e = entry({
      id: "acme-db",
      displayName: "Acme DB",
      serverName: "acme-db",
      transport: "stdio",
      command: "npx",
      args: ["-y", "acme-db-tool"],
      envTemplateKeys: ["ACME_TOKEN"],
      requiresSecret: true,
      trust: { tier: "verified" },
    });
    const r = entryToCreateInput(e, "co1", "local_trusted", ACTOR);
    expect(r.envTemplate).toEqual({ ACME_TOKEN: "${TOKEN}" });
  });

  it("Authorization stays EMPTY even when credentialed — the Bearer synth owns it", () => {
    // verifiedHttp is requiresSecret:true with headerTemplateKeys:["Authorization"].
    // A raw ${TOKEN} here would defeat withSynthesizedBearerHeader and send an
    // unprefixed token; leaving it empty lets the synth fill `Bearer <token>`.
    const r = entryToCreateInput(verifiedHttp, "co1", "local_trusted", ACTOR);
    expect(r.headerTemplate).toEqual({ Authorization: "" });
  });

  it("SECRETLESS entry keeps empty template values (no unresolved placeholder)", () => {
    // unverifiedStdio has envTemplateKeys but requiresSecret:false.
    const r = entryToCreateInput(unverifiedStdio, "co1", "local_trusted", ACTOR);
    expect(r.requiresSecret).toBe(false);
    expect(r.envTemplate).toEqual({ ACME_TOKEN: "" });
  });

  it("installs credential-UNBOUND: secretRef is null and requiresSecret is carried through", () => {
    const r = entryToCreateInput(verifiedHttp, "co1", "local_trusted", ACTOR);
    expect(r.secretRef).toBeNull();
    expect(r.requiresSecret).toBe(true);
  });

  // FU-19 follow-up — the entry's trust tier is persisted so the delivery-time
  // D7 re-check can honor the catalog+verified exemption after a mode conversion.
  it("carries the entry's trust tier onto the create input", () => {
    expect(entryToCreateInput(verifiedHttp, "co1", "local_trusted", ACTOR).trustTier).toBe(
      "verified",
    );
    expect(entryToCreateInput(unverifiedStdio, "co1", "local_trusted", ACTOR).trustTier).toBe(
      "community",
    );
  });

  it('sets source to "catalog" — never "marketplace", which would make the D7 branch dead code', () => {
    expect(entryToCreateInput(verifiedHttp, "co1", "local_trusted", ACTOR).source).toBe("catalog");
  });

  it("carries the entry's transport/url/command/args verbatim", () => {
    const http = entryToCreateInput(verifiedHttp, "co1", "local_trusted", ACTOR);
    expect(http).toMatchObject({
      transport: "http",
      url: "https://mcp.notion.example/mcp",
      command: null,
      serverName: "notion",
      displayName: "Notion",
    });
    const stdio = entryToCreateInput(unverifiedStdio, "co1", "authenticated", ACTOR);
    expect(stdio).toMatchObject({
      transport: "stdio",
      url: null,
      command: "npx",
      args: ["-y", "acme-db-tool@1.0.0"],
      companyId: "co1",
      deploymentMode: "authenticated",
      actor: ACTOR,
    });
  });

  it("a __proto__ template key cannot pollute Object.prototype", () => {
    // Both HEADER_NAME_RE and ENV_NAME_RE admit `__proto__`, so the mapper must be
    // safe against it. Plain `obj["__proto__"] = ""` sets nothing (assigning a
    // non-object to [[Prototype]] is a no-op) — it fails CLOSED: the key is
    // dropped rather than propagated into a downstream header/env writer.
    const nasty = entry({
      id: "nasty",
      displayName: "Nasty",
      serverName: "nasty",
      transport: "http",
      url: "https://x.example/mcp",
      headerTemplateKeys: ["__proto__"],
      envTemplateKeys: ["__proto__"],
    });
    const r = entryToCreateInput(nasty, "co1", "local_trusted", ACTOR);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(r.headerTemplate ?? {})).toEqual([]);
    expect(Object.keys(r.envTemplate ?? {})).toEqual([]);
    expect(Object.getPrototypeOf(r.headerTemplate ?? {})).toBe(Object.prototype);
  });

  // Security-critical override (Task 10): `requiresOAuth` and `requiresSecret`
  // are INDEPENDENT catalog booleans that both default `false`. `oauthHttp`
  // (declared above) is `requiresOAuth: true` with no `requiresSecret` set, so
  // this pins that the mapper still forces `requiresSecret: true` — without it
  // the connector would resolve `status: "active"` with no credential bound and
  // silently authenticate as no-one.
  it("forces requiresSecret=true for a requiresOAuth entry even when the catalog omits requiresSecret", () => {
    const input = entryToCreateInput(oauthHttp, "co1", "local_trusted", ACTOR);
    expect(input.requiresSecret).toBe(true);
    expect(input.secretRef).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Entry resolution
// ---------------------------------------------------------------------------

describe("install route — entry resolution", () => {
  it("an unknown entryId -> 404, no write", async () => {
    const res = await install(makeApp(founderActor), { entryId: "does-not-exist" });
    expect(res.status).toBe(404);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("an empty shelf (offline instance) -> 404, no write", async () => {
    const res = await install(makeApp(founderActor, []), { entryId: "notion" });
    expect(res.status).toBe(404);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("the D7 gate is never consulted for an entry that does not exist", async () => {
    await install(makeApp(founderActor), { entryId: "nope" });
    expect(assertTransportAllowed).not.toHaveBeenCalled();
  });

  // Resolution is a linear `entries.find(...)`, NOT a keyed object lookup. On a
  // `Object.fromEntries(...)` map these ids resolve through the PROTOTYPE CHAIN to
  // truthy non-entries (`Object.prototype`, the `Object` constructor, a function),
  // which would sail past the `if (!entry)` guard and reach D7 with
  // `transport: undefined` — i.e. "not stdio", so the gate would wave it through
  // before blowing up somewhere less honest. These must be plain 404s.
  it.each(["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"])(
    "a prototype-chain entryId (%s) -> 404, no write, no gate call",
    async (entryId) => {
      const res = await install(makeApp(founderActor), { entryId });
      expect(res.status).toBe(404);
      expect(mockConnectorSvc.create).not.toHaveBeenCalled();
      expect(assertTransportAllowed).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("install route — verified entries install in one call", () => {
  it("a verified http entry needs no consent token -> 201", async () => {
    deploymentMode = "authenticated";
    const res = await install(makeApp(founderActor), { entryId: "notion" });
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ source: "catalog", serverName: "notion" }),
    );
  });

  it("a verified stdio entry installs in authenticated mode with no token (D7 exemption) -> 201", async () => {
    deploymentMode = "authenticated";
    const res = await install(makeApp(founderActor), { entryId: "fs" });
    expect(res.status).toBe(201);
    expect(assertTransportAllowed).toHaveBeenCalledWith(
      "stdio",
      "authenticated",
      "catalog",
      "verified",
    );
  });

  // FU-19 follow-up — the persisted row carries the tier, so the delivery re-gate
  // can later prove the catalog+verified exemption after a mode conversion.
  it("persists the entry's trust tier on the connector row (verified stdio)", async () => {
    deploymentMode = "authenticated";
    await install(makeApp(founderActor), { entryId: "fs" });
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ source: "catalog", trustTier: "verified" }),
    );
  });

  it("the response carries the connector plus approvalId (the UI branches on it)", async () => {
    deploymentMode = "authenticated";
    const res = await install(makeApp(founderActor), { entryId: "notion" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: CONNECTOR_ID, approvalId: "approval-1" });
  });

  it("local_trusted: approvalId is present and null", async () => {
    deploymentMode = "local_trusted";
    const res = await install(makeApp(founderActor), { entryId: "notion" });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("approvalId", null);
  });

  it("a duplicate serverName surfaces the shared 409, not a raw 500", async () => {
    mockConnectorSvc.getByName.mockResolvedValue({ id: "existing" });
    const res = await install(makeApp(founderActor), { entryId: "notion" });
    expect(res.status).toBe(409);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FU-16 — the credential axis, first real producer
// ---------------------------------------------------------------------------

describe("install route — a requiresSecret entry installs credential-unbound (FU-16)", () => {
  it("local_trusted: status is needs_credentials, not active", async () => {
    deploymentMode = "local_trusted";
    const res = await install(makeApp(founderActor), { entryId: "notion" });
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({
        requiresSecret: true,
        secretRef: null,
        status: "needs_credentials",
      }),
    );
    // needs_credentials is not pending_approval, so no approval is raised.
    expect(mockApprovalSvc.create).not.toHaveBeenCalled();
  });

  it("authenticated: governance wins first — pending_approval + an approval raised", async () => {
    deploymentMode = "authenticated";
    const res = await install(makeApp(founderActor), { entryId: "notion" });
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ status: "pending_approval", requiresSecret: true }),
    );
    expect(mockApprovalSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ type: "install_mcp_connector" }),
    );
  });

  it("an entry that needs no secret is not forced into needs_credentials", async () => {
    deploymentMode = "local_trusted";
    const res = await install(makeApp(founderActor), { entryId: "fs" });
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ requiresSecret: false, status: "active" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Consent gate (UX / TOCTOU binding)
// ---------------------------------------------------------------------------

describe("install route — consent gate for unverified stdio", () => {
  it("no token -> 400 explaining the connector runs a command on the host, no write", async () => {
    deploymentMode = "local_trusted";
    const res = await install(makeApp(founderActor), { entryId: "acme" });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).toMatch(/command/i);
    expect(JSON.stringify(res.body)).toMatch(/host/i);
    // ...and it is the CONSENT branch answering, not D7 wearing a different hat.
    expect(JSON.stringify(res.body)).not.toMatch(D7_REFUSAL);
  });

  it("a valid token -> installs in local_trusted -> 201", async () => {
    deploymentMode = "local_trusted";
    const res = await install(makeApp(founderActor), {
      entryId: "acme",
      consentToken: tokenFor(unverifiedStdio),
    });
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ source: "catalog", command: "npx", args: ["-y", "acme-db-tool@1.0.0"] }),
    );
  });

  it("a token minted for a DIFFERENT command -> 400 naming the reason, no write", async () => {
    deploymentMode = "local_trusted";
    const forOtherArgv = mintConsentToken(
      SECRET,
      "acme",
      { command: "npx", args: ["-y", "acme-db-tool-EVIL"] },
      Date.now(),
    );
    const res = await install(makeApp(founderActor), {
      entryId: "acme",
      consentToken: forOtherArgv,
    });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).toMatch(/signature_mismatch/);
  });

  it("a token minted for a DIFFERENT entryId -> 400, no write", async () => {
    deploymentMode = "local_trusted";
    const res = await install(makeApp(founderActor), {
      entryId: "acme",
      consentToken: mintConsentToken(
        SECRET,
        "some-other-entry",
        { command: "npx", args: ["-y", "acme-db-tool"] },
        Date.now(),
      ),
    });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("a token signed with the wrong secret -> 400, no write", async () => {
    deploymentMode = "local_trusted";
    const forged = mintConsentToken(
      "not-the-server-secret",
      "acme",
      { command: "npx", args: ["-y", "acme-db-tool"] },
      Date.now(),
    );
    const res = await install(makeApp(founderActor), { entryId: "acme", consentToken: forged });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("an expired token -> 400 naming expiry, no write", async () => {
    deploymentMode = "local_trusted";
    const stale = tokenFor(unverifiedStdio, Date.now() - CONSENT_TOKEN_TTL_MS - 60_000);
    const res = await install(makeApp(founderActor), { entryId: "acme", consentToken: stale });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).toMatch(/expired/);
  });

  it("garbage in the token field -> 400, no write", async () => {
    deploymentMode = "local_trusted";
    const res = await install(makeApp(founderActor), { entryId: "acme", consentToken: "nonsense" });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("TOCTOU: a token bound to the argv the founder SAW is refused once the shelf re-syncs", async () => {
    // Exactly the attack the token exists for: the entry rendered in the dialog and
    // the entry read at install time are two reads of a MUTABLE remote file.
    deploymentMode = "local_trusted";
    const shown = tokenFor(unverifiedStdio);
    const swapped = entry({
      ...unverifiedStdio,
      args: ["-y", "acme-db-tool@evil"],
      trust: { tier: "community" },
    });
    const res = await install(makeApp(founderActor, [swapped]), {
      entryId: "acme",
      consentToken: shown,
    });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("a verified stdio entry does NOT require a token (the gate is scoped to unverified)", async () => {
    deploymentMode = "local_trusted";
    const res = await install(makeApp(founderActor), { entryId: "fs" });
    expect(res.status).toBe(201);
  });

  it("an unverified HTTP entry does NOT require a token (no host execution)", async () => {
    deploymentMode = "authenticated";
    const unverifiedHttp = entry({
      id: "u-http",
      displayName: "Community HTTP",
      serverName: "u-http",
      transport: "http",
      url: "https://community.example/mcp",
      trust: { tier: "community" },
    });
    const res = await install(makeApp(founderActor, [unverifiedHttp]), { entryId: "u-http" });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// THE load-bearing one: D7 is not rescued by consent
// ---------------------------------------------------------------------------

describe("install route — D7 authorization is independent of consent", () => {
  it("a VALID consent token does NOT rescue an unverified stdio install in authenticated mode", async () => {
    deploymentMode = "authenticated";
    const res = await install(makeApp(founderActor), {
      entryId: "acme",
      consentToken: tokenFor(unverifiedStdio), // perfectly valid, correctly bound
    });
    expect(res.status).toBe(400);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
    // The refusal must come from D7, not from the consent branch — assert the
    // message, because a bare 400 would also pass if consent had (wrongly) run
    // first and rejected for some unrelated reason.
    expect(JSON.stringify(res.body)).toMatch(D7_REFUSAL);
  });

  it("the same entry with the same token installs once the deployment is local_trusted", async () => {
    // Proves the previous refusal is about DEPLOYMENT AUTHORIZATION, not the token.
    deploymentMode = "local_trusted";
    const res = await install(makeApp(founderActor), {
      entryId: "acme",
      consentToken: tokenFor(unverifiedStdio),
    });
    expect(res.status).toBe(201);
  });

  it("D7 runs BEFORE the consent branch: no token + authenticated is refused by D7, not by consent", async () => {
    deploymentMode = "authenticated";
    const res = await install(makeApp(founderActor), { entryId: "acme" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(D7_REFUSAL);
  });

  // Every install path must consult D7 with the CATALOG provenance and the entry's
  // OWN tier. A path that passed `undefined` for the tier would fail closed (safe
  // but broken); a path that passed `"verified"` unconditionally, or omitted the
  // call, would be the real hole. One case per transport/tier combination the
  // catalog can produce.
  it.each([
    ["notion", "authenticated", ["http", "authenticated", "catalog", "verified"]],
    ["fs", "authenticated", ["stdio", "authenticated", "catalog", "verified"]],
    ["acme", "local_trusted", ["stdio", "local_trusted", "catalog", "community"]],
  ] as const)(
    "%s in %s: D7 is consulted with catalog provenance + the entry's own tier",
    async (entryId, mode, expected) => {
      deploymentMode = mode;
      await install(makeApp(founderActor), {
        entryId,
        ...(entryId === "acme" ? { consentToken: tokenFor(unverifiedStdio) } : {}),
      });
      expect(assertTransportAllowed).toHaveBeenCalledWith(...expected);
    },
  );

  it("the gate is called before the write, on every successful install", async () => {
    deploymentMode = "local_trusted";
    await install(makeApp(founderActor), { entryId: "notion" });
    expect(mockConnectorSvc.create).toHaveBeenCalledTimes(1);
    const gateOrder = (assertTransportAllowed as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder[0];
    const writeOrder = mockConnectorSvc.create.mock.invocationCallOrder[0];
    expect(gateOrder).toBeLessThan(writeOrder);
  });
});

// ---------------------------------------------------------------------------
// requiresOAuth — Task 10: installable to needs_credentials, D7 still runs
// ---------------------------------------------------------------------------

describe("install route — an OAuth-only entry installs to needs_credentials", () => {
  it("refuses an unsupported OAuth entry before any connector or activity write", async () => {
    const res = await install(makeApp(founderActor, [unsupportedOauthHttp]), {
      entryId: "sentry-hosted",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported by this server version/i);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
    expect(mockApprovalSvc.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("refuses an emergency-denied OAuth entry before any connector or activity write", async () => {
    process.env.AOA_MCP_CONNECTOR_DENYLIST = "notion";
    const res = await install(makeApp(founderActor, [oauthHttp]), {
      entryId: "notion-hosted",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disabled by the operator policy/i);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
    expect(mockApprovalSvc.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("installs an OAuth entry to needs_credentials (not a 400)", async () => {
    deploymentMode = "local_trusted";
    const res = await install(makeApp(founderActor, [oauthHttp]), { entryId: "notion-hosted" });
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({
        requiresSecret: true,
        secretRef: null,
        status: "needs_credentials",
        transport: "http",
      }),
    );
  });

  // OAuth is no longer refused outright, but it must not bypass authorization:
  // D7 still runs for an OAuth entry exactly like any other catalog install.
  it("D7 still runs for an OAuth entry (it is not exempted from the transport gate)", async () => {
    deploymentMode = "local_trusted";
    const res = await install(makeApp(founderActor, [oauthHttp]), { entryId: "notion-hosted" });
    expect(res.status).toBe(201);
    expect(assertTransportAllowed).toHaveBeenCalledWith(
      "http",
      "local_trusted",
      "catalog",
      "verified",
    );
  });

  it("authenticated mode: an OAuth entry with requiresSecret goes pending_approval, same governance as any other credentialed install", async () => {
    deploymentMode = "authenticated";
    const res = await install(makeApp(founderActor, [oauthHttp]), { entryId: "notion-hosted" });
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ status: "pending_approval", requiresSecret: true }),
    );
    expect(mockApprovalSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ type: "install_mcp_connector" }),
    );
  });

  it("a normal verified entry beside it still installs (unaffected)", async () => {
    deploymentMode = "authenticated";
    const res = await install(makeApp(founderActor, [oauthHttp, verifiedHttp]), {
      entryId: "notion",
    });
    expect(res.status).toBe(201);
    expect(mockConnectorSvc.create).toHaveBeenCalledTimes(1);
  });
});

describe("catalog shelf route — an OAuth-only entry is shown and installable, with oauthRequired", () => {
  it("shows an emergency-denied OAuth entry as unavailable", async () => {
    process.env.AOA_MCP_CONNECTOR_DENYLIST = "notion";
    const res = await getCatalog(makeApp(founderActor, [oauthHttp]));
    const oauth = res.body.entries.find((e: { id: string }) => e.id === "notion-hosted");

    expect(oauth).toMatchObject({
      installable: false,
      oauthRequired: false,
      unavailableReason: expect.stringMatching(/disabled by the operator policy/i),
    });
  });

  it("projects installable:true + oauthRequired:true + no unavailableReason + no consent token", async () => {
    deploymentMode = "local_trusted";
    const res = await getCatalog(makeApp(founderActor, [oauthHttp]));
    const oauth = res.body.entries.find((e: { id: string }) => e.id === "notion-hosted") as {
      installable: boolean;
      oauthRequired: boolean;
      unavailableReason?: string;
      consentToken?: string;
    };
    expect(oauth.installable).toBe(true);
    expect(oauth.oauthRequired).toBe(true);
    expect(oauth.unavailableReason).toBeUndefined();
    expect(oauth.consentToken).toBeUndefined();
  });

  it("a normal verified entry beside it is unchanged (installable, oauthRequired:false)", async () => {
    deploymentMode = "authenticated";
    const res = await getCatalog(makeApp(founderActor, [oauthHttp, verifiedHttp]));
    const byId = Object.fromEntries(
      res.body.entries.map((e: { id: string }) => [e.id, e]),
    ) as Record<string, { installable: boolean; oauthRequired?: boolean; unavailableReason?: string }>;
    expect(byId["notion-hosted"].installable).toBe(true);
    expect(byId["notion-hosted"].oauthRequired).toBe(true);
    expect(byId.notion.installable).toBe(true);
    expect(byId.notion.oauthRequired).toBe(false);
    expect(byId.notion).not.toHaveProperty("unavailableReason");
  });

  // A hypothetical unverified-stdio OAuth entry would previously have needed a
  // shelf-side test for the D7-degrade path (installable:false, oauthRequired
  // reset to false). That scenario is no longer constructible: the shared
  // catalog schema now rejects `requiresOAuth: true` combined with
  // `transport: "stdio"` at parse time (packages/shared/src/mcp-connector-catalog.ts,
  // covered by packages/shared/src/__tests__/mcp-connector-catalog.test.ts
  // "rejects an OAuth entry declared with stdio transport"), so no valid catalog
  // entry can ever reach this route with that combination. The try/catch around
  // `assertTransportAllowed` in the OAuth branch is retained as defense-in-depth
  // (mirrors the non-OAuth branch) but is not exercised by a producible fixture
  // here — a hand-rolled literal that skips the real schema would test a shape
  // the CDN can never actually produce, which this file's fixtures deliberately
  // avoid (see the `entry()` helper's docstring above).
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("install route — founder only (C5: NOT canInstallType)", () => {
  it.each(["team_lead", "team_member"])("%s -> 403, no write", async (role) => {
    mockGetEffectiveRole.mockResolvedValue(role);
    const res = await install(makeApp(founderActor), { entryId: "notion" });
    expect(res.status).toBe(403);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("founder -> 201", async () => {
    mockGetEffectiveRole.mockResolvedValue("founder");
    const res = await install(makeApp(founderActor), { entryId: "notion" });
    expect(res.status).toBe(201);
  });

  it("a caller with no company access -> 403, no write", async () => {
    const outsider = { ...founderActor, companyIds: ["other-company"] };
    const res = await install(makeApp(outsider), { entryId: "notion" });
    expect(res.status).toBe(403);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  // `assertRole` RETURNS EARLY for agent actors ("agents have separate permission
  // paths"), so `assertBoard` is the only thing keeping a non-board principal off
  // this route. Without it an MCP-token or agent-key holder could install a
  // connector — on stdio, a process on the AoA host — with no founder involved.
  it.each([
    ["an MCP key", { type: "mcp", source: "token", companyId: COMPANY, userId: null }],
    ["an agent key", { type: "agent", source: "token", companyId: COMPANY, agentId: "a1" }],
  ])("%s cannot install -> 403, no write", async (_label, actor) => {
    const res = await install(makeApp(actor), { entryId: "notion" });
    expect(res.status).toBe(403);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller -> 401, no write", async () => {
    const res = await install(makeApp({ type: "none" }), { entryId: "notion" });
    expect(res.status).toBe(401);
    expect(mockConnectorSvc.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Shelf read + consent minting
// ---------------------------------------------------------------------------

describe("catalog shelf route — how the UI obtains a consent token", () => {
  it("returns the shelf plus the stale flag", async () => {
    const res = await getCatalog(makeApp(founderActor, CATALOG, true));
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.entries.map((e: { id: string }) => e.id)).toEqual(["notion", "fs", "acme"]);
  });

  it("mints a token ONLY for entries that need consent", async () => {
    deploymentMode = "local_trusted";
    const res = await getCatalog(makeApp(founderActor));
    const byId = Object.fromEntries(
      res.body.entries.map((e: { id: string }) => [e.id, e]),
    ) as Record<string, { consentRequired: boolean; consentToken?: string }>;
    expect(byId.notion.consentRequired).toBe(false);
    expect(byId.notion.consentToken).toBeUndefined();
    expect(byId.fs.consentRequired).toBe(false);
    expect(byId.fs.consentToken).toBeUndefined();
    expect(byId.acme.consentRequired).toBe(true);
    expect(typeof byId.acme.consentToken).toBe("string");
  });

  it("the minted token is bound to the exact command the same response displayed", async () => {
    deploymentMode = "local_trusted";
    const listed = await getCatalog(makeApp(founderActor));
    const acme = listed.body.entries.find((e: { id: string }) => e.id === "acme");
    expect(acme.command).toBe("npx");
    expect(acme.args).toEqual(["-y", "acme-db-tool@1.0.0"]);

    const res = await install(makeApp(founderActor), {
      entryId: "acme",
      consentToken: acme.consentToken,
    });
    expect(res.status).toBe(201);
  });

  it("does NOT mint a token for an entry D7 would refuse — consent can never look like a bypass", async () => {
    deploymentMode = "authenticated";
    const res = await getCatalog(makeApp(founderActor));
    const acme = res.body.entries.find((e: { id: string }) => e.id === "acme");
    expect(acme.installable).toBe(false);
    expect(acme.consentRequired).toBe(true);
    expect(acme.consentToken).toBeUndefined();
  });

  it("marks D7-permitted entries installable", async () => {
    deploymentMode = "authenticated";
    const res = await getCatalog(makeApp(founderActor));
    const byId = Object.fromEntries(
      res.body.entries.map((e: { id: string }) => [e.id, e]),
    ) as Record<string, { installable: boolean }>;
    expect(byId.notion.installable).toBe(true);
    expect(byId.fs.installable).toBe(true);
  });

  it("carries the GATE'S OWN refusal message, and only on refused entries", async () => {
    // The UI renders this verbatim. Deriving the copy client-side is exact only
    // while the gate has one refusal branch; sourcing it from the thrown error
    // means the founder always reads the refusal that actually happened.
    deploymentMode = "authenticated";
    const res = await getCatalog(makeApp(founderActor));
    const byId = Object.fromEntries(
      res.body.entries.map((e: { id: string }) => [e.id, e]),
    ) as Record<string, { installable: boolean; unavailableReason?: string }>;

    expect(byId.acme.installable).toBe(false);
    expect(byId.acme.unavailableReason).toBe(
      "Only remote HTTP connectors can be added in this deployment. stdio connectors run a " +
        "command on the AoA host and are restricted to verified catalog entries.",
    );
    // An installable entry must not carry a refusal reason at all.
    expect(byId.notion).not.toHaveProperty("unavailableReason");
    expect(byId.fs).not.toHaveProperty("unavailableReason");
  });

  it("never leaks a secret VALUE — every template key stays a bare key list", async () => {
    const res = await getCatalog(makeApp(founderActor));
    const notion = res.body.entries.find((e: { id: string }) => e.id === "notion");
    expect(notion.headerTemplateKeys).toEqual(["Authorization"]);
    expect(notion).not.toHaveProperty("headerTemplate");
  });

  it.each(["team_lead", "team_member"])("%s cannot read the shelf -> 403", async (role) => {
    mockGetEffectiveRole.mockResolvedValue(role);
    const res = await getCatalog(makeApp(founderActor));
    expect(res.status).toBe(403);
  });

  // FU-24 — when the signing secret is unset, a consent-requiring stdio entry
  // cannot be minted a token, so the install POST would 400 on the missing
  // token. The shelf must present such an entry as UNAVAILABLE (not a dead,
  // enabled Install button) with a reason naming the misconfiguration.
  describe("FU-24 — consent-gated stdio when no signing secret is configured", () => {
    let priorBetterAuth: string | undefined;
    let priorJwt: string | undefined;

    beforeEach(() => {
      priorBetterAuth = process.env.BETTER_AUTH_SECRET;
      priorJwt = process.env.AOA_AGENT_JWT_SECRET;
      // Both names resolveConsentSecret() checks — remove both so it throws.
      delete process.env.BETTER_AUTH_SECRET;
      delete process.env.AOA_AGENT_JWT_SECRET;
      // local_trusted so D7 permits acme: the only thing standing in the way is
      // the missing signing secret, isolating exactly this fix.
      deploymentMode = "local_trusted";
    });

    afterEach(() => {
      if (priorBetterAuth === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = priorBetterAuth;
      if (priorJwt === undefined) delete process.env.AOA_AGENT_JWT_SECRET;
      else process.env.AOA_AGENT_JWT_SECRET = priorJwt;
    });

    it("marks the entry NOT installable, with a clear reason and NO token", async () => {
      const res = await getCatalog(makeApp(founderActor));
      const acme = res.body.entries.find((e: { id: string }) => e.id === "acme") as {
        installable: boolean;
        consentRequired: boolean;
        consentToken?: string;
        unavailableReason?: string;
      };
      expect(acme.consentRequired).toBe(true);
      expect(acme.installable).toBe(false);
      expect(acme.consentToken).toBeUndefined();
      expect(acme.unavailableReason).toMatch(/signing secret/i);
    });

    it("leaves consent-free entries (http + verified stdio) installable and reason-free", async () => {
      const res = await getCatalog(makeApp(founderActor));
      const byId = Object.fromEntries(
        res.body.entries.map((e: { id: string }) => [e.id, e]),
      ) as Record<string, { installable: boolean; unavailableReason?: string }>;
      expect(byId.notion.installable).toBe(true);
      expect(byId.notion).not.toHaveProperty("unavailableReason");
      expect(byId.fs.installable).toBe(true);
      expect(byId.fs).not.toHaveProperty("unavailableReason");
    });

    it("with the signing secret present the SAME entry IS installable with a token (ablation companion)", async () => {
      process.env.BETTER_AUTH_SECRET = "fu24-test-signing-secret";
      const res = await getCatalog(makeApp(founderActor));
      const acme = res.body.entries.find((e: { id: string }) => e.id === "acme") as {
        installable: boolean;
        consentToken?: string;
        unavailableReason?: string;
      };
      expect(acme.installable).toBe(true);
      expect(typeof acme.consentToken).toBe("string");
      expect(acme).not.toHaveProperty("unavailableReason");
    });
  });
});
