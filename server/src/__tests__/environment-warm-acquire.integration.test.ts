/**
 * U7.5 — warm acquire/release, real embedded-PG proof.
 *
 * Boots embedded-postgres + real migrations, then drives the REAL
 * `acquireExecutionContext` → REAL `environmentRunOrchestrator` →
 * `environmentRuntimeService` with a fake sandbox PROVIDER registered under the
 * "e2b" key (never touches the real e2b SDK/network — same DI seam as
 * `crew-lease-release.integration.test.ts` / `acquire-execution-context.integration.test.ts`).
 * `environments` is left REAL so every lease is a genuine `environment_leases`
 * row and every assertion is a real DB re-read.
 *
 * Proves the full warm lifecycle end-to-end:
 *   run 1 (warm)      → lease active + reuse_by_agent + agent_id set + providerLeaseId
 *   release run 1     → lease paused (paused_at set, released_at NULL)
 *   run 2 (same agent)→ RESUME the same providerLeaseId, NO new lease row
 *   dead snapshot     → transparent create-fresh (new row), run does NOT throw
 *
 * Skipped on Windows by default (embedded-postgres can't start on the CI
 * runner — Issue #114); set AOA_RUN_WIN_INTEGRATION=1 on a Windows dev box to
 * force-run it (mirrors the sibling integration tests).
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
const PORT = 55200 + Math.floor(Math.random() * 400);

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-warm-"));
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
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org Warm', 'org-warm')`);
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co Warm', 'WARM', ${ORG})`,
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

/** Fake sandbox provider registered under the "e2b" key (never touches the real
 *  e2b SDK/network). Its resumeLease echoes resumed:true unless the persisted
 *  provider metadata carries `__dead: true` — letting us simulate a GC'd VM. */
function fakeE2bProvider(): SandboxRuntimeProvider {
  return { ...createFakeSandboxRuntimeProvider(), provider: "e2b" };
}
function fakeRuntimeProviderKeys() {
  return { resolveCredential: async () => "fake-e2b-key-for-test" };
}

async function leaseRow(id: string) {
  const res = await db.execute(
    sql`SELECT id, status, agent_id, lease_policy, provider_lease_id, paused_at, released_at FROM environment_leases WHERE id = ${id}`,
  );
  const rows = Array.isArray(res) ? res : (res as { rows: unknown[] }).rows;
  return (rows?.[0] ?? null) as
    | { id: string; status: string; agent_id: string | null; lease_policy: string; provider_lease_id: string | null; paused_at: string | null; released_at: string | null }
    | null;
}

async function countAgentLeases(agentId: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM environment_leases WHERE agent_id = ${agentId}`,
  );
  const rows = Array.isArray(res) ? res : (res as { rows: unknown[] }).rows;
  return Number((rows?.[0] as { n: number } | undefined)?.n ?? 0);
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "U7.5: warm acquire/release lifecycle against a genuine environment_leases table",
  () => {
    it("run1 warm → active+reuse_by_agent+agent_id; release → paused; run2 same agent RESUMES same providerLeaseId (no new row); dead → create-fresh (no throw)", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");

      const agentId = randomUUID();
      await db.execute(sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${CO}, 'Warm Agent')`);

      const [envRow] = await db
        .insert(environments)
        .values({
          companyId: CO,
          name: "warm e2b env",
          driver: "sandbox",
          config: { provider: "e2b", remoteCwd: "/workspace", shellCommand: "bash", template: "base" },
        })
        .returning();
      expect(envRow).toBeTruthy();

      const runtime = environmentRuntimeService(db, {
        sandboxProviders: [fakeE2bProvider()],
        runtimeProviderKeys: fakeRuntimeProviderKeys(),
      });
      const orchestrator = environmentRunOrchestrator(db, { environmentRuntime: runtime });
      const acquire = (extra: { warmPreference: boolean }) =>
        acquireExecutionContext(
          { orchestrator } as never,
          {
            runIdentity: { companyId: CO, agentId, runId: randomUUID(), adapterType: "claude_local" },
            functionType: "software_development",
            warmPreference: extra.warmPreference,
            worktree: null,
            environmentId: envRow!.id,
          },
        );

      // ── run 1 (warm) ──────────────────────────────────────────────────
      const run1 = await acquire({ warmPreference: true });
      expect(run1.sandbox).not.toBeNull();
      const lease1Id = run1.sandbox!.lease.id;
      const lease1Provider = run1.sandbox!.lease.providerLeaseId;
      const row1 = await leaseRow(lease1Id);
      expect(row1?.status).toBe("active");
      expect(row1?.lease_policy).toBe("reuse_by_agent");
      expect(row1?.agent_id).toBe(agentId); // U7.5: agent_id MUST be persisted
      expect(row1?.provider_lease_id).toBeTruthy();

      // ── release run 1 → pause (not kill) ──────────────────────────────
      const paused = await runtime.releaseRunLease({
        environment: run1.sandbox!.environment,
        lease: run1.sandbox!.lease,
        status: "released",
      });
      expect(paused?.status).toBe("paused");
      const pausedRow = await leaseRow(lease1Id);
      expect(pausedRow?.status).toBe("paused");
      expect(pausedRow?.paused_at).not.toBeNull();
      expect(pausedRow?.released_at).toBeNull(); // paused, NOT released

      expect(await countAgentLeases(agentId)).toBe(1);

      // ── run 2 (same agent) → RESUME the same lease, NO new row ─────────
      const run2 = await acquire({ warmPreference: true });
      expect(run2.sandbox).not.toBeNull();
      expect(run2.sandbox!.lease.id).toBe(lease1Id); // resumed the SAME row
      expect(run2.sandbox!.lease.providerLeaseId).toBe(lease1Provider); // SAME providerLeaseId
      expect(run2.sandbox!.lease.status).toBe("active");
      expect(await countAgentLeases(agentId)).toBe(1); // still ONE row — resume, not create

      // ── simulate a dead/GC'd snapshot → transparent create-fresh ──────
      // Pause run 2 again, then mark the persisted snapshot dead so the fake
      // provider's resumeLease returns resumed:false.
      await runtime.releaseRunLease({
        environment: run2.sandbox!.environment,
        lease: run2.sandbox!.lease,
        status: "released",
      });
      await db.execute(
        sql`UPDATE environment_leases SET metadata = jsonb_set(metadata, '{providerMetadata,__dead}', 'true'::jsonb) WHERE id = ${lease1Id}`,
      );

      const run3 = await acquire({ warmPreference: true });
      expect(run3.sandbox).not.toBeNull();
      expect(run3.sandbox!.lease.id).not.toBe(lease1Id); // a FRESH lease row
      expect(run3.sandbox!.lease.status).toBe("active");
      expect(run3.sandbox!.lease.leasePolicy).toBe("reuse_by_agent");

      // The dead row was retired (expired), and a new active one exists.
      const deadRow = await leaseRow(lease1Id);
      expect(deadRow?.status).toBe("expired");
      // Two rows for the agent now: the retired dead one + the fresh active one.
      expect(await countAgentLeases(agentId)).toBe(2);
    }, 60_000);
  },
);
