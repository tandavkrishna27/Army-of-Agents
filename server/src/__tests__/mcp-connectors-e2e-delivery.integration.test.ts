/**
 * LIVE end-to-end integration proof for the MCP connectors feature (Task 14
 * Part C). Boots embedded-postgres, applies ALL migrations (proving 0178 — the
 * connector tables — applies to a fresh DB), then drives the REAL pipeline
 * against a real DB and the REAL delivery builder (no hand-assembled argv):
 *
 *   create secret + connector + agent + link  (real services)
 *     -> mcpConnectorService.list()             (A34: enabledAgentIds populated)
 *     -> loadEnabledConnectorRows()             (real DB read + secret resolve)
 *     -> buildConnectorSpecs()                  (real spec/env builder)
 *     -> prepareHeartbeatMcpDelivery()          (THE real delivery builder)
 *
 * and asserts the generated --mcp-config FILE carries the connector with a
 * `${AOA_MCP_*_TOKEN}` placeholder and NO plaintext secret, that the delivered
 * config.env carries the real token, and that the args carry
 * `--strict-mcp-config`.
 *
 * Passes `initdbFlags` for locale/encoding (per the repo's Windows embedded-PG
 * note) so it CAN run locally on Windows — verified passing there during Task 14
 * sign-off. For CI it is `describe.skipIf(process.platform === "win32")`
 * (embedded-PG can't boot on the Windows CI runner — Issue #114); Linux CI is
 * the authoritative gate. If setup fails the suite surfaces the error rather
 * than silently passing.
 */
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { mcpConnectorService } from "../services/mcp-connectors-crud.js";
import { loadEnabledConnectorRows, resolveAgentConnectors } from "../services/mcp-connectors-loader.js";
import { buildConnectorSpecs } from "../services/mcp-connectors.js";
import { prepareMcpOAuthSecretVersion, secretService } from "../services/secrets.js";
import {
  deriveOAuthBundleKey,
  encodeOAuthBundle,
  type OAuthTokenBundle,
} from "../services/mcp-connector-oauth-bundle.js";
import { resolveConsentSecret } from "../services/mcp-connector-consent.js";
import {
  prepareHeartbeatMcpDelivery,
  type HeartbeatMcpDelivery,
} from "../services/heartbeat-mcp.js";

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

const PORT = 58200 + Math.floor(Math.random() * 700);
const SECRET_PLAINTEXT = "notion-secret-do-not-leak-xyz";

beforeAll(async () => {
  try {
    // Deterministic 32-byte master key so the local_encrypted provider can
    // create + resolve the secret without touching a key file.
    process.env.AOA_SECRETS_MASTER_KEY = "a".repeat(64); // 64 hex chars = 32 bytes
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mcp-e2e-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    // Proves migration 0178 (connector tables) applies to a FRESH DB.
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[mcp-e2e] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
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

async function firstId(query: ReturnType<Db["execute"]>): Promise<string> {
  const res: any = await query;
  const rows = Array.isArray(res) ? res : res.rows;
  return rows[0].id as string;
}

// Skipped on Windows CI (embedded-postgres can't start on the runneradmin
// runner — Issue #114); Linux CI is the authoritative gate. VERIFIED PASSING
// locally on Windows (initdbFlags above) during Task 14 sign-off by temporarily
// removing this skip.
describe.skipIf(process.platform === "win32")("MCP connectors — live end-to-end delivery (real DB + real builder)", () => {
  it("proves 0178 migration + A34 enabledAgentIds + real heartbeat delivery config", async () => {
    if (setupError) throw setupError;

    // ── Seed a company + agent directly (raw SQL keeps the test independent of
    //    the full company/agent service surface). ──────────────────────────────
    const companyId = await firstId(
      db.execute(sql`
        INSERT INTO companies (organization_id, name)
        VALUES ('00000000-0000-0000-0000-000000000001', 'E2E Co')
        RETURNING id
      `),
    );
    const agentId = await firstId(
      db.execute(sql`
        INSERT INTO agents (company_id, name, adapter_type, status, kind)
        VALUES (${companyId}, 'Scout', 'claude_local', 'active', 'org')
        RETURNING id
      `),
    );
    const otherAgentId = await firstId(
      db.execute(sql`
        INSERT INTO agents (company_id, name, adapter_type, status, kind)
        VALUES (${companyId}, 'Idle One', 'claude_local', 'active', 'org')
        RETURNING id
      `),
    );

    // ── Real secret via the secret service (local_encrypted / aoa_managed). ────
    const secrets = secretService(db);
    await secrets.create(companyId, {
      name: "mcp:notion",
      provider: "local_encrypted",
      managedMode: "aoa_managed",
      value: SECRET_PLAINTEXT,
    });

    // ── Real connector create + agent link via the CRUD service. ──────────────
    const svc = mcpConnectorService(db);
    const connector = await svc.create(companyId, {
      serverName: "notion",
      displayName: "Notion Docs",
      transport: "http",
      url: "https://mcp.notion.example/v1",
      headerTemplate: { Authorization: "Bearer ${TOKEN}" },
      secretRef: "mcp:notion",
      status: "active",
    });
    // A second connector with NO agents, to prove enabledAgentIds -> [].
    const lonely = await svc.create(companyId, {
      serverName: "linear",
      displayName: "Linear",
      transport: "http",
      url: "https://mcp.linear.example/v1",
      status: "active",
    });
    await svc.replaceAgents(companyId, connector.id, [agentId]);

    // ── A34: list() must report the CURRENT enabled-agent set. ────────────────
    const listed = await svc.list(companyId);
    const byId = new Map(listed.map((c: any) => [c.id, c]));
    expect(byId.get(connector.id)!.enabledAgentIds).toEqual([agentId]);
    expect(byId.get(lonely.id)!.enabledAgentIds).toEqual([]);
    // The other agent is not linked → connector must not appear for it.
    expect(byId.get(connector.id)!.enabledAgentIds).not.toContain(otherAgentId);

    // ── Real loader → real spec builder (secret resolves off the real DB). ────
    const resolved = await loadEnabledConnectorRows(db, { companyId, agentId });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].serverName).toBe("notion");
    expect(resolved[0].secretValue).toBe(SECRET_PLAINTEXT); // decrypt round-trip

    const built = buildConnectorSpecs(resolved);
    expect(built.skipped).toEqual([]);
    expect(built.env.AOA_MCP_NOTION_TOKEN).toBe(SECRET_PLAINTEXT);

    // ── THE real delivery builder. ────────────────────────────────────────────
    const delivery: HeartbeatMcpDelivery = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId,
      runId: "run-" + PORT,
      config: { args: ["--model", "sonnet"] },
      params: {
        companyId,
        userId: "00000000-0000-0000-0000-000000000000",
        userRole: "founder",
        enabledCapabilities: [],
        bridgeEntrypoint: "/tmp/aoa-bridge.js",
        agentId,
        runId: "run-" + PORT,
      },
      extraMcpServers: built.specs,
      connectorEnv: built.env,
    });

    try {
      // Args carry AoA's own --mcp-config + --strict-mcp-config, and the user tail.
      const args = (delivery.config as any).args as string[];
      expect(args).toContain("--mcp-config");
      expect(args).toContain("--strict-mcp-config");
      expect(args).toContain("--model"); // user tail preserved

      // The delivered env carries the REAL token (rides in the spawn env).
      expect((delivery.config as any).env.AOA_MCP_NOTION_TOKEN).toBe(SECRET_PLAINTEXT);

      // The generated --mcp-config FILE: connector present with a placeholder,
      // and NO plaintext secret anywhere on disk.
      const cfgPathIdx = args.indexOf("--mcp-config");
      const cfgPath = args[cfgPathIdx + 1];
      const raw = await readFile(cfgPath, "utf8");
      expect(raw).toContain("notion");
      expect(raw).toContain("${AOA_MCP_NOTION_TOKEN}");
      expect(raw).not.toContain(SECRET_PLAINTEXT); // secret NEVER on disk
      const parsed = JSON.parse(raw);
      expect(parsed.mcpServers.notion).toBeDefined();
      expect(parsed.mcpServers.notion.headers.Authorization).toBe(
        "Bearer ${AOA_MCP_NOTION_TOKEN}",
      );
      // AoA's own bridge server is still present alongside the connector.
      expect(parsed.mcpServers.aoa).toBeDefined();
    } finally {
      await delivery.cleanup();
    }
  }, 180_000);

  // U11-e — regression fence (test-only, no code change): the OAuth broker
  // (#317) connectors are HTTP transport with a host-minted access token.
  // U11's stdio relaxation must never touch their resolution/refresh, and
  // they must stay admissible without the sandbox axis. Reproduces the
  // callback route's real DB writes directly (routes/mcp-connectors.ts
  // oauth/callback: prepareMcpOAuthSecretVersion -> commitPreparedMcpOAuthSecret
  // -> updateIfStatus) rather than replaying the full discovery/DCR/PKCE/
  // callback HTTP dance — that whole flow is already proven end-to-end by
  // mcp-connector-oauth.integration.test.ts; this test's job is narrower.
  it("U11-e: an active notion-hosted OAuth (HTTP) connector delivers on cloud_auth with sandboxTarget:false — the bearer lands in connectorEnv, and the signed bundle / refresh token never appear in egressHosts or connectorEnv", async () => {
    if (setupError) throw setupError;

    const savedDeploymentMode = process.env.AOA_DEPLOYMENT_MODE;
    const savedAuthSecret = process.env.BETTER_AUTH_SECRET;
    // Deliberately on cloud_auth: proves this HTTP connector needs NO sandbox
    // to be admissible — isTransportAllowed's first branch (`transport !==
    // "stdio"`) already returns true unconditionally, so sandboxTarget:false
    // must not change anything here.
    process.env.AOA_DEPLOYMENT_MODE = "cloud_auth";
    // resolveConsentSecret() (reused to derive the bundle signing key) throws
    // without one.
    process.env.BETTER_AUTH_SECRET = "test-secret-for-oauth-fence";
    try {
      // Explicit unique issue_prefix — the file's FIRST test already inserted a
      // company relying on the column's default, and a second default-prefix
      // row would collide on companies_issue_prefix_idx.
      const companyId = await firstId(
        db.execute(sql`
          INSERT INTO companies (organization_id, name, issue_prefix)
          VALUES ('00000000-0000-0000-0000-000000000001', 'OAuth Fence Co', 'OAF')
          RETURNING id
        `),
      );
      const agentId = await firstId(
        db.execute(sql`
          INSERT INTO agents (company_id, name, adapter_type, status, kind)
          VALUES (${companyId}, 'Scout', 'claude_local', 'active', 'org')
          RETURNING id
        `),
      );

      // The catalog OAuth-shaped connector row, created directly in
      // needs_credentials (mirrors the pre-callback state the real install
      // route lands, per mcp-connector-oauth.integration.test.ts).
      const svc = mcpConnectorService(db);
      const connector = await svc.create(companyId, {
        serverName: "notion",
        displayName: "Notion (hosted)",
        transport: "http",
        url: "https://mcp.notion.com/mcp",
        headerTemplate: { Authorization: "Bearer ${TOKEN}" },
        requiresSecret: true,
        source: "catalog",
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
        trustTier: "verified",
        status: "needs_credentials",
      });
      await svc.replaceAgents(companyId, connector.id, [agentId]);

      // The real signed OAuth bundle, committed via the EXACT same service
      // calls the callback route makes (prepareMcpOAuthSecretVersion ->
      // commitPreparedMcpOAuthSecret -> updateIfStatus), bypassing only the
      // HTTP authorize/discovery/DCR round trip.
      const secretName = `mcp:oauth:${connector.id}`;
      const bundleKey = deriveOAuthBundleKey(resolveConsentSecret());
      const ACCESS_TOKEN = "at-do-not-leak-xyz";
      const REFRESH_TOKEN = "rt-do-not-leak-xyz";
      const bundle: OAuthTokenBundle = {
        companyId,
        connectorId: connector.id,
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
        secretName,
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresAt: Date.now() + 3_600_000, // far from expiry — no refresh triggered
        issuer: "https://mcp.notion.com",
        tokenEndpoint: "https://mcp.notion.com/token",
        clientId: "dcr-client-1",
        redirectUri: "https://app.example.test/api/mcp-connectors/oauth/callback",
        scopes: ["default"],
        resource: "https://mcp.notion.com/mcp",
      };
      const prepared = await prepareMcpOAuthSecretVersion({
        companyId,
        value: encodeOAuthBundle(bundle, bundleKey),
        owner: { connectorId: connector.id, catalogEntryId: "notion-hosted", oauthPolicyVersion: 1 },
        expectedLatestVersion: 0,
      });
      await secretService(db).commitPreparedMcpOAuthSecret(prepared, { userId: null });
      const bound = await svc.updateIfStatus(connector.id, "needs_credentials", {
        secretRef: secretName,
        status: "active",
      });
      expect(bound).not.toBeNull();

      // ── The real delivery seam. sandboxTarget is explicit false: this
      //    connector must never have needed the U11 stdio relaxation. ────────
      // runId omitted (optional): activity_log.run_id FKs to heartbeat_runs,
      // which this test never seeds — the delivery audit's own try/catch
      // already tolerates that (best-effort, never breaks delivery), but
      // omitting it keeps the run clean rather than relying on that catch.
      const resolved = await resolveAgentConnectors(db, {
        companyId,
        agentId,
        sandboxTarget: false,
      });

      // The resolved bearer (the access token alone) lands in connectorEnv,
      // under the connector's deterministic env var name.
      const envKeys = Object.keys(resolved.connectorEnv);
      expect(envKeys).toHaveLength(1);
      const tokenEnvVar = envKeys[0]!;
      expect(resolved.connectorEnv[tokenEnvVar]).toBe(ACCESS_TOKEN);

      // The spec itself carries only a placeholder + the env-var-name
      // indirection — never the raw token.
      const spec = resolved.extraMcpServers.notion as {
        headers?: Record<string, string>;
        authTokenEnvVar?: string;
      };
      expect(spec).toBeDefined();
      expect(spec.authTokenEnvVar).toBe(tokenEnvVar);
      expect(spec.headers?.Authorization).toBe(`Bearer \${${tokenEnvVar}}`);

      // egressHosts (U11) is bare-host-only, sourced ONLY from the
      // connector's own URL — the signed bundle / refresh token never reach
      // it, and no npm/PyPI host is added (this connector is HTTP, not
      // stdio).
      expect(resolved.egressHosts).toEqual(["mcp.notion.com"]);

      // Belt-and-suspenders over the whole resolved result: the refresh
      // token never appears ANYWHERE, and the access token appears EXACTLY
      // once (the one deliberate connectorEnv slot) — never duplicated into
      // egressHosts or leaked as a raw header value. Resolution/refresh stay
      // host-side (§9/§14).
      const serialized = JSON.stringify(resolved);
      expect(serialized).not.toContain(REFRESH_TOKEN);
      expect(serialized.split(ACCESS_TOKEN)).toHaveLength(2); // exactly one occurrence
    } finally {
      if (savedDeploymentMode === undefined) delete process.env.AOA_DEPLOYMENT_MODE;
      else process.env.AOA_DEPLOYMENT_MODE = savedDeploymentMode;
      if (savedAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = savedAuthSecret;
    }
  }, 180_000);
});
