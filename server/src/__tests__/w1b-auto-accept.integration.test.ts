/**
 * W1b integration: autonomy-gated auto-accept of controller scope drafts.
 *
 * Real-Postgres proof that commitThreadAgentActions auto-accepts per autonomy:
 *   - Manual (autonomyLevel=0): draft created, zero issues rows, version stays 'draft'.
 *   - Assist (autonomyLevel=1): task_proposal → issues row (assignee=Engineer,
 *       work_mode='planning'), no agent_wakeup_requests row.
 *   - Drive  (autonomyLevel=2): issues row (work_mode='standard') + wakeup row.
 *   - No-strand invariant (Assist + Drive): the memory_candidate scope item stays
 *       status='draft' + null result_memory_id, AND the scope version stays 'draft'
 *       (NOT 'accepted') — proving createOutputItem left the version open for the
 *       founder to approve the memory item (W1b-1 regression guard, Decision B7).
 *
 * Each case runs in an isolated company / thread / agent triple so they are
 * fully independent despite sharing the same embedded-postgres instance.
 *
 * Skipped on Windows (embedded-postgres / migration-chain issue — Issue #114);
 * Linux CI is the authoritative gate. Modeled on w1a-crew-assignment.integration.test.ts.
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

// Offset from W1a's 59100 range to avoid port collision if both run together.
const PORT = 59600 + Math.floor(Math.random() * 400);

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
  const company = await companyService(db).create({ name: `W1b ${label} Co` } as never);
  const companyId = company.id;
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
    dataDir = await mkdtemp(join(tmpdir(), "aoa-w1b-auto-accept-integ-"));
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
    console.error("[w1b-auto-accept] embedded-postgres setup failed:", err);
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
describe.skipIf(process.platform === "win32")("W1b integration: autonomy-gated auto-accept", () => {

  // ── Case 1: Manual (autonomyLevel=0) ─────────────────────────────────────

  it("Manual (autonomyLevel=0): commits draft but creates zero issues rows and leaves version 'draft'", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("Manual");
    const { threadId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 0);

    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();

    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
         ${JSON.stringify({
           summary: "Auth scope",
           proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
         })}::jsonb,
         ${`k:w1b:manual:${actionId}`},
         ${JSON.stringify(snap)}::jsonb)
    `);

    const svc = threadAgentActionService(db);
    const commitResult = await svc.commitThreadAgentActions({ companyId, threadId, runId });
    expect(commitResult.committed).toBe(1);
    expect(commitResult.failed).toBe(0);

    // The action should be committed and have a scope version.
    const [actionRow] = rowsOf(
      await db.execute(sql`
        SELECT status, committed_scope_version_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(actionRow.status)).toBe("committed");
    expect(actionRow.committed_scope_version_id).toBeTruthy();
    const scopeVersionId = String(actionRow.committed_scope_version_id);

    // Scope version should still be 'draft' — Manual = no auto-accept.
    const [versionRow] = rowsOf(
      await db.execute(sql`
        SELECT status FROM thread_scope_versions WHERE id = ${scopeVersionId}
      `),
    );
    expect(String(versionRow.status)).toBe("draft");

    // Zero issues rows should have been created for this thread.
    const issueRows = rowsOf(
      await db.execute(sql`
        SELECT id FROM issues WHERE source_discussion_id = ${threadId}
      `),
    );
    expect(issueRows).toHaveLength(0);
  });

  // ── Case 2: Assist (autonomyLevel=1) ─────────────────────────────────────

  it("Assist (autonomyLevel=1): creates assigned planning issue; no wakeup; version stays draft (no-strand)", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("Assist");
    const { threadId, extractedItemId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 1);

    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();

    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
         ${JSON.stringify({
           summary: "Auth scope",
           proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
         })}::jsonb,
         ${`k:w1b:assist:${actionId}`},
         ${JSON.stringify(snap)}::jsonb)
    `);

    const svc = threadAgentActionService(db);
    const commitResult = await svc.commitThreadAgentActions({ companyId, threadId, runId });
    expect(commitResult.committed).toBe(1);
    expect(commitResult.failed).toBe(0);

    const [actionRow] = rowsOf(
      await db.execute(sql`
        SELECT status, committed_scope_version_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(actionRow.status)).toBe("committed");
    expect(actionRow.committed_scope_version_id).toBeTruthy();
    const scopeVersionId = String(actionRow.committed_scope_version_id);

    // ── Assist: one issues row, assigned to Engineer, work_mode='planning' ──
    const issueRows = rowsOf(
      await db.execute(sql`
        SELECT id, assignee_agent_id, work_mode FROM issues WHERE source_discussion_id = ${threadId}
      `),
    );
    expect(issueRows).toHaveLength(1);
    const issueRow = issueRows[0];
    expect(String(issueRow.assignee_agent_id)).toBe(agentId);
    expect(String(issueRow.work_mode)).toBe("planning");
    const issueId = String(issueRow.id);

    // ── Assist: NO wakeup row (planning mode tasks are not dispatched) ───────
    const wakeupRows = rowsOf(
      await db.execute(sql`
        SELECT id FROM agent_wakeup_requests
        WHERE agent_id = ${agentId} AND payload->>'issueId' = ${issueId}
      `),
    );
    expect(wakeupRows).toHaveLength(0);

    // ── No-strand invariant: task_proposal item is 'applied' with result_issue_id ─
    const taskItems = rowsOf(
      await db.execute(sql`
        SELECT id, status, result_issue_id FROM thread_scope_items
        WHERE scope_version_id = ${scopeVersionId} AND kind = 'task_proposal'
      `),
    );
    expect(taskItems).toHaveLength(1);
    expect(String(taskItems[0].status)).toBe("applied");
    expect(taskItems[0].result_issue_id).toBeTruthy();

    // ── No-strand invariant: memory_candidate item is still 'draft', null result ─
    // The extracted insight was mapped to a memory_candidate scope item.
    // createOutputItem was NOT called for it — it must remain 'draft'.
    const memItems = rowsOf(
      await db.execute(sql`
        SELECT id, status, result_memory_id FROM thread_scope_items
        WHERE scope_version_id = ${scopeVersionId} AND kind = 'memory_candidate'
      `),
    );
    expect(memItems.length).toBeGreaterThanOrEqual(1);
    for (const memItem of memItems) {
      expect(String(memItem.status)).toBe("draft");
      expect(memItem.result_memory_id).toBeNull();
    }

    // ── No-strand invariant: version is still 'draft' (NOT 'accepted') ────────
    // Because the memory_candidate is still 'draft' (non-terminal),
    // maybeAcceptDraftAfterDirectCreate won't auto-accept the version.
    const [versionRow] = rowsOf(
      await db.execute(sql`
        SELECT status FROM thread_scope_versions WHERE id = ${scopeVersionId}
      `),
    );
    expect(String(versionRow.status)).toBe("draft");

    // Sanity: the extracted item we seeded should still be pending (untouched).
    const [extItem] = rowsOf(
      await db.execute(sql`
        SELECT status FROM discussion_extracted_items WHERE id = ${extractedItemId}
      `),
    );
    expect(String(extItem.status)).toBe("pending");
  });

  // ── Case 3: Drive (autonomyLevel=2) ──────────────────────────────────────

  it("Drive (autonomyLevel=2): creates standard issue + wakeup row; version stays draft (no-strand)", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("Drive");
    const { threadId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 2);

    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();

    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
         ${JSON.stringify({
           summary: "Auth scope",
           proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
         })}::jsonb,
         ${`k:w1b:drive:${actionId}`},
         ${JSON.stringify(snap)}::jsonb)
    `);

    const svc = threadAgentActionService(db);
    const commitResult = await svc.commitThreadAgentActions({ companyId, threadId, runId });
    expect(commitResult.committed).toBe(1);
    expect(commitResult.failed).toBe(0);

    const [actionRow] = rowsOf(
      await db.execute(sql`
        SELECT status, committed_scope_version_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(actionRow.status)).toBe("committed");
    expect(actionRow.committed_scope_version_id).toBeTruthy();
    const scopeVersionId = String(actionRow.committed_scope_version_id);

    // ── Drive: one issues row, assigned to Engineer, work_mode='standard' ────
    const issueRows = rowsOf(
      await db.execute(sql`
        SELECT id, assignee_agent_id, work_mode FROM issues WHERE source_discussion_id = ${threadId}
      `),
    );
    expect(issueRows).toHaveLength(1);
    const issueRow = issueRows[0];
    expect(String(issueRow.assignee_agent_id)).toBe(agentId);
    expect(String(issueRow.work_mode)).toBe("standard");
    const issueId = String(issueRow.id);

    // ── Drive: a wakeup row exists for (Engineer, issue) ─────────────────────
    const wakeupRows = rowsOf(
      await db.execute(sql`
        SELECT id FROM agent_wakeup_requests
        WHERE agent_id = ${agentId} AND payload->>'issueId' = ${issueId}
      `),
    );
    expect(wakeupRows.length).toBeGreaterThanOrEqual(1);

    // ── No-strand invariant: task_proposal item is 'applied' ─────────────────
    const taskItems = rowsOf(
      await db.execute(sql`
        SELECT id, status, result_issue_id FROM thread_scope_items
        WHERE scope_version_id = ${scopeVersionId} AND kind = 'task_proposal'
      `),
    );
    expect(taskItems).toHaveLength(1);
    expect(String(taskItems[0].status)).toBe("applied");
    expect(taskItems[0].result_issue_id).toBeTruthy();

    // ── No-strand invariant: memory_candidate item is still 'draft' ──────────
    const memItems = rowsOf(
      await db.execute(sql`
        SELECT id, status, result_memory_id FROM thread_scope_items
        WHERE scope_version_id = ${scopeVersionId} AND kind = 'memory_candidate'
      `),
    );
    expect(memItems.length).toBeGreaterThanOrEqual(1);
    for (const memItem of memItems) {
      expect(String(memItem.status)).toBe("draft");
      expect(memItem.result_memory_id).toBeNull();
    }

    // ── No-strand invariant: version is still 'draft' (NOT 'accepted') ────────
    const [versionRow] = rowsOf(
      await db.execute(sql`
        SELECT status FROM thread_scope_versions WHERE id = ${scopeVersionId}
      `),
    );
    expect(String(versionRow.status)).toBe("draft");
  });

  // ── Case 4: Drive (autonomyLevel=2) but the crew dispatch preflight BLOCKS ──
  //
  // Codex #265 P1: a paused thread (crew_paused=true, a founder kill-switch that
  // preflightCrewDispatch reports as `thread_paused`) must stop the Drive path from
  // applying OR dispatching. The draft is committed but left for manual accept:
  // zero issues rows, zero wakeup rows, task item stays 'draft', version stays 'draft'.

  it("Drive but preflight-blocked (thread paused): commits draft, creates NO issues and NO wakeup, leaves items draft", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("DrivePaused");
    const { threadId } = await seedThreadWithInsight(companyId);
    await setThreadAutonomy(threadId, 2);
    // Founder pause → preflightCrewDispatch returns { allowed:false, reasonCode:'thread_paused' }.
    await db.execute(sql`UPDATE discussions SET crew_paused = true WHERE id = ${threadId}`);

    const snap = await captureFreshnessSnapshot(db as never, threadId);
    const runId = await seedRun(companyId);
    const actionId = randomUUID();

    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
         ${JSON.stringify({
           summary: "Auth scope",
           proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
         })}::jsonb,
         ${`k:w1b:drive-paused:${actionId}`},
         ${JSON.stringify(snap)}::jsonb)
    `);

    const svc = threadAgentActionService(db);
    const commitResult = await svc.commitThreadAgentActions({ companyId, threadId, runId });
    // Action still commits (the draft was created); only the auto-accept was skipped.
    expect(commitResult.committed).toBe(1);
    expect(commitResult.failed).toBe(0);

    const [actionRow] = rowsOf(
      await db.execute(sql`
        SELECT status, committed_scope_version_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(actionRow.status)).toBe("committed");
    const scopeVersionId = String(actionRow.committed_scope_version_id);

    // ── Blocked: NO issues rows (nothing applied) ────────────────────────────
    const issueRows = rowsOf(
      await db.execute(sql`
        SELECT id FROM issues WHERE source_discussion_id = ${threadId}
      `),
    );
    expect(issueRows).toHaveLength(0);

    // ── Blocked: NO wakeup rows ──────────────────────────────────────────────
    const wakeupRows = rowsOf(
      await db.execute(sql`
        SELECT id FROM agent_wakeup_requests WHERE agent_id = ${agentId}
      `),
    );
    expect(wakeupRows).toHaveLength(0);

    // ── Draft left for manual accept: task item stays 'draft', version stays 'draft' ──
    const taskItems = rowsOf(
      await db.execute(sql`
        SELECT status, result_issue_id FROM thread_scope_items
        WHERE scope_version_id = ${scopeVersionId} AND kind = 'task_proposal'
      `),
    );
    expect(taskItems).toHaveLength(1);
    expect(String(taskItems[0].status)).toBe("draft");
    expect(taskItems[0].result_issue_id).toBeNull();

    const [versionRow] = rowsOf(
      await db.execute(sql`
        SELECT status FROM thread_scope_versions WHERE id = ${scopeVersionId}
      `),
    );
    expect(String(versionRow.status)).toBe("draft");
  });
});
