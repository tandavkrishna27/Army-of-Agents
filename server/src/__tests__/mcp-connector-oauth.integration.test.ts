/**
 * @fileoverview Plan 4 (OAuth connector broker) Task 17 — end-to-end integration
 * proof against a REAL embedded Postgres, ALL migrations (including 0185
 * `mcp_connector_oauth_flows`), and the REAL Express routes
 * (`mcpConnectorRoutes`). Every unit/route test written for the broker so far
 * (`mcp-connector-oauth.test.ts`, `mcp-connector-oauth-route.test.ts`,
 * `mcp-connector-token-refresh.test.ts`) drives the pieces over mocks — this
 * file is the first to prove the WHOLE flow (install → authorize → callback →
 * deliver → refresh) against a real database with nothing but the outbound
 * `fetch` to the authorization server stubbed.
 *
 * WHAT IS STUBBED, AND WHAT IS NOT: `globalThis.fetch` is replaced with a
 * URL-routing mock authorization server (`https://as.example`) — discovery
 * (RFC 9728 protected-resource-metadata → RFC 8414 AS metadata), dynamic client
 * registration (RFC 7591), and the token endpoint (code exchange + refresh).
 * `discoverOAuthServer`/`registerOAuthClient`/`exchangeAuthorizationCode`/
 * `refreshOAuthToken` in `mcp-connector-oauth.ts` all call the DEFAULT `fetch`
 * parameter from the real routes and the real loader (`mcp-connectors.ts`
 * `oauth/start` and `oauth/callback` never pass a `fetchImpl`, nor does
 * `mcp-connector-token-refresh.ts`'s `doRefresh`) — so overriding the global is
 * the only seam available, and it is also the only thing stubbed. The
 * connector CATALOG is injected the same way the sibling install integration
 * suite does it (`opts.catalog`), purely so no network call is needed to reach
 * a curated entry.
 *
 * WHAT IS PROVEN, against a real DB:
 *  1. Catalog install of a `requiresOAuth` entry lands `needs_credentials`,
 *     `requiresSecret: true`, `secretRef: null` (mirrors the non-OAuth proof in
 *     `mcp-connector-install.integration.test.ts`, for the OAuth override in
 *     `entryToCreateInput`).
 *  2. `POST …/oauth/start` runs discovery + DCR + PKCE + signed state against
 *     the mock AS and persists a real `mcp_connector_oauth_flows` row.
 *  3. `GET /mcp-connectors/oauth/callback` exchanges the code, stores an
 *     `OAuthTokenBundle` as a real encrypted `company_secrets` row named
 *     `mcp:notion`, binds the connector to `active`, and marks the flow
 *     `completed` — all through the real atomic-claim + status-derivation code
 *     path, not a mock.
 *  4. `loadEnabledConnectorRows` decrypts the bundle and hands back the LIVE
 *     access token (`secretValue`), not the encoded bundle string — proving the
 *     bundle → access-token extraction the whole broker exists for.
 *  5. When the bundle is expired, the SAME loader call transparently refreshes
 *     against the mock AS's token endpoint, rotates the stored secret to a new
 *     version carrying the new access token, and returns the new token — the
 *     JIT refresh path (Task 13), exercised here for the first time against a
 *     real secret row instead of an injected `RefreshDeps` fake.
 *
 * Skipped on Windows CI (embedded-postgres cannot start on the `runneradmin`
 * runner — Issue #114); Linux CI is the authoritative gate. `initdbFlags` are
 * passed so it CAN be run locally on Windows by removing the skip. A setup
 * failure is RETHROWN inside the test rather than swallowed — a green run must
 * never mean "the database never started".
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  mcpConnectorOauthFlows,
  type Db,
} from "@armyofagents/db";
import type { McpConnectorCatalogEntry } from "@armyofagents/shared";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { mcpConnectorRoutes } from "../routes/mcp-connectors.js";
import { errorHandler } from "../middleware/index.js";
import { loadEnabledConnectorRows } from "../services/mcp-connectors-loader.js";
import {
  prepareMcpOAuthSecretVersion,
  secretService,
} from "../services/secrets.js";
import {
  decodeOAuthBundle,
  deriveOAuthBundleKey,
  encodeOAuthBundle,
} from "../services/mcp-connector-oauth-bundle.js";
import { resolveConsentSecret } from "../services/mcp-connector-consent.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
let originalDeploymentMode: string | undefined;
let originalMasterKey: string | undefined;
let originalAuthSecret: string | undefined;
let realFetch: typeof globalThis.fetch;

/**
 * The mock authorization server's token endpoint response is mutable so the
 * SAME fixture serves both the code exchange (step 3) and the refresh (step
 * 5) with different access tokens, exactly like a real AS issuing a fresh
 * token each time it is called.
 */
let tokenResponse: {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
} = {
  access_token: "at-1",
  refresh_token: "rt-1",
  token_type: "Bearer",
  expires_in: 3600,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * URL-routing `globalThis.fetch` mock for a single OAuth-only MCP connector
 * whose hosted server lives at `https://as.example/mcp`. Modeled on
 * `installFixtureFetch` in `crew-marketplace-bootstrap.integration.test.ts`:
 * save the real fetch, override the global, restore in `afterAll`.
 */
function installMockAuthorizationServer() {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (
      method === "GET" &&
      url === "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp"
    ) {
      return jsonResponse({
        resource: "https://mcp.notion.com/mcp",
        authorization_servers: ["https://mcp.notion.com"],
        scopes_supported: ["default"],
      });
    }
    if (
      method === "GET" &&
      url === "https://mcp.notion.com/.well-known/oauth-authorization-server"
    ) {
      return jsonResponse({
        issuer: "https://mcp.notion.com",
        authorization_endpoint: "https://mcp.notion.com/authorize",
        token_endpoint: "https://mcp.notion.com/token",
        registration_endpoint: "https://mcp.notion.com/register",
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["default"],
      });
    }
    if (method === "POST" && url === "https://mcp.notion.com/register") {
      return jsonResponse({ client_id: "dcr-client-1" }, 201);
    }
    if (method === "POST" && url === "https://mcp.notion.com/token") {
      return jsonResponse(tokenResponse);
    }
    return new Response(`no fixture for ${method} ${url}`, { status: 404 });
  }) as typeof fetch;
}

/**
 * The curated OAuth-only entry under test. `requiresSecret` is left at its
 * catalog default (`false`) DELIBERATELY — `entryToCreateInput` overrides it
 * to `true` whenever `requiresOAuth` is set (Task 10), and this test exists in
 * part to prove that override fires for real, not just in the unit suite.
 */
const CATALOG_ENTRY: McpConnectorCatalogEntry = {
  id: "notion-hosted",
  serverName: "notion",
  displayName: "Notion (hosted)",
  transport: "http",
  url: "https://mcp.notion.com/mcp",
  args: [],
  headerTemplateKeys: [],
  envTemplateKeys: [],
  requiresSecret: false,
  requiresOAuth: true,
  oauth: { scopes: ["default"] },
  trust: { tier: "verified" },
};

const fakeCatalog = {
  load: async () => ({ entries: [CATALOG_ENTRY], stale: false }),
};

beforeAll(async () => {
  try {
    originalDeploymentMode = process.env.AOA_DEPLOYMENT_MODE;
    originalMasterKey = process.env.AOA_SECRETS_MASTER_KEY;
    originalAuthSecret = process.env.BETTER_AUTH_SECRET;

    // Deterministic 32-byte master key so the local_encrypted secret provider
    // can create + resolve secrets without touching a key file.
    process.env.AOA_SECRETS_MASTER_KEY = "c".repeat(64);
    // `resolveConsentSecret()` (reused to sign OAuth `state`) throws without one.
    process.env.BETTER_AUTH_SECRET = "test-secret";
    // local_trusted: no governance gate (install lands `needs_credentials`
    // directly, no approval) and `oauthRedirectUri` does not fail closed for
    // want of `AOA_AUTH_PUBLIC_BASE_URL`.
    process.env.AOA_DEPLOYMENT_MODE = "local_trusted";

    dataDir = await mkdtemp(join(tmpdir(), "aoa-conn-oauth-"));
    const port = await allocateEmbeddedPgPort();
    const { default: EmbeddedPostgres } = (await import(
      "embedded-postgres"
    )) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    installMockAuthorizationServer();
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[conn-oauth] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  if (originalDeploymentMode === undefined)
    delete process.env.AOA_DEPLOYMENT_MODE;
  else process.env.AOA_DEPLOYMENT_MODE = originalDeploymentMode;
  if (originalMasterKey === undefined)
    delete process.env.AOA_SECRETS_MASTER_KEY;
  else process.env.AOA_SECRETS_MASTER_KEY = originalMasterKey;
  if (originalAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = originalAuthSecret;
  if (realFetch) globalThis.fetch = realFetch;
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function firstRow<T = Record<string, unknown>>(
  query: unknown
): Promise<T> {
  const res = (await query) as { rows?: T[] } | T[];
  const rows = Array.isArray(res) ? res : res.rows ?? [];
  return rows[0] as T;
}

/** Board actor shape. `source: "session"` so `assertRole` really runs. */
function boardActor(userId: string, companyIds: string[]) {
  return {
    type: "board" as const,
    source: "session" as const,
    userId,
    companyIds,
    isInstanceAdmin: false,
  };
}

/**
 * The REAL router, with only the actor injected (the auth middleware is the
 * one thing a supertest harness cannot boot) and the fake CATALOG so no
 * network is touched for the catalog lookup itself. `db` is the real handle.
 */
function app(actor: unknown) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    mcpConnectorRoutes(db, {
      catalog: fakeCatalog,
      oauthFetch: globalThis.fetch,
    })
  );
  server.use(errorHandler);
  // `request(...)` and not the bare app: an express app also has `.post`,
  // which REGISTERS a route instead of issuing one.
  return request(server);
}

let companySeq = 0;

/** A company + a founder + an agent, all real rows. */
async function seedCompany(name: string) {
  companySeq += 1;
  const prefix = `OA${String(companySeq).padStart(2, "0")}`;
  const company = await firstRow<{ id: string }>(
    db.execute(
      sql`INSERT INTO companies (name, issue_prefix) VALUES (${name}, ${prefix}) RETURNING id`
    )
  );
  const founderId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES (${founderId}, 'Founder', ${`${founderId}@example.test`}, now(), now())
  `);
  await db.execute(sql`
    INSERT INTO user_roles (company_id, user_id, role) VALUES (${company.id}, ${founderId}, 'founder')
  `);
  const agent = await firstRow<{ id: string }>(
    db.execute(sql`
      INSERT INTO agents (company_id, name, adapter_type, status, kind)
      VALUES (${company.id}, 'Scout', 'claude_local', 'active', 'org')
      RETURNING id
    `)
  );
  return { companyId: company.id, founderId, agentId: agent.id };
}

/** Reads the connector row straight from the DB — never from a response body. */
async function connectorRow(id: string) {
  return firstRow<{
    id: string;
    status: string;
    secret_ref: string | null;
    requires_secret: boolean;
    server_name: string;
  }>(db.execute(sql`SELECT * FROM company_mcp_connectors WHERE id = ${id}`));
}

describe.skipIf(process.platform === "win32")(
  "OAuth connector broker — end-to-end (real routes, real DB, mock authorization server)",
  () => {
    it("install -> oauth/start -> callback -> delivers a live access token -> refreshes on expiry", async () => {
      if (setupError) throw setupError;

      const { companyId, founderId, agentId } = await seedCompany(
        "OAuth Broker Co"
      );
      const founder = app(boardActor(founderId, [companyId]));

      // ── (1) Catalog install of the requiresOAuth entry. ─────────────────────
      const installed = await founder
        .post(`/api/companies/${companyId}/mcp-connectors/install`)
        .send({ entryId: CATALOG_ENTRY.id });
      expect(installed.status).toBe(201);
      const connectorId = installed.body.id as string;

      const afterInstall = await connectorRow(connectorId);
      expect({
        status: afterInstall.status,
        requiresSecret: afterInstall.requires_secret,
        secretRef: afterInstall.secret_ref,
      }).toEqual({
        // OAuth entries ALWAYS need a credential (Task 10 override), even
        // though this catalog entry's OWN `requiresSecret` is false.
        status: "needs_credentials",
        requiresSecret: true,
        secretRef: null,
      });

      // ── (2) Start the OAuth flow: discovery + DCR + PKCE + signed state ──────
      //    against the mock authorization server. ─────────────────────────────
      const started = await founder
        .post(
          `/api/companies/${companyId}/mcp-connectors/${connectorId}/oauth/start`
        )
        .send({});
      expect(started.status).toBe(200);
      expect(typeof started.body.authorizeUrl).toBe("string");
      const authorizeUrl = new URL(started.body.authorizeUrl as string);
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
        "https://mcp.notion.com/authorize"
      );
      expect(authorizeUrl.searchParams.get("client_id")).toBe("dcr-client-1");
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe(
        "S256"
      );

      const flowRows = await db
        .select()
        .from(mcpConnectorOauthFlows)
        .where(eq(mcpConnectorOauthFlows.connectorId, connectorId));
      expect(flowRows).toHaveLength(1);
      expect(flowRows[0].status).toBe("pending");
      const state = flowRows[0].state;
      const flowId = flowRows[0].id;

      // ── (3) The browser round-trip: the AS calls back with a code. ──────────
      const callback = await founder
        .get(`/api/mcp-connectors/oauth/callback`)
        .query({ code: "CODE", state });
      expect(callback.status).toBe(302);

      const secretName = `mcp:oauth:${connectorId}`;
      const bundleKey = deriveOAuthBundleKey(resolveConsentSecret());
      const bundleContext = {
        companyId,
        connectorId,
        catalogEntryId: CATALOG_ENTRY.id,
        oauthPolicyVersion: 1,
        secretName,
      };
      const secretRow = await secretService(db).getByName(
        companyId,
        secretName
      );
      expect(secretRow).toBeTruthy();
      expect(secretRow!.provider).toBe("local_encrypted");

      const afterCallback = await connectorRow(connectorId);
      expect(afterCallback.status).toBe("active");
      expect(afterCallback.secret_ref).toBe(secretName);

      const flowAfterRows = await db
        .select()
        .from(mcpConnectorOauthFlows)
        .where(eq(mcpConnectorOauthFlows.id, flowId));
      expect(flowAfterRows[0].status).toBe("completed");
      expect(flowAfterRows[0].completedAt).toBeTruthy();

      // A replay of the same code/state must not be honored a second time
      // (the atomic flow-claim proven at the unit level, now over a real row).
      const replay = await founder
        .get(`/api/mcp-connectors/oauth/callback`)
        .query({ code: "CODE", state });
      expect(replay.status).toBe(400);

      // ── (4) Opt the connector into the agent, then prove the loader hands ────
      //    back the DECRYPTED, LIVE ACCESS TOKEN — not the encoded bundle. ─────
      const enabled = await founder
        .put(`/api/companies/${companyId}/mcp-connectors/${connectorId}/agents`)
        .send({ agentIds: [agentId] });
      expect(enabled.status).toBe(200);

      const delivered = await loadEnabledConnectorRows(db, {
        companyId,
        agentId,
        oauthFetch: globalThis.fetch,
      });
      expect(delivered).toHaveLength(1);
      expect(delivered[0].serverName).toBe("notion");
      expect(delivered[0].secretValue).toBe("at-1");

      // ── (5) Refresh path: age the bundle past expiry, point the mock AS at a ─
      //    new access token, and prove the SAME loader call refreshes silently ─
      //    and rotates the stored secret. ──────────────────────────────────────
      const consumerCtx = {
        consumerType: "system" as const,
        consumerId: "oauth-broker",
        actorType: "system" as const,
        configPath: "mcp.connector.notion",
        mcpOAuthOwner: {
          connectorId,
          catalogEntryId: CATALOG_ENTRY.id,
          oauthPolicyVersion: 1,
        },
      };
      const rawBefore = await secretService(db).resolveByName(
        companyId,
        secretName,
        consumerCtx
      );
      const bundleBefore = decodeOAuthBundle(
        rawBefore,
        bundleKey,
        bundleContext
      );
      expect(bundleBefore).toBeTruthy();
      expect(bundleBefore!.accessToken).toBe("at-1");
      expect(bundleBefore!.refreshToken).toBe("rt-1");

      const expiredBundle = { ...bundleBefore!, expiresAt: Date.now() - 1_000 };
      const preparedExpired = await prepareMcpOAuthSecretVersion({
        companyId,
        value: encodeOAuthBundle(expiredBundle, bundleKey),
        owner: {
          connectorId,
          catalogEntryId: CATALOG_ENTRY.id,
          oauthPolicyVersion: 1,
        },
        expectedLatestVersion: secretRow!.latestVersion,
      });
      await db.transaction((tx) =>
        secretService(tx as unknown as Db).commitPreparedMcpOAuthSecret(
          preparedExpired
        )
      );
      const versionBeforeRefresh = (await secretService(db).getByName(
        companyId,
        secretName
      ))!.latestVersion;

      tokenResponse = {
        access_token: "at-2",
        token_type: "Bearer",
        expires_in: 3600,
      };

      const refreshed = await loadEnabledConnectorRows(db, {
        companyId,
        agentId,
        oauthFetch: globalThis.fetch,
      });
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0].secretValue).toBe("at-2");

      const secretAfterRefresh = await secretService(db).getByName(
        companyId,
        secretName
      );
      expect(secretAfterRefresh!.latestVersion).toBeGreaterThan(
        versionBeforeRefresh
      );

      const rawAfterRefresh = await secretService(db).resolveByName(
        companyId,
        secretName,
        consumerCtx
      );
      const bundleAfterRefresh = decodeOAuthBundle(
        rawAfterRefresh,
        bundleKey,
        bundleContext
      );
      expect(bundleAfterRefresh!.accessToken).toBe("at-2");
      // No new refresh_token in the mock response -> the old one is kept
      // (`doRefresh`'s `refreshToken: token.refreshToken ?? bundle.refreshToken`).
      expect(bundleAfterRefresh!.refreshToken).toBe("rt-1");
    }, 120_000);

    // ─────────────────────────────────────────────────────────────────────────
    // R1 (multi-tenant merge blocker): the callback binds the exchanged provider
    // token to a connector based on the board session that COMPLETES the flow.
    // #316 reshaped the board actor model; a clean textual merge could silently
    // break this binding. This test proves a cross-tenant session cannot complete
    // another founder's flow. It runs in `authenticated` mode because the R1
    // check is skipped under local_trusted (loopback trust).
    // ─────────────────────────────────────────────────────────────────────────
    it("R1: only the founder session that started the flow can complete the callback (cross-tenant is refused)", async () => {
      if (setupError) throw setupError;

      const priorMode = process.env.AOA_DEPLOYMENT_MODE;
      const priorBaseUrl = process.env.AOA_AUTH_PUBLIC_BASE_URL;
      process.env.AOA_DEPLOYMENT_MODE = "authenticated";
      process.env.AOA_AUTH_PUBLIC_BASE_URL = "https://app.example.test";
      try {
        const a = await seedCompany("Tenant A Co");
        const b = await seedCompany("Tenant B Co");
        const founderA = app(boardActor(a.founderId, [a.companyId]));
        const founderB = app(boardActor(b.founderId, [b.companyId]));

        // Founder A installs the OAuth connector and starts the flow. In
        // authenticated mode `startedByUserId` is the real session user (A).
        const installed = await founderA
          .post(`/api/companies/${a.companyId}/mcp-connectors/install`)
          .send({ entryId: CATALOG_ENTRY.id });
        expect(installed.status).toBe(201);
        const connectorId = installed.body.id as string;

        const started = await founderA
          .post(
            `/api/companies/${a.companyId}/mcp-connectors/${connectorId}/oauth/start`
          )
          .send({});
        expect(started.status).toBe(200);

        const flowRows = await db
          .select()
          .from(mcpConnectorOauthFlows)
          .where(eq(mcpConnectorOauthFlows.connectorId, connectorId));
        expect(flowRows).toHaveLength(1);
        expect(flowRows[0].startedByUserId).toBe(a.founderId);
        const state = flowRows[0].state;
        const flowId = flowRows[0].id;
        const secretName = `mcp:oauth:${connectorId}`;

        // ── Cross-tenant hijack: founder B (different user AND company) tries to
        //    complete founder A's flow. Must be refused BEFORE any code exchange
        //    or secret write — a 403, not a silent bind.
        const hijack = await founderB
          .get(`/api/mcp-connectors/oauth/callback`)
          .query({ code: "CODE", state });
        expect(hijack.status).toBe(403);

        // The hijack changed nothing: no secret bound, connector not activated,
        // flow still pending (claimable only by the rightful owner). Assert the
        // mode-independent security invariants — NOT the exact lifecycle string
        // (in authenticated mode a fresh connector is `pending_approval`, not
        // `needs_credentials`).
        const afterHijack = await connectorRow(connectorId);
        expect(afterHijack.secret_ref).toBeNull();
        expect(afterHijack.status).not.toBe("active");
        expect(
          await secretService(db).getByName(a.companyId, secretName)
        ).toBeFalsy();
        const flowAfterHijack = await db
          .select()
          .from(mcpConnectorOauthFlows)
          .where(eq(mcpConnectorOauthFlows.id, flowId));
        expect(flowAfterHijack[0].status).toBe("pending");

        // ── The rightful founder A completes the SAME flow successfully. ───────
        const ok = await founderA
          .get(`/api/mcp-connectors/oauth/callback`)
          .query({ code: "CODE", state });
        expect(ok.status).toBe(302);
        // Binding the token is the proof the rightful owner completed the flow.
        // (The resulting lifecycle status depends on board-approval state in
        // authenticated mode; the happy-path test covers the ->active transition.)
        const afterOk = await connectorRow(connectorId);
        expect(afterOk.secret_ref).toBe(secretName);
      } finally {
        if (priorMode === undefined) delete process.env.AOA_DEPLOYMENT_MODE;
        else process.env.AOA_DEPLOYMENT_MODE = priorMode;
        if (priorBaseUrl === undefined) delete process.env.AOA_AUTH_PUBLIC_BASE_URL;
        else process.env.AOA_AUTH_PUBLIC_BASE_URL = priorBaseUrl;
      }
    }, 120_000);

    it("rolls back secret, connector, flow completion, and activity when the durable activity insert fails", async () => {
      if (setupError) throw setupError;

      const { companyId, founderId } = await seedCompany(
        "OAuth Callback Rollback Co"
      );
      const founder = app(boardActor(founderId, [companyId]));
      const installed = await founder
        .post(`/api/companies/${companyId}/mcp-connectors/install`)
        .send({ entryId: CATALOG_ENTRY.id });
      expect(installed.status).toBe(201);
      const connectorId = installed.body.id as string;
      const started = await founder
        .post(
          `/api/companies/${companyId}/mcp-connectors/${connectorId}/oauth/start`
        )
        .send({});
      expect(started.status).toBe(200);
      const flow = await db
        .select()
        .from(mcpConnectorOauthFlows)
        .where(eq(mcpConnectorOauthFlows.connectorId, connectorId))
        .then((rows) => rows[0]);

      await db.execute(
        sql.raw(`
          CREATE OR REPLACE FUNCTION fail_oauth_authorized_activity()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.action = 'mcp_connector.oauth_authorized' THEN
              RAISE EXCEPTION 'forced oauth activity failure';
            END IF;
            RETURN NEW;
          END;
          $$;
        `)
      );
      await db.execute(
        sql.raw(`
          CREATE TRIGGER fail_oauth_authorized_activity_trigger
          BEFORE INSERT ON activity_log
          FOR EACH ROW EXECUTE FUNCTION fail_oauth_authorized_activity();
        `)
      );

      try {
        const callback = await founder
          .get(`/api/mcp-connectors/oauth/callback`)
          .query({ code: "CODE-ROLLBACK", state: flow.state });
        expect(callback.status).toBe(302);
        expect(callback.headers.location).toContain("oauthResult=failed");

        const connector = await connectorRow(connectorId);
        expect(connector.status).toBe("needs_credentials");
        expect(connector.secret_ref).toBeNull();
        await expect(
          secretService(db).getByName(companyId, `mcp:oauth:${connectorId}`)
        ).resolves.toBeNull();

        const failedFlow = await db
          .select()
          .from(mcpConnectorOauthFlows)
          .where(eq(mcpConnectorOauthFlows.id, flow.id))
          .then((rows) => rows[0]);
        expect(failedFlow.status).toBe("failed");
        expect(failedFlow.completedAt).toBeNull();

        const activityCount = await firstRow<{ count: string }>(
          db.execute(sql`
            SELECT count(*)::text AS count
            FROM activity_log
            WHERE company_id = ${companyId}
              AND action = 'mcp_connector.oauth_authorized'
          `)
        );
        expect(activityCount.count).toBe("0");
      } finally {
        await db.execute(
          sql.raw(
            "DROP TRIGGER IF EXISTS fail_oauth_authorized_activity_trigger ON activity_log;"
          )
        );
        await db.execute(
          sql.raw("DROP FUNCTION IF EXISTS fail_oauth_authorized_activity();")
        );
      }
    }, 120_000);

    it("rolls back OAuth start flow creation when its durable activity insert fails", async () => {
      if (setupError) throw setupError;

      const { companyId, founderId } = await seedCompany(
        "OAuth Start Rollback Co"
      );
      const founder = app(boardActor(founderId, [companyId]));
      const installed = await founder
        .post(`/api/companies/${companyId}/mcp-connectors/install`)
        .send({ entryId: CATALOG_ENTRY.id });
      expect(installed.status).toBe(201);
      const connectorId = installed.body.id as string;

      await db.execute(
        sql.raw(`
          CREATE OR REPLACE FUNCTION fail_oauth_started_activity()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.action = 'mcp_connector.oauth_started' THEN
              RAISE EXCEPTION 'forced oauth start activity failure';
            END IF;
            RETURN NEW;
          END;
          $$;
        `)
      );
      await db.execute(
        sql.raw(`
          CREATE TRIGGER fail_oauth_started_activity_trigger
          BEFORE INSERT ON activity_log
          FOR EACH ROW EXECUTE FUNCTION fail_oauth_started_activity();
        `)
      );

      try {
        const started = await founder
          .post(
            `/api/companies/${companyId}/mcp-connectors/${connectorId}/oauth/start`
          )
          .send({});
        expect(started.status).toBe(500);

        const flowCount = await firstRow<{ count: string }>(
          db.execute(sql`
            SELECT count(*)::text AS count
            FROM mcp_connector_oauth_flows
            WHERE connector_id = ${connectorId}
          `)
        );
        expect(flowCount.count).toBe("0");

        const activityCount = await firstRow<{ count: string }>(
          db.execute(sql`
            SELECT count(*)::text AS count
            FROM activity_log
            WHERE company_id = ${companyId}
              AND action = 'mcp_connector.oauth_started'
          `)
        );
        expect(activityCount.count).toBe("0");
      } finally {
        await db.execute(
          sql.raw(
            "DROP TRIGGER IF EXISTS fail_oauth_started_activity_trigger ON activity_log;"
          )
        );
        await db.execute(
          sql.raw("DROP FUNCTION IF EXISTS fail_oauth_started_activity();")
        );
      }
    }, 120_000);
  }
);
