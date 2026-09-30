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

const PORT = 56000 + Math.floor(Math.random() * 1000);

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code =
    (error as { code?: string }).code ??
    (error as { cause?: { code?: string } }).cause?.code;
  return code === "23505";
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-ew-unique-test-"));
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

    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    // ignore cleanup failures
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}, 60_000);

describe.skipIf(process.platform === "win32")(
  "execution_workspaces active task uniqueness — real DB",
  () => {
    it("rejects two non-archived task-owned rows and allows a new row after archiving", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }

      const companyId = "11111111-1111-4111-8111-111111111111";
      const projectId = "22222222-2222-4222-8222-222222222222";
      const projectWorkspaceId = "33333333-3333-4333-8333-333333333333";
      const issueId = "44444444-4444-4444-8444-444444444444";
      const firstWorkspaceId = "55555555-5555-4555-8555-555555555555";
      const secondWorkspaceId = "66666666-6666-4666-8666-666666666666";

      await db.execute(sql`
        INSERT INTO companies (id, name, issue_prefix)
        VALUES (${companyId}, 'Execution Workspace Unique Co', 'EWU')
      `);
      await db.execute(sql`
        INSERT INTO projects (id, company_id, name)
        VALUES (${projectId}, ${companyId}, 'Engineering')
      `);
      await db.execute(sql`
        INSERT INTO project_workspaces (id, company_id, project_id, name, cwd)
        VALUES (${projectWorkspaceId}, ${companyId}, ${projectId}, 'Primary', '/tmp/ewu')
      `);
      await db.execute(sql`
        INSERT INTO issues (id, company_id, project_id, title, identifier)
        VALUES (${issueId}, ${companyId}, ${projectId}, 'Unique workspace proof', 'EWU-1')
      `);
      await db.execute(sql`
        INSERT INTO execution_workspaces (
          id, company_id, project_id, project_workspace_id, source_issue_id,
          mode, strategy_type, name, status, provider_type, cwd
        )
        VALUES (
          ${firstWorkspaceId}, ${companyId}, ${projectId}, ${projectWorkspaceId}, ${issueId},
          'isolated_workspace', 'git_worktree', 'EWU-1-a', 'active', 'git_worktree', '/tmp/ewu-a'
        )
      `);

      await expect(db.execute(sql`
        INSERT INTO execution_workspaces (
          id, company_id, project_id, project_workspace_id, source_issue_id,
          mode, strategy_type, name, status, provider_type, cwd
        )
        VALUES (
          ${secondWorkspaceId}, ${companyId}, ${projectId}, ${projectWorkspaceId}, ${issueId},
          'isolated_workspace', 'git_worktree', 'EWU-1-b', 'active', 'git_worktree', '/tmp/ewu-b'
        )
      `)).rejects.toSatisfy(isUniqueViolation);

      await db.execute(sql`
        UPDATE execution_workspaces
        SET status = 'archived'
        WHERE id = ${firstWorkspaceId}
      `);

      await expect(db.execute(sql`
        INSERT INTO execution_workspaces (
          id, company_id, project_id, project_workspace_id, source_issue_id,
          mode, strategy_type, name, status, provider_type, cwd
        )
        VALUES (
          ${secondWorkspaceId}, ${companyId}, ${projectId}, ${projectWorkspaceId}, ${issueId},
          'isolated_workspace', 'git_worktree', 'EWU-1-b', 'active', 'git_worktree', '/tmp/ewu-b'
        )
      `)).resolves.toBeTruthy();
    });
  },
);
