/**
 * R3 (Wave 2 review): org agents on cloud with NO pinned environment must
 * auto-use the platform-default E2B sandbox — same as crew.
 *
 * THE GAP: `heartbeat.ts`'s org run used to call `acquireExecutionContext`
 * INSIDE `if (environmentRuntime.environmentId)` — true only for a PINNED
 * task/agent environment. An org agent with no pin never reached the acquire
 * call, never resolved the U1/U1b platform-default sandbox, and ran
 * UNSANDBOXED on the host, which the U8 D1 guard then refuses on cloud_auth.
 * Crew already called `acquireExecutionContext` UNCONDITIONALLY (`environmentId:
 * agent.defaultEnvironmentId ?? null` — see aoa-agents/runner.ts), letting a
 * null flow straight through to the orchestrator's null -> platform-default
 * branch. THE FIX relaxes org's gate to match: `environmentId:
 * environmentRuntime.environmentId ?? null`, called unconditionally.
 *
 * This test proves the underlying primitive composition org's run now makes
 * (post-fix) end-to-end against a REAL orchestrator + REAL `environments` /
 * `environment_leases` tables: `acquireExecutionContext(db, { environmentId:
 * null, heartbeatRunId: <a real heartbeat_runs.id>, ... })` resolves a
 * provider-sandbox target via the materialized platform default on
 * cloud_auth (S1/U1b), and the existing org reaper
 * (`environmentRuntimeService(db).releaseRunLeases(heartbeatRunId)`, called
 * unconditionally in heartbeat.ts's run `finally` — grep confirms it is NOT
 * gated on environmentRuntime.environmentId) reaps that lease by
 * heartbeat_run_id exactly like it already does for a pinned-env lease. A
 * sibling case proves the desktop/local_trusted path stays byte-identical:
 * sandbox:null, local executionTarget, and — because
 * `environmentRunOrchestrator.resolveEnvironment(null)` throws
 * `environment_not_found` BEFORE any DB write on that branch (see
 * environment-run-orchestrator.ts:132-149) — no `environment_leases` row is
 * ever created.
 *
 * REAL-SHAPE NOTE: running heartbeat.ts's actual org wakeup() end-to-end
 * would require spawning a real adapter subprocess (no existing test harness
 * does this — every heartbeat*.test.ts either tests pure extracted helpers
 * with heavy `vi.mock`s, or is a narrowly-scoped integration test like this
 * one). This test instead proves the exact real orchestrator + real
 * environment-runtime-service call SHAPE the org path now makes
 * post-fix (`acquireExecutionContext` unconditional + `releaseRunLeases`
 * keyed by heartbeatRunId, both already unconditional in heartbeat.ts), the
 * same style already established by acquire-execution-context.integration
 * .test.ts and platform-default-environment-materialization.integration
 * .test.ts (which this file directly builds on).
 *
 * Skipped on Windows by default (embedded-postgres can't start on the CI
 * runner — Issue #114); set AOA_RUN_WIN_INTEGRATION=1 on a Windows dev box to
 * force-run it (verified locally for this task, then reverted to the default
 * skip before commit).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  agents,
  heartbeatRuns,
  environmentLeases,
  type Db,
} from "@armyofagents/db";
import type { SandboxRuntimeProvider } from "../services/sandbox-provider-runtime.js";
import { createFakeSandboxRuntimeProvider } from "../services/sandbox-provider-runtime.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentRunOrchestrator } from "../services/environment-run-orchestrator.js";
import { acquireExecutionContext } from "../services/acquire-execution-context.js";
import { applyEnvironmentAcquisitionConfig } from "../services/heartbeat.js";
import { derivePlatformDefaultEnvironmentId } from "../services/platform-default-environment.js";
import { setDeploymentMode, getDeploymentMode } from "../config/deployment-mode.js";

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
const PORT = 58000 + Math.floor(Math.random() * 1000);

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
let orgAgentId = "";

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-oapd-"));
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
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org OAPD', 'org-oapd')`);
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co OAPD', 'OAPD', ${ORG})`,
    );
    // A real org agent (kind defaults to 'org') with NO defaultEnvironmentId
    // pin — the exact "no pinned env" shape R3 fixes.
    const [agentRow] = await db
      .insert(agents)
      .values({ companyId: CO, name: "Org Agent (no pin)", adapterType: "claude_local" })
      .returning();
    orgAgentId = agentRow!.id;
  } catch (e) {
    setupError = e;
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

// deployment-mode is process-wide mutable state (config/deployment-mode.ts) —
// restore it after every test so this file can never leak cloud_auth into a
// sibling test running in the same worker.
const savedDeploymentMode = getDeploymentMode();
const savedE2bApiKey = process.env.E2B_API_KEY;
afterEach(() => {
  setDeploymentMode(savedDeploymentMode);
  if (savedE2bApiKey === undefined) delete process.env.E2B_API_KEY;
  else process.env.E2B_API_KEY = savedE2bApiKey;
});

/** Fake sandbox provider registered under the "e2b" key (never touches the
 *  real e2b SDK / network) — mirrors acquire-execution-context.integration
 *  .test.ts / platform-default-environment-materialization.integration.test.ts. */
function fakeE2bProvider(): SandboxRuntimeProvider {
  return { ...createFakeSandboxRuntimeProvider(), provider: "e2b" };
}

/** Minimal fake runtime-provider-key resolver: the real one queries
 *  `runtime_provider_keys` for a company-configured E2B key, which this test
 *  company has none of. */
function fakeRuntimeProviderKeys() {
  return { resolveCredential: async () => "fake-e2b-key-for-test" };
}

async function insertHeartbeatRun(): Promise<string> {
  const [run] = await db
    .insert(heartbeatRuns)
    .values({ companyId: CO, agentId: orgAgentId, invocationSource: "on_demand", status: "running" })
    .returning();
  return run!.id;
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "org agent auto-uses the platform-default sandbox when no env is pinned (R3)",
  () => {
    it("cloud_auth, no pinned env: resolves a provider-sandbox executionTarget via the platform default, AND the lease is released on run completion", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");
      process.env.E2B_API_KEY = "fake-key-for-org-platform-default";

      const heartbeatRunId = await insertHeartbeatRun();

      // Same DI seam as acquire-execution-context.integration.test.ts / U1b's
      // materialization test: real `environments`/`environment_leases`
      // tables, only the outermost E2B network leaf + runtime-provider-key
      // lookup are faked. Reused for BOTH acquire and release below so the
      // fake "e2b" provider is registered for the whole lifecycle.
      const runtime = environmentRuntimeService(db, {
        sandboxProviders: [fakeE2bProvider()],
        runtimeProviderKeys: fakeRuntimeProviderKeys(),
      });
      const orchestrator = environmentRunOrchestrator(db, { environmentRuntime: runtime });

      // This mirrors EXACTLY what heartbeat.ts's org run now calls
      // unconditionally post-fix: `environmentId: environmentRuntime
      // .environmentId ?? null` — null here because no env is pinned
      // (agent.defaultEnvironmentId is null, no issue executionEnvironmentId).
      const acquired = await acquireExecutionContext(
        { orchestrator } as never,
        {
          runIdentity: { companyId: CO, agentId: orgAgentId, runId: heartbeatRunId, adapterType: "claude_local" },
          functionType: null,
          warmPreference: false,
          worktree: null,
          environmentId: null,
          issueId: null,
          heartbeatRunId,
        },
      );

      // (1) Resolves the platform default to a real provider-sandbox target.
      expect(acquired.sandbox).not.toBeNull();
      expect(acquired.sandbox!.environment.driver).toBe("sandbox");
      expect(acquired.sandbox!.environment.id).toBe(derivePlatformDefaultEnvironmentId(CO));
      expect(
        applyEnvironmentAcquisitionConfig({}, acquired.sandbox).executionTarget,
      ).toEqual(expect.objectContaining({ type: "provider-sandbox", provider: "e2b" }));

      // Genuine DB proof: a REAL environment_leases row, tagged with the real
      // heartbeatRunId — exactly the shape the org reaper queries by.
      const [leaseRow] = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, acquired.lease!.id));
      expect(leaseRow).toBeTruthy();
      expect(leaseRow!.heartbeatRunId).toBe(heartbeatRunId);
      expect(leaseRow!.status).toBe("active");
      expect(leaseRow!.provider).toBe("e2b");

      // (2) The org reaper (environmentRuntimeService(db).releaseRunLeases(
      // run.id), unconditional in heartbeat.ts's run `finally`) reaps a
      // platform-default lease exactly like a pinned one — no leak.
      const released = await runtime.releaseRunLeases(heartbeatRunId);
      expect(released).toHaveLength(1);
      expect(released[0]!.status).toBe("released");

      const [releasedRow] = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, acquired.lease!.id));
      expect(releasedRow!.status).toBe("released");
      expect(releasedRow!.releasedAt).not.toBeNull();

      // No active leases remain for this run — the reaper is exhaustive.
      const stillActive = await db
        .select()
        .from(environmentLeases)
        .where(and(eq(environmentLeases.heartbeatRunId, heartbeatRunId), eq(environmentLeases.status, "active")));
      expect(stillActive).toHaveLength(0);
    }, 60_000);

    it("desktop/local_trusted, no pinned env: sandbox stays null (local target), and NO environment_leases row is ever created", async () => {
      if (setupError) throw new Error(String(setupError));
      // Deliberately do NOT set cloud_auth — this is the default state, the
      // same one the pinned-env path already exercises byte-identically
      // today. No DI needed: resolveEnvironment(null) is a pure,
      // deploymentMode-gated check off-cloud and never reaches the DB.
      const heartbeatRunId = await insertHeartbeatRun();

      const acquired = await acquireExecutionContext(db, {
        runIdentity: { companyId: CO, agentId: orgAgentId, runId: heartbeatRunId, adapterType: "claude_local" },
        functionType: null,
        warmPreference: false,
        worktree: null,
        environmentId: null,
        issueId: null,
        heartbeatRunId,
      });

      expect(acquired.sandbox).toBeNull();
      expect(acquired.lease).toBeNull();

      // applyEnvironmentAcquisitionConfig is the exact call heartbeat.ts now
      // makes unconditionally too — a null sandbox must be a documented
      // no-op, returning the input config BY REFERENCE, unchanged.
      const config = { executionTarget: { type: "local" }, env: { FOO: "bar" } };
      expect(applyEnvironmentAcquisitionConfig(config, acquired.sandbox)).toBe(config);

      // No DB lease was ever created for this run.
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.heartbeatRunId, heartbeatRunId));
      expect(rows).toHaveLength(0);

      // The org reaper is a documented no-op too when nothing was leased.
      const runtime = environmentRuntimeService(db);
      const released = await runtime.releaseRunLeases(heartbeatRunId);
      expect(released).toHaveLength(0);
    }, 30_000);
  },
);
