/**
 * E0-F013 Decision 2, acceptance condition (c) — the unscoped-reader disclosure
 * path, closed and PROVOKED.
 *
 * ★ WHAT THE PAPER FOUND. `DECISION-REQUEST-unattributable-denial-sink.md` §2
 * measured that `activityService.forIssue` filters on `entityType = 'issue'` +
 * `entityId` and NOTHING ELSE — no company predicate — while the route that
 * serves it, `GET /issues/:id/activity`, gates on the ISSUE's company
 * (`assertCompanyAccess(db, req, issue.companyId)`), never on the ROW's. On the
 * denial recorder `entityType`/`entityId` are caller-supplied free text
 * (`security-denial-audit.ts`), so a denial row recorded in tenant B and typed
 * `issue` against tenant A's issue id is returned to a tenant-A reader. The
 * ruling makes `company_id` NULLABLE, so this stops being an oddity and becomes
 * the door the decision exists to shut: it hands Decision 3's disclosure
 * question straight back.
 *
 * ★ BLAST RADIUS, MEASURED BEFORE CHOOSING (the answer is LATENT, not LIVE).
 * All three production callers of `recordSecurityDenial` HARD-CODE their
 * `entityType`: `memory_item` (`mcp/tools/read-tools.ts`) and `job_artifact`
 * (`services/artifact-commit.ts`, `services/artifact-transfer-grant.ts`). None
 * types `issue`, so no denial row reachable through `forIssue` exists today, and
 * `company_id` is still NOT NULL so no tenantless row exists either. The
 * exposure is therefore LATENT — one future writer, or one caller-chosen
 * `entityType`, away. It is fixed now because the ruling removes the second of
 * those two protections in the same wave.
 *
 * ★ THE FIX CHOSEN, AND WHY THIS ONE. The paper offered two: scope `forIssue` by
 * company, or bar the denial namespace from entity types an unscoped reader keys
 * on. This file proves the FIRST. Barring entity types would have to be enforced
 * inside `security-denial-audit.ts` — Unit A's file this wave — and it protects
 * only the rows it knows about, leaving `forIssue` cross-tenant for every other
 * writer. Scoping the reader fixes the reader, which is where the defect is, and
 * it is defensive against the ruling by construction: a NULL `company_id` never
 * satisfies `company_id = $1`, so a tenantless denial row is invisible here the
 * moment Unit A lands.
 *
 * ★ WHY THIS IS A PROVOCATION AND NOT A READ-BACK. Nothing here asserts what the
 * predicate says. The row is planted through the REAL `recordSecurityDenial`
 * (which is exactly what proves `entityType`/`entityId` are unconstrained), and
 * the assertion is made against the REAL route + REAL service over real
 * Postgres. A read-back verifies what was DECLARED; this asserts what is
 * ENFORCED.
 *
 * ★ NAMED POSITIVE CONTROLS, because "return nothing" must fail this file:
 *   1. SAME-TENANT ROW STILL RETURNED — a legitimate tenant-A `issue` activity
 *      row on the same issue comes back. Scope the reader to nothing and this
 *      goes red.
 *   2. THE PLANTED ROW EXISTS — asserted by raw SQL. Its absence from the
 *      response is the predicate, not a failed insert.
 *   3. THE ROUTE STILL WORKS AT ALL — 200, not 403/404.
 *
 * Real Postgres (embedded-postgres + the committed migration chain), the real
 * `activityRoutes(db)` router, the real `activityService`, the real
 * `assertCompanyAccess`. No stubs on the reader and none on the writer.
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { activityRoutes } from "../routes/activity.js";
import { errorHandler } from "../middleware/index.js";
import { recordSecurityDenial } from "../services/security-denial-audit.js";
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

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as { id: string })?.id;
  return (result as { rows?: { id: string }[] }).rows?.[0]?.id;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** Tenant A — owns the issue, and is the tenant the reader is authorized for. */
let coA = "";
/** Tenant B — the tenant the planted denial row is attributed to. */
let coB = "";
/** An issue owned by tenant A. Its id is the `entityId` the probe reuses. */
let issueA = "";

/**
 * A board session scoped to ONE company, the shape `assertCompanyAccess` reads
 * in static (non-cloud) mode. Deliberately NOT an instance admin: that branch
 * short-circuits the company check and would make the test vacuous.
 */
function appAsMemberOf(companyId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = {
      type: "board",
      userId: "user-a",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    };
    next();
  });
  app.use("/api", activityRoutes(db));
  app.use(errorHandler);
  return app;
}

/**
 * An OPERATOR-plane board session: `operator: true`, and a member of NO company.
 * `canManageInstanceSettings` reads `req.actor.operator` deliberately rather than
 * `isInstanceAdmin` (which cloud_auth clamps to false), so this is the shape a
 * real cloud operator presents. Membership of zero companies is the point: it
 * proves the denial reader is not smuggling company scope in through the actor.
 */
function appAsOperator() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = {
      type: "board",
      userId: "operator-1",
      source: "session",
      operator: true,
      isInstanceAdmin: false,
      companyIds: [],
    };
    next();
  });
  app.use("/api", activityRoutes(db));
  app.use(errorHandler);
  return app;
}

interface ActivityRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  companyId: string | null;
}

/**
 * A row as the denial reader returns it. `createdAt` is the millisecond-truncated
 * JSON `Date`; `cursor` is the microsecond-precision paging key. Both are typed
 * here because one arm below deliberately pages on the WRONG one to prove the
 * other is load bearing.
 */
type DenialRow = ActivityRow & { createdAt: string; cursor: string };

/**
 * Walk the denial reader from newest to oldest through its keyset cursor,
 * returning the ids in the order the pages produced them.
 *
 * The iteration cap is not decoration: a reader that IGNORES the cursor returns
 * the same newest page forever, and without the cap that failure hangs the suite
 * instead of failing it.
 */
async function pageAll(query: Record<string, string | number>, pageSize: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: { before: string; beforeId: string } | null = null;
  for (let page = 0; page < 20; page++) {
    const res = await request(appAsOperator())
      .get("/api/instance/security-denials")
      .query({ ...query, limit: pageSize, ...(cursor ?? {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body as DenialRow[];
    if (rows.length === 0) break;
    seen.push(...rows.map((r) => r.id));
    const last = rows[rows.length - 1]!;
    // ★ Page on `cursor`, never on `createdAt` — that is the property under test.
    expect(last.cursor, "the reader stopped emitting the full-precision `cursor` field").toBeTruthy();
    cursor = { before: last.cursor, beforeId: last.id };
    if (rows.length < pageSize) break;
  }
  return seen;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-e0f013-disclosure-"));
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
    console.error("[e0f013-disclosure] embedded-postgres setup failed:", err);
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
  "E0-F013 (c) — a denial row typed `issue` in another tenant does not come back from GET /issues/:id/activity",
  () => {
    it("setup: two companies, one issue in company A, one legitimate same-tenant activity row on it", async () => {
      assertSetupOk();

      coA = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (organization_id, id, name, issue_prefix)
          VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Disclosure Co A', 'DCA')
          RETURNING id`),
      );
      coB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (organization_id, id, name, issue_prefix)
          VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Disclosure Co B', 'DCB')
          RETURNING id`),
      );
      expect(coA).toBeTruthy();
      expect(coB).toBeTruthy();
      expect(coA).not.toBe(coB);

      issueA = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO issues (id, company_id, title, status)
          VALUES (gen_random_uuid(), ${coA}, 'Tenant A task', 'todo')
          RETURNING id`),
      );
      expect(issueA).toBeTruthy();

      // POSITIVE CONTROL #1's fixture: an ordinary, correctly-attributed
      // tenant-A activity row on the same issue.
      await db.execute(sql`
        INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id)
        VALUES (gen_random_uuid(), ${coA}, 'user', 'user-a', 'issue.created', 'issue', ${issueA})`);
    });

    it("plants the probe through the REAL recorder: a tenant-B denial typed `issue` against tenant A's issue id", async () => {
      assertSetupOk();

      // This call is itself the evidence for the paper's claim that
      // `entityType`/`entityId` are caller-supplied free text on the recorder:
      // nothing here is rejected, coerced, or namespaced.
      const id = await recordSecurityDenial(db, {
        companyId: coB,
        crossing: "E0-F013",
        surface: "disclosure_path_probe",
        reason: "cross_tenant_probe",
        actorType: "system",
        actorId: "prober",
        entityType: "issue",
        entityId: issueA,
        control: "server/src/__tests__/e0-f013-denial-disclosure-path.integration.test.ts",
        details: { note: "planted by the acceptance-condition-(c) provocation" },
      });

      // POSITIVE CONTROL #2 — the row really is in the table. Without this, an
      // empty response below would be indistinguishable from a failed insert,
      // and the test would pass while proving nothing.
      expect(id, "recordSecurityDenial returned null — the probe was never planted").toBeTruthy();
      const planted = rowsOf<{ n: string }>(
        await db.execute(sql`
          SELECT count(*)::text AS n FROM activity_log
          WHERE action = 'security.denied.disclosure_path_probe'
            AND entity_type = 'issue' AND entity_id = ${issueA} AND company_id = ${coB}`),
      );
      expect(planted[0]?.n).toBe("1");
    });

    it("★ THE PROVOCATION: tenant A's issue activity feed does not disclose the tenant-B denial row", async () => {
      assertSetupOk();

      const res = await request(appAsMemberOf(coA)).get(`/api/issues/${issueA}/activity`);

      // POSITIVE CONTROL #3 — the route is reachable and authorized. A 403/404
      // would produce an empty body for the wrong reason.
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const rows = res.body as ActivityRow[];
      expect(Array.isArray(rows)).toBe(true);

      expect(
        rows.map((r) => r.action),
        "GET /issues/:id/activity returned a `security.denied.*` row attributed to ANOTHER company — the unscoped-reader disclosure path is open",
      ).not.toContain("security.denied.disclosure_path_probe");
      expect(
        rows.filter((r) => r.companyId !== null && r.companyId !== coA),
        "GET /issues/:id/activity returned a row belonging to another company",
      ).toEqual([]);

      // POSITIVE CONTROL #1 — the legitimate same-tenant row is still returned.
      // A reader that returns nothing also passes the two assertions above.
      expect(
        rows.map((r) => r.action),
        "the same-tenant activity row vanished too — the reader was scoped to nothing, not to the company",
      ).toContain("issue.created");
    });

    it("a tenant-B member is still refused the route outright (the company gate itself is intact)", async () => {
      assertSetupOk();
      const res = await request(appAsMemberOf(coB)).get(`/api/issues/${issueA}/activity`);
      expect(res.status).toBe(403);
    });

    /**
     * ★ ACCEPTANCE CONDITION (a) — the reader, proved on the SAME rows the
     * condition-(c) arms above just proved are undisclosed to tenants.
     *
     * The two halves of the ruling are one property, not two: the denial row
     * must be UNREACHABLE from every company surface and REACHABLE from exactly
     * one operator surface. Asserting them against the same planted row is what
     * makes "we hid it" distinguishable from "we lost it".
     */
    it("★ (a) THE READER: the operator plane can see the same denial row that no tenant surface disclosed", async () => {
      assertSetupOk();

      const res = await request(appAsOperator()).get("/api/instance/security-denials");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const rows = res.body as (ActivityRow & { details: Record<string, unknown> | null })[];

      const probe = rows.find((r) => r.action === "security.denied.disclosure_path_probe");
      expect(
        probe,
        "the operator reader did not return the planted denial row — the evidence is written and still unreachable, which is the failure acceptance condition (a) exists to prevent",
      ).toBeTruthy();

      // ATTRIBUTION is the point of the namespace, so the reader must carry it
      // through rather than returning a bare count. All four questions:
      expect(probe?.companyId, "WHICH TENANT").toBe(coB);
      expect(probe?.entityType, "WHICH RESOURCE (kind)").toBe("issue");
      expect(probe?.entityId, "WHICH RESOURCE (id)").toBe(issueA);
      expect(probe?.details?.crossing, "WHICH CROSSING").toBe("E0-F013");
      expect(probe?.details?.reason, "WHY").toBe("cross_tenant_probe");
    });

    it("(a) the reader is closed to a company member — including one who is a member of the denial's own tenant", async () => {
      assertSetupOk();
      const res = await request(appAsMemberOf(coB)).get("/api/instance/security-denials");
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    });

    /**
     * POSITIVE CONTROL for the namespace predicate itself. Four green arms above
     * are also what a reader that returns EVERY activity row would produce, so
     * prove it excludes non-denial rows — the tenant-A `issue.created` row that
     * condition (c)'s positive control depends on must NOT appear here.
     */
    it("(a) the reader returns only the reserved namespace, not the whole audit log", async () => {
      assertSetupOk();
      const res = await request(appAsOperator()).get("/api/instance/security-denials");
      expect(res.status).toBe(200);
      const rows = res.body as ActivityRow[];
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.map((r) => r.action),
        "the operator reader returned an ordinary product activity row — it is a whole-audit-log reader wearing a denial-reader name",
      ).not.toContain("issue.created");
      expect(rows.every((r) => r.action.startsWith("security.denied."))).toBe(true);
    });

    it("(a) filters narrow rather than widen: an unmatched crossing returns nothing", async () => {
      assertSetupOk();
      const miss = await request(appAsOperator())
        .get("/api/instance/security-denials")
        .query({ crossing: "DE-NOT-A-CROSSING" });
      expect(miss.status).toBe(200);
      expect(miss.body).toEqual([]);

      // POSITIVE CONTROL — the same filter with the real value still matches, so
      // the empty result above is the predicate and not a broken filter path.
      const hit = await request(appAsOperator())
        .get("/api/instance/security-denials")
        .query({ crossing: "E0-F013" });
      expect(hit.status).toBe(200);
      expect((hit.body as ActivityRow[]).length).toBeGreaterThan(0);
    });

    /**
     * ★ (a) THE TAIL — raised as a P1 on the PR and fixed rather than argued.
     *
     * `since` is a LOWER bound and the order is newest-first, so before the
     * cursor existed the OLDEST matching rows were unreachable through the only
     * production reader of this namespace once the matches exceeded one page:
     * moving `since` earlier only ever adds NEWER rows. A sustained series of
     * identical refusals — which is what an incident looks like — therefore hid
     * its own beginning. That is evidence written and unreachable, the exact
     * failure acceptance condition (a) exists to prevent, so this arm is part of
     * the condition and not an ergonomics test.
     *
     * ★ THE FIXTURE DELIBERATELY CONTAINS A `created_at` TIE. Three of the five
     * rows share one timestamp, because that is what a burst of denials written
     * by one statement looks like and it is the case a timestamp-only cursor
     * gets wrong: `created_at < last_seen` skips the rest of the tie, and
     * `<=` repeats it forever. The assertion below is exact-set + no-duplicates,
     * so either mistake reds it. These rows are planted by raw SQL rather than
     * through `recordSecurityDenial` only because the recorder cannot be asked
     * for a chosen `created_at`; the attribution arms above are the ones that
     * prove the real writer's shape.
     */
    it("★ (a) THE TAIL: the OLDEST denial row is reachable by paging the cursor, ties included", async () => {
      assertSetupOk();

      // t1 is OLDER than t2. Three rows share t1 exactly (the tie), two share t2.
      await db.execute(sql`
        INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
        SELECT gen_random_uuid(), ${coB}, 'system', 'tail-prober',
               'security.denied.tail_probe', 'memory_item', 'tail-' || g,
               jsonb_build_object('crossing', 'E0-F013-TAIL', 'reason', 'tail_probe'),
               TIMESTAMPTZ '2020-01-01 00:00:00+00'
        FROM generate_series(1, 3) AS g`);
      await db.execute(sql`
        INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
        SELECT gen_random_uuid(), ${coB}, 'system', 'tail-prober',
               'security.denied.tail_probe', 'memory_item', 'tail-' || (g + 3),
               jsonb_build_object('crossing', 'E0-F013-TAIL', 'reason', 'tail_probe'),
               TIMESTAMPTZ '2020-01-01 00:00:01+00'
        FROM generate_series(1, 2) AS g`);

      const allPlanted = rowsOf<{ id: string }>(
        await db.execute(sql`
          SELECT id::text AS id FROM activity_log
          WHERE action = 'security.denied.tail_probe'
          ORDER BY created_at DESC, id DESC`),
      ).map((r) => r.id);
      expect(allPlanted.length, "the tail fixture was not planted").toBe(5);
      const oldestPlanted = allPlanted[allPlanted.length - 1]!;

      // POSITIVE CONTROL — one page really is too small to hold the tail, so an
      // "oldest is reachable" pass below cannot be an artefact of a page that
      // happened to contain everything.
      const firstPage = await request(appAsOperator())
        .get("/api/instance/security-denials")
        .query({ crossing: "E0-F013-TAIL", limit: 2 });
      expect(firstPage.status, JSON.stringify(firstPage.body)).toBe(200);
      const firstRows = firstPage.body as DenialRow[];
      expect(firstRows.length).toBe(2);
      expect(
        firstRows.map((r) => r.id),
        "the fixture is too small to prove anything: one page already holds the oldest row",
      ).not.toContain(oldestPlanted);

      const seen = await pageAll({ crossing: "E0-F013-TAIL" }, 2);

      expect(
        new Set(seen).size,
        "the cursor returned the same row on more than one page — a `<=` cursor repeats a `created_at` tie",
      ).toBe(seen.length);
      expect(
        seen,
        "paging the cursor did not enumerate every denial row exactly once in total order — the earliest incident evidence is unreachable or the tie was skipped",
      ).toEqual(allPlanted);
      expect(
        seen,
        "the OLDEST denial row was never returned by any page: evidence written and unreachable",
      ).toContain(oldestPlanted);
    });

    /**
     * ★ (a) THE CURSOR IS EMITTED, NOT INFERRED — the precision half of the same
     * P1, and the reason the reader carries a `cursor` field at all.
     *
     * Postgres orders these rows at MICROSECOND precision. `createdAt` reaches
     * the operator as JSON, where it is a `Date` truncated to MILLISECONDS. A
     * cursor built from `createdAt` therefore excludes every row that shares the
     * boundary row's millisecond but has a larger microsecond part — silently,
     * with a 200 and no error. Measured on this same embedded Postgres, 40 rows
     * written by 40 separate statements produced 40 distinct microsecond
     * timestamps and only 21 distinct millisecond ones, so that is not a corner
     * case; it is roughly half the rows.
     *
     * This arm plants rows that are distinct only BELOW the millisecond and
     * asserts the full set is still enumerable. It reds if the reader stops
     * emitting `cursor`, if `cursor` loses precision, or if the service parses
     * `before` through a `Date` anywhere on the path.
     */
    it("★ (a) THE CURSOR ROUND-TRIPS AT MICROSECOND PRECISION: rows inside one millisecond are not skipped", async () => {
      assertSetupOk();

      // Six rows inside a single millisecond, distinct only in microseconds.
      await db.execute(sql`
        INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
        SELECT gen_random_uuid(), ${coB}, 'system', 'us-prober',
               'security.denied.microsecond_probe', 'memory_item', 'us-' || g,
               jsonb_build_object('crossing', 'E0-F013-US', 'reason', 'microsecond_probe'),
               TIMESTAMPTZ '2020-02-02 00:00:00.500000+00' + (g || ' microseconds')::interval
        FROM generate_series(1, 6) AS g`);

      const planted = rowsOf<{ id: string; ms: string }>(
        await db.execute(sql`
          SELECT id::text AS id,
                 to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS ms
          FROM activity_log
          WHERE action = 'security.denied.microsecond_probe'
          ORDER BY created_at DESC, id DESC`),
      );
      expect(planted.length).toBe(6);
      // THE PREMISE OF THIS ARM, asserted rather than assumed: at millisecond
      // resolution these rows are indistinguishable from one another.
      expect(
        new Set(planted.map((r) => r.ms)).size,
        "the fixture does not actually collide at millisecond precision, so it proves nothing",
      ).toBe(1);

      const seen = await pageAll({ crossing: "E0-F013-US" }, 2);
      expect(
        seen,
        "paging lost rows that differ only below the millisecond — the cursor is being truncated somewhere on the round trip",
      ).toEqual(planted.map((r) => r.id));

      // ...and the negative: the SAME paging driven by `createdAt` instead of
      // `cursor` does lose them. This pins WHY the `cursor` field exists, so a
      // future reader cannot delete it as redundant and keep this file green.
      const firstPage = await request(appAsOperator())
        .get("/api/instance/security-denials")
        .query({ crossing: "E0-F013-US", limit: 2 });
      const firstRows = firstPage.body as DenialRow[];
      const lossy = await request(appAsOperator())
        .get("/api/instance/security-denials")
        .query({
          crossing: "E0-F013-US",
          limit: 10,
          before: firstRows[firstRows.length - 1]!.createdAt,
          beforeId: firstRows[firstRows.length - 1]!.id,
        });
      expect(lossy.status).toBe(200);
      expect(
        (lossy.body as DenialRow[]).length,
        "paging on `createdAt` returned everything, so millisecond truncation is not real here and this arm's premise is wrong",
      ).toBeLessThan(4);
    });

    /**
     * The cursor has two halves and only one of them is a timestamp. A caller
     * that sends `beforeId` alone must be REFUSED rather than quietly served an
     * unpaged newest-first page — a cursor half that silently does nothing is
     * how a pager loses the tail while looking like it works.
     */
    it("(a) half a cursor is refused, not silently ignored", async () => {
      assertSetupOk();
      const res = await request(appAsOperator())
        .get("/api/instance/security-denials")
        .query({ beforeId: "00000000-0000-0000-0000-000000000009" });
      expect(res.status, JSON.stringify(res.body)).toBe(400);

      // POSITIVE CONTROL — the same id WITH its timestamp half is accepted, so
      // the 400 above is the refinement and not a broken uuid/route path.
      const ok = await request(appAsOperator())
        .get("/api/instance/security-denials")
        .query({
          beforeId: "00000000-0000-0000-0000-000000000009",
          before: new Date().toISOString(),
        });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ★ THE TENANTLESS CASE — the half of condition (c) that could not be
     * tested when (c) was first proved, and can be now.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ★ WHY IT WAS DEFERRED, AND WHY THE REASON HAS EXPIRED. When the arms above
     * were written, `activity_log.company_id` was still NOT NULL: the tenantless
     * namespace was EMPTY, so a reader or a fence built against it could not be
     * made to go red and any arm asserting "the tenantless row is not disclosed"
     * would have passed vacuously — there was no such row to disclose. Migration
     * `0274` (E0-F013 Decision 2, ruled option (a2)) made the column NULLABLE
     * behind a partial CHECK, so the row can now exist and the arm can now fail.
     * These arms are worth exactly as much as that difference.
     *
     * ★ WHAT IS ACTUALLY UNDER TEST, AND WHY IT IS NOT THE SAME PROPERTY AS THE
     * ARMS ABOVE. The provocation at the top of this file plants a row belonging
     * to ANOTHER company: it is excluded because `company_id = $A` is false for
     * it. A tenantless row is excluded for a DIFFERENT reason — `company_id = $A`
     * is not false but NULL, and SQL's three-valued logic drops it from a WHERE.
     * The claim in the shipped comment ("a NULL `company_id` never satisfies
     * `company_id = $1`") is a claim about SQL semantics that the existing arms
     * never exercised. These drive it against real Postgres instead.
     *
     * ★ AND THE COMPLEMENT, WHICH IS THE POINT OF CONDITION (a). "Invisible
     * everywhere" is not the goal and would be a failure: a denial written into a
     * namespace no reader can reach is EVIDENCE WRITTEN AND UNREACHABLE, the
     * exact defect condition (a) exists to prevent. So the same planted row is
     * asserted UNREACHABLE from every company surface and REACHABLE from the
     * operator surface. Asserting both against ONE row is what distinguishes "we
     * fenced it" from "we lost it".
     *
     * ★ NO DEPENDENCE ON ANY UNLANDED UNIT. Every arm below runs against the
     * committed migration chain at this commit. `0274` is in it, so the nullable
     * column and the partial CHECK are present; the row is planted through the
     * REAL `recordSecurityDenial`, whose `companyId` field is already typed
     * `string | null`. Nothing here waits on a wiring unit to land.
     */

    /** The tenantless probe's action slug, kept distinct from the tenant-B one. */
    const TENANTLESS_ACTION = "security.denied.tenantless_disclosure_probe";
    let tenantlessId = "";

    it("plants a TENANTLESS probe through the REAL recorder: company_id NULL, typed `issue` against tenant A's issue id", async () => {
      assertSetupOk();

      const id = await recordSecurityDenial(db, {
        // ★ THE WHOLE POINT. Not tenant B, not tenant A — NO tenant. This is the
        // sink `0274` opened, and before it this insert violated a NOT NULL.
        companyId: null,
        crossing: "E0-F013",
        surface: "tenantless_disclosure_probe",
        reason: "tenantless_cross_tenant_probe",
        actorType: "system",
        actorId: "prober-tenantless",
        // Still caller-supplied free text, still aimed at tenant A's issue.
        entityType: "issue",
        entityId: issueA,
        control: "server/src/__tests__/e0-f013-denial-disclosure-path.integration.test.ts",
        details: { note: "planted by the tenantless half of acceptance condition (c)" },
      });

      // POSITIVE CONTROL — the row exists AND its company_id really is NULL.
      // Without this, every "it is not returned" assertion below would pass just
      // as well if the insert had been rejected by the CHECK, and the file would
      // be green while proving nothing at all.
      expect(
        id,
        "recordSecurityDenial returned null — the tenantless probe was never planted, so nothing below is a test",
      ).toBeTruthy();
      tenantlessId = id as string;
      const planted = rowsOf<{ n: string }>(
        await db.execute(sql`
          SELECT count(*)::text AS n FROM activity_log
          WHERE id = ${tenantlessId} AND company_id IS NULL
            AND action = ${TENANTLESS_ACTION} AND entity_type = 'issue' AND entity_id = ${issueA}`),
      );
      expect(
        planted[0]?.n,
        "the planted row is missing or its company_id is not NULL — the tenantless sink did not take it",
      ).toBe("1");
    });

    it("★ THE TENANTLESS PROVOCATION: a NULL-company denial row is not disclosed by GET /issues/:id/activity", async () => {
      assertSetupOk();

      const res = await request(appAsMemberOf(coA)).get(`/api/issues/${issueA}/activity`);

      // POSITIVE CONTROL — route reachable and authorized, not a 403/404 that
      // would empty the body for the wrong reason.
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const rows = res.body as ActivityRow[];

      expect(
        rows.map((r) => r.id),
        "GET /issues/:id/activity returned the TENANTLESS denial row — a NULL company_id passed a company predicate, so the fence does not hold for the sink `0274` opened",
      ).not.toContain(tenantlessId);
      expect(
        rows.map((r) => r.action),
        "GET /issues/:id/activity disclosed a tenantless `security.denied.*` row",
      ).not.toContain(TENANTLESS_ACTION);
      // Directly: no row without a tenant may reach a tenant surface.
      expect(
        rows.filter((r) => r.companyId === null),
        "GET /issues/:id/activity returned a row with no company at all",
      ).toEqual([]);

      // POSITIVE CONTROL — the legitimate same-tenant row still comes back. A
      // reader scoped to NOTHING passes all three assertions above.
      expect(
        rows.map((r) => r.action),
        "the same-tenant activity row vanished too — the reader was scoped to nothing, not to the company",
      ).toContain("issue.created");
    });

    /**
     * The SECOND company-scoped reader on this router. `forIssue` is not the only
     * door into `activity_log` from a tenant surface, and fencing one door is not
     * fencing the room — `activityService.list` behind
     * `GET /companies/:companyId/activity` is the other one, and it is where a
     * tenantless row would surface as "an event in my company" if its predicate
     * were ever written as anything but equality.
     */
    it("the tenantless row is not disclosed by the company activity feed either", async () => {
      assertSetupOk();

      const res = await request(appAsMemberOf(coA)).get(`/api/companies/${coA}/activity`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const rows = res.body as ActivityRow[];

      expect(
        rows.map((r) => r.id),
        "GET /companies/:companyId/activity returned the tenantless denial row",
      ).not.toContain(tenantlessId);
      expect(rows.filter((r) => r.companyId === null)).toEqual([]);

      // POSITIVE CONTROL — the feed is not simply empty.
      expect(
        rows.map((r) => r.action),
        "the company activity feed returned nothing at all — the assertions above are vacuous",
      ).toContain("issue.created");
    });

    /**
     * ★ THE COMPLEMENT. Everything above proves the row is hidden. This proves it
     * is not LOST. A tenantless denial that no production reader can reach is the
     * failure acceptance condition (a) exists to prevent, and it is the failure
     * mode a fence is most likely to cause.
     */
    it("★ (a) THE TENANTLESS ROW IS REACHABLE: the operator reader returns the row no tenant surface would", async () => {
      assertSetupOk();

      const res = await request(appAsOperator())
        .get("/api/instance/security-denials")
        .query({ crossing: "E0-F013" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const rows = res.body as (ActivityRow & { details: Record<string, unknown> | null })[];

      const probe = rows.find((r) => r.id === tenantlessId);
      expect(
        probe,
        "the operator reader did not return the tenantless denial row — the evidence is written and unreachable, which is exactly the defect condition (a) exists to prevent",
      ).toBeTruthy();

      // The attribution that SURVIVES having no tenant. `companyId` is null by
      // construction here, so the remaining questions must still be answerable
      // or the row is a bare count rather than evidence.
      expect(probe?.companyId, "a tenantless row must arrive AS tenantless, not as someone else's").toBe(null);
      expect(probe?.entityType, "WHICH RESOURCE (kind)").toBe("issue");
      expect(probe?.entityId, "WHICH RESOURCE (id)").toBe(issueA);
      expect(probe?.details?.reason, "WHY").toBe("tenantless_cross_tenant_probe");
    });

    /**
     * The `companyId` FILTER on the operator reader is a filter, never a scope —
     * but it must still NARROW. A NULL company matches no company, so asking for
     * one tenant's refusals must not sweep the tenantless row in with them.
     * Without this arm, a filter implemented as `company_id = $1 OR company_id IS
     * NULL` — an easy "be helpful" mistake — would go unnoticed, and it would
     * attribute an unattributable refusal to a named tenant.
     */
    it("(a) narrowing to one tenant excludes the tenantless row rather than adopting it", async () => {
      assertSetupOk();

      for (const [label, companyId] of [
        ["tenant A", coA],
        ["tenant B", coB],
      ] as const) {
        const res = await request(appAsOperator())
          .get("/api/instance/security-denials")
          .query({ companyId });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const rows = res.body as ActivityRow[];
        expect(
          rows.map((r) => r.id),
          `narrowing the denial reader to ${label} returned the TENANTLESS row — the filter widened instead of narrowing, and an unattributable refusal is now attributed to a named tenant`,
        ).not.toContain(tenantlessId);
        expect(rows.every((r) => r.companyId === companyId)).toBe(true);
      }

      // POSITIVE CONTROL — narrowing to tenant B still returns tenant B's own
      // planted denial, so the two assertions above are not passing on an empty
      // result set.
      const bRows = (
        await request(appAsOperator())
          .get("/api/instance/security-denials")
          .query({ companyId: coB })
      ).body as ActivityRow[];
      expect(
        bRows.map((r) => r.action),
        "narrowing to tenant B returned nothing — the arm above is vacuous",
      ).toContain("security.denied.disclosure_path_probe");
    });

    /**
     * ★ DE-06's INVARIANT, RE-ASSERTED AGAINST THE NEW ROW RATHER THAN ASSUMED.
     * DE-06 asserts that a PROBED tenant's `activity_log` stays EMPTY — a refusal
     * is attributed to the ACTOR's tenant, never to the tenant that was probed,
     * so being probed is not itself disclosed to the victim. Nothing in this unit
     * adds a per-company denial feed, and the tenantless row is attributed to no
     * tenant at all, so tenant A — the tenant whose issue id both probes aimed at
     * — must still hold ZERO denial rows of its own.
     */
    it("the PROBED tenant stays blind: tenant A owns no denial row despite being the target of both probes", async () => {
      assertSetupOk();

      const mine = rowsOf<{ n: string }>(
        await db.execute(sql`
          SELECT count(*)::text AS n FROM activity_log
          WHERE company_id = ${coA} AND action LIKE 'security.denied.%'`),
      );
      expect(
        mine[0]?.n,
        "a denial row was attributed to the PROBED tenant — DE-06's invariant is broken and the probed tenant now learns it was probed",
      ).toBe("0");

      // POSITIVE CONTROL — tenant A does have ordinary activity, so the zero
      // above is about the denial namespace and not about an empty table.
      const any = rowsOf<{ n: string }>(
        await db.execute(sql`SELECT count(*)::text AS n FROM activity_log WHERE company_id = ${coA}`),
      );
      expect(Number(any[0]?.n)).toBeGreaterThan(0);
    });
  },
);
