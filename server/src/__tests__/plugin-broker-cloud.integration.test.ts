/**
 * U10 (Cloud Execution Isolation / E2B, Wave 5) — cloud integration proof
 * that a plugin tool call from an agent run-JWT reaches the host-resident
 * plugin worker and returns, with cross-company isolation held.
 *
 * Proven here against a REAL Postgres (embedded-postgres + the committed
 * migration chain), through the REAL HTTP router (`mcpServerRoutes(db)`)
 * mounted behind the REAL `actorMiddleware` in `deploymentMode:"cloud_auth"`
 * — the run-JWT is verified for real, not stubbed, and `isCloudPluginExecutionBlocked()`
 * is asserted `false` under that exact mode. This mirrors the embedded-pg
 * pattern of `broker-internal-registry.test.ts` (agent run-JWT dispatch
 * proof) and `mcp-connectors-e2e-delivery.integration.test.ts` (delivery
 * seam proof).
 *
 * WHAT IS REAL vs STUBBED, and why:
 *   - REAL: company/agent DB rows, run-JWT minting + verification, the
 *     broker HTTP route, `assertCompanyAccess`, `isCloudPluginExecutionBlocked()`,
 *     the production `createPluginToolRegistry`/`createPluginToolDispatcher`
 *     (the actual company-scoped `getTool` + `executeTool` dispatch logic —
 *     the security-critical code this task is about).
 *   - STUBBED: the `PluginWorkerManager`'s `isRunning`/`call` — i.e. the OS
 *     process fork + stdio JSON-RPC transport that actually runs a plugin's
 *     worker code. No test in this codebase today forks a real plugin
 *     worker end-to-end (plugin-worker-manager.test.ts's own fixture uses a
 *     deliberately-nonexistent entrypoint to prove REJECTION, never a
 *     working fork) — building that fixture (a real ESM worker file, doing
 *     its own module resolution from an ad-hoc location, forked as a
 *     genuine child process on Windows) is substantial, platform-risky
 *     infra unrelated to what U10 changed. `plugin-worker-manager.ts`'s own
 *     fork/RPC mechanics have their own dedicated unit tests. Stubbing only
 *     that leaf still exercises the REAL registry/dispatcher all the way
 *     down to "hand the RPC params to the worker manager and return its
 *     result" — the actual host-resident-worker dispatch path this task
 *     adds. Flagged as a suggested follow-up (a real-fork proof) in the
 *     task report rather than silently left uncovered.
 *
 * Skipped on Windows (embedded-postgres can't start on this platform's CI
 * runner — Issue #114); set AOA_RUN_WIN_INTEGRATION=1 on a Windows dev box
 * to force-run locally. Linux CI `push` is the authoritative gate for this
 * file, same as every other `*.integration.test.ts` in this suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { actorMiddleware } from "../middleware/auth.js";
import { mcpServerRoutes } from "../mcp/server.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { isCloudPluginExecutionBlocked } from "../services/cloud-plugin-execution.js";
import { createPluginToolDispatcher, type PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { AoAPluginManifestV1 } from "@armyofagents/shared";

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
let setupFailed = false;

function assertSetupOk(): void {
  const dbReady = (db as Db | undefined) !== undefined;
  if (!setupFailed && dbReady) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as { id: string })?.id;
  return (result as { rows?: { id: string }[] }).rows?.[0]?.id;
}

const JWT_SECRET_ENV = "AOA_AGENT_JWT_SECRET";
const originalJwtSecret = process.env[JWT_SECRET_ENV];

let c1 = "";
let c2 = "";
let agentInC1 = "";
let agentInC2 = "";
let runInC1 = "";
let runInC2 = "";
let jwtC1 = "";
let jwtC2 = "";
let pluginDbId = "";

const PLUGIN_KEY = "acme.test";
const TOOL_NAME = `${PLUGIN_KEY}:search`;

const MANIFEST: AoAPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Acme Test Plugin",
  description: "A minimal test plugin with one tool",
  author: "test",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "worker.js" },
  tools: [
    {
      name: "search",
      displayName: "Search",
      description: "Search test data",
      parametersSchema: { type: "object", properties: { query: { type: "string" } } },
    },
  ],
};

function buildApp() {
  const app = express();
  app.use(express.json());
  // "cloud_auth" — the exact deployment mode this task's block-lift applies
  // to. verifyLocalAgentJwt's Bearer-token path (middleware/auth.ts) is
  // deployment-mode-agnostic, so the JWT verifies identically to
  // broker-internal-registry.test.ts's "authenticated" mode; the point here
  // is exercising the broker end-to-end WHILE isCloudPluginExecutionBlocked()
  // is asserted false under cloud_auth specifically.
  app.use(actorMiddleware(db, { deploymentMode: "cloud_auth" }));
  app.use("/api", mcpServerRoutes(db));
  return app;
}

async function callTool(companyId: string, jwt: string, name: string, args: Record<string, unknown> = {}) {
  return request(buildApp())
    .post(`/api/companies/${companyId}/mcp`)
    .set("Authorization", `Bearer ${jwt}`)
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

async function listTools(companyId: string, jwt: string) {
  return request(buildApp())
    .post(`/api/companies/${companyId}/mcp`)
    .set("Authorization", `Bearer ${jwt}`)
    .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
}

beforeAll(async () => {
  process.env[JWT_SECRET_ENV] = "plugin-broker-cloud-test-secret";
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-plugin-broker-cloud-"));
    const port = await allocateEmbeddedPgPort();
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
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
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[plugin-broker-cloud] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  if (originalJwtSecret === undefined) delete process.env[JWT_SECRET_ENV];
  else process.env[JWT_SECRET_ENV] = originalJwtSecret;
  setDeploymentMode("local_trusted");
  delete (globalThis as any).__aoaPluginToolDispatcher;
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
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "MCP HTTP broker — cloud plugin tool dispatch (U10)",
  () => {
    it("setup: two companies, a crew agent in each, and a ready plugin registered for c1 only", async () => {
      assertSetupOk();
      setDeploymentMode("cloud_auth");

      c1 = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (id, name, issue_prefix) VALUES (gen_random_uuid(), 'Plugin Broker Co 1', 'PBC1') RETURNING id`),
      );
      c2 = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (id, name, issue_prefix) VALUES (gen_random_uuid(), 'Plugin Broker Co 2', 'PBC2') RETURNING id`),
      );

      agentInC1 = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO agents (id, company_id, name, kind, status, skill_keys, runtime_config)
          VALUES (gen_random_uuid(), ${c1}, 'C1 Crew Agent', 'aoa', 'idle', '[]'::jsonb, '{}'::jsonb)
          RETURNING id`),
      );
      agentInC2 = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO agents (id, company_id, name, kind, status, skill_keys, runtime_config)
          VALUES (gen_random_uuid(), ${c2}, 'C2 Crew Agent', 'aoa', 'idle', '[]'::jsonb, '{}'::jsonb)
          RETURNING id`),
      );

      runInC1 = randomUUID();
      runInC2 = randomUUID();
      jwtC1 = createLocalAgentJwt(agentInC1, c1, "claude_local", runInC1) ?? "";
      jwtC2 = createLocalAgentJwt(agentInC2, c2, "claude_local", runInC2) ?? "";
      expect(jwtC1).not.toBe("");
      expect(jwtC2).not.toBe("");

      // A real, ready, installed plugin row for c1 only — proves the
      // company-scoped tool is backed by genuine DB state, not just an
      // in-memory fixture.
      pluginDbId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO plugins (id, company_id, plugin_key, package_name, version, api_version, categories, manifest_json, status, trust_tier)
          VALUES (
            gen_random_uuid(), ${c1}, ${PLUGIN_KEY}, 'aoa-plugin-acme-test', '1.0.0', 1,
            ${JSON.stringify(["automation"])}::jsonb,
            ${JSON.stringify(MANIFEST)}::jsonb,
            'ready', 'trusted'
          )
          RETURNING id`),
      );
      expect(pluginDbId).toBeTruthy();

      // The REAL production dispatcher + registry (plugin-tool-dispatcher.ts
      // / plugin-tool-registry.ts) — only the deepest leaf (the worker
      // process fork + stdio RPC transport) is stubbed; see the file header
      // for why. `registerPluginTools` is the SDK-documented "manual
      // registration for testing or recovery scenarios" entry point —
      // mirrors what `registerFromDb` does from a real `plugins` row at
      // plugin-enable time.
      // rpcParams is `{ toolName, parameters, runContext }`
      // (plugin-tool-registry.ts `executeTool`) — echoed back so the test
      // can assert the runContext identity that actually crossed the
      // broker -> registry -> worker-manager boundary.
      const workerManager: Pick<PluginWorkerManager, "isRunning" | "call"> = {
        isRunning: () => true,
        call: (async (_pluginId: string, _method: string, rpcParams: unknown) => {
          return { content: JSON.stringify({ echo: rpcParams }) };
        }) as PluginWorkerManager["call"],
      };
      const dispatcher: PluginToolDispatcher = createPluginToolDispatcher({
        workerManager: workerManager as PluginWorkerManager,
        db,
      });
      dispatcher.registerPluginTools(PLUGIN_KEY, MANIFEST, pluginDbId, c1);
      (globalThis as any).__aoaPluginToolDispatcher = dispatcher;

      expect(dispatcher.getTool(TOOL_NAME, c1)).not.toBeNull();
    });

    it("isCloudPluginExecutionBlocked() is false under cloud_auth (host-resident worker model)", () => {
      assertSetupOk();
      expect(isCloudPluginExecutionBlocked()).toBe(false);
    });

    it("tools/list for c1's agent run includes the registered plugin tool", async () => {
      assertSetupOk();
      const res = await listTools(c1, jwtC1);

      expect(res.status).toBe(200);
      const names = (res.body.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain(TOOL_NAME);
    });

    it("tools/list for c2's agent run does NOT include c1's plugin tool", async () => {
      assertSetupOk();
      const res = await listTools(c2, jwtC2);

      expect(res.status).toBe(200);
      const names = (res.body.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).not.toContain(TOOL_NAME);
    });

    it("tools/call for c1's agent run reaches the host-resident worker and returns its result", async () => {
      assertSetupOk();
      const res = await callTool(c1, jwtC1, TOOL_NAME, { query: "auth" });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      // The worker's result crosses back over the broker HTTP response as
      // this text content — the worker itself never entered a VM.
      const outer = JSON.parse(res.body.result.content[0].text);
      const echoed = JSON.parse(outer.content).echo as {
        toolName: string;
        parameters: unknown;
        runContext: { agentId: string; runId: string; companyId: string; projectId: string };
      };
      expect(echoed.toolName).toBe("search");
      expect(echoed.parameters).toEqual({ query: "auth" });
      // companyId/agentId/runId came from the VERIFIED run-JWT (never the
      // request body, which never carried them).
      expect(echoed.runContext).toEqual({
        agentId: agentInC1,
        runId: runInC1,
        companyId: c1,
        projectId: "",
      });
    });

    it("the same tool called with a c2 JWT 404s (company-scoped getTool yields no tool owned by c2)", async () => {
      assertSetupOk();
      const res = await callTool(c2, jwtC2, TOOL_NAME, { query: "auth" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(-32004);
    });

    it("a board (non-agent) actor cannot call the plugin tool over the broker", async () => {
      assertSetupOk();
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = {
          type: "board",
          source: "local_implicit",
          userId: "local",
          isInstanceAdmin: true,
          companyIds: [c1],
        };
        next();
      });
      app.use("/api", mcpServerRoutes(db));

      const res = await request(app)
        .post(`/api/companies/${c1}/mcp`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: TOOL_NAME, arguments: {} } });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(-32003);
    });
  },
);
