/**
 * U2c — the HTTP MCP broker (`server/src/mcp/server.ts`) serves the FULL
 * internal-agent tool registry for `agent`-source actors over `/companies/:cid/mcp`,
 * authenticated by a run-JWT (U3's `createLocalAgentJwt`) as `Authorization: Bearer`.
 * This is the wire the CLI's `aoa` MCP server points at from inside an E2B sandbox —
 * the run's ONLY path to the control-plane DB.
 *
 * Proven here against a REAL Postgres (embedded-postgres + the committed migration
 * chain), through the REAL HTTP router (`mcpServerRoutes(db)`) mounted behind the
 * REAL `actorMiddleware` (so the run-JWT is verified for real, not stubbed):
 *
 *   1. `tools/list` returns the agent's allowlist-filtered internal tools
 *      (query_memory, write_memory, create_task, use_skill, ask_human) and
 *      EXCLUDES a tool deliberately left off the allowlist (proving real
 *      filtering, not "show everything").
 *   2. `tools/call query_memory` executes through the SAME service layer a
 *      local (non-sandboxed) crew run would use, returns as a `jsonRpcResult`,
 *      and writes a `memory_retrievals` audit row attributable to this
 *      agent+run (heartbeat_runs seeded so the FK on memory_retrievals.run_id
 *      resolves — recordMemoryRetrievals is best-effort and silently drops
 *      the row on an FK violation, so this is load-bearing, not decorative).
 *   3. Unknown-tool invariant: `tools/call "__does_not_exist__"` returns a
 *      JSON-RPC top-level `error` (code -32601, message names the tool) —
 *      the ONLY case that is a transport-level error.
 *   4. Gating parity (in-band `isError`, NOT `-32601`):
 *      - `use_skill` for a tool NOT in the agent's runtimeConfig.aoa.toolAllowlist
 *        (the COARSE D2 allowlist gate in authorize-tool.ts, checked before
 *        tool.execute runs) returns `isError:true` with `NOT_IN_ALLOWLIST`.
 *      - `use_skill` for a key NOT in the agent's `skillKeys` column (the FINE
 *        per-skill gate INSIDE use_skill's own execute(), skill-tools.ts) —
 *        with use_skill itself ALLOWLISTED — returns `isError:true` with
 *        `NOT_ENABLED`. (Real-shape note: the plan's prose calls this
 *        "NOT_IN_ALLOWLIST"; the actual code produces `NOT_ENABLED` for the
 *        per-skill-key denial — `NOT_IN_ALLOWLIST` is the COARSE gate's error
 *        code. Both are exercised here so the invariant — denial as in-band
 *        isError, never -32601 — is proven for both real gates.)
 *      - `ask_human` when the run-JWT's `run_id` is not attached to any task
 *        (no `internal_agent_runs` row backing it — the real "no active run"
 *        shape for an `agentKind:"aoa"` broker actor, since
 *        askHumanForActiveRun resolves via `internal_agent_runs` for kind
 *        "aoa", never `heartbeat_runs`) returns `isError:true` with
 *        `ASK_HUMAN_FAILED` — an in-band refusal, not a thrown/unhandled error.
 *      Both come back as `result` (isError content), never JSON-RPC `error`.
 *   5. Regression guard (U2c follow-up): a `source==="agent"` actor with NO
 *      runId — a standalone agent-API-key caller (auth.ts `source:"agent_key"`,
 *      populated only when the caller sends `x-aoa-run-id`, unlike the run-JWT
 *      path's mandatory `run_id` claim) — is NOT routed into the run-scoped
 *      broker. `tools/list` still returns the outbound `TOOL_DEFINITIONS`
 *      (not a 403 from `resolveBrokerToolContext`'s missing-runId guard), and
 *      `tools/call` for an outbound tool (`memory.get`) still dispatches.
 *
 * Skipped on Windows (embedded-postgres can't start on this platform's CI
 * runner — Issue #114); Linux CI `push` is the authoritative gate for this
 * file, mirroring every other `*.integration.test.ts` in this suite (e.g.
 * mcp-memory-read-rbac.integration.test.ts / memory-tools-agent-rbac.integration.test.ts,
 * whose embedded-pg harness this one is modeled on).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { actorMiddleware } from "../middleware/auth.js";
import { mcpServerRoutes } from "../mcp/server.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { ORG_HEARTBEAT_TOOL_ALLOWLIST } from "../services/heartbeat-mcp.js";

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

let co = "";
let agentId = "";
let runId = "";
let jwt = "";

const JWT_SECRET_ENV = "AOA_AGENT_JWT_SECRET";
const originalJwtSecret = process.env[JWT_SECRET_ENV];

function buildApp() {
  const app = express();
  app.use(express.json());
  // authenticated (not local_trusted): forces the JWT path — no loopback
  // board escape hatch, no x-aoa-run-id implicit fallback. This is the
  // deployment mode an E2B-sandboxed run authenticates against for real.
  app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
  app.use("/api", mcpServerRoutes(db));
  return app;
}

async function callTool(app: express.Express, name: string, args: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/companies/${co}/mcp`)
    .set("Authorization", `Bearer ${jwt}`)
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

beforeAll(async () => {
  process.env[JWT_SECRET_ENV] = "broker-internal-registry-test-secret";
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-broker-registry-"));
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
    console.error("[broker-internal-registry] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  if (originalJwtSecret === undefined) delete process.env[JWT_SECRET_ENV];
  else process.env[JWT_SECRET_ENV] = originalJwtSecret;
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

describe.skipIf(process.platform === "win32")(
  "MCP HTTP broker — internal registry dispatch for agent actors (U2c)",
  () => {
    it("setup: company, a crew (kind='aoa') agent with a toolAllowlist + one enabled skill, a heartbeat_runs row backing the run-JWT's run_id (memory_retrievals FK), a company-wide memory item, and a mismatched skill NOT in skillKeys", async () => {
      assertSetupOk();

      co = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (organization_id, id, name, issue_prefix) VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Broker Registry Co', 'BRK') RETURNING id`),
      );

      agentId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO agents (id, company_id, name, kind, status, skill_keys, runtime_config)
          VALUES (
            gen_random_uuid(), ${co}, 'Broker Crew Agent', 'aoa', 'idle',
            ${JSON.stringify(["skill:enabled-one"])}::jsonb,
            ${JSON.stringify({
              aoa: {
                toolAllowlist: [
                  "query_memory",
                  "write_memory",
                  "create_task",
                  "use_skill",
                  "ask_human",
                ],
              },
            })}::jsonb
          )
          RETURNING id`),
      );

      runId = randomUUID();
      // Backs the memory_retrievals.run_id FK (→ heartbeat_runs.id) so
      // recordMemoryRetrievals' insert doesn't silently drop on an FK
      // violation. Deliberately NOT an internal_agent_runs row — that's what
      // makes the ask_human "no active run" scenario below genuine: an
      // agentKind:'aoa' ask_human call resolves its source task via
      // internal_agent_runs, not heartbeat_runs (ask-founder-tool.ts
      // sourceForRun), so this row existing here does not give ask_human
      // anything to find.
      await db.execute(sql`
        INSERT INTO heartbeat_runs (id, company_id, agent_id)
        VALUES (${runId}, ${co}, ${agentId})`);

      jwt = createLocalAgentJwt(agentId, co, "claude_local", runId) ?? "";
      expect(jwt).not.toBe("");

      // Company-wide (unscoped, non-private) approved memory — visible to
      // every agent regardless of department per Decision #119 / the internal
      // registry's own filterCommanderMemoryItems policy.
      await db.execute(sql`
        INSERT INTO memory_items
          (id, company_id, title, content, category, source, status, created_by, layer, visibility)
        VALUES
          (gen_random_uuid(), ${co}, 'Broker retrieval marker', 'broker retrieval marker content',
           'reference', 'founder', 'approved', 'integration-test', 'domain', 'company')`);

      // A skill that exists for the company but is NOT in this agent's
      // skillKeys (only 'skill:enabled-one' is) — the NOT_ENABLED fine-gate case.
      await db.execute(sql`
        INSERT INTO company_skills (id, company_id, key, slug, name, markdown)
        VALUES (gen_random_uuid(), ${co}, 'skill:not-enabled', 'not-enabled', 'Not Enabled Skill', '# content')`);
      // The enabled one too, so a positive-control call could resolve it (not
      // exercised here — the coarse allowlist gate below denies use_skill
      // categorically before this skill would ever be reached; kept for
      // fixture completeness / future positive-control coverage).
      await db.execute(sql`
        INSERT INTO company_skills (id, company_id, key, slug, name, markdown)
        VALUES (gen_random_uuid(), ${co}, 'skill:enabled-one', 'enabled-one', 'Enabled Skill', '# content')`);

      expect(co && agentId && runId).toBeTruthy();
    });

    it("tools/list returns the agent's allowlist-filtered internal tools and excludes a non-allowlisted one", async () => {
      assertSetupOk();
      const app = buildApp();
      const res = await request(app)
        .post(`/api/companies/${co}/mcp`)
        .set("Authorization", `Bearer ${jwt}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

      expect(res.status).toBe(200);
      const names = res.body.result.tools.map((t: { name: string }) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(["query_memory", "write_memory", "create_task", "use_skill", "ask_human"]),
      );
      // propose_crew_work is NOT in this agent's toolAllowlist — proves the
      // list is genuinely filtered, not the full registry unconditionally.
      expect(names).not.toContain("propose_crew_work");
    });

    it("tools/call query_memory returns a jsonRpcResult and writes a memory_retrievals audit row for this agent+run", async () => {
      assertSetupOk();
      const app = buildApp();
      const res = await callTool(app, "query_memory", { query: "broker retrieval marker" });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.success).toBe(true);
      const titles = (payload.data as Array<{ title: string }>).map((item) => item.title);
      expect(titles).toContain("Broker retrieval marker");

      const auditRows = await db.execute<{ agent_id: string; run_id: string; triggered_by: string }>(sql`
        SELECT agent_id, run_id, triggered_by FROM memory_retrievals
        WHERE company_id = ${co} AND agent_id = ${agentId} AND run_id = ${runId}`);
      const rows = Array.isArray(auditRows) ? auditRows : (auditRows as unknown as { rows: unknown[] }).rows;
      expect((rows as unknown[]).length).toBeGreaterThan(0);
    });

    it("unknown-tool invariant: tools/call for a name unknown in both registries returns a JSON-RPC top-level error (-32601)", async () => {
      assertSetupOk();
      const app = buildApp();
      const res = await callTool(app, "__does_not_exist__");

      expect(res.body.result).toBeUndefined();
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(-32601);
      expect(res.body.error.message).toMatch(/__does_not_exist__/);
    });

    it("gating parity — use_skill NOT in the coarse toolAllowlist returns isError:true (NOT_IN_ALLOWLIST) as a jsonRpcResult, never -32601", async () => {
      assertSetupOk();
      // A sibling agent whose toolAllowlist omits use_skill entirely.
      const noSkillAgentId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO agents (id, company_id, name, kind, status, skill_keys, runtime_config)
          VALUES (
            gen_random_uuid(), ${co}, 'No-Skill-Tool Agent', 'aoa', 'idle',
            '[]'::jsonb,
            ${JSON.stringify({ aoa: { toolAllowlist: ["query_memory"] } })}::jsonb
          )
          RETURNING id`),
      );
      const noSkillRunId = randomUUID();
      await db.execute(sql`
        INSERT INTO heartbeat_runs (id, company_id, agent_id) VALUES (${noSkillRunId}, ${co}, ${noSkillAgentId})`);
      const noSkillJwt = createLocalAgentJwt(noSkillAgentId, co, "claude_local", noSkillRunId) ?? "";

      const app = buildApp();
      const res = await request(app)
        .post(`/api/companies/${co}/mcp`)
        .set("Authorization", `Bearer ${noSkillJwt}`)
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "use_skill", arguments: { key: "skill:enabled-one" } },
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.result).toBeDefined();
      expect(res.body.result.isError).toBe(true);
      const text = res.body.result.content[0].text as string;
      expect(text).toMatch(/NOT_IN_ALLOWLIST/);
    });

    it("gating parity — use_skill for a key NOT in this agent's skillKeys returns isError:true (NOT_ENABLED) as a jsonRpcResult, never -32601", async () => {
      assertSetupOk();
      const app = buildApp();
      const res = await callTool(app, "use_skill", { key: "skill:not-enabled" });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.result).toBeDefined();
      expect(res.body.result.isError).toBe(true);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.error).toBe("NOT_ENABLED");
    });

    it("gating parity — ask_human with no active run (run_id not attached to any internal_agent_runs task) returns isError:true (ASK_HUMAN_FAILED) as a jsonRpcResult, never -32601", async () => {
      assertSetupOk();
      const app = buildApp();
      const res = await callTool(app, "ask_human", { question: "Which vendor should we pick?" });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.result).toBeDefined();
      expect(res.body.result.isError).toBe(true);
      const payload = JSON.parse(res.body.result.content[0].text);
      expect(payload.success).toBe(false);
      expect(payload.error).toBe("ASK_HUMAN_FAILED");
    });

    it("U2c follow-up regression guard: an agent-API-key actor with NO runId (source:'agent_key', no x-aoa-run-id header) is NOT run-scoped into the broker — tools/list still returns the outbound TOOL_DEFINITIONS (not a 403), and tools/call for an outbound tool still works", async () => {
      assertSetupOk();

      // A standalone agent-API-key identity (auth.ts source:"agent_key") —
      // distinct from the run-JWT (source:"agent_jwt") path every other test
      // in this file uses. This is the ONLY way to get a real, middleware-
      // verified req.actor with type:"agent" and runId undefined: the JWT
      // claims always carry a mandatory run_id, but an agent API key's runId
      // is populated ONLY from an optional x-aoa-run-id header — omitted here
      // on purpose. Before U2c this caller's tools/list returned the outbound
      // TOOL_DEFINITIONS; the (now-fixed) regression made it 403 by
      // unconditionally routing every source:"agent" actor into the run-scoped
      // resolveAgentBrokerContext(), which throws when runId is missing.
      const keyAgentId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO agents (id, company_id, name, kind, status, skill_keys, runtime_config)
          VALUES (gen_random_uuid(), ${co}, 'Runless Key Agent', 'org', 'idle', '[]'::jsonb, '{}'::jsonb)
          RETURNING id`),
      );
      const rawKey = `test-agent-key-${randomUUID()}`;
      const keyHash = createHash("sha256").update(rawKey).digest("hex");
      await db.execute(sql`
        INSERT INTO agent_api_keys (id, agent_id, company_id, name, key_hash)
        VALUES (gen_random_uuid(), ${keyAgentId}, ${co}, 'test key', ${keyHash})`);

      const app = buildApp();

      // tools/list: no x-aoa-run-id header sent -> req.actor.runId is
      // undefined -> the `protocolActor.source === "agent" && protocolActor.runId`
      // guard is false -> falls through to the outbound TOOL_DEFINITIONS list.
      const listRes = await request(app)
        .post(`/api/companies/${co}/mcp`)
        .set("Authorization", `Bearer ${rawKey}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

      expect(listRes.status).toBe(200);
      expect(listRes.body.error).toBeUndefined();
      const listNames = listRes.body.result.tools.map((t: { name: string }) => t.name);
      // Outbound registry tool, present (proves the fallback list, not a 403).
      expect(listNames).toContain("memory.get");
      // Internal-registry-only tool name, must NOT appear — this is the
      // outbound TOOL_DEFINITIONS list, not the broker's filtered internal list.
      expect(listNames).not.toContain("query_memory");

      // tools/call: an outbound tool must still work for this runless actor —
      // proves the fall-through preserves pre-existing agent-key behavior on
      // the call path too (this side already worked pre-fix via the additive
      // fallthrough; asserted here for completeness alongside the list fix).
      const callRes = await request(app)
        .post(`/api/companies/${co}/mcp`)
        .set("Authorization", `Bearer ${rawKey}`)
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "memory.get", arguments: { id: randomUUID() } },
        });

      // Reaches the real outbound memory.get handler (read-tools.ts
      // handleMemoryGet -> notFoundResult -> err(404, -32004, ...)) for a
      // lookup miss on a random id — proves dispatch actually happened, not
      // a -32601 "unknown tool" / 403 "missing run identity" short-circuit.
      expect(callRes.status).toBe(404);
      expect(callRes.body.error?.code).toBe(-32004);
      expect(callRes.body.error?.message).toBe("Memory item not found");
    });

    it("Wave 1 review, FIX A: an org run-JWT's tools/list returns the org 8-tool set (NOT empty), and tools/call for one of them (query_memory) succeeds through the broker", async () => {
      assertSetupOk();

      const orgAgentId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO agents (id, company_id, name, kind, status, runtime_config)
          VALUES (gen_random_uuid(), ${co}, 'Broker Org Agent', 'org', 'idle', '{}'::jsonb)
          RETURNING id`),
      );
      const orgRunId = randomUUID();
      await db.execute(sql`
        INSERT INTO heartbeat_runs (id, company_id, agent_id)
        VALUES (${orgRunId}, ${co}, ${orgAgentId})`);
      const orgJwt = createLocalAgentJwt(orgAgentId, co, "claude_local", orgRunId) ?? "";
      expect(orgJwt).not.toBe("");

      const app = buildApp();

      const listRes = await request(app)
        .post(`/api/companies/${co}/mcp`)
        .set("Authorization", `Bearer ${orgJwt}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

      expect(listRes.status).toBe(200);
      expect(listRes.body.error).toBeUndefined();
      const orgNames = listRes.body.result.tools.map((t: { name: string }) => t.name);
      // Pre-fix this was empty (agentKind:'org' fell through the crew-only
      // toolAllowlist derivation, which reads agent.runtimeConfig.aoa —
      // absent on an org agent — producing toolAllowlist:[] and default-deny).
      expect(orgNames.length).toBeGreaterThan(0);
      expect(orgNames).toEqual(expect.arrayContaining([...ORG_HEARTBEAT_TOOL_ALLOWLIST]));
      // Crew-only tools must NOT leak into the org set.
      expect(orgNames).not.toContain("create_task");
      expect(orgNames).not.toContain("write_memory");

      const callRes = await request(app)
        .post(`/api/companies/${co}/mcp`)
        .set("Authorization", `Bearer ${orgJwt}`)
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "query_memory", arguments: { query: "org broker probe" } },
        });

      expect(callRes.status).toBe(200);
      expect(callRes.body.error).toBeUndefined();
      expect(callRes.body.result?.isError).not.toBe(true);
      const payload = JSON.parse(callRes.body.result.content[0].text);
      expect(payload.success).toBe(true);
    });

    it("Wave 1 review, FIX A: an unsupported agent kind ('platform') is refused with a 403 before reaching tool dispatch", async () => {
      assertSetupOk();

      const platformAgentId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO agents (id, company_id, name, kind, status, runtime_config)
          VALUES (gen_random_uuid(), ${co}, 'Broker Platform Agent', 'platform', 'idle', '{}'::jsonb)
          RETURNING id`),
      );
      const platformRunId = randomUUID();
      await db.execute(sql`
        INSERT INTO heartbeat_runs (id, company_id, agent_id)
        VALUES (${platformRunId}, ${co}, ${platformAgentId})`);
      const platformJwt = createLocalAgentJwt(platformAgentId, co, "claude_local", platformRunId) ?? "";
      expect(platformJwt).not.toBe("");

      const app = buildApp();
      const res = await request(app)
        .post(`/api/companies/${co}/mcp`)
        .set("Authorization", `Bearer ${platformJwt}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

      expect(res.status).toBe(403);
    });

    it("cross-tenant guard: a run-JWT whose company_id does not match the URL company is rejected before reaching the broker", async () => {
      assertSetupOk();
      const otherCo = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (organization_id, id, name, issue_prefix) VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Other Co', 'OTH') RETURNING id`),
      );
      const app = buildApp();
      const res = await request(app)
        .post(`/api/companies/${otherCo}/mcp`)
        .set("Authorization", `Bearer ${jwt}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

      expect(res.status).not.toBe(200);
    });
  },
);
