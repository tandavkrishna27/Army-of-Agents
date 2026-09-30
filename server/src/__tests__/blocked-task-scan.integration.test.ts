import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { blockedTaskScan } from "../services/internal-agent/proactive.js";

// A-M14 — blockedTaskScan must (1) only count an in-progress task as blocked
// when at least one of its dependencies is genuinely incomplete (the dependency
// issue's status is non-terminal), and (2) count each blocked task ONCE no
// matter how many incomplete dependencies it has (DISTINCT). The query joins a
// second `issues` alias on `dependencyIssueId` and filters out terminal
// dependency statuses — behaviour that pre-filtered unit mocks can't exercise,
// so this runs against a real embedded Postgres. It collects + skips on Windows
// (embedded-postgres can't start on the CI Windows runner); the controller runs
// it on Linux.

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

const PORT = 58000 + Math.floor(Math.random() * 1000);

const companyId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";

// Fresh ids per case so rows never collide on the unique dependency index.
function freshIds(suffix: string) {
  return {
    dependent: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix.padStart(12, "0")}`,
    depA: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix.padStart(12, "0")}`,
    depB: `cccccccc-cccc-4ccc-8ccc-${suffix.padStart(12, "0")}`,
  };
}

async function seedTask(id: string, title: string, status: string) {
  await db.execute(sql`
    INSERT INTO issues (id, company_id, title, status)
    VALUES (${id}, ${companyId}, ${title}, ${status})
  `);
}

async function seedDependency(dependentId: string, dependencyId: string) {
  await db.execute(sql`
    INSERT INTO task_dependencies (company_id, dependent_issue_id, dependency_issue_id)
    VALUES (${companyId}, ${dependentId}, ${dependencyId})
  `);
}

beforeAll(async () => {
  if (process.platform === "win32") return; // skipped suite — don't boot pg
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-blocked-scan-test-"));
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

    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'Blocked Scan Co', 'BSC')
    `);
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
  "A-M14 — blockedTaskScan honors dependency completion + dedups",
  () => {
    // Each case asserts a COMPANY-WIDE blocked count, so isolate them: clear
    // issues + dependency edges between tests (shared company + shared pg).
    // Without this, an earlier case's in-progress blocked dependent leaks into
    // a later case's count (the count is correct; the leak is a test-isolation
    // bug — caught by the real-DB run, invisible to the sequence-mock unit).
    beforeEach(async () => {
      if (setupError) return;
      await db.execute(sql`DELETE FROM task_dependencies WHERE company_id = ${companyId}`);
      await db.execute(sql`DELETE FROM issues WHERE company_id = ${companyId}`);
    });

    it("returns 0 findings when the ONLY dependency is already done", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const { dependent, depA } = freshIds("a00000000001");
      await seedTask(depA, "Dependency (done)", "done");
      await seedTask(dependent, "In-progress dependent", "in_progress");
      await seedDependency(dependent, depA);

      const result = await blockedTaskScan(db, companyId, userId);

      // The dependency is terminal → the dependent is NOT blocked.
      expect(result.findings).toHaveLength(0);
      expect(result.runCreated).toBe(true);
    });

    it("returns 1 finding when an in-progress task has an incomplete dependency", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const { dependent, depA } = freshIds("a00000000002");
      await seedTask(depA, "Dependency (todo)", "todo");
      await seedTask(dependent, "In-progress dependent", "in_progress");
      await seedDependency(dependent, depA);

      const result = await blockedTaskScan(db, companyId, userId);

      // The dependency is non-terminal → exactly one blocked task.
      expect(result.findings).toHaveLength(1);
      expect((result.findings[0] as { id: string }).id).toBe(dependent);
      expect(result.runCreated).toBe(true);
    });

    it("counts a task with TWO incomplete dependencies exactly ONCE (DISTINCT)", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const { dependent, depA, depB } = freshIds("a00000000003");
      await seedTask(depA, "Dependency A (todo)", "todo");
      await seedTask(depB, "Dependency B (in_progress)", "in_progress");
      await seedTask(dependent, "In-progress dependent", "in_progress");
      await seedDependency(dependent, depA);
      await seedDependency(dependent, depB);

      const result = await blockedTaskScan(db, companyId, userId);

      // Two incomplete deps would, without DISTINCT, fan out to two rows.
      expect(result.findings).toHaveLength(1);
      expect((result.findings[0] as { id: string }).id).toBe(dependent);
    });

    it("does not count an in-progress task whose deps are ALL terminal (mix of done + cancelled)", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const { dependent, depA, depB } = freshIds("a00000000004");
      await seedTask(depA, "Dependency A (done)", "done");
      await seedTask(depB, "Dependency B (cancelled)", "cancelled");
      await seedTask(dependent, "In-progress dependent", "in_progress");
      await seedDependency(dependent, depA);
      await seedDependency(dependent, depB);

      const result = await blockedTaskScan(db, companyId, userId);

      // Both `done` and `cancelled` are terminal → not blocked.
      expect(result.findings).toHaveLength(0);
    });
  },
);
