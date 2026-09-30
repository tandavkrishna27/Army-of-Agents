/**
 * E0-F013 Decision 3 — Q3, the disclosure to the ACTOR'S OWN TENANT, closed and
 * PROVOKED per tenant-facing reader.
 *
 * ★ WHAT THE FOUNDER RULED (2026-09-11, best-practice throughout). A
 * `security.denied.*` row is disclosed to NO tenant. Q2 — the PROBED tenant —
 * was already true: no per-company denial feed exists, and DE-06/DE-19/DE-21's
 * suites assert the probed tenant's `activity_log` is empty. Q3 — the ACTOR'S
 * OWN tenant — was NOT. A cross-tenant probe mounted from inside tenant A files
 * its refusal under tenant A (actor-attribution, ratified as Q1), so before this
 * slice the prober's own colleagues, and the prober, read the detection through
 * four live tenant-facing readers. The decision paper's §3 census named exactly
 * these four (`DECISION-REQUEST-denial-retention-and-disclosure.md` §3, §8):
 *
 *   1. `activityService.list`        — GET /companies/:cid/activity
 *   2. `homeService.summary`         — GET /companies/:cid/home (carries full `details`)
 *   3. `cockpitTeammatesActivity`    — GET /companies/:cid/cockpit
 *   4. `morningDigest`               — Commander's overnight digest (feeds an LLM)
 *
 * ★ WHY A PROVOCATION PER READER, NOT ONE. The paper's own finding is that a
 * single test against `/activity` would have passed while `/home` returned the
 * whole row — "precisely the shape of defect this condition exists to catch". So
 * each reader is driven directly against real Postgres, over the SAME planted
 * denial row, and each has a named positive control so "return nothing" fails
 * this file.
 *
 * ★ WHY THE ROW IS PLANTED THROUGH THE REAL RECORDER. `recordSecurityDenial` is
 * what composes the reserved `security.denied.` action and writes it under the
 * ACTOR's own tenant — company A here. Asserting against a hand-inserted row
 * would prove the predicate reads back what a test declared; planting through
 * the real writer proves what is ENFORCED on the real namespace.
 *
 * ★ THE DENIAL ROW IS TYPED `actorType: 'user'` ON PURPOSE. The cockpit reader
 * has a HUMAN_ACTORS allowlist (`['user','board']`) that already drops
 * agent/system denials, so a denial typed `system` would be excluded there for
 * the WRONG reason and the cockpit arm would pass without the new predicate. A
 * HUMAN actor refused a cross-tenant action is a real `user` denial row that
 * passes the allowlist — the exact row only `notDenialNamespace()` excludes.
 *
 * ★ THE COMPLEMENT — the operator plane STILL sees it. "Invisible everywhere" is
 * the failure this programme exists to stop: a denial written into a namespace
 * no reader can reach is evidence written and unreachable. The final arm asserts
 * `activityService.securityDenials` returns the same row every tenant reader
 * hides, so the fix hid it rather than lost it.
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { activityService } from "../services/activity.js";
import { homeService } from "../services/home.js";
import { cockpitTeammatesActivity } from "../services/cockpit.js";
import { morningDigest } from "../services/internal-agent/proactive.js";
import { recordSecurityDenial } from "../services/security-denial-audit.js";
import type { CockpitScope } from "../services/cockpit-scope.js";
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

/** Tenant A — the ACTOR's own tenant, the tenant every reader below is a member of. */
let coA = "";
/** The founder scope the cockpit reader resolves for; its userId must differ from
 *  both seeded actors so neither is filtered out by cockpit's `ne(actorId, self)`. */
const FOUNDER_SCOPE: CockpitScope = {
  userId: "founder-user",
  role: "founder",
  isFounder: true,
  leadDepartmentIds: [],
};

/** The action slugs, kept distinct so an assertion names exactly one row. */
const DENIAL_ACTION = "security.denied.own_tenant_probe";
const NORMAL_ACTION = "goal.created";
let denialId = "";

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-e0f013-q3-"));
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
    console.error("[e0f013-q3] embedded-postgres setup failed:", err);
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
  "E0-F013 Decision 3 (Q3) — a `security.denied.*` row filed under the actor's OWN tenant is disclosed to no tenant-facing reader",
  () => {
    it("setup: one company, one same-tenant denial row (through the REAL recorder) and one ordinary row", async () => {
      assertSetupOk();

      coA = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (organization_id, id, name, issue_prefix)
          VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Q3 Disclosure Co', 'Q3C')
          RETURNING id`),
      );
      expect(coA).toBeTruthy();

      // The denial row, filed under the ACTOR's OWN tenant (company A) by the
      // real recorder. actorType 'user' so it passes cockpit's HUMAN_ACTORS
      // allowlist; actorId differs from FOUNDER_SCOPE.userId so cockpit's
      // `ne(actorId, self)` does not drop it either — only the new predicate can.
      denialId =
        (await recordSecurityDenial(db, {
          companyId: coA,
          crossing: "DE-19",
          surface: "own_tenant_probe",
          reason: "cross_tenant_probe",
          actorType: "user",
          actorId: "prober-human",
          entityType: "memory_item",
          entityId: "mem-probed",
          control: "server/src/__tests__/e0-f013-denial-own-tenant-disclosure.integration.test.ts",
          details: { requestedCompanyId: "some-other-tenant", keyId: "leaky-key" },
        })) ?? "";
      // POSITIVE CONTROL — the denial row really is in the table AND filed under
      // tenant A. Without this, every "not returned" assertion below would pass
      // just as well if the insert had silently failed.
      expect(denialId, "recordSecurityDenial returned null — the probe was never planted").toBeTruthy();
      const planted = rowsOf<{ n: string }>(
        await db.execute(sql`
          SELECT count(*)::text AS n FROM activity_log
          WHERE id = ${denialId} AND company_id = ${coA} AND action = ${DENIAL_ACTION}`),
      );
      expect(planted[0]?.n, "the denial row is missing or not filed under tenant A").toBe("1");

      // The ordinary same-tenant row every arm uses as its positive control. A
      // human teammate action (actorType 'user', actorId != founder) so it also
      // appears in the cockpit teammates feed. entity_type 'goal' keeps it clear
      // of the issues left-join in `activityService.list`.
      await db.execute(sql`
        INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id)
        VALUES (gen_random_uuid(), ${coA}, 'user', 'teammate-user', ${NORMAL_ACTION}, 'goal', gen_random_uuid()::text)`);
    });

    it("1. activityService.list (GET /companies/:cid/activity) does not return the same-tenant denial row", async () => {
      assertSetupOk();
      const rows = await activityService(db).list({ companyId: coA });
      const actions = rows.map((r) => r.action);

      expect(
        actions,
        "activityService.list returned a `security.denied.*` row to a member of the row's OWN tenant — Q3 is open",
      ).not.toContain(DENIAL_ACTION);
      expect(rows.map((r) => r.id)).not.toContain(denialId);
      // POSITIVE CONTROL — the ordinary same-tenant row still comes back, so the
      // absence above is the predicate and not a reader scoped to nothing.
      expect(
        actions,
        "the ordinary same-tenant row vanished too — the reader was scoped to nothing",
      ).toContain(NORMAL_ACTION);
    });

    it("2. homeService.summary (GET /companies/:cid/home) does not return the denial row, details included", async () => {
      assertSetupOk();
      const summary = await homeService(db).summary(coA, "founder-user");
      const actions = summary.recentActivity.map((r) => r.action);

      expect(
        actions,
        "homeService.summary disclosed a `security.denied.*` row (with its `details` payload) to its own tenant",
      ).not.toContain(DENIAL_ACTION);
      expect(summary.recentActivity.map((r) => r.id)).not.toContain(denialId);
      // POSITIVE CONTROL — the recent-activity feed is not simply empty.
      expect(
        actions,
        "the recent-activity feed returned nothing — the assertion above is vacuous",
      ).toContain(NORMAL_ACTION);
    });

    it("3. cockpitTeammatesActivity (GET /companies/:cid/cockpit) does not return the denial row", async () => {
      assertSetupOk();
      const rows = await cockpitTeammatesActivity(db, coA, FOUNDER_SCOPE);
      const actions = rows.map((r) => r.action);

      expect(
        actions,
        "the cockpit teammates feed disclosed a human `security.denied.*` row — it passed HUMAN_ACTORS and only the new predicate should have dropped it",
      ).not.toContain(DENIAL_ACTION);
      expect(rows.map((r) => r.id)).not.toContain(denialId);
      // POSITIVE CONTROL — the ordinary human-teammate row still comes back, so
      // HUMAN_ACTORS + `ne(actorId, self)` did not empty the feed on their own.
      expect(
        actions,
        "the cockpit teammates feed returned nothing — the assertion above is vacuous",
      ).toContain(NORMAL_ACTION);
    });

    it("4. morningDigest (Commander's overnight digest) does not return the denial row", async () => {
      assertSetupOk();
      const result = await morningDigest(db, coA, "founder-user");
      const rows = result.digest.overnightActivity as { id: string; action: string }[];
      const actions = rows.map((r) => r.action);

      expect(
        actions,
        "morningDigest fed a `security.denied.*` row to the LLM digest of the row's own tenant",
      ).not.toContain(DENIAL_ACTION);
      expect(rows.map((r) => r.id)).not.toContain(denialId);
      // POSITIVE CONTROL — the overnight window is not simply empty.
      expect(
        actions,
        "the overnight digest returned nothing — the assertion above is vacuous",
      ).toContain(NORMAL_ACTION);
    });

    it("5. activityService.forIssue (GET /issues/:id/activity) does not return a denial filed under an issue (Codex P2)", async () => {
      assertSetupOk();
      // recordSecurityDenial ACCEPTS entityType:'issue', so the disclosure boundary must
      // cover this 5th tenant-facing reader too — not depend on "no writer files a denial
      // under an issue". Plant a denial under an issue in tenant A, plus an ordinary issue
      // row as the positive control, and read the issue's activity as a member of A.
      const issueId = firstId(await db.execute<{ id: string }>(sql`SELECT gen_random_uuid() AS id`));
      const issueDenialId =
        (await recordSecurityDenial(db, {
          companyId: coA,
          crossing: "DE-19",
          surface: "own_tenant_probe",
          reason: "cross_tenant_probe",
          actorType: "user",
          actorId: "prober-human",
          entityType: "issue",
          entityId: issueId,
          control: "server/src/__tests__/e0-f013-denial-own-tenant-disclosure.integration.test.ts",
          details: { requestedCompanyId: "some-other-tenant" },
        })) ?? "";
      expect(issueDenialId, "the issue-scoped denial was never planted").toBeTruthy();
      await db.execute(sql`
        INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id)
        VALUES (gen_random_uuid(), ${coA}, 'user', 'teammate-user', ${NORMAL_ACTION}, 'issue', ${issueId})`);

      const rows = await activityService(db).forIssue(coA, issueId);
      const actions = rows.map((r) => r.action);
      expect(
        actions,
        "forIssue returned a `security.denied.*` row to a member of the row's own tenant — the 5th reader leaks",
      ).not.toContain(DENIAL_ACTION);
      expect(rows.map((r) => r.id)).not.toContain(issueDenialId);
      // POSITIVE CONTROL — the issue's ordinary activity IS still returned.
      expect(actions, "forIssue returned nothing — the assertion above is vacuous").toContain(NORMAL_ACTION);
    });

    it("★ THE COMPLEMENT: the operator reader STILL returns the row every tenant reader hid (hidden, not lost)", async () => {
      assertSetupOk();
      const rows = await activityService(db).securityDenials({});
      const probe = rows.find((r) => r.id === denialId);

      expect(
        probe,
        "the operator reader did not return the denial row — it was over-hidden, which is evidence written and unreachable",
      ).toBeTruthy();
      // Attribution survives: the operator can still answer who/where/why.
      expect(probe?.action).toBe(DENIAL_ACTION);
      expect(probe?.companyId, "the row is still attributed to the actor's own tenant").toBe(coA);
      expect((probe?.details as Record<string, unknown> | null)?.reason, "WHY").toBe("cross_tenant_probe");

      // POSITIVE CONTROL — the operator reader is scoped to the namespace, not to
      // the whole log: the ordinary row does NOT appear here.
      expect(
        rows.map((r) => r.action),
        "the operator reader returned an ordinary product row — it is a whole-log reader wearing a denial-reader name",
      ).not.toContain(NORMAL_ACTION);
    });
  },
);
