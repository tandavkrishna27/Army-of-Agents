/**
 * Real-DB integration test for companies.remove().
 *
 * Boots an embedded-postgres instance, applies all migrations, seeds a
 * company with rows in EVERY child table that references companies.id
 * (or that needs to be cleared by remove() before its parent), and then
 * calls companyService.remove() asserting success and full cleanup.
 *
 * This is the test that would have caught the issue_read_states (53a2c2f)
 * and assets (f21bbbe) bugs before they shipped — and it now provides
 * comprehensive verification of the 0066 cascade sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  type Db,
} from "@armyofagents/db";
import { companyService } from "../services/companies.js";

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
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let connectionString = "";
let db: Db;
let svc: ReturnType<typeof companyService>;
let setupError: unknown = null;

// Normalize an `INSERT ... RETURNING id` result across the two shapes
// drizzle's `db.execute()` may return (postgres-js array vs. node-pg
// `{rows}` envelope), and pull out the first row's `id` column.
function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as any)?.id;
  return (result as any).rows?.[0]?.id;
}

// Random port between 55000-55999 to avoid collisions with other test runs
const PORT = 55000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-fk-cascade-test-"));
    const { default: EmbeddedPostgres } = (await import(
      "embedded-postgres"
    )) as { default: EmbeddedPostgresCtor };

    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();

    connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);

    db = createDb(connectionString);
    svc = companyService(db);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error(
      "[companies-delete-integration] embedded-postgres setup failed:",
      err,
    );
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    // ignore
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}, 60_000);

// Run only on Linux CI. This heavyweight embedded-postgres cascade test already
// exercises the platform-independent service/migration contract in the primary
// verify job; Windows has a known initdb encoding issue, and macOS runners have
// shown intermittent embedded-postgres setup/teardown timeouts in full-suite
// cross-platform runs.
describe.skipIf(process.platform !== "linux")(
  "companies.remove() — real DB integration (0066 cascade sweep)",
  () => {
    it("deletes a company with rows in every child table", async () => {
      if (setupError) {
        throw new Error(
          `embedded-postgres setup failed; cannot run integration test: ${String(setupError)}`,
        );
      }

      // ── 1. Create core entities ─────────────────────────────────────
      const company = await svc.create({
        name: "FK Cascade Sweep Co",
        description: "Integration test for migration 0066",
      });
      expect(company).toBeDefined();
      const companyId = company!.id;

      // Insert dependency tree using raw SQL (works regardless of
      // schema-helper drift). We only insert NOT-NULL columns and let
      // defaults handle the rest.
      const agentInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO agents (id, company_id, name, role, status, adapter_type, runtime_config, adapter_config, permissions, skill_keys, budget_monthly_cents, spent_monthly_cents)
        VALUES (gen_random_uuid(), ${companyId}, 'agent-a', 'general', 'idle', 'process', '{}', '{}', '{}', '[]', 0, 0)
        RETURNING id
      `);
      const agentId = firstId(agentInserted);
      expect(agentId).toBeTruthy();

      const projectInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO projects (id, company_id, name, type, status)
        VALUES (gen_random_uuid(), ${companyId}, 'proj-a', 'project', 'backlog')
        RETURNING id
      `);
      const projectId = firstId(projectInserted);
      expect(projectId).toBeTruthy();

      const goalInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO goals (id, company_id, title, level, status)
        VALUES (gen_random_uuid(), ${companyId}, 'goal-a', 'task', 'planned')
        RETURNING id
      `);
      const goalId = firstId(goalInserted);
      expect(goalId).toBeTruthy();

      const issueInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO issues (id, company_id, project_id, title, status, priority, request_depth)
        VALUES (gen_random_uuid(), ${companyId}, ${projectId}, 'issue-a', 'backlog', 'medium', 0)
        RETURNING id
      `);
      const issueId = firstId(issueInserted);
      expect(issueId).toBeTruthy();

      const runInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO heartbeat_runs (id, company_id, agent_id, status)
        VALUES (gen_random_uuid(), ${companyId}, ${agentId}, 'queued')
        RETURNING id
      `);
      const runId = firstId(runInserted);
      expect(runId).toBeTruthy();

      const approvalInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO approvals (id, company_id, type, status, payload)
        VALUES (gen_random_uuid(), ${companyId}, 'test', 'pending', '{}')
        RETURNING id
      `);
      const approvalId = firstId(approvalInserted);
      expect(approvalId).toBeTruthy();

      // Documents (must exist before document_revisions)
      const documentInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO documents (id, company_id, format, latest_body, latest_revision_number)
        VALUES (gen_random_uuid(), ${companyId}, 'markdown', 'hello', 1)
        RETURNING id
      `);
      const documentId = firstId(documentInserted);
      expect(documentId).toBeTruthy();

      // Assets (for issue_attachments)
      const assetInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO assets (id, company_id, provider, object_key, content_type, byte_size, sha256)
        VALUES (gen_random_uuid(), ${companyId}, 'local', 'k1', 'text/plain', 10, 'abc')
        RETURNING id
      `);
      const assetId = firstId(assetInserted);
      expect(assetId).toBeTruthy();

      // Project workspace (for execution_workspaces)
      const projectWsInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO project_workspaces (id, company_id, project_id, name, source_type, visibility, is_primary)
        VALUES (gen_random_uuid(), ${companyId}, ${projectId}, 'pw-a', 'local_path', 'default', false)
        RETURNING id
      `);
      const projectWorkspaceId = firstId(projectWsInserted);
      expect(projectWorkspaceId).toBeTruthy();

      // Execution workspace
      const execWsInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO execution_workspaces (id, company_id, project_id, project_workspace_id, mode, strategy_type, name, status, provider_type)
        VALUES (gen_random_uuid(), ${companyId}, ${projectId}, ${projectWorkspaceId}, 'isolated', 'project_primary', 'ew-a', 'active', 'local_fs')
        RETURNING id
      `);
      const executionWorkspaceId = firstId(execWsInserted);
      expect(executionWorkspaceId).toBeTruthy();

      // ── 2. Insert one row per newly-swept table ─────────────────────

      // agent_config_revisions
      await db.execute(sql`
        INSERT INTO agent_config_revisions (id, company_id, agent_id, source, changed_keys, before_config, after_config)
        VALUES (gen_random_uuid(), ${companyId}, ${agentId}, 'patch', '[]', '{}', '{}')
      `);

      // agent_projects
      await db.execute(sql`
        INSERT INTO agent_projects (agent_id, project_id, company_id)
        VALUES (${agentId}, ${projectId}, ${companyId})
      `);

      // company_skills
      await db.execute(sql`
        INSERT INTO company_skills (id, company_id, key, slug, name, markdown, source_type, trust_level, compatibility, file_inventory)
        VALUES (gen_random_uuid(), ${companyId}, 'k1', 's1', 'Skill 1', '# md', 'local_path', 'markdown_only', 'compatible', '[]')
      `);

      // documents already inserted
      // document_revisions
      await db.execute(sql`
        INSERT INTO document_revisions (id, company_id, document_id, revision_number, body)
        VALUES (gen_random_uuid(), ${companyId}, ${documentId}, 1, 'hello')
      `);

      // execution_workspaces already inserted
      // feedback_votes
      const feedbackVoteInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO feedback_votes (id, company_id, issue_id, target_type, target_id, author_user_id, vote)
        VALUES (gen_random_uuid(), ${companyId}, ${issueId}, 'comment', 'tid', 'u1', 'up')
        RETURNING id
      `);
      const feedbackVoteId = firstId(feedbackVoteInserted);
      expect(feedbackVoteId).toBeTruthy();

      // feedback_exports
      await db.execute(sql`
        INSERT INTO feedback_exports (id, company_id, feedback_vote_id, issue_id, author_user_id, target_type, target_id, vote, target_summary)
        VALUES (gen_random_uuid(), ${companyId}, ${feedbackVoteId}, ${issueId}, 'u1', 'comment', 'tid', 'up', '{}')
      `);

      // finance_events
      await db.execute(sql`
        INSERT INTO finance_events (id, company_id, agent_id, issue_id, project_id, goal_id, heartbeat_run_id, event_kind, biller, amount_cents, currency, occurred_at)
        VALUES (gen_random_uuid(), ${companyId}, ${agentId}, ${issueId}, ${projectId}, ${goalId}, ${runId}, 'usage', 'anthropic', 100, 'USD', NOW())
      `);

      // heartbeat_run_watchdog_decisions
      await db.execute(sql`
        INSERT INTO heartbeat_run_watchdog_decisions (id, company_id, run_id, evaluation_issue_id, decision, created_by_agent_id, created_by_run_id)
        VALUES (gen_random_uuid(), ${companyId}, ${runId}, ${issueId}, 'continue', ${agentId}, ${runId})
      `);

      // issue_approvals
      await db.execute(sql`
        INSERT INTO issue_approvals (company_id, issue_id, approval_id, linked_by_agent_id)
        VALUES (${companyId}, ${issueId}, ${approvalId}, ${agentId})
      `);

      // issue_attachments
      await db.execute(sql`
        INSERT INTO issue_attachments (id, company_id, issue_id, asset_id)
        VALUES (gen_random_uuid(), ${companyId}, ${issueId}, ${assetId})
      `);

      // issue_documents
      await db.execute(sql`
        INSERT INTO issue_documents (id, company_id, issue_id, document_id, key)
        VALUES (gen_random_uuid(), ${companyId}, ${issueId}, ${documentId}, 'k1')
      `);

      // project_goals
      await db.execute(sql`
        INSERT INTO project_goals (project_id, goal_id, company_id)
        VALUES (${projectId}, ${goalId}, ${companyId})
      `);

      // project_workspaces already inserted
      // workspace_operations
      await db.execute(sql`
        INSERT INTO workspace_operations (id, company_id, execution_workspace_id, heartbeat_run_id, phase, status)
        VALUES (gen_random_uuid(), ${companyId}, ${executionWorkspaceId}, ${runId}, 'provision', 'running')
      `);

      // workspace_runtime_services
      await db.execute(sql`
        INSERT INTO workspace_runtime_services (id, company_id, project_id, project_workspace_id, execution_workspace_id, issue_id, scope_type, service_name, status, lifecycle, provider, owner_agent_id, started_by_run_id, health_status)
        VALUES (gen_random_uuid(), ${companyId}, ${projectId}, ${projectWorkspaceId}, ${executionWorkspaceId}, ${issueId}, 'execution_workspace', 'dev-server', 'running', 'long_running', 'process', ${agentId}, ${runId}, 'healthy')
      `);

      // ── 3. Verify rows exist ────────────────────────────────────────
      const tablesToCheck = [
        "agent_config_revisions",
        "agent_projects",
        "company_skills",
        "document_revisions",
        "documents",
        "execution_workspaces",
        "feedback_exports",
        "feedback_votes",
        "finance_events",
        "heartbeat_run_watchdog_decisions",
        "issue_approvals",
        "issue_attachments",
        "issue_documents",
        "project_goals",
        "project_workspaces",
        "workspace_operations",
        "workspace_runtime_services",
      ];
      for (const table of tablesToCheck) {
        const rows = await db.execute<{ count: string }>(
          sql.raw(
            `SELECT count(*)::text AS count FROM ${table} WHERE company_id = '${companyId}'`,
          ),
        );
        const count = Array.isArray(rows)
          ? Number(rows[0]?.count ?? 0)
          : Number((rows as any).rows?.[0]?.count ?? 0);
        expect(count, `${table} should have at least 1 row before remove`).toBeGreaterThanOrEqual(1);
      }

      // ── 4. Call remove() and assert success ─────────────────────────
      const removed = await svc.remove(companyId);
      expect(removed).toBeDefined();
      expect(removed?.id).toBe(companyId);

      // ── 5. All child rows gone ──────────────────────────────────────
      for (const table of tablesToCheck) {
        const rows = await db.execute<{ count: string }>(
          sql.raw(
            `SELECT count(*)::text AS count FROM ${table} WHERE company_id = '${companyId}'`,
          ),
        );
        const count = Array.isArray(rows)
          ? Number(rows[0]?.count ?? 0)
          : Number((rows as any).rows?.[0]?.count ?? 0);
        expect(count, `${table} should have 0 rows after remove`).toBe(0);
      }

      // Companies row also gone
      const companyRowsResult = await db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM companies WHERE id = ${companyId}`,
      );
      const companyCount = Array.isArray(companyRowsResult)
        ? Number(companyRowsResult[0]?.count ?? 0)
        : Number((companyRowsResult as any).rows?.[0]?.count ?? 0);
      expect(companyCount).toBe(0);
    }, 90_000);
  },
);
