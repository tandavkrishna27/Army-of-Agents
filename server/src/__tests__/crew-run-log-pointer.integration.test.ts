/**
 * T1 (crew observability) integration: the crew run-transcript pointer on real Postgres.
 *
 * `runAoaAgent` opens an NDJSON transcript right before `adapter.execute` and
 * records the resulting handle on the run row so an operator can FIND the
 * transcript from a run id. The unit suite (crew-run-log.test.ts) covers the
 * sink, and the mocked service suite (aoa-runner.test.ts) covers the wiring —
 * neither can see a real database, so neither can catch the two failure modes
 * that actually matter here:
 *
 *   1. Migration 0179 never applying. The pointer UPDATE is deliberately
 *      best-effort (a failure only warns), so an unapplied migration would
 *      silently degrade T1 back into the black box it exists to eliminate —
 *      green mocked tests and zero findable transcripts in production.
 *   2. The pointer not surviving a round trip. `logRef` is a store-minted
 *      relative path (`<companyId>/<agentId>/<runId>.ndjson`, with the host path
 *      separator), and `log_store`/`log_ref` must accept it verbatim.
 *
 * The "no transcript" case is equally load-bearing: every path that bails before
 * `adapter.execute` (entry-claim race, task-checkout conflict, fake-crew turn)
 * leaves both columns NULL, so a run row with neither column set must still
 * insert. That is what makes a non-null `log_ref` MEAN "the adapter actually ran".
 *
 * Scope stops at schema + pointer persistence — driving a whole `runAoaAgent`
 * would need a registered adapter and a live CLI.
 *
 * Skipped on Windows by default (CI's `runneradmin` account can't start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real — the UTF-8
 * initdbFlags below make the cluster locale-safe. Modeled on
 * ask-founder-dogfood.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  internalAgentRuns,
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
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let runLogDir = "";
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

const PORT = 61600 + Math.floor(Math.random() * 400);

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<
    Record<string, unknown>
  >;
}

// companies.issue_prefix is globally unique, so seeds are numbered rather than randomized.
let seedCounter = 0;

/** Seed a company + one crew agent — the two FK parents of an internal_agent_runs row. */
async function seedCompanyAndCrewAgent(label: string): Promise<{
  companyId: string;
  agentId: string;
}> {
  const companyId = randomUUID();
  seedCounter += 1;
  await db.execute(sql`
    INSERT INTO companies (id, name, issue_prefix)
    VALUES (${companyId}, ${`Crew Run Log ${label} Co`}, ${`CRL${seedCounter}`})
  `);
  const [agent] = rowsOf(
    await db.execute(sql`
      INSERT INTO agents (id, company_id, name, kind, status)
      VALUES (gen_random_uuid(), ${companyId}, ${`Engineer ${label}`}, 'aoa', 'idle')
      RETURNING id
    `),
  );
  return { companyId, agentId: String(agent.id) };
}

/** Insert a crew run row the way the dispatcher does — before any transcript exists. */
async function seedRun(companyId: string, agentId: string): Promise<string> {
  const [run] = await db
    .insert(internalAgentRuns)
    .values({
      companyId,
      agentId,
      triggerType: "sub_agent",
      triggerSource: "discussion_entry",
      status: "running",
    })
    .returning({ id: internalAgentRuns.id });
  return run!.id;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-crew-run-log-pointer-integ-"));
    runLogDir = join(dataDir, "run-logs");
    // Point the run-log store at the throwaway dir BEFORE getRunLogStore() is
    // first called (it caches its base path on first use), so the real store can
    // mint a real handle without touching the operator's AoA home.
    process.env.RUN_LOG_BASE_PATH = runLogDir;

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
    console.error("[crew-run-log-pointer] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  delete process.env.RUN_LOG_BASE_PATH;
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
)("crew run-log pointer (real PostgreSQL)", () => {
  it("migration 0179 gives internal_agent_runs nullable text log_store/log_ref", async () => {
    assertSetupOk();

    const columns = rowsOf(
      await db.execute(sql`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'internal_agent_runs'
          AND column_name IN ('log_store', 'log_ref')
        ORDER BY column_name
      `),
    );

    expect(columns.map((c) => c.column_name)).toEqual(["log_ref", "log_store"]);
    for (const column of columns) {
      // NOT NULL would make every pre-T1 run and every run that bailed before
      // adapter.execute unrepresentable.
      expect(column.is_nullable, String(column.column_name)).toBe("YES");
      expect(column.data_type, String(column.column_name)).toBe("text");
      // A default would claim a transcript exists for runs that never opened one.
      expect(column.column_default, String(column.column_name)).toBeNull();
    }
  });

  it("persists the handle runLogStore.begin() mints, so the transcript is findable by run id", async () => {
    assertSetupOk();

    const { companyId, agentId } = await seedCompanyAndCrewAgent("roundtrip");
    const runId = await seedRun(companyId, agentId);

    // A brand-new run has no transcript yet.
    const before = await db
      .select({ logStore: internalAgentRuns.logStore, logRef: internalAgentRuns.logRef })
      .from(internalAgentRuns)
      .where(eq(internalAgentRuns.id, runId));
    expect(before[0]).toEqual({ logStore: null, logRef: null });

    // Mint a real handle from the real store, then write it exactly as
    // runAoaAgent does immediately after begin().
    const { getRunLogStore } = await import("../services/run-log-store.js");
    const handle = await getRunLogStore().begin({ companyId, agentId, runId });

    await db
      .update(internalAgentRuns)
      .set({ logStore: handle.store, logRef: handle.logRef })
      .where(eq(internalAgentRuns.id, runId));

    const after = await db
      .select({ logStore: internalAgentRuns.logStore, logRef: internalAgentRuns.logRef })
      .from(internalAgentRuns)
      .where(eq(internalAgentRuns.id, runId));
    expect(after[0]).toEqual({ logStore: handle.store, logRef: handle.logRef });

    // The stored ref is what an operator holding only the run id needs: it
    // resolves back to this run's transcript inside the store.
    expect(after[0]!.logRef).toContain(runId);
    expect(await getRunLogStore().read({ store: "local_file", logRef: after[0]!.logRef! }))
      .toEqual({ content: "" });
  });

  it("leaves a run that never opened a transcript insertable with both columns NULL", async () => {
    assertSetupOk();

    const { companyId, agentId } = await seedCompanyAndCrewAgent("no-transcript");
    // The fake-crew / early-bail case: the run row exists, nothing was streamed.
    const runId = await seedRun(companyId, agentId);

    const [row] = rowsOf(
      await db.execute(sql`
        SELECT log_store, log_ref FROM internal_agent_runs WHERE id = ${runId}
      `),
    );
    expect(row.log_store).toBeNull();
    expect(row.log_ref).toBeNull();
  });
});
