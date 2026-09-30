/**
 * LIVE end-to-end integration proof for Plan 2 (the RUNTIME half of the MCP
 * connectors feature: approval activation + crew/Commander delivery). Boots
 * embedded-postgres, applies ALL migrations, then drives the REAL runtime code
 * against a real DB — NOT a hand-assembled argv/config (amendment A33: asserting
 * on your own construction misses real bugs). Concretely it exercises:
 *
 *   1. Approval → activation capstone (authenticated-mode SOLE activation path):
 *        real approvalService(db).approve(...) flips a pending_approval connector
 *        to `active` and makes it visible to loadEnabledConnectorRows(); a second
 *        connector's real .reject(...) flips it to `disabled` and hides it.
 *
 *   2. Crew delivery via the REAL builder: real resolveAgentConnectors(db,
 *        {companyId, agentId}) (loader → secret-resolve → buildConnectorSpecs)
 *        for a crew (kind='aoa') agent with a real opt-in row, then the REAL
 *        runner config-file seam (buildMcpConfig + writeFile — the exact two
 *        lines runAoaAgent runs) — asserting the written --mcp-config file holds
 *        the `${AOA_MCP_*_TOKEN}` placeholder and NOT the plaintext secret, and
 *        that connectorEnv carries the real token.
 *
 *   3. Commander delivery via the REAL builder: real resolveAgentConnectors(db,
 *        {companyId, agentId:null}) returns ALL active company connectors (D3)
 *        and EXCLUDES a pending_approval one.
 *
 * Passes `initdbFlags` for locale/encoding (per the repo's Windows embedded-PG
 * note) so it CAN run locally on Windows. For CI it is
 * `describe.skipIf(process.platform === "win32")` (embedded-PG can't boot on the
 * Windows CI runner — Issue #114); Linux CI is the authoritative gate. If setup
 * fails the suite surfaces the error rather than silently passing.
 */
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { mcpConnectorService } from "../services/mcp-connectors-crud.js";
import { loadEnabledConnectorRows, resolveAgentConnectors } from "../services/mcp-connectors-loader.js";
import { approvalService } from "../services/approvals.js";
import { secretService } from "../services/secrets.js";
import { buildMcpConfig } from "../services/internal-agent/cli-mode.js";

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

const PORT = 58900 + Math.floor(Math.random() * 700);
const DECIDER_USER = "00000000-0000-0000-0000-0000000000aa";

beforeAll(async () => {
  try {
    // Deterministic 32-byte master key so the local_encrypted provider can
    // create + resolve secrets without touching a key file.
    process.env.AOA_SECRETS_MASTER_KEY = "b".repeat(64); // 64 hex chars = 32 bytes
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mcp-p2-e2e-"));
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
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[mcp-p2-e2e] embedded-postgres setup failed:", err);
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

// Fresh company per test so a connector created in one test can never bleed into
// another's companyId-scoped loader query. issue_prefix is UNIQUE (default
// "PAP"), so each company needs its own — three companies would collide on the
// default otherwise.
let companySeq = 0;
async function newCompany(name: string): Promise<string> {
  const prefix = `P2${(companySeq++).toString().padStart(1, "0")}`;
  return firstId(
    db.execute(
      sql`INSERT INTO companies (name, issue_prefix) VALUES (${name}, ${prefix}) RETURNING id`,
    ),
  );
}

// Skipped on Windows CI (embedded-postgres can't start on the runneradmin
// runner — Issue #114); Linux CI is the authoritative gate. Runs locally on
// Windows via the initdbFlags above (verified by temporarily removing the skip).
describe.skipIf(process.platform === "win32")(
  "MCP connectors Plan 2 — live approval activation + crew/Commander delivery (real DB + real builders)",
  () => {
    it("1) real approvalService.approve activates a pending connector; reject disables it (loader visibility flips)", async () => {
      if (setupError) throw setupError;
      const companyId = await newCompany("P2 Approval Co");
      const secrets = secretService(db);
      const approvals = approvalService(db);

      // ── A) APPROVE path ──────────────────────────────────────────────────
      await secrets.create(companyId, {
        name: "mcp:notion",
        provider: "local_encrypted",
        managedMode: "aoa_managed",
        value: "notion-token-approve-xyz",
      });
      const connector = await mcpConnectorService(db).create(companyId, {
        serverName: "notion",
        displayName: "Notion Docs",
        transport: "http",
        url: "https://mcp.notion.example/v1",
        headerTemplate: { Authorization: "Bearer ${TOKEN}" },
        secretRef: "mcp:notion",
        status: "pending_approval",
      });

      // While pending, Commander's loader (agentId:null = all-active) must NOT see it.
      const beforeApprove = await loadEnabledConnectorRows(db, { companyId, agentId: null });
      expect(beforeApprove.map((r) => r.serverName)).not.toContain("notion");

      const installApproval = await approvals.create(companyId, {
        type: "install_mcp_connector",
        status: "pending",
        payload: { connectorId: connector.id, serverName: "notion" },
      });

      // THE real approval side-effect (SOLE activation path in authenticated mode).
      const approved = await approvals.approve(installApproval.id, companyId, DECIDER_USER);
      expect(approved?.status).toBe("approved");

      // Re-read the connector from DB: it must now be active.
      const afterApproveRow = await mcpConnectorService(db).getById(connector.id);
      expect(afterApproveRow?.status).toBe("active");

      // And the loader now returns it (was excluded while pending).
      const afterApprove = await loadEnabledConnectorRows(db, { companyId, agentId: null });
      expect(afterApprove.map((r) => r.serverName)).toContain("notion");

      // ── B) REJECT path ───────────────────────────────────────────────────
      await secrets.create(companyId, {
        name: "mcp:linear",
        provider: "local_encrypted",
        managedMode: "aoa_managed",
        value: "linear-token-reject-xyz",
      });
      const rejectConn = await mcpConnectorService(db).create(companyId, {
        serverName: "linear",
        displayName: "Linear",
        transport: "http",
        url: "https://mcp.linear.example/v1",
        headerTemplate: { Authorization: "Bearer ${TOKEN}" },
        secretRef: "mcp:linear",
        status: "pending_approval",
      });
      const rejectApproval = await approvals.create(companyId, {
        type: "install_mcp_connector",
        status: "pending",
        payload: { connectorId: rejectConn.id, serverName: "linear" },
      });

      const rejected = await approvals.reject(rejectApproval.id, companyId, DECIDER_USER);
      expect(rejected?.status).toBe("rejected");

      // Re-read: rejected connector is `disabled` (kept for audit, not deleted).
      const afterRejectRow = await mcpConnectorService(db).getById(rejectConn.id);
      expect(afterRejectRow?.status).toBe("disabled");

      // And the loader must NOT return a disabled connector.
      const afterReject = await loadEnabledConnectorRows(db, { companyId, agentId: null });
      expect(afterReject.map((r) => r.serverName)).not.toContain("linear");
      // The approved one is still there (sanity: reject didn't disturb it).
      expect(afterReject.map((r) => r.serverName)).toContain("notion");
    }, 180_000);

    it("2) crew delivery: real resolveAgentConnectors (opt-in) + real runner config-file seam (placeholder on disk, secret only in env)", async () => {
      if (setupError) throw setupError;
      const companyId = await newCompany("P2 Crew Co");
      const SECRET = "crew-notion-secret-do-not-leak-abc";
      const secrets = secretService(db);

      await secrets.create(companyId, {
        name: "mcp:notion",
        provider: "local_encrypted",
        managedMode: "aoa_managed",
        value: SECRET,
      });

      // A crew (kind='aoa') claude_local agent — the per-agent opt-in (D4) path.
      const agentId = await firstId(
        db.execute(sql`
          INSERT INTO agents (company_id, name, adapter_type, status, kind)
          VALUES (${companyId}, 'Scout', 'claude_local', 'active', 'aoa')
          RETURNING id
        `),
      );
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
      // Real opt-in junction row.
      await svc.replaceAgents(companyId, connector.id, [agentId]);

      // THE real crew resolution: loader → secret-resolve → buildConnectorSpecs.
      const resolved = await resolveAgentConnectors(db, { companyId, agentId });
      expect(Object.keys(resolved.extraMcpServers)).toContain("notion");
      const spec: any = resolved.extraMcpServers.notion;
      // Placeholder rides in the spec (headers), real secret only in connectorEnv.
      expect(JSON.stringify(spec)).toContain("${AOA_MCP_NOTION_TOKEN}");
      expect(JSON.stringify(spec)).not.toContain(SECRET);
      expect(resolved.connectorEnv.AOA_MCP_NOTION_TOKEN).toBe(SECRET);

      // THE real runner config-file seam (runAoaAgent lines ~389-391): build the
      // claude --mcp-config envelope with the resolved connector specs and write
      // it to the same temp-file shape, then prove the on-disk file holds the
      // placeholder and NEVER the plaintext secret.
      const mcp = buildMcpConfig({
        companyId,
        userId: DECIDER_USER,
        userRole: "founder",
        enabledCapabilities: [],
        bridgeEntrypoint: "/tmp/aoa-bridge.js",
        agentKind: "aoa",
        agentId,
        runId: "run-" + PORT,
        extraMcpServers: resolved.extraMcpServers,
      });
      const cfgPath = join(dataDir, `aoa-mcp-${agentId}.json`);
      await writeFile(cfgPath, JSON.stringify(mcp, null, 2));
      try {
        const raw = await readFile(cfgPath, "utf8");
        expect(raw).toContain("notion");
        expect(raw).toContain("${AOA_MCP_NOTION_TOKEN}");
        expect(raw).not.toContain(SECRET); // secret NEVER on disk
        const parsed = JSON.parse(raw);
        expect(parsed.mcpServers.notion).toBeDefined();
        expect(parsed.mcpServers.notion.headers.Authorization).toBe(
          "Bearer ${AOA_MCP_NOTION_TOKEN}",
        );
        // AoA's own bridge server is still present alongside the connector.
        expect(parsed.mcpServers.aoa).toBeDefined();
      } finally {
        await rm(cfgPath, { force: true });
      }
    }, 180_000);

    it("3) Commander delivery: real resolveAgentConnectors (agentId:null) returns ALL active (D3), excludes pending_approval", async () => {
      if (setupError) throw setupError;
      const companyId = await newCompany("P2 Commander Co");
      const secrets = secretService(db);
      const svc = mcpConnectorService(db);

      // Two ACTIVE connectors — Commander (all-active, D3) must get BOTH with no
      // opt-in rows at all (Commander is exempt from the per-agent junction).
      await secrets.create(companyId, {
        name: "mcp:notion",
        provider: "local_encrypted",
        managedMode: "aoa_managed",
        value: "cmdr-notion-secret-1",
      });
      await secrets.create(companyId, {
        name: "mcp:github",
        provider: "local_encrypted",
        managedMode: "aoa_managed",
        value: "cmdr-github-secret-2",
      });
      await svc.create(companyId, {
        serverName: "notion",
        displayName: "Notion Docs",
        transport: "http",
        url: "https://mcp.notion.example/v1",
        headerTemplate: { Authorization: "Bearer ${TOKEN}" },
        secretRef: "mcp:notion",
        status: "active",
      });
      await svc.create(companyId, {
        serverName: "github",
        displayName: "GitHub",
        transport: "http",
        url: "https://mcp.github.example/v1",
        headerTemplate: { Authorization: "Bearer ${TOKEN}" },
        secretRef: "mcp:github",
        status: "active",
      });
      // A pending_approval connector — must NOT reach Commander.
      await svc.create(companyId, {
        serverName: "pendingsvc",
        displayName: "Pending Svc",
        transport: "http",
        url: "https://mcp.pending.example/v1",
        status: "pending_approval",
      });

      const resolved = await resolveAgentConnectors(db, { companyId, agentId: null });
      const names = Object.keys(resolved.extraMcpServers).sort();
      expect(names).toEqual(["github", "notion"]);
      expect(names).not.toContain("pendingsvc");
      // Both real tokens present in the env map.
      expect(resolved.connectorEnv.AOA_MCP_NOTION_TOKEN).toBe("cmdr-notion-secret-1");
      expect(resolved.connectorEnv.AOA_MCP_GITHUB_TOKEN).toBe("cmdr-github-secret-2");
    }, 180_000);
  },
);
