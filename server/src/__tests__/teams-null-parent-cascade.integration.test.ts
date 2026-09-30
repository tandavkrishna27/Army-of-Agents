/**
 * D21 — a company-wide team must survive department deletion.
 *
 * `teams.parent_project_id` carries `ON DELETE CASCADE`. That is right for a
 * departmental team, but AoA crew (Adjutant, Scout, Engineer, …) are
 * company-wide singletons: parenting them to an arbitrary department would mean
 * deleting that department silently deletes the crew team row. Making the
 * column nullable is what fixes that — a NULL parent has nothing to cascade
 * from.
 *
 * A mocked test can only prove "NULL is accepted". Cascade semantics are pure
 * Postgres, so this suite runs against a real embedded cluster:
 *
 *   1. the column is actually nullable (the migration applied), AND
 *   2. the FK is still `ON DELETE CASCADE` (nullability did not quietly relax
 *      the departmental contract), AND
 *   3. deleting a department deletes its departmental team but leaves the
 *      company-wide team standing.
 *
 * (3) is the discriminator: without it, a green suite would still ship the bug.
 *
 * Skipped on Windows by default (CI's `runneradmin` account can't start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real — the
 * UTF-8 initdbFlags below make the cluster locale-safe. Modeled on
 * crew-run-log-pointer.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";

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
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
let setupFailed = false;

/**
 * Fail LOUDLY and ONCE when embedded-postgres never came up.
 *
 * `setupError = err` alone is not a guard: embedded-postgres can reject with
 * `undefined`, which is falsy, so the old `if (setupError) throw` silently
 * no-oped and every case then ran against an unassigned `db` — a wall of
 * `Cannot read properties of undefined (reading 'insert')` pointing into
 * product code, which reads as a product bug rather than a setup failure.
 * A boolean cannot be falsy-by-accident, and the `db` check covers a throw
 * that happens to leave `setupError` null.
 */
function assertSetupOk(): void {
  const dbReady = (db as Db | undefined) !== undefined;
  if (!setupFailed && dbReady) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}

const PORT = 57300 + Math.floor(Math.random() * 500);

/** drizzle's execute() returns either `{ rows }` or a bare array depending on driver. */
function rowsOf<T>(result: unknown): T[] {
  const asObj = result as { rows?: T[] };
  return asObj?.rows ?? (result as T[]);
}

// `companies.issue_prefix` is globally unique, so a hardcoded literal would
// collide the moment a second company is seeded in this file.
let seedCounter = 0;
function nextIssuePrefix(): string {
  seedCounter += 1;
  return `D2${seedCounter}`;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-teams-null-parent-integ-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      // Force UTF-8 so migration SQL containing non-Latin1 characters applies.
      // Without this, initdb inherits the host locale (WIN1252 on Windows) and
      // the `postgres` DB rejects those bytes.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[teams-null-parent-cascade] embedded-postgres setup failed:", err);
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

describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
)("teams.parent_project_id nullability + cascade (real PostgreSQL)", () => {
  it("teams.parent_project_id is nullable and still ON DELETE CASCADE", async () => {
    assertSetupOk();

    const columns = rowsOf<{ is_nullable: string }>(
      await db.execute(sql`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'teams'
          AND column_name = 'parent_project_id'
      `),
    );
    expect(columns.length).toBe(1);
    expect(columns[0]!.is_nullable).toBe("YES");

    // Nullability must not have been achieved by dropping/weakening the FK —
    // a departmental team still has to cascade away with its department. Every
    // matching constraint is checked, not just the first: a second, non-cascade
    // FK on the same column would be exactly the regression this guards.
    const fks = rowsOf<{ delete_rule: string }>(
      await db.execute(sql`
        SELECT rc.delete_rule
        FROM information_schema.referential_constraints rc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = rc.constraint_name
         AND kcu.constraint_schema = rc.constraint_schema
        WHERE kcu.table_schema = 'public'
          AND kcu.table_name = 'teams'
          AND kcu.column_name = 'parent_project_id'
      `),
    );
    expect(fks.length).toBeGreaterThanOrEqual(1);
    for (const fk of fks) {
      expect(fk.delete_rule).toBe("CASCADE");
    }
  });

  it("deleting a department cascades its departmental team but NOT a company-wide team", async () => {
    assertSetupOk();

    const companyId = randomUUID();
    const deptId = randomUUID();
    const deptTeamId = randomUUID();
    const crewTeamId = randomUUID();

    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'D21 Cascade Co', ${nextIssuePrefix()})
    `);
    await db.execute(sql`
      INSERT INTO projects (id, company_id, name, type)
      VALUES (${deptId}, ${companyId}, 'Engineering', 'department')
    `);

    // A normal departmental team — the existing contract.
    await db.execute(sql`
      INSERT INTO teams (id, company_id, parent_project_id, name, slug)
      VALUES (${deptTeamId}, ${companyId}, ${deptId}, 'Eng Team', 'eng-team')
    `);
    // The company-wide crew team — no parent department at all.
    await db.execute(sql`
      INSERT INTO teams (id, company_id, parent_project_id, name, slug)
      VALUES (${crewTeamId}, ${companyId}, NULL, 'AoA Crew', 'aoa-crew')
    `);

    await db.execute(sql`DELETE FROM projects WHERE id = ${deptId}`);

    const surviving = rowsOf<{ id: string }>(
      await db.execute(sql`SELECT id FROM teams WHERE company_id = ${companyId}`),
    );
    const survivingIds = surviving.map((r) => r.id);
    expect(survivingIds).not.toContain(deptTeamId); // departmental cascade intact
    expect(survivingIds).toContain(crewTeamId);     // company-wide crew survives
    expect(survivingIds).toHaveLength(1);
  });
});
