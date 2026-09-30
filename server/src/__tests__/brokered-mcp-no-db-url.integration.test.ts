/**
 * S7 security proof (U4b): no DATABASE_URL reaches a sandboxed run's MCP
 * config. Boots embedded-postgres + real migrations, then drives the REAL
 * `acquireExecutionContext` → REAL `environmentRunOrchestrator` → a fake
 * sandbox PROVIDER registered at the DI seam (mirrors
 * `acquire-execution-context.integration.test.ts` exactly — same
 * `environmentRuntimeService(db, { sandboxProviders, runtimeProviderKeys,
 * environments })` seam, same fake-only-the-outermost-leaf philosophy as
 * `AOA_E2E_FAKE_EMBEDDER`) to resolve a GENUINE `provider-sandbox` lease. That
 * real `acquired.sandbox` is then fed into the REAL, completely unmocked
 * `buildMcpConfig` / `buildCodexAoaMcpSpec` (cli-mode.ts) the exact same way
 * runner.ts / heartbeat.ts do — `brokered: acquired.sandbox?.environment
 * .driver === "sandbox"` — so this test does NOT force the sandbox with a
 * test-only bypass: a regression anywhere in the real acquisition chain OR
 * the honoring code goes red here.
 *
 * LAYERING (why this file doesn't also drive `runAoaAgent`/heartbeat's full
 * dispatch loop): `runAoaAgent`'s own DB graph (agents/connectors/memory/
 * provider-resolution/workspaces) spans dozens of tables and every existing
 * runner suite (aoa-runner.test.ts et al.) exercises it via a Proxy-table
 * mock, never embedded-PG — there is no precedent or seam for driving it
 * against a real DB, and building one is out of scope for this proof. That
 * "does runner.ts/heartbeat.ts itself read `acquired.sandbox?.environment
 * .driver` and set `brokered`" wiring is covered for real (production
 * `runAoaAgent`, unmocked cli-mode.ts, mocked acquireExecutionContext at the
 * SAME seam this file's own S1 test proves resolves a real sandbox) by
 * `aoa-runner-brokered-mcp.test.ts`, and for org by the direct
 * `prepareHeartbeatMcpDelivery` calls added to `heartbeat-mcp.test.ts`. This
 * file supplies the piece those cannot: proof against a GENUINELY resolved
 * (non-mocked) sandbox lease, all the way from the orchestrator down to the
 * bytes `buildMcpConfig`/`buildCodexAoaMcpSpec` produce.
 *
 * REAL-SHAPE DRIFT — "org dispatch through the platform default": heartbeat.ts
 * only calls `acquireExecutionContext` INSIDE `if (environmentRuntime.
 * environmentId)` (U4 step 5) — org never resolves the null-env platform
 * default the way crew/Commander do; it only acquires when a project/agent
 * has a PINNED environment. So the "org" case below exercises the REAL pinned-
 * environment path (mirrors acquire-execution-context.integration.test.ts's
 * own test 3: a genuine `environments` row + a real `environment_leases`
 * round trip), which is the actual mechanism org's `orgAcquired` gate uses —
 * not the null-env platform-default branch, which org's wiring never reaches.
 *
 * Skipped on Windows by default (embedded-postgres can't start on the CI
 * runner — Issue #114); set AOA_RUN_WIN_INTEGRATION=1 on a Windows dev box to
 * force-run it (verified locally for this task, then reverted to the default
 * skip before commit — see acquire-execution-context.integration.test.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, environments, type Db } from "@armyofagents/db";
import type { SandboxRuntimeProvider } from "../services/sandbox-provider-runtime.js";
import { createFakeSandboxRuntimeProvider } from "../services/sandbox-provider-runtime.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentRunOrchestrator } from "../services/environment-run-orchestrator.js";
import { acquireExecutionContext } from "../services/acquire-execution-context.js";
import { setDeploymentMode, getDeploymentMode } from "../config/deployment-mode.js";
import { buildMcpConfig, buildCodexAoaMcpSpec, type McpConfigParams } from "../services/internal-agent/cli-mode.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

const ORG = randomUUID();
const CO = randomUUID();
const PORT = 55000 + Math.floor(Math.random() * 1000);

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-bmcp-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
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
    const url = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org BMCP', 'org-bmcp')`);
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co BMCP', 'BMCP', ${ORG})`,
    );
  } catch (e) {
    setupError = e;
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

const savedDeploymentMode = getDeploymentMode();
const savedE2bApiKey = process.env.E2B_API_KEY;
const savedDbUrlEnv = process.env.DATABASE_URL;
afterEach(() => {
  setDeploymentMode(savedDeploymentMode);
  if (savedE2bApiKey === undefined) delete process.env.E2B_API_KEY;
  else process.env.E2B_API_KEY = savedE2bApiKey;
  if (savedDbUrlEnv === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDbUrlEnv;
});

/** Fake sandbox provider registered under the "e2b" key — never touches the
 *  real e2b SDK/network. See acquire-execution-context.integration.test.ts. */
function fakeE2bProvider(): SandboxRuntimeProvider {
  return { ...createFakeSandboxRuntimeProvider(), provider: "e2b" };
}

function fakeRuntimeProviderKeys() {
  return { resolveCredential: async () => "fake-e2b-key-for-test" };
}

const baseParams = {
  companyId: CO,
  userId: "agent-1",
  userRole: "team_member",
  enabledCapabilities: ["system_actions"],
  bridgeEntrypoint: "C:/aoa/mcp-bridge.js",
  agentKind: "aoa",
  actorType: "agent",
  agentId: "agent-1",
  runId: "run-1",
} satisfies Partial<McpConfigParams>;

/** The one-line derivation runner.ts / heartbeat.ts BOTH make (S7 contract):
 *  brokered iff the acquired result resolved a real sandbox driver. */
function brokeredFrom(acquired: { sandbox: { environment: { driver: string } } | null }): boolean {
  return acquired.sandbox?.environment.driver === "sandbox";
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "brokered MCP config carries no DATABASE_URL (U4b, S7 — real acquireExecutionContext + real buildMcpConfig/buildCodexAoaMcpSpec)",
  () => {
    it("crew (null env, cloud_auth): a REAL provider-sandbox lease produces an HTTP aoa entry with no DATABASE_URL/postgres:// — claude AND codex", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");
      process.env.E2B_API_KEY = "fake-key-for-platform-default-resolution";
      process.env.DATABASE_URL = "postgres://should-be-absent:5432/db"; // the leak this closes

      // Same in-memory lease-persistence fake as acquire-execution-context.
      // integration.test.ts — the platform-default id materializes a REAL
      // `environments` row (U1b) but this test doesn't need the lease itself
      // to be a durable DB row to prove the MCP-config honoring chain.
      const leases = new Map<string, Record<string, unknown>>();
      const fakeEnvironments = {
        acquireLease: async (input: Record<string, unknown>) => {
          const id = randomUUID();
          const row = { id, ...input, status: "active", acquiredAt: new Date(), lastUsedAt: new Date() };
          leases.set(id, row);
          return row as never;
        },
        releaseLease: async (id: string) => {
          const row = leases.get(id);
          if (!row) return null;
          const released = { ...row, status: "released", releasedAt: new Date() };
          leases.set(id, released);
          return released as never;
        },
        releaseLeasesForRun: async () => [] as never,
      };

      const orchestrator = environmentRunOrchestrator(db, {
        environmentRuntime: environmentRuntimeService(db, {
          environments: fakeEnvironments,
          sandboxProviders: [fakeE2bProvider()],
          runtimeProviderKeys: fakeRuntimeProviderKeys(),
        }),
      });

      // Crew-style dispatch: null environmentId -> orchestrator's platform
      // default (U1). REAL acquireExecutionContext, no bypass.
      const acquired = await acquireExecutionContext(
        { orchestrator } as never,
        {
          runIdentity: { companyId: CO, agentId: randomUUID(), runId: randomUUID(), adapterType: "claude_local" },
          functionType: null,
          warmPreference: false,
          worktree: null,
          environmentId: null,
        },
      );
      // S5 confirmation: this really is a resolved sandbox, not a hand-built stub.
      expect(acquired.sandbox).not.toBeNull();
      expect(acquired.sandbox!.environment.driver).toBe("sandbox");

      // ---- the EXACT one-liner runner.ts executes right after `acquired` ----
      const brokered = brokeredFrom(acquired);
      expect(brokered).toBe(true);

      // claude path: buildMcpConfig (the --mcp-config JSON file contents).
      const claudeParams: McpConfigParams = { ...baseParams, brokered, apiBaseUrl: "https://cp.example.test" };
      const staged = buildMcpConfig(claudeParams);
      expect(staged.mcpServers.aoa).toMatchObject({
        type: "http",
        url: `https://cp.example.test/companies/${CO}/mcp`,
      });
      expect((staged.mcpServers.aoa as { command?: unknown }).command).toBeUndefined();
      const stagedRaw = JSON.stringify(staged);
      expect(stagedRaw).not.toContain("DATABASE_URL");
      expect(stagedRaw).not.toMatch(/postgres(ql)?:\/\//);

      // codex path: buildCodexAoaMcpSpec (the ctx.mcpBridge -> config.toml input).
      const codexSpec = buildCodexAoaMcpSpec(claudeParams);
      expect(codexSpec).toMatchObject({
        kind: "http",
        url: `https://cp.example.test/companies/${CO}/mcp`,
        authTokenEnvVar: "AOA_API_KEY",
      });
      const codexRaw = JSON.stringify(codexSpec);
      expect(codexRaw).not.toContain("DATABASE_URL");
      expect(codexRaw).not.toMatch(/postgres(ql)?:\/\//);
      // codex-config-toml.test.ts ("reserved aoa server as HTTP (U2d-bridge)")
      // already proves THIS exact spec shape, handed to the real
      // writeCodexMcpConfigToml, renders a config.toml with no DATABASE_URL —
      // not re-proven here to keep this file server-side (adapters must not
      // be imported from server tests).
    }, 60_000);

    it("desktop/local_trusted (no platform default -> sandbox:null): brokered stays false, buildMcpConfig/buildCodexAoaMcpSpec fall through to the unchanged stdio bridge — DATABASE_URL still present (strictly additive)", async () => {
      if (setupError) throw new Error(String(setupError));
      // No cloud_auth / E2B_API_KEY — real orchestrator, no DI needed (mirrors
      // acquire-execution-context.integration.test.ts test 2).
      process.env.DATABASE_URL = "postgres://should-be-present:5432/db";

      const acquired = await acquireExecutionContext(db, {
        runIdentity: { companyId: CO, agentId: null, runId: randomUUID(), adapterType: "claude_local" },
        functionType: null,
        warmPreference: false,
        worktree: null,
        environmentId: null,
      });
      expect(acquired.sandbox).toBeNull();

      const brokered = brokeredFrom(acquired);
      expect(brokered).toBe(false);

      const params: McpConfigParams = { ...baseParams, brokered, apiBaseUrl: undefined };
      const staged = buildMcpConfig(params);
      expect((staged.mcpServers.aoa as { type?: unknown }).type).toBeUndefined();
      expect(staged.mcpServers.aoa).toMatchObject({ command: "node" });
      expect((staged.mcpServers.aoa as { env: Record<string, string> }).env.DATABASE_URL).toBe(
        "postgres://should-be-present:5432/db",
      );

      const codexSpec = buildCodexAoaMcpSpec(params);
      expect(codexSpec).toMatchObject({ command: "node" });
      expect((codexSpec as { env: Record<string, string> }).env.DATABASE_URL).toBe(
        "postgres://should-be-present:5432/db",
      );
    }, 30_000);

    it("org (pinned environmentId, cloud_auth): a REAL environment_leases round trip resolves a provider-sandbox — the ONLY path heartbeat.ts's orgAcquired gate ever takes (org never resolves the null-env platform default)", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");
      process.env.DATABASE_URL = "postgres://should-be-absent:5432/db";

      const [envRow] = await db
        .insert(environments)
        .values({
          companyId: CO,
          name: "org pinned e2b env",
          driver: "sandbox",
          config: { provider: "e2b", remoteCwd: "/workspace", shellCommand: "bash" },
        })
        .returning();
      expect(envRow).toBeTruthy();

      const orchestrator = environmentRunOrchestrator(db, {
        environmentRuntime: environmentRuntimeService(db, {
          // environments left REAL — genuine DB round trip (S5/S6), same as
          // acquire-execution-context.integration.test.ts test 3.
          sandboxProviders: [fakeE2bProvider()],
          runtimeProviderKeys: fakeRuntimeProviderKeys(),
        }),
      });

      // Mirrors heartbeat.ts's orgAcquired call INSIDE `if (environmentRuntime.
      // environmentId)` — environmentId is the PIN, never null, for org.
      const orgAcquired = await acquireExecutionContext(
        { orchestrator } as never,
        {
          runIdentity: { companyId: CO, agentId: randomUUID(), runId: randomUUID(), adapterType: "claude_local" },
          functionType: null,
          warmPreference: false,
          worktree: null,
          environmentId: envRow!.id,
        },
      );
      expect(orgAcquired.sandbox!.environment.driver).toBe("sandbox");

      // ---- the EXACT one-liner heartbeat.ts puts on heartbeatMcpParams ----
      const brokered = orgAcquired?.sandbox?.environment.driver === "sandbox";
      expect(brokered).toBe(true);

      const orgParams: McpConfigParams = {
        ...baseParams,
        agentKind: "org",
        brokered,
        apiBaseUrl: "https://cp.example.test",
      };
      const staged = buildMcpConfig(orgParams);
      expect(staged.mcpServers.aoa).toMatchObject({
        type: "http",
        url: `https://cp.example.test/companies/${CO}/mcp`,
      });
      const stagedRaw = JSON.stringify(staged);
      expect(stagedRaw).not.toContain("DATABASE_URL");
      expect(stagedRaw).not.toMatch(/postgres(ql)?:\/\//);

      // Genuine DB proof the lease is real (not an in-memory fake this time).
      const rows = await db.execute(
        sql`SELECT provider, status FROM environment_leases WHERE id = ${orgAcquired.lease!.id}`,
      );
      const persisted = (Array.isArray(rows) ? rows[0] : (rows as { rows: unknown[] }).rows?.[0]) as
        | { provider: string; status: string }
        | undefined;
      expect(persisted?.provider).toBe("e2b");
      expect(persisted?.status).toBe("active");
    }, 60_000);
  },
);
