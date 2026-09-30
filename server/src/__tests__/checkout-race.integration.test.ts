import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  issues,
  type Db,
} from "@armyofagents/db";
import { issueService } from "../services/issues.js";

// TQ-1 / COV-3 — issueService.checkout is the single-agent task lock. The lock
// IS an atomic conditional UPDATE: `WHERE id = ? AND status IN (expected) AND
// (assignee is null OR same-run) AND exec-lock`. Only one of two simultaneous
// checkouts can match that WHERE — that's the whole guarantee that two agents
// can't grab the same task. Every other checkout test uses the Proxy mock where
// drizzle operators are no-ops, so the WHERE clause that *is* the lock is never
// the guard. This exercises the real lock under genuine contention against an
// embedded Postgres (two pooled connections → real row-level serialization). It
// collects + skips on Windows (embedded-postgres can't start on the CI Windows
// runner); the controller runs it on Linux.

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

const PORT = 59000 + Math.floor(Math.random() * 1000);

const companyId = "44444444-4444-4444-8444-444444444444";
const agentA = "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentB = "b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const runA = "f1f1f1f1-1111-4111-8111-111111111111";
const runB = "f2f2f2f2-2222-4222-8222-222222222222";

// Fresh issue id per case so rows never collide across tests (shared company).
function freshIssueId(suffix: string) {
  return `cccccccc-cccc-4ccc-8ccc-${suffix.padStart(12, "0")}`;
}

async function seedIssue(id: string, status: string) {
  await db.execute(sql`
    INSERT INTO issues (id, company_id, title, status)
    VALUES (${id}, ${companyId}, 'Contended task', ${status})
  `);
}

beforeAll(async () => {
  if (process.platform === "win32") return; // skipped suite — don't boot pg
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-checkout-race-test-"));
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
      VALUES (${companyId}, 'Checkout Race Co', 'CRC')
    `);
    // Two assignable agents (status defaults to 'idle' — neither pending nor
    // terminated, so assertAssignableAgent passes for both).
    await db.execute(sql`
      INSERT INTO agents (id, company_id, name)
      VALUES (${agentA}, ${companyId}, 'Agent A'),
             (${agentB}, ${companyId}, 'Agent B')
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

async function readIssue(id: string) {
  const [row] = await db
    .select({
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
    })
    .from(issues)
    .where(eq(issues.id, id));
  return row ?? null;
}

describe.skipIf(process.platform === "win32")(
  "issueService.checkout — atomic single-agent lock under contention",
  () => {
    beforeEach(async () => {
      if (setupError) return;
      // Shared company + agents; clear issues between cases for isolation.
      await db.execute(sql`DELETE FROM issues WHERE company_id = ${companyId}`);
    });

    it("two concurrent checkouts: exactly one wins, the other gets a 409 conflict", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const issueId = freshIssueId("a00000000001");
      await seedIssue(issueId, "todo");

      const svc = issueService(db);

      // Fire both checkouts genuinely concurrently. Each runs as its own atomic
      // UPDATE statement on a separate pooled connection; Postgres row-locking
      // serializes them. Whichever commits first flips status → in_progress, so
      // the loser's WHERE (`status IN (todo, backlog)`) no longer matches → 0
      // rows → falls through to the conflict path (loser is not the assignee, so
      // no adopt branch applies).
      const results = await Promise.allSettled([
        svc.checkout(issueId, agentA, ["todo", "backlog"], runA),
        svc.checkout(issueId, agentB, ["todo", "backlog"], runB),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly one agent acquires the task; the other is rejected.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The winner's returned row is in_progress and owned by one of the racers.
      const winner = (fulfilled[0] as PromiseFulfilledResult<{ status: string; assigneeAgentId: string | null; checkoutRunId: string | null }>).value;
      expect(winner.status).toBe("in_progress");
      expect([agentA, agentB]).toContain(winner.assigneeAgentId);

      // The loser fails with a 409 checkout conflict (HttpError.status).
      const reason = (rejected[0] as PromiseRejectedResult).reason as { status?: number };
      expect(reason?.status).toBe(409);

      // Committed DB state agrees with the winner: single owner, run locked.
      const persisted = await readIssue(issueId);
      expect(persisted?.status).toBe("in_progress");
      expect(persisted?.assigneeAgentId).toBe(winner.assigneeAgentId);
      expect(persisted?.checkoutRunId).toBe(winner.checkoutRunId);
      // The winner's run owns the execution lock too.
      expect([runA, runB]).toContain(persisted?.checkoutRunId);
    });

    it("same-run re-checkout is idempotent — the owning run does not self-409", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const issueId = freshIssueId("a00000000002");
      await seedIssue(issueId, "todo");

      const svc = issueService(db);

      // First checkout acquires the task for agentA / runA.
      const first = await svc.checkout(issueId, agentA, ["todo", "backlog"], runA);
      expect(first.status).toBe("in_progress");
      expect(first.assigneeAgentId).toBe(agentA);
      expect(first.checkoutRunId).toBe(runA);

      // Re-checkout by the SAME agent + SAME run (e.g. a retried wakeup for the
      // same heartbeat run) must return the task, not throw a self-conflict.
      const second = await svc.checkout(issueId, agentA, ["todo", "backlog"], runA);
      expect(second.id).toBe(issueId);
      expect(second.status).toBe("in_progress");
      expect(second.assigneeAgentId).toBe(agentA);
      expect(second.checkoutRunId).toBe(runA);
    });

    it("a different agent cannot steal a task already in_progress under another run", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const issueId = freshIssueId("a00000000003");
      await seedIssue(issueId, "todo");

      const svc = issueService(db);
      await svc.checkout(issueId, agentA, ["todo", "backlog"], runA);

      // agentB attempts to check out the same task with its own run → 409.
      await expect(
        svc.checkout(issueId, agentB, ["todo", "backlog"], runB),
      ).rejects.toMatchObject({ status: 409 });

      // The task is unchanged: still agentA / runA.
      const persisted = await readIssue(issueId);
      expect(persisted?.assigneeAgentId).toBe(agentA);
      expect(persisted?.checkoutRunId).toBe(runA);
    });
  },
);
