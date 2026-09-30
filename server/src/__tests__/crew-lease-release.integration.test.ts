/**
 * FIX 1 (Wave 2 adversarial review, HIGH — cloud VM/lease leak): real-DB proof
 * that `environmentRuntimeService(db).releaseRunLease({ environment, lease,
 * status: "released" })` — the exact call `runAoaAgent`'s `finally` block now
 * makes (server/src/services/internal-agent/aoa-agents/runner.ts) — actually
 * flips a GENUINE `environment_leases` row from 'active' to 'released'.
 *
 * Boots embedded-postgres + real migrations, then drives the REAL
 * `acquireExecutionContext` -> REAL `environmentRunOrchestrator` -> a fake
 * sandbox PROVIDER registered at the DI seam (mirrors
 * `acquire-execution-context.integration.test.ts` test 3 / the "org" case in
 * `brokered-mcp-no-db-url.integration.test.ts` exactly — same
 * `environmentRuntimeService(db, { sandboxProviders, runtimeProviderKeys })`
 * seam, `environments` left REAL so the lease is a genuine row) to acquire a
 * real `environment_leases` row (status='active', heartbeat_run_id=null — the
 * crew shape: `acquireExecutionContext`'s `runIdentity` carries no
 * heartbeatRunId for crew, which is WHY the org-only
 * `releaseRunLeases(heartbeatRunId)` sweeper can never reap it). Then calls
 * the SAME `releaseRunLease` the runner's `finally` calls and asserts the row
 * is no longer 'active' in the database.
 *
 * LAYERING: this file proves `releaseRunLease` itself does the right thing
 * against a real DB. That `runner.ts` actually CALLS it, on every exit path
 * (success/thrown-failure/no-sandbox no-op), is proven by the mocked-DB unit
 * suite `aoa-runner-lease-release.test.ts` (no seam exists for driving the
 * full `runAoaAgent` — with its dozens-of-tables DB graph — against embedded-
 * PG; see `brokered-mcp-no-db-url.integration.test.ts`'s header for why that
 * split is the established layering for this file family).
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
    dataDir = await mkdtemp(join(tmpdir(), "aoa-clr-"));
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
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org CLR', 'org-clr')`);
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co CLR', 'CLR', ${ORG})`,
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
afterEach(() => {
  setDeploymentMode(savedDeploymentMode);
});

/** Fake sandbox provider registered under the "e2b" key (never touches the
 *  real e2b SDK/network) — see acquire-execution-context.integration.test.ts. */
function fakeE2bProvider(): SandboxRuntimeProvider {
  return { ...createFakeSandboxRuntimeProvider(), provider: "e2b" };
}

function fakeRuntimeProviderKeys() {
  return { resolveCredential: async () => "fake-e2b-key-for-test" };
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "FIX 1: environmentRuntimeService(db).releaseRunLease frees a genuine environment_leases row (crew shape: heartbeat_run_id=null)",
  () => {
    it("acquires a real provider-sandbox lease (heartbeat_run_id=null, status='active'), then releaseRunLease flips it to no-longer-active — the exact call runner.ts's finally now makes", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");

      const [envRow] = await db
        .insert(environments)
        .values({
          companyId: CO,
          name: "crew e2b env (lease-release proof)",
          driver: "sandbox",
          config: { provider: "e2b", remoteCwd: "/workspace", shellCommand: "bash" },
        })
        .returning();
      expect(envRow).toBeTruthy();

      const runtime = environmentRuntimeService(db, {
        // environments left REAL — genuine environment_leases DB round trip.
        sandboxProviders: [fakeE2bProvider()],
        runtimeProviderKeys: fakeRuntimeProviderKeys(),
      });
      const orchestrator = environmentRunOrchestrator(db, { environmentRuntime: runtime });

      // Crew-shaped acquire: runAoaAgent's acquireExecutionContext call passes
      // no heartbeatRunId at all (see runner.ts's `runIdentity` — it carries
      // companyId/agentId/runId/adapterType only, no heartbeatRunId field) —
      // mirror that here so the resulting lease row is the exact shape the
      // bug report describes (heartbeat_run_id=null, unreachable by the org
      // sweeper).
      const acquired = await acquireExecutionContext(
        { orchestrator } as never,
        {
          runIdentity: { companyId: CO, agentId: randomUUID(), runId: randomUUID(), adapterType: "claude_local" },
          functionType: null,
          warmPreference: false,
          worktree: null,
          environmentId: envRow!.id,
        },
      );
      expect(acquired.sandbox).not.toBeNull();
      expect(acquired.sandbox!.environment.driver).toBe("sandbox");
      const leaseId = acquired.sandbox!.lease.id;

      // Genuine DB proof of the PRE-fix leak shape: active + heartbeat_run_id
      // NULL, so environmentsSvc.releaseLeasesForRun/listActiveLeasesForRun
      // (WHERE heartbeat_run_id = <id>) could never find this row.
      const before = await db.execute(
        sql`SELECT status, heartbeat_run_id FROM environment_leases WHERE id = ${leaseId}`,
      );
      const beforeRow = (Array.isArray(before) ? before[0] : (before as { rows: unknown[] }).rows?.[0]) as
        | { status: string; heartbeat_run_id: string | null }
        | undefined;
      expect(beforeRow?.status).toBe("active");
      expect(beforeRow?.heartbeat_run_id).toBeNull();

      // ---- the EXACT call runner.ts's finally block now makes (Fix 1) ----
      const releaseResult = await runtime.releaseRunLease({
        environment: acquired.sandbox!.environment,
        lease: acquired.sandbox!.lease,
        status: "released",
      });
      expect(releaseResult).not.toBeNull();
      expect(releaseResult!.status).not.toBe("active");

      // Genuine DB re-read: the row is really no longer active — the leak this
      // fix closes is provably closed.
      const after = await db.execute(
        sql`SELECT status, released_at FROM environment_leases WHERE id = ${leaseId}`,
      );
      const afterRow = (Array.isArray(after) ? after[0] : (after as { rows: unknown[] }).rows?.[0]) as
        | { status: string; released_at: string | null }
        | undefined;
      expect(afterRow?.status).not.toBe("active");
      expect(afterRow?.released_at).not.toBeNull();
    }, 60_000);
  },
);
