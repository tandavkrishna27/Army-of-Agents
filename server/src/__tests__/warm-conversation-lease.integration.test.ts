/**
 * W7.5c — warm CONVERSATION acquire/release, real embedded-PG proof.
 *
 * Commander analogue of `environment-warm-acquire.integration.test.ts`. Drives
 * the REAL `acquireExecutionContext` → REAL `environmentRunOrchestrator` →
 * `environmentRuntimeService` with a fake sandbox PROVIDER registered under the
 * "e2b" key (never touches the real e2b SDK/network). `environments` is left
 * REAL so every lease is a genuine `environment_leases` row keyed on
 * `commander_conversation_id` (Commander has no agent row) and every assertion
 * is a real DB re-read.
 *
 * Proves the full warm CONVERSATION lifecycle end-to-end:
 *   turn 1 (warm)          → lease active + reuse_by_agent + commander_conversation_id set + agent_id NULL
 *   release turn 1         → lease paused (paused_at set, released_at NULL)
 *   turn 2 (same conv)     → RESUME the same providerLeaseId, NO new lease row
 *   different conversation → a distinct fresh lease (no cross-conversation resume)
 *   dead snapshot          → transparent create-fresh (new row), turn does NOT throw
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
const USER = randomUUID();
const PORT = 55600 + Math.floor(Math.random() * 400);

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-warm-conv-"));
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
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org WarmConv', 'org-warm-conv')`);
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co WarmConv', 'WCONV', ${ORG})`,
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

function fakeE2bProvider(): SandboxRuntimeProvider {
  return { ...createFakeSandboxRuntimeProvider(), provider: "e2b" };
}
function fakeRuntimeProviderKeys() {
  return { resolveCredential: async () => "fake-e2b-key-for-test" };
}

async function leaseRow(id: string) {
  const res = await db.execute(
    sql`SELECT id, status, agent_id, commander_conversation_id, lease_policy, provider_lease_id, paused_at, released_at FROM environment_leases WHERE id = ${id}`,
  );
  const rows = Array.isArray(res) ? res : (res as { rows: unknown[] }).rows;
  return (rows?.[0] ?? null) as
    | {
        id: string;
        status: string;
        agent_id: string | null;
        commander_conversation_id: string | null;
        lease_policy: string;
        provider_lease_id: string | null;
        paused_at: string | null;
        released_at: string | null;
      }
    | null;
}

async function countConversationLeases(conversationId: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM environment_leases WHERE commander_conversation_id = ${conversationId}`,
  );
  const rows = Array.isArray(res) ? res : (res as { rows: unknown[] }).rows;
  return Number((rows?.[0] as { n: number } | undefined)?.n ?? 0);
}

async function makeConversation(): Promise<string> {
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO internal_agent_conversations (id, company_id, user_id) VALUES (${id}, ${CO}, ${USER})`,
  );
  return id;
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "W7.5c: warm CONVERSATION acquire/release lifecycle against a genuine environment_leases table",
  () => {
    it("turn1 warm → active+reuse_by_agent+commander_conversation_id (agent_id NULL); release → paused; turn2 same conv RESUMES same providerLeaseId (no new row); other conv → distinct lease; dead → create-fresh (no throw)", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");

      const conv1 = await makeConversation();
      const conv2 = await makeConversation();

      const [envRow] = await db
        .insert(environments)
        .values({
          companyId: CO,
          name: "warm conv e2b env",
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
      const acquire = (conversationId: string, warmPreference: boolean) =>
        acquireExecutionContext(
          { orchestrator } as never,
          {
            // Commander: agentId null, functionType null, keyed on conversation.
            runIdentity: { companyId: CO, agentId: null, runId: randomUUID(), adapterType: "claude_local" },
            functionType: null,
            warmPreference,
            commanderConversationId: conversationId,
            worktree: null,
            environmentId: envRow!.id,
          },
        );

      // ── turn 1 (warm) ──────────────────────────────────────────────────
      const turn1 = await acquire(conv1, true);
      expect(turn1.sandbox).not.toBeNull();
      const lease1Id = turn1.sandbox!.lease.id;
      const lease1Provider = turn1.sandbox!.lease.providerLeaseId;
      const row1 = await leaseRow(lease1Id);
      expect(row1?.status).toBe("active");
      expect(row1?.lease_policy).toBe("reuse_by_agent"); // reused policy literal (resume KEY is the conv column)
      expect(row1?.commander_conversation_id).toBe(conv1); // W7.5c: conversation key MUST be persisted
      expect(row1?.agent_id).toBeNull(); // Commander has no agent row
      expect(row1?.provider_lease_id).toBeTruthy();

      // ── release turn 1 → pause (not kill) ──────────────────────────────
      const paused = await runtime.releaseRunLease({
        environment: turn1.sandbox!.environment,
        lease: turn1.sandbox!.lease,
        status: "released",
      });
      expect(paused?.status).toBe("paused");
      const pausedRow = await leaseRow(lease1Id);
      expect(pausedRow?.status).toBe("paused");
      expect(pausedRow?.paused_at).not.toBeNull();
      expect(pausedRow?.released_at).toBeNull(); // paused, NOT released
      expect(await countConversationLeases(conv1)).toBe(1);

      // ── turn 2 (same conversation) → RESUME the same lease, NO new row ──
      const turn2 = await acquire(conv1, true);
      expect(turn2.sandbox).not.toBeNull();
      expect(turn2.sandbox!.lease.id).toBe(lease1Id); // resumed the SAME row
      expect(turn2.sandbox!.lease.providerLeaseId).toBe(lease1Provider); // SAME providerLeaseId
      expect(turn2.sandbox!.lease.status).toBe("active");
      expect(await countConversationLeases(conv1)).toBe(1); // still ONE — resume, not create

      // ── a DIFFERENT conversation → its own fresh lease (no cross resume) ─
      const otherTurn = await acquire(conv2, true);
      expect(otherTurn.sandbox).not.toBeNull();
      expect(otherTurn.sandbox!.lease.id).not.toBe(lease1Id); // distinct row
      const otherRow = await leaseRow(otherTurn.sandbox!.lease.id);
      expect(otherRow?.commander_conversation_id).toBe(conv2);
      expect(await countConversationLeases(conv2)).toBe(1);
      // Release conv2 so it does not linger active across the dead-snapshot step.
      await runtime.releaseRunLease({
        environment: otherTurn.sandbox!.environment,
        lease: otherTurn.sandbox!.lease,
        status: "released",
      });

      // ── simulate a dead/GC'd snapshot → transparent create-fresh ───────
      // Pause turn 2 again, then mark the persisted snapshot dead so the fake
      // provider's resumeLease returns resumed:false.
      await runtime.releaseRunLease({
        environment: turn2.sandbox!.environment,
        lease: turn2.sandbox!.lease,
        status: "released",
      });
      await db.execute(
        sql`UPDATE environment_leases SET metadata = jsonb_set(metadata, '{providerMetadata,__dead}', 'true'::jsonb) WHERE id = ${lease1Id}`,
      );

      const turn3 = await acquire(conv1, true);
      expect(turn3.sandbox).not.toBeNull();
      expect(turn3.sandbox!.lease.id).not.toBe(lease1Id); // a FRESH lease row
      expect(turn3.sandbox!.lease.status).toBe("active");
      expect(turn3.sandbox!.lease.leasePolicy).toBe("reuse_by_agent");
      const freshRow = await leaseRow(turn3.sandbox!.lease.id);
      expect(freshRow?.commander_conversation_id).toBe(conv1);

      // The dead row was retired (expired), and a new active one exists.
      const deadRow = await leaseRow(lease1Id);
      expect(deadRow?.status).toBe("expired");
      // Two rows for the conversation now: the retired dead one + the fresh active one.
      expect(await countConversationLeases(conv1)).toBe(2);
    }, 60_000);
  },
);
