/**
 * FND-006 (Decision #103 cloud-enforcement amendment) — cloud integration proof
 * that a plugin tool call from an agent run-JWT is DENIED on `cloud_auth`: no
 * host-process plugin worker may start, so the broker cannot dispatch to one,
 * with cross-company isolation still held.
 *
 * Superseded intent: an earlier Wave-5 iteration (U10) proved the OPPOSITE — a
 * "host-resident worker" running in cloud — and asserted
 * `isCloudPluginExecutionBlocked()` was `false`. Decision #103's amendment
 * reverses that: `cloud_auth` executes no host-process plugin worker at any
 * sink or trust tier. This file now proves the denial through the same real
 * harness.
 *
 * Proven here against a REAL Postgres (embedded-postgres + the committed
 * migration chain), through the REAL HTTP router (`mcpServerRoutes(db)`)
 * mounted behind the REAL `actorMiddleware` in `deploymentMode:"cloud_auth"`
 * — the run-JWT is verified for real, and:
 *   - `isCloudPluginExecutionBlocked()` (and every typed sink) is asserted
 *     `true` under `cloud_auth`;
 *   - a plugin `tools/call` is DENIED before dispatch: FND-008 adds the typed
 *     cloud denial at the top of `dispatchPluginToolCall`, so the broker fails
 *     closed with `forbidden` (HTTP 403 / JSON-RPC -32003, carrying the stable
 *     Decision #103 block message) BEFORE resolving the dispatcher or reaching a
 *     worker — no plugin worker may start on cloud_auth anyway (the real worker
 *     manager's denial is proven in `cloud-plugin-process-composition.test.ts` /
 *     `plugin-worker-manager.test.ts`);
 *   - cross-company isolation and the board-actor denial still hold.
 *
 * The worker-manager leaf is imported TYPE-ONLY here (a value import tips this
 * file's graph into the drizzle-orm require(esm) cycle — E0-F005), so the
 * not-running state is stubbed to mirror the proven cloud reality.
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
// NOTE: `plugin-worker-manager.js` is imported TYPE-ONLY. Adding a value import
// of it to this file's already-heavy graph (plugin-tool-dispatcher + mcp/server
// + @armyofagents/db) tips vitest into the drizzle-orm require(esm) cycle
// (finding E0-F005), which fails collection on every lane. The REAL worker
// manager's cloud-denial (startWorker/fork fail closed) is proven separately in
// `cloud-plugin-process-composition.test.ts` and `plugin-worker-manager.test.ts`,
// which import it in a graph that stays clear of the cycle.
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PaperclipPluginManifestV1 } from "@armyofagents/shared";

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

const MANIFEST: PaperclipPluginManifestV1 = {
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
  delete (globalThis as any).__paperclipPluginToolDispatcher;
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
          INSERT INTO companies (organization_id, id, name, issue_prefix) VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Plugin Broker Co 1', 'PBC1') RETURNING id`),
      );
      c2 = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (organization_id, id, name, issue_prefix) VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Plugin Broker Co 2', 'PBC2') RETURNING id`),
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

      // The REAL production dispatcher + registry (plugin-tool-dispatcher.ts /
      // plugin-tool-registry.ts). The worker manager leaf is stubbed as NOT
      // RUNNING — the faithful cloud_auth state: no plugin worker may start
      // (proven in cloud-plugin-process-composition.test.ts /
      // plugin-worker-manager.test.ts via the real manager), so `isRunning` is
      // false and the registry cannot dispatch. `registerPluginTools` registers
      // tool METADATA only (it starts no worker), mirroring `registerFromDb` at
      // plugin-enable time. `call` is present but unreachable (the not-running
      // check fires first) — it would fail the test loudly if ever invoked.
      const workerManager: Pick<PluginWorkerManager, "isRunning" | "call"> = {
        isRunning: () => false,
        call: (async () => {
          throw new Error(
            "worker.call must never be reached on cloud_auth (no worker runs)",
          );
        }) as PluginWorkerManager["call"],
      };
      const dispatcher: PluginToolDispatcher = createPluginToolDispatcher({
        workerManager: workerManager as PluginWorkerManager,
        db,
      });
      dispatcher.registerPluginTools(PLUGIN_KEY, MANIFEST, pluginDbId, c1);
      (globalThis as any).__paperclipPluginToolDispatcher = dispatcher;

      expect(dispatcher.getTool(TOOL_NAME, c1)).not.toBeNull();
    });

    it("isCloudPluginExecutionBlocked() is true under cloud_auth for every sink (FND-006 / Decision #103)", () => {
      assertSetupOk();
      expect(isCloudPluginExecutionBlocked()).toBe(true);
      for (const sink of [
        "worker-manager",
        "worker-fork",
        "lifecycle",
        "loader",
        "loader-import",
        "ui-static",
      ] as const) {
        expect(isCloudPluginExecutionBlocked(sink)).toBe(true);
      }
    });

    it("tools/list for c1's agent run includes the registered plugin tool (registration is metadata)", async () => {
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

    it("tools/call for c1's agent run is DENIED before dispatch on cloud_auth (FND-008) — the broker never reaches a worker", async () => {
      assertSetupOk();
      const res = await callTool(c1, jwtC1, TOOL_NAME, { query: "auth" });

      // FND-008 (Decision #103 CP-003): `dispatchPluginToolCall` fails closed
      // with the typed cloud denial BEFORE resolving the dispatcher or reaching
      // any worker — the broker maps `forbidden` to HTTP 403 / JSON-RPC -32003
      // carrying the stable block message. (Before FND-008 the call fell through
      // to the registry, which threw "worker not running" as -32000; the denial
      // now fires strictly earlier, so no worker/registry path is exercised.)
      expect(res.status).toBe(403);
      expect(res.body.result).toBeUndefined();
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(-32003);
      expect(String(res.body.error.message)).toMatch(/blocked on AoA Cloud/i);
    });

    it("the same tool called with a c2 JWT is cloud-blocked (403) before the company-scoped getTool 404 — tenant isolation preserved", async () => {
      assertSetupOk();
      const res = await callTool(c2, jwtC2, TOOL_NAME, { query: "auth" });

      // FND-008: cloud plugin tool dispatch is blocked (403 / -32003) for every
      // company BEFORE the company-scoped getTool lookup that would 404. This is
      // strictly safer than the prior 404 — c2 is denied all plugin dispatch and
      // the response discloses nothing about whether c1 owns the tool.
      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(-32003);
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
