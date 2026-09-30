/**
 * DE-16, `audit` clause — DISPATCH CONJUNCT, the MCP-agent i-GAP. An agent's
 * plugin tool-call refused by the `cloud_auth` execution block is durable and
 * attributable.
 *
 * ★ THE GAP THIS RETIRES. DE-16's audit clause is a conjunction — "blocked
 * plugin routes, dispatch, and reconciliations are audited." The route half
 * (`recordCloudPluginDenial`) and the reconciliation half
 * (`recordCloudPluginReconcileToBlocked`) were delivered; the AGENT dispatch
 * path was not. `dispatchPluginToolCall` (`server/src/mcp/tools/plugin-broker-tools.ts`)
 * returned `forbidden` on the cloud block with NO durable row — and on
 * `cloud_auth` EVERY agent plugin tool-call is blocked, so a burst left the same
 * trace as none. This file proves the third conjunct's row is now written.
 *
 * ★ NOT A READ-BACK. It drives the REAL `dispatchPluginToolCall` — the exact
 * function `server/src/mcp/server.ts` tools/call invokes — over a real embedded
 * Postgres with the committed migration chain, with `cloud_auth` forced so the
 * block genuinely fires, then asserts the durable row the function itself left.
 *
 * ★ ATTRIBUTION IS THE ASSERTION:
 *   WHO      -> actor_type "agent" / actor_id the verified agentId
 *   TENANT   -> company_id the broker-validated FK-valid company, org null
 *   RESOURCE -> entity_type "plugin_tool" / entity_id the namespaced tool name
 *   WHY      -> details.reason cloud_plugin_execution_blocked, crossing DE-16
 *
 * ★ THE ARMS THAT MUST BITE: drop-the-write reds THE RECORD; a non-agent block
 * writing a row reds SCOPE; the gate-off reachability control reds by vacuity if
 * the block never fired.
 *
 * Skipped on Windows CI by default (Issue #114); `AOA_RUN_WIN_INTEGRATION=1` to
 * run locally. Linux CI `push` is authoritative. Harness modeled on
 * `de-16-reconciliation-audit.integration.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { isCloudPluginExecutionBlocked } from "../services/cloud-plugin-execution.js";
import { dispatchPluginToolCall } from "../mcp/tools/plugin-broker-tools.js";
import { SECURITY_DENIAL_ACTION_PREFIX } from "../services/activity-namespace.js";
import { CLOUD_PLUGIN_DISPATCH_DENIAL_SURFACE } from "../services/cloud-plugin-dispatch-denial-audit.js";

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

interface AuditRow {
  company_id: string | null;
  organization_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  agent_id: string | null;
  run_id: string | null;
  details: Record<string, unknown> | null;
}

const AGENT_ID = "a9000000-0000-4000-8000-000000000001";
const RUN_ID = "a9000000-0000-4000-8000-000000000002";
const TOOL_NAME = "acme.linear:search-issues";
const DISPATCH_ACTION = `${SECURITY_DENIAL_ACTION_PREFIX}${CLOUD_PLUGIN_DISPATCH_DENIAL_SURFACE}`;

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as { id: string })?.id;
  return (result as { rows?: { id: string }[] }).rows?.[0]?.id;
}

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db | undefined;
let setupError: unknown = null;
let setupFailed = false;
let companyId = "";

function assertSetupOk(): void {
  if (!setupFailed && db !== undefined) return;
  throw new Error(
    `embedded-postgres setup failed: ${setupError instanceof Error ? setupError.message : String(setupError)}`,
  );
}
function ctxDb(): Db {
  assertSetupOk();
  return db as Db;
}

async function dispatchRows(): Promise<AuditRow[]> {
  const res = await ctxDb().execute<AuditRow>(sql`
    SELECT company_id, organization_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, run_id, details
    FROM activity_log
    WHERE action = ${DISPATCH_ACTION}
    ORDER BY created_at`);
  return (Array.isArray(res) ? res : (res as { rows?: AuditRow[] }).rows) ?? [];
}

async function clearRows(): Promise<void> {
  await ctxDb().execute(sql`DELETE FROM activity_log WHERE action LIKE ${`${SECURITY_DENIAL_ACTION_PREFIX}%`}`);
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-de16d-"));
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
    // Default Organization (…0001) is seeded by migration 0188.
    companyId = firstId(
      await db.execute<{ id: string }>(sql`
        INSERT INTO companies (organization_id, id, name, issue_prefix)
        VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'DE-16 Dispatch Co', 'D16D')
        RETURNING id`),
    );
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[de-16-dispatch-denial-audit] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  setDeploymentMode("local_trusted");
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
  "DE-16 (dispatch conjunct) — an agent plugin dispatch cloud-block is durable and attributable",
  () => {
    it("setup: cloud_auth forced, the gate is ON, and no dispatch-denial row exists yet", async () => {
      assertSetupOk();
      expect(companyId).toBeTruthy();
      setDeploymentMode("cloud_auth");
      // REACHABILITY CONTROL: without the gate, dispatch would proceed past the
      // block and every arm below would pass by vacuity.
      expect(isCloudPluginExecutionBlocked()).toBe(true);
      await clearRows();
      expect(await dispatchRows()).toHaveLength(0);
    });

    it("THE RECORD: a blocked agent dispatch writes one attributable security.denied.cloud_plugin_dispatch row", async () => {
      setDeploymentMode("cloud_auth");
      await clearRows();
      const outcome = await dispatchPluginToolCall({
        db: ctxDb(),
        companyId,
        actorSource: "agent",
        agentId: AGENT_ID,
        runId: RUN_ID,
        name: TOOL_NAME,
        args: {},
      });
      expect(outcome.kind).toBe("forbidden");
      const rows = await dispatchRows();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.action).toBe(DISPATCH_ACTION);
      // WHO — the verified agent.
      expect(row.actor_type).toBe("agent");
      expect(row.actor_id).toBe(AGENT_ID);
      // TENANT — the FK-valid company, org null.
      expect(row.company_id).toBe(companyId);
      expect(row.organization_id).toBeNull();
      // RESOURCE — the refused plugin tool.
      expect(row.entity_type).toBe("plugin_tool");
      expect(row.entity_id).toBe(TOOL_NAME);
      // WHY.
      expect(row.details?.reason).toBe("cloud_plugin_execution_blocked");
      expect(row.details?.crossing).toBe("DE-16");
      expect(row.details?.runId).toBe(RUN_ID);
      // The FK'd columns stay null (actor identity rides actor_id/details).
      expect(row.agent_id).toBeNull();
      expect(row.run_id).toBeNull();
    });

    it("SCOPE: a non-agent blocked dispatch writes NO row (this service's own actor-gate refusal)", async () => {
      setDeploymentMode("cloud_auth");
      await clearRows();
      const board = await dispatchPluginToolCall({
        db: ctxDb(),
        companyId,
        actorSource: "board",
        agentId: null,
        runId: null,
        name: TOOL_NAME,
        args: {},
      });
      expect(board.kind).toBe("forbidden");
      // And an agent WITHOUT a live run is the "requires an active agent run"
      // refusal — also this service's own, also unrecorded.
      const noRun = await dispatchPluginToolCall({
        db: ctxDb(),
        companyId,
        actorSource: "agent",
        agentId: AGENT_ID,
        runId: null,
        name: TOOL_NAME,
        args: {},
      });
      expect(noRun.kind).toBe("forbidden");
      expect(await dispatchRows()).toHaveLength(0);
    });
  },
);
