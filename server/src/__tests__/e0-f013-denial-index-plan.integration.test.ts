/**
 * E0-F013 Decision 2, acceptance condition (a), SECOND HALF — the denial-prefix
 * index, proved by PLAN rather than by read-back.
 *
 * ★ WHAT WAS NOT DONE, AND IS DONE HERE. The unit that shipped
 * `GET /api/instance/security-denials` filed the missing index as NOT DONE and
 * measured why: `activity_log` carries indexes on `(company_id, created_at)`,
 * `(run_id)` and `(entity_type, entity_id)` and NOTHING on `action` or on
 * `created_at` alone, so the only production reader of the reserved
 * `security.denied.` namespace planned every page as
 * `Limit <- Sort <- Seq Scan`. Deep paging was therefore O(table) PER PAGE — the
 * cursor made the oldest evidence REACHABLE, but re-read the whole table to
 * reach it. Migration `0276` adds a partial index; this file is what makes the
 * claim that it works an observation instead of an assertion.
 *
 * ★ THE SQL EXPLAINED HERE IS THE READER'S OWN, AND THE FIRST VERSION OF THIS
 * FILE GOT THAT WRONG. It held `FIRST_PAGE_SQL` and a `deepPageSql()` as
 * HAND-TRANSCRIBED string literals and never imported `activityService` at all.
 * Measured: dropping `desc(activityLog.id)` from the reader's `ORDER BY` — the
 * exact "sort columns" drift the prose warned about, and the loss of the total
 * order the keyset cursor depends on — left this file and its sibling at 23/23
 * GREEN. It was EXPLAINing a COPY of the reader's query, so after any drift the
 * copy is no longer the query, which is precisely when the guard is needed. The
 * two plans below are now built from `activityService(db).securityDenials(...)`
 * via drizzle's `getSQL()`, so there is no second copy to drift away from, and
 * `THE MATCHED PAIR` arm compares the reader's emitted sort keys against the
 * shipped index's own — which is the half that a plan assertion alone cannot
 * see (see that arm for why, measured).
 *
 * ★ WHY A PLAN ASSERTION AND NOT A TIMING ONE. A wall-clock threshold on a
 * shared CI runner is a flake generator, and a fast query proves nothing about
 * the plan on a table two orders of magnitude larger. The plan is the durable
 * property: an `Index Scan` feeding a `Limit` is O(page), a `Sort` over a
 * `Seq Scan` is O(table), and the difference does not depend on the machine.
 *
 * ★ WHY IT CANNOT PASS VACUOUSLY. A plan assertion on a 10-row table is
 * meaningless — Postgres seq-scans small tables no matter what indexes exist, so
 * an arm that asserted "no Seq Scan" there would be asserting nothing. So this
 * file seeds enough rows that the choice is real, and then makes the vacuity
 * question empirical: one arm DROPS the index, re-plans the identical query on
 * the identical data, and asserts the plan DEGRADES to the documented
 * `Sort <- Seq Scan`, before restoring it from the definition Postgres itself
 * reports. That arm is the built-in positive control — if the good plan and the
 * bad plan are indistinguishable on this data on this machine, that arm fails
 * and the file refuses to certify anything.
 *
 * ★ WHY PARAMETERIZED `EXPLAIN` IS SOUND HERE. The derived SQL carries bind
 * parameters (`action like $1`, `limit $2`), and a partial index is matched by
 * proving the query's `WHERE` implies the index predicate — which cannot be
 * proved against an unbound `Param`. It works because node-postgres issues
 * one-shot extended-protocol queries rather than reusing named prepared
 * statements, so Postgres plans each with the values bound (a custom plan) and
 * folds them to constants first. That is not taken on trust: the positive
 * control drops the index and requires this same mechanism to produce a
 * `Seq Scan`, so if parameterization ever stopped the index being matched, the
 * three good-plan arms would fail rather than pass for the wrong reason.
 *
 * Real Postgres (embedded-postgres + the committed migration chain), the real
 * migration, and the two queries the reader really emits — not a transcription
 * of them: the first page, and the keyset page that the `before`/`beforeId`
 * cursor produces.
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { activityService } from "../services/activity.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

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

function assertSetupOk(): void {
  const dbReady = (db as Db | undefined) !== undefined;
  if (!setupFailed && dbReady) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

const INDEX_NAME = "activity_log_denial_created_idx";

/**
 * The row count is not decoration. Below roughly this size Postgres prefers a
 * sequential scan whatever indexes exist, which would make every assertion in
 * this file vacuously true. The degradation arm proves empirically that this
 * many rows is enough on the machine actually running the suite.
 */
const PRODUCT_ROWS = 40_000;
const DENIAL_ROWS = 400;

/** How far into the denial rows the deep-page boundary is taken. */
const DEEP_PAGE_OFFSET = DENIAL_ROWS - 60;

/**
 * The one seam between this file and the reader, and the reason it is a
 * function rather than a string: it hands back whatever `securityDenials`
 * builds, so the SQL that gets planned below is the reader's, byte for byte.
 * There is no second copy in this file to drift away from the first.
 */
function denialQuery(
  filters: Parameters<ReturnType<typeof activityService>["securityDenials"]>[0],
): DenialQuery {
  return activityService(db).securityDenials(filters);
}

/**
 * The reader hands back a drizzle query builder. Only two things are asked of
 * it here — compile it, and render it as a SQL chunk — so it is typed by those
 * two capabilities rather than by drizzle's builder generics.
 */
type DenialQuery = { getSQL(): SQL; toSQL(): { sql: string } };

/** Read a plan back as one string, from a drizzle query rather than a literal. */
async function planOf(query: { getSQL(): SQL }): Promise<string> {
  const res = await db.execute(sql`EXPLAIN ${query.getSQL()}`);
  return rowsOf<Record<string, string>>(res)
    .map((r) => r["QUERY PLAN"])
    .join("\n");
}

/**
 * The DEEP-PAGE query, built by asking the READER for a page and handing its
 * own emitted `cursor` + `id` straight back to it — which is how a client pages
 * and therefore the only faithful way to plan it. This is the query the NOT-DONE
 * entry was about: the keyset predicate is a row-value comparison, and whether
 * it becomes an `Index Cond` (a seek) or a `Filter` (a scan) is the entire
 * difference between O(page) and O(table).
 *
 * ★ IT IS RETURNED BOXED, AND THAT IS NOT STYLE. A drizzle query builder is a
 * THENABLE: returning one from an `async` function makes `await` execute it and
 * hand back ROWS, which is how the first attempt at this helper silently turned
 * a query into a result set. The box keeps the unexecuted builder intact so it
 * can be compiled and EXPLAINed instead of run.
 */
async function deepPageQuery(): Promise<{ query: DenialQuery }> {
  const page = (await denialQuery({ limit: DEEP_PAGE_OFFSET })) as unknown as Array<{
    id: string;
    cursor: string;
  }>;
  expect(
    page.length,
    "the reader did not return a deep page — the denial seed or the limit clamp is wrong",
  ).toBe(DEEP_PAGE_OFFSET);
  const boundary = page[page.length - 1]!;
  return { query: denialQuery({ before: boundary.cursor, beforeId: boundary.id }) };
}

/**
 * Normalize a sort-key list to `column direction` tokens so the reader's SQL and
 * Postgres's rendering of the index can be compared directly. Table
 * qualification, quoting and case are noise; the column, the direction and any
 * explicit NULLS ordering are not.
 */
function normalizeSortKeys(raw: string): string[] {
  return raw
    .split(",")
    .map((part) =>
      part
        .trim()
        .toLowerCase()
        .replace(/"/g, "")
        .replace(/[a-z_]+\./g, "")
        .replace(/\s+/g, " "),
    )
    .filter((part) => part.length > 0)
    .map((part) => (/\b(asc|desc)\b/.test(part) ? part : `${part} asc`));
}

/** The `ORDER BY ... ` list the reader itself emits, from its compiled SQL. */
function readerSortKeys(query: { toSQL(): { sql: string } }): string[] {
  const compiled = query.toSQL().sql;
  const match = /\border by\s+(.*?)(?:\s+limit\b|\s+offset\b|$)/is.exec(compiled);
  expect(
    match,
    `could not find an ORDER BY in the reader's own SQL — it pages by a keyset cursor and MUST emit a total order:\n${compiled}`,
  ).toBeTruthy();
  return normalizeSortKeys(match![1]!);
}

/** The key list of the shipped index, from Postgres's own rendering of it. */
async function indexSortKeys(): Promise<string[]> {
  const def = await indexDef();
  const match = /using btree \((.*?)\)(?:\s+where\b|$)/is.exec(def);
  expect(match, `could not parse the index key list out of:\n${def}`).toBeTruthy();
  return normalizeSortKeys(match![1]!);
}

async function indexDef(): Promise<string> {
  const defs = rowsOf<{ indexdef: string }>(
    await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${INDEX_NAME}`),
  );
  expect(defs.length, `${INDEX_NAME} does not exist — migration 0276 did not apply`).toBe(1);
  return defs[0]!.indexdef;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-e0f013-denial-index-"));
    const port = await allocateEmbeddedPgPort();
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[e0f013-denial-index] embedded-postgres setup failed:", err);
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

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "E0-F013 (a) — the denial-prefix index changes the plan of the only production denial reader",
  () => {
    it("setup: a realistic activity_log — 40,000 ordinary product rows and 400 denials", async () => {
      assertSetupOk();

      const co = rowsOf<{ id: string }>(
        await db.execute(sql`
          INSERT INTO companies (organization_id, id, name, issue_prefix)
          VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Plan Co', 'PLN')
          RETURNING id`),
      )[0]!.id;

      await db.execute(sql`
        INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, created_at)
        SELECT ${co}, 'user', 'seed-user', 'issue.updated', 'issue', gen_random_uuid()::text,
               now() - (g || ' seconds')::interval
        FROM generate_series(1, ${sql.raw(String(PRODUCT_ROWS))}) AS g`);

      // Half the denials are TENANTLESS, because that is now a shape the table
      // really holds and a partial index must cover it too — the predicate is on
      // `action`, not on `company_id`, and this is what proves it.
      //
      // ★ EACH DENIAL ROW GETS A DISTINCT `created_at` (a whole-second step), so
      // the deep-page boundary read through the reader is stable. The tie case
      // that `beforeId` exists for is covered by the sibling disclosure-path
      // suite, which writes a real tie; here a stable boundary is what the plan
      // assertion needs.
      await db.execute(sql`
        INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, created_at)
        SELECT CASE WHEN g % 2 = 0 THEN ${co}::uuid ELSE NULL END,
               'system', 'seed-prober', 'security.denied.plan_probe', 'memory_item', gen_random_uuid()::text,
               now() - (g || ' seconds')::interval
        FROM generate_series(1, ${sql.raw(String(DENIAL_ROWS))}) AS g`);

      // The planner chooses on statistics, so this is load bearing, not hygiene.
      await db.execute(sql`ANALYZE activity_log`);

      const counts = rowsOf<{ total: string; denials: string; tenantless: string }>(
        await db.execute(sql`
          SELECT count(*)::text AS total,
                 count(*) FILTER (WHERE action LIKE 'security.denied.%')::text AS denials,
                 count(*) FILTER (WHERE company_id IS NULL)::text AS tenantless
          FROM activity_log`),
      )[0];
      expect(counts?.total).toBe(String(PRODUCT_ROWS + DENIAL_ROWS));
      expect(counts?.denials).toBe(String(DENIAL_ROWS));
      expect(Number(counts?.tenantless)).toBeGreaterThan(0);
    }, 120_000);

    it("migration 0276 created the partial index, with the predicate and the DESC ordering it needs", async () => {
      assertSetupOk();
      const def = await indexDef();
      // PARTIAL — it indexes denial rows only, so it costs nothing per product row.
      expect(def, "the index is not partial — it would index every product row").toContain(
        "WHERE (action ~~ 'security.denied.%'::text)",
      );
      // DESC on both keys, matching the reader's total order. Postgres prints
      // `DESC` without `NULLS FIRST` precisely because NULLS FIRST is the default
      // for DESC — which is the whole reason the schema pins `nullsFirst()`.
      expect(def).toContain("created_at DESC");
      expect(def).toContain("id DESC");
      expect(def, "the index emitted NULLS LAST, which does NOT match the reader's ORDER BY").not.toContain(
        "NULLS LAST",
      );
    });

    /**
     * ★ THE MATCHED PAIR — the half a plan assertion CANNOT see, and the arm the
     * first version of this file was missing.
     *
     * The prose on this endpoint says that changing the sort columns reverts the
     * plan to `Sort <- Seq Scan`. MEASURED, THAT IS NOT WHAT DROPPING THE
     * TIEBREAKER DOES. Drop `desc(activityLog.id)` and the reader orders by
     * `created_at DESC` alone, which is a PREFIX of this index's key order — so
     * Postgres happily keeps using the index, keeps the plan at
     * `Limit <- Index Scan`, and every plan arm in this file stays green. What
     * breaks is not the plan; it is the TOTAL ORDER the keyset cursor needs,
     * silently, with a 200 and no error.
     *
     * So the drift is caught structurally instead: the reader's own emitted sort
     * keys must equal the shipped index's own key list, position for position,
     * direction for direction. Both sides are read from the artefacts
     * themselves — drizzle's compiled SQL and `pg_indexes.indexdef` — so neither
     * is a transcription that can agree with a stale copy of the other.
     *
     * (Direction and prefix drift ARE caught by the plan arms: an `ASC` order
     * cannot walk this index and re-introduces the `Sort`, and a changed action
     * prefix no longer implies the partial predicate and re-introduces the
     * `Seq Scan`. Both measured. This arm is for the drift they miss.)
     */
    it("★ THE MATCHED PAIR: the reader's emitted ORDER BY is exactly the index's key list", async () => {
      assertSetupOk();

      const firstPage = denialQuery({});
      const readerKeys = readerSortKeys(firstPage);
      const idxKeys = await indexSortKeys();

      expect(
        readerKeys,
        `the reader's ORDER BY and the index key list have diverged.\n` +
          `  reader: ${readerKeys.join(", ")}\n` +
          `  index : ${idxKeys.join(", ")}\n` +
          `The plan can survive this (a prefix of the index order still walks it) while the ` +
          `keyset cursor silently loses rows on a created_at tie. Change both together or neither.`,
      ).toEqual(idxKeys);

      // A total order, not just an agreeing one: one key is a prefix that the
      // planner accepts and the cursor cannot use.
      expect(
        readerKeys.length,
        `the reader pages by a row-value keyset over (created_at, id) and must order by both`,
      ).toBeGreaterThanOrEqual(2);

      // And the reader must not pin an explicit NULLS ordering: bare `DESC`
      // means NULLS FIRST, which is what the index is built with. An explicit
      // `NULLS LAST` on the reader side would break the match in the direction
      // the index arm above cannot see.
      expect(
        readerSortKeys(firstPage).join(", "),
        "the reader pinned an explicit NULLS ordering; the index is DESC NULLS FIRST",
      ).not.toContain("nulls last");

      // The keyset page must order the same way as the first page, or paging
      // walks a different order than it seeks in.
      expect(readerSortKeys((await deepPageQuery()).query)).toEqual(readerKeys);
    }, 60_000);

    it("★ THE FIRST PAGE: an ordered index scan feeds the LIMIT — no Seq Scan and no Sort", async () => {
      assertSetupOk();
      const plan = await planOf(denialQuery({}));
      expect(plan, `plan was:\n${plan}`).toContain(`Index Scan using ${INDEX_NAME}`);
      expect(
        plan,
        `the denial reader still sequentially scans activity_log — the index is not being used:\n${plan}`,
      ).not.toContain("Seq Scan on activity_log");
      expect(
        plan,
        `the plan still sorts — the index ordering does not match the reader's ORDER BY, so the scan was narrowed but the O(n log n) was left behind:\n${plan}`,
      ).not.toContain("Sort");
    }, 60_000);

    it("★ THE DEEP PAGE: the keyset cursor becomes an Index Cond (a seek), not a Filter (a scan)", async () => {
      assertSetupOk();
      const plan = await planOf((await deepPageQuery()).query);
      expect(plan, `plan was:\n${plan}`).toContain(`Index Scan using ${INDEX_NAME}`);
      // The row-value comparison must be pushed INTO the index as a search
      // condition. As a `Filter` it is evaluated per row after the scan, which is
      // the O(table)-per-page behaviour the NOT-DONE entry described.
      expect(
        plan,
        `the cursor predicate was not pushed into the index — deep paging is still O(table) per page:\n${plan}`,
      ).toContain("Index Cond");
      expect(plan, `plan was:\n${plan}`).not.toContain("Seq Scan on activity_log");
      expect(plan, `plan was:\n${plan}`).not.toContain("Sort");
    }, 60_000);

    /**
     * ★ THE POSITIVE CONTROL, AND THE ONLY REASON THE THREE ARMS ABOVE MEAN
     * ANYTHING. They assert the ABSENCE of `Seq Scan` and `Sort`. An absence
     * assertion is worthless unless the presence is achievable on this data on
     * this machine — if Postgres would never seq-scan here anyway, those arms are
     * green for a reason that has nothing to do with the index.
     *
     * So: drop the index, re-plan the READER'S OWN query on the identical rows,
     * and require the documented BAD plan to appear. Then restore the index from
     * the definition Postgres itself reports, so the file leaves the database as
     * it found it and arm order cannot matter.
     *
     * ★ IT ALSO PROVES THE MECHANISM. The plan is taken through parameterized
     * `EXPLAIN` of a drizzle query; this arm shows that mechanism can render BOTH
     * plans, so the good-plan arms cannot be passing because parameterization
     * hid something.
     */
    it("★ POSITIVE CONTROL: without the index the reader's own query on the same rows degrades to Sort over Seq Scan", async () => {
      assertSetupOk();

      const def = await indexDef();

      try {
        await db.execute(sql.raw(`DROP INDEX ${INDEX_NAME}`));
        await db.execute(sql`ANALYZE activity_log`);

        const degraded = await planOf(denialQuery({}));
        expect(
          degraded,
          `dropping the index did NOT produce a sequential scan, so the "no Seq Scan" arms above are vacuous on this data — raise PRODUCT_ROWS until this fails honestly:\n${degraded}`,
        ).toContain("Seq Scan on activity_log");
        expect(
          degraded,
          `dropping the index did NOT reintroduce a Sort, so the "no Sort" arms above are vacuous:\n${degraded}`,
        ).toContain("Sort");
      } finally {
        // Restore from Postgres's own rendering of the shipped definition, not
        // from a literal retyped here — a retyped literal could silently restore
        // a DIFFERENT index and make every later arm test the wrong object.
        await db.execute(sql.raw(def));
        await db.execute(sql`ANALYZE activity_log`);
      }

      // And the good plan is back, so the restore really restored.
      const restored = await planOf(denialQuery({}));
      expect(restored, `plan after restore:\n${restored}`).toContain(`Index Scan using ${INDEX_NAME}`);
    }, 60_000);

    /**
     * The index must not change WHAT the reader returns, only how it finds it.
     * A partial index whose predicate disagreed with the query's would silently
     * drop rows; asserting the row set is unchanged is cheap and catches that.
     * Run through the READER, both times.
     */
    it("the index changes the plan and not the answer: the same rows, in the same order", async () => {
      assertSetupOk();
      const withIndex = ((await denialQuery({})) as unknown as Array<{ id: string }>).map((r) => r.id);
      expect(withIndex.length).toBe(100);

      await db.execute(sql`SET enable_indexscan = off`);
      await db.execute(sql`SET enable_bitmapscan = off`);
      try {
        const withoutIndex = ((await denialQuery({})) as unknown as Array<{ id: string }>).map((r) => r.id);
        expect(
          withoutIndex,
          "the indexed and unindexed plans disagree about the answer — the index predicate does not match the query's",
        ).toEqual(withIndex);
      } finally {
        await db.execute(sql`SET enable_indexscan = on`);
        await db.execute(sql`SET enable_bitmapscan = on`);
      }
    }, 60_000);
  },
);
