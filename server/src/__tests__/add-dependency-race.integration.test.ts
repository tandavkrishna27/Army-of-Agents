import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { dependencyService } from "../services/dependencies.js";

// A-M12 — addDependency must auto-block transactionally so a dependency that
// completes in the read→write window can never leave its dependent permanently
// `blocked`. The race needs real transaction isolation (FOR UPDATE on both
// sides), so this runs against an embedded Postgres. It collects + skips on
// Windows (embedded-postgres can't start on the CI Windows runner); the
// controller runs it on Linux.

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

const PORT = 57000 + Math.floor(Math.random() * 1000);

const companyId = "11111111-1111-4111-8111-111111111111";

// Fresh task ids per test so cases never collide on the unique dependency index.
function freshIds(suffix: string) {
  return {
    taskC: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix.padStart(12, "0")}`,
    taskD: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix.padStart(12, "0")}`,
  };
}

async function seedTask(id: string, title: string, status: string) {
  await db.execute(sql`
    INSERT INTO issues (id, company_id, title, status)
    VALUES (${id}, ${companyId}, ${title}, ${status})
  `);
}

beforeAll(async () => {
  if (process.platform === "win32") return; // skipped suite — don't boot pg
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-adddep-race-test-"));
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
      VALUES (${companyId}, 'AddDep Race Co', 'ADR')
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

async function statusOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, id));
  return row?.status ?? null;
}

async function blockedFromOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ blockedFromStatus: issues.blockedFromStatus })
    .from(issues)
    .where(eq(issues.id, id));
  return row?.blockedFromStatus ?? null;
}

describe.skipIf(process.platform === "win32")(
  "A-M12 — addDependency auto-block is transactional (no block-after-complete race)",
  () => {
    it("does NOT leave the dependent blocked when the dependency is already terminal at add time", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const { taskC, taskD } = freshIds("a00000000001");
      // C is already done (the read→write window collapsed to: C terminal first).
      await seedTask(taskC, "Dependency C (done)", "done");
      await seedTask(taskD, "Dependent D", "todo");

      const svc = dependencyService(db);
      // addDependency(D depends-on C). With the old non-tx code + no post-insert
      // terminal re-check this could still blanket-block D; the transactional
      // re-check + maybeUnblockTx must leave D unblocked because C is terminal.
      await svc.addDependency(companyId, taskD, taskC);

      // Deterministic invariant: D must NOT be `blocked` when C is `done`.
      expect(await statusOf(taskD)).not.toBe("blocked");
      expect(await statusOf(taskD)).toBe("todo");
      expect(await blockedFromOf(taskD)).toBeNull();
    });

    it("race: concurrent complete-C + addDependency(D→C) never leaves D blocked-on-done", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const { taskC, taskD } = freshIds("a00000000002");
      await seedTask(taskC, "Dependency C", "todo");
      await seedTask(taskD, "Dependent D", "todo");

      const svc = dependencyService(db);

      // Interleave the add (which locks both rows + re-checks) with C completing.
      // Model a REAL completion: the status flip AND the resolveDependencies
      // sweep that issueService.update runs on completion (issues.ts:1345) —
      // that sweep is what unblocks dependents. A raw status update alone would
      // skip the production unblock path; releasing an already-blocked dependent
      // when its dep completes is the completion path's responsibility by
      // design, not addDependency's. Whichever order the lock grants, the
      // invariant below must hold: D is never left `blocked` on a `done` dep.
      const completeC = (async () => {
        await db
          .update(issues)
          .set({ status: "done", updatedAt: new Date() })
          .where(eq(issues.id, taskC));
        await svc.resolveDependencies(companyId, taskC);
      })();
      const addDep = svc.addDependency(companyId, taskD, taskC);

      await Promise.allSettled([addDep, completeC]);

      // Settle any lingering ordering by reading committed state.
      const cStatus = await statusOf(taskC);
      const dStatus = await statusOf(taskD);

      expect(cStatus).toBe("done");
      // Invariant: a dependent must never be permanently blocked on a done dep.
      // Either it was never blocked, or it was released — but not `blocked`.
      expect(dStatus).not.toBe("blocked");
    });

    it("regression: addDependency(D→C) while C is still todo blocks D and captures blockedFromStatus", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const { taskC, taskD } = freshIds("a00000000003");
      await seedTask(taskC, "Dependency C (todo)", "todo");
      await seedTask(taskD, "Dependent D", "todo");

      const svc = dependencyService(db);
      await svc.addDependency(companyId, taskD, taskC);

      // C is non-terminal → D must be blocked, and its pre-block status captured.
      expect(await statusOf(taskD)).toBe("blocked");
      expect(await blockedFromOf(taskD)).toBe("todo");
    });

    it("regression: a backlog dependent blocked while C is todo captures blockedFromStatus=backlog", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const { taskC, taskD } = freshIds("a00000000004");
      await seedTask(taskC, "Dependency C (todo)", "todo");
      await seedTask(taskD, "Dependent D (backlog)", "backlog");

      const svc = dependencyService(db);
      await svc.addDependency(companyId, taskD, taskC);

      expect(await statusOf(taskD)).toBe("blocked");
      expect(await blockedFromOf(taskD)).toBe("backlog");
    });
  },
);
