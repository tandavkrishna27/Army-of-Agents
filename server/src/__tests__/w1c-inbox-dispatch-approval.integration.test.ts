/**
 * W1c integration: Assist Inbox crew-dispatch approval round-trip.
 *
 * Real-Postgres proof that at Assist autonomy, committing a create_scope_draft
 * action:
 *   - auto-creates the assigned crew task(s) as 'planning' (W1b behaviour), and
 *   - enqueues ONE pending 'crew_dispatch' approval + a hub item (notifications row).
 * Then, resolving that approval:
 *   - approve  → the task flips 'planning'→'standard' AND a crew wakeup is enqueued.
 *   - reject   → the task stays 'planning' (parked) and NO wakeup is enqueued.
 *   - approve while the thread is crew_paused → preflightCrewDispatch blocks, so
 *       approve() throws inside the transaction and the WHOLE thing rolls back:
 *       the approval stays 'pending', the task stays 'planning', and no wakeup fires.
 *
 * Each case runs in an isolated company / thread / agent triple so they are
 * fully independent despite sharing the same embedded-postgres instance.
 *
 * Skipped on Windows (embedded-postgres / migration-chain issue — Issue #114);
 * Linux CI is the authoritative gate. Modeled on w1b-auto-accept.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  type Db,
} from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { threadAgentActionService } from "../services/thread-agent-actions.js";
import { captureFreshnessSnapshot } from "../services/thread-agent-action-freshness.js";
import { approvalService } from "../services/approvals.js";

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
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

// Offset by +3 from W1b's 59600 range to avoid port collision if both run together.
const PORT = 59603 + Math.floor(Math.random() * 400);

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<
    Record<string, unknown>
  >;
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function seedCompanyAndAgent(label: string): Promise<{
  companyId: string;
  agentId: string;
}> {
  const company = await companyService(db).create({ name: `W1c ${label} Co` } as never);
  const companyId = company.id;

  // Seed a founder user + user_roles row. companyService.create() does NOT create a
  // human owner, but emitHubItem() (via buildApprovalHubEmit) resolves an owner through
  // getFounderUserId() and THROWS if the company has none — which the Assist branch's
  // try/catch would then swallow, leaving the approval created but no hub (notifications)
  // row. A real board-deployed company always has a founder, so seed one here so the hub
  // item actually persists and Case 1 can observe it. (auth `user` table needs
  // id/name/email/created_at/updated_at; user_roles.userId FKs to it.)
  const founderUserId = `founder-${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES (${founderUserId}, ${`Founder ${label}`}, ${`${founderUserId}@example.test`}, now(), now())
  `);
  await db.execute(sql`
    INSERT INTO user_roles (id, company_id, user_id, role)
    VALUES (gen_random_uuid(), ${companyId}, ${founderUserId}, 'founder')
  `);

  // companyService.create() auto-seeds the AoA crew (incl. 'Engineer'); a second INSERT
  // would violate agents_aoa_name_per_company_idx. Reuse the seeded Engineer — the same
  // row resolveRoleToAgentId resolves for assigneeRole='engineer'. Fall back to an INSERT
  // only if a future create() stops seeding crew.
  let engRows = rowsOf(
    await db.execute(sql`
      SELECT id FROM agents
      WHERE company_id = ${companyId} AND kind = 'aoa' AND name = 'Engineer' AND status <> 'terminated'
      LIMIT 1
    `),
  );
  if (engRows.length === 0) {
    engRows = rowsOf(
      await db.execute(sql`
        INSERT INTO agents (id, company_id, name, kind, status)
        VALUES (gen_random_uuid(), ${companyId}, 'Engineer', 'aoa', 'idle')
        RETURNING id
      `),
    );
  }
  return { companyId, agentId: String(engRows[0].id) };
}

/**
 * Seed a thread + one discussion entry + one extracted 'insight' item.
 * The insight item maps to `memory_candidate` in the scope compiler
 * (mapExtractedItem returns memory_candidate for any type that is not
 * 'task', 'artifact', or 'decision').
 *
 * Returns { threadId, entryId, extractedItemId }.
 */
async function seedThreadWithInsight(companyId: string): Promise<{
  threadId: string;
  entryId: string;
  extractedItemId: string;
}> {
  const [thread] = rowsOf(
    await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by, entry_seq)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test', 1)
      RETURNING id
    `),
  );
  const threadId = String(thread.id);

  const [entry] = rowsOf(
    await db.execute(sql`
      INSERT INTO discussion_entries (id, discussion_id, input_type, raw_content, created_by, seq)
      VALUES (gen_random_uuid(), ${threadId}, 'write', 'let us scope the auth work', 'human-user', 1)
      RETURNING id
    `),
  );
  const entryId = String(entry.id);

  // Seed an extracted insight item (type='insight' → memory_candidate via mapExtractedItem).
  // status='pending' + null resultTaskId + null resultMemoryId → the compiler picks it up.
  const [extractedItem] = rowsOf(
    await db.execute(sql`
      INSERT INTO discussion_extracted_items
        (id, discussion_entry_id, type, title, status)
      VALUES
        (gen_random_uuid(), ${entryId}, 'insight', 'Use JWT for stateless auth', 'pending')
      RETURNING id
    `),
  );
  const extractedItemId = String(extractedItem.id);

  return { threadId, entryId, extractedItemId };
}

async function seedRun(companyId: string): Promise<string> {
  const [run] = rowsOf(
    await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test')
      RETURNING id
    `),
  );
  return String(run.id);
}

/**
 * Set the thread's autonomy_level column (0=Manual, 1=Assist, 2=Drive).
 * When set on the thread, the handler's effectiveAutonomy resolves to this
 * value rather than the company config's level.
 */
async function setThreadAutonomy(threadId: string, level: number): Promise<void> {
  await db.execute(sql`
    UPDATE discussions SET autonomy_level = ${level} WHERE id = ${threadId}
  `);
}

// ── embedded-postgres lifecycle ───────────────────────────────────────────────

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-w1c-dispatch-approval-integ-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      // Force UTF-8 so migration SQL containing non-Latin1 chars (e.g. '→' in a
      // comment) applies. Without this, initdb inherits the host locale (WIN1252 on
      // Windows) and the `postgres` DB rejects those bytes.
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
    console.error("[w1c-inbox-dispatch-approval] embedded-postgres setup failed:", err);
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
}, 60_000);

// ── test suite ────────────────────────────────────────────────────────────────

// Windows-skip: CI's `runneradmin` account can't start embedded-postgres (Issue #114).
// To run locally on Windows, temporarily flip this to `describe.skipIf(false)` — the
// UTF-8 initdbFlags above make the cluster locale-safe.
describe.skipIf(process.platform === "win32")("W1c integration: Assist crew-dispatch approval", () => {

  // ── Case 1: Assist commit → planning task + pending approval + hub item ──────

  it("Assist: commit creates planning tasks + a PENDING crew_dispatch approval + a hub item", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("Assist");
    const { threadId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 1); // Assist

    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
         ${JSON.stringify({ summary: "Auth scope", proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }] })}::jsonb,
         ${`k:w1c:assist:${actionId}`}, ${JSON.stringify(snap)}::jsonb)
    `);

    const commitResult = await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId });
    expect(commitResult.committed).toBe(1);

    // Tasks exist as planning, assigned to Engineer.
    const issueRows = rowsOf(await db.execute(sql`
      SELECT id, assignee_agent_id, work_mode FROM issues WHERE source_discussion_id = ${threadId}
    `));
    expect(issueRows).toHaveLength(1);
    expect(String(issueRows[0].work_mode)).toBe("planning");
    const issueId = String(issueRows[0].id);

    // A pending crew_dispatch approval referencing that task exists.
    const apRows = rowsOf(await db.execute(sql`
      SELECT id, status, payload FROM approvals WHERE company_id = ${companyId} AND type = 'crew_dispatch'
    `));
    expect(apRows).toHaveLength(1);
    expect(String(apRows[0].status)).toBe("pending");
    expect((apRows[0].payload as { taskIds?: string[] }).taskIds).toContain(issueId);

    // A hub item (notifications row) surfaced it.
    const hubRows = rowsOf(await db.execute(sql`
      SELECT id FROM notifications WHERE company_id = ${companyId} AND source_type = 'approval' AND source_id = ${String(apRows[0].id)}
    `));
    expect(hubRows.length).toBeGreaterThanOrEqual(1);

    // No wakeup yet. (agent_wakeup_requests has NO issue_id column — crew wakeups
    // store the issue id in the payload jsonb.)
    const wake = rowsOf(await db.execute(sql`
      SELECT id FROM agent_wakeup_requests WHERE agent_id = ${agentId} AND payload->>'issueId' = ${issueId}
    `));
    expect(wake).toHaveLength(0);
  });

  // ── Case 2: approve → flip planning→standard + enqueue a wakeup ──────────────

  it("approve: flips the tasks to standard and enqueues a wakeup", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("AssistApprove");
    const { threadId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 1);
    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
        ${JSON.stringify({ summary: "Auth scope", proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }] })}::jsonb,
        ${`k:w1c:approve:${actionId}`}, ${JSON.stringify(snap)}::jsonb)
    `);
    await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId });

    const apRows = rowsOf(await db.execute(sql`SELECT id FROM approvals WHERE company_id = ${companyId} AND type = 'crew_dispatch'`));
    const approvalId = String(apRows[0].id);
    const issueRows = rowsOf(await db.execute(sql`SELECT id FROM issues WHERE source_discussion_id = ${threadId}`));
    const issueId = String(issueRows[0].id);

    // Approve within a transaction, exactly like the /approvals/:id/approve route.
    await db.transaction(async (tx) => {
      await approvalService(tx as never).approve(approvalId, companyId, "local-board", null);
    });

    const afterWorkMode = rowsOf(await db.execute(sql`SELECT work_mode FROM issues WHERE id = ${issueId}`));
    expect(String(afterWorkMode[0].work_mode)).toBe("standard");
    // agent_wakeup_requests has NO issue_id column — crew wakeups store the id in payload jsonb.
    const wake = rowsOf(await db.execute(sql`
      SELECT id FROM agent_wakeup_requests WHERE agent_id = ${agentId} AND payload->>'issueId' = ${issueId}
    `));
    expect(wake.length).toBeGreaterThanOrEqual(1);
  });

  // ── Case 3: reject → parked (stays planning), no wakeup ──────────────────────

  it("reject: leaves the tasks as planning and enqueues NO wakeup", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("AssistReject");
    const { threadId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 1);
    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
        ${JSON.stringify({ summary: "Auth scope", proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }] })}::jsonb,
        ${`k:w1c:reject:${actionId}`}, ${JSON.stringify(snap)}::jsonb)
    `);
    await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId });

    const apRows = rowsOf(await db.execute(sql`SELECT id FROM approvals WHERE company_id = ${companyId} AND type = 'crew_dispatch'`));
    const approvalId = String(apRows[0].id);
    const issueRows = rowsOf(await db.execute(sql`SELECT id FROM issues WHERE source_discussion_id = ${threadId}`));
    const issueId = String(issueRows[0].id);

    await db.transaction(async (tx) => {
      await approvalService(tx as never).reject(approvalId, companyId, "local-board", "not now");
    });

    const afterWorkMode = rowsOf(await db.execute(sql`SELECT work_mode FROM issues WHERE id = ${issueId}`));
    expect(String(afterWorkMode[0].work_mode)).toBe("planning");
    // agent_wakeup_requests has NO issue_id column — crew wakeups store the id in payload jsonb.
    const wake = rowsOf(await db.execute(sql`SELECT id FROM agent_wakeup_requests WHERE agent_id = ${agentId} AND payload->>'issueId' = ${issueId}`));
    expect(wake).toHaveLength(0);
  });

  // ── Case 4: approve under a preflight block (thread paused) → throws + rolls back ─

  it("approve under a budget hard-stop throws, leaves the approval pending + tasks planning, dispatches nothing", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("AssistBlocked");
    const { threadId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 1);
    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
        ${JSON.stringify({ summary: "Auth scope", proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }] })}::jsonb,
        ${`k:w1c:blocked:${actionId}`}, ${JSON.stringify(snap)}::jsonb)
    `);
    await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId });

    // Pause the thread → preflightCrewDispatch returns { allowed:false, reasonCode:'thread_paused' }.
    await db.execute(sql`UPDATE discussions SET crew_paused = true WHERE id = ${threadId}`);

    const apRows = rowsOf(await db.execute(sql`SELECT id FROM approvals WHERE company_id = ${companyId} AND type = 'crew_dispatch'`));
    const approvalId = String(apRows[0].id);
    const issueRows = rowsOf(await db.execute(sql`SELECT id FROM issues WHERE source_discussion_id = ${threadId}`));
    const issueId = String(issueRows[0].id);

    // approve() throws inside the tx → the whole approval rolls back.
    let threw = false;
    try {
      await db.transaction(async (tx) => {
        await approvalService(tx as never).approve(approvalId, companyId, "local-board", null);
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Approval stays pending, task stays planning, no wakeup.
    const [ap] = rowsOf(await db.execute(sql`SELECT status FROM approvals WHERE id = ${approvalId}`));
    expect(String(ap.status)).toBe("pending");
    const [wm] = rowsOf(await db.execute(sql`SELECT work_mode FROM issues WHERE id = ${issueId}`));
    expect(String(wm.work_mode)).toBe("planning");
    const wake = rowsOf(await db.execute(sql`SELECT id FROM agent_wakeup_requests WHERE agent_id = ${agentId} AND payload->>'issueId' = ${issueId}`));
    expect(wake).toHaveLength(0);
  });
});
