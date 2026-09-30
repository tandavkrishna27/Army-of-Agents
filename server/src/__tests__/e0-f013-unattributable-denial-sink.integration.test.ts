/**
 * E0-F013 Decision 2, ruled option (a2) — THE UNATTRIBUTABLE-DENIAL SINK.
 *
 * `docs/replatform/DECISION-REQUEST-unattributable-denial-sink.md` §4. The ruling
 * makes `activity_log.company_id` NULLABLE, adds a nullable `organization_id`,
 * and keeps the NOT NULL guarantee for every product writer with a partial
 *   CHECK (company_id IS NOT NULL OR action LIKE 'security.denied.%').
 *
 * ★ WHY THIS FILE EXISTS, and why arm 1 is the reason. Before the ruling, `NOT
 * NULL` was the only thing standing between the ~34 direct `insert(activityLog)`
 * product writers and a row belonging to no company. It is now a LIKE over a text
 * column, which is strictly weaker: it depends on a literal prefix staying in
 * step with `SECURITY_DENIAL_ACTION_PREFIX`, and on the predicate itself still
 * being attached. A relaxation that silently stops enforcing is exactly the
 * failure class this programme exists to stop, so the invariant the whole ruling
 * turns on carries its own provocation rather than riding on the migration's
 * word.
 *
 * ★ ALL FOUR ARMS WERE OBSERVED RED FIRST against the unchanged tree (the
 * `NOT NULL` column with no `organization_id`), and they fail for four DIFFERENT
 * reasons, which is the point — a harness that reds uniformly is broken, not
 * discriminating:
 *   0 (drift) — RED: `pg_constraint` has no `activity_log_company_or_denial_check`.
 *   1 (the invariant) — RED: the insert IS refused, but with SQLSTATE 23502
 *     (not-null violation) and no constraint name, not 23514 by the CHECK. The
 *     arm asserts the DISCRIMINATOR, not merely "it was refused", so it cannot
 *     pass on the old column's strength.
 *   2 (tenantless denial admitted) — RED: 23502, the recorder's insert is refused
 *     and `recordSecurityDenial` logs-and-returns-null.
 *   3 (verified organization carried) — RED: same swallow as arm 2. The write is
 *     refused before `organization_id` is ever reached, so a verified
 *     organization cannot be recorded even though the control held one.
 *   4 (POSITIVE CONTROL) — GREEN on the unchanged tree and GREEN after. An
 *     ordinary company-scoped product write is untouched by any of this.
 * Two further arms carry the deploy properties the migration claims in prose:
 *   5 (replay safety) — the readiness gate RE-APPLIES the pending tail, so 0274
 *     is re-executed statement by statement against a database that already has
 *     it, and must be a no-op. Without the C14 class (a) guards it reds 42701 /
 *     42710.
 *   6 (N/N-1) — `remote-compose-deploy.sh` rolls the BINARY back without
 *     reverting the DATABASE, so the N-1 binary's exact SQL (no
 *     `organization_id`, `company_id` always supplied) must still write and read.
 *   7 (the FK trap this PR lays) — an attested organization that no longer
 *     exists must DEGRADE to the tenantless sink, not vanish. Observed RED
 *     against this PR's own first draft, where `recordSecurityDenial` swallowed
 *     the 23503 and returned null.
 *
 * ★ THE NAMED POSITIVE CONTROL IS ARM 4, and the mutation discipline is: change
 * the CHECK predicate in `packages/db/src/schema/activity_log.ts` (e.g. to
 * `company_id IS NOT NULL OR action LIKE 'security.%'`, or drop the predicate to
 * `true`), regenerate, and arm 1 goes RED while arm 4 stays GREEN. If arm 4 also
 * reds, the harness broke and no verdict here is worth anything.
 *
 * ★ NOT A READ-BACK. Arms 2 and 3 provoke the REAL recorder
 * (`recordSecurityDenial`) against real PostgreSQL on the real non-owner
 * `aoa_app` role — the role production actually writes as, which holds
 * `SELECT, INSERT` on this table and nothing else. Asserting that a migration
 * DECLARED a nullable column would verify a declaration; these assert what the
 * database ENFORCES.
 *
 * Windows-skipped unless AOA_RUN_WIN_INTEGRATION=1 (embedded-postgres cannot
 * start on the `runneradmin` CI runner — Issue #114); Linux CI is the authority.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, type Db } from "@armyofagents/db";
import type { Sql } from "postgres";
import { startMigratedDatabase } from "./helpers/migrated-database.js";
import { recordSecurityDenial } from "../services/security-denial-audit.js";
import { SECURITY_DENIAL_ACTION_PREFIX } from "../services/activity-namespace.js";

const ORG = "f0130000-0000-4000-8000-000000000001";
const COMPANY = "f0130000-0000-4000-8000-000000000002";

const CHECK_NAME = "activity_log_company_or_denial_check";

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

type Fixture = {
  appDb: Db;
  admin: Sql;
  teardown: () => Promise<void>;
};

/**
 * Postgres surfaces SQLSTATE on `.code` and the violated constraint on
 * `.constraint_name`. Drizzle re-throws its own `DrizzleQueryError` with the
 * driver error on `.cause`, so the SQLSTATE is NOT on the outer object — reading
 * only the outer one yields `undefined` for every failure alike, which would make
 * arm 1's discriminator indistinguishable from "no error information at all".
 * Walk the cause chain to the first frame that carries a code.
 */
function pgError(err: unknown): { code?: string; constraint?: string; message: string } {
  let cursor: unknown = err;
  for (let depth = 0; depth < 5 && cursor; depth += 1) {
    const e = cursor as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    if (typeof e.code === "string") {
      return {
        code: e.code,
        constraint: e.constraint_name ?? e.constraint,
        message: String(e.message ?? err),
      };
    }
    cursor = e.cause;
  }
  return { code: undefined, constraint: undefined, message: String((err as Error)?.message ?? err) };
}

async function setUpFixture(): Promise<Fixture> {
  const database = await startMigratedDatabase({ label: "aoa-e0-f013-sink-" });
  const { admin, appDb, teardown } = database;
  try {
    // Seeded as ADMIN; every assertion below writes and reads as `aoa_app`.
    await admin`INSERT INTO organizations (id, name, slug)
      VALUES (${ORG}, 'E0-F013 org', 'e0-f013-org')`;
    await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
      VALUES (${COMPANY}, ${ORG}, 'E0-F013 company', 'F013')`;
    return { appDb, admin, teardown };
  } catch (error) {
    await teardown();
    throw error;
  }
}

describe.skipIf(!RUN)("E0-F013 Decision 2 (a2) — the unattributable-denial sink", () => {
  let fixture: Fixture | null = null;

  beforeAll(async () => {
    fixture = await setUpFixture();
  }, 180_000);

  afterAll(async () => {
    await fixture?.teardown();
  }, 60_000);

  function f(): Fixture {
    if (!fixture) throw new Error("E0-F013 sink fixture was not initialized");
    return fixture;
  }

  // ── ARM 0 ── the predicate exists, and its literal is the namespace constant.
  //
  // The CHECK hard-codes `'security.denied.%'`; the recorder builds its action
  // from `SECURITY_DENIAL_ACTION_PREFIX`. Two copies of one string in two
  // languages is a drift hazard, and drift here silently converts the retained
  // NOT NULL into a rejection of every denial write. Read the predicate back out
  // of the catalog and pin it against the constant.
  it("arm 0 — the CHECK is attached and its prefix literal IS the namespace constant", async () => {
    const rows = await f().admin<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'activity_log' AND c.conname = ${CHECK_NAME}`;
    expect(rows).toHaveLength(1);
    const def = rows[0]!.def;
    expect(def).toContain("CHECK");
    expect(def).toContain(`${SECURITY_DENIAL_ACTION_PREFIX}%`);
    // And the escape hatch really is scoped to the namespace: `company_id IS NOT
    // NULL` must still be one of the two disjuncts.
    expect(def).toContain("company_id IS NOT NULL");
  });

  // ── ARM 1 ── THE INVARIANT THE RULING TURNS ON.
  //
  // A product writer that omits `companyId` must still be refused BY THE
  // DATABASE. This is the shape of all ~34 direct `insert(activityLog)` sites:
  // a hard-coded, non-denial action, written on the `aoa_app` pool.
  it("arm 1 — a NON-denial row with a null company_id is REJECTED by the CHECK", async () => {
    let caught: unknown = null;
    try {
      await f()
        .appDb.insert(activityLog)
        .values({
          companyId: null,
          organizationId: null,
          actorType: "system",
          actorId: "arm-1-product-writer",
          // Deliberately OUTSIDE the reserved namespace, and deliberately a NEAR
          // MISS on it: `security.denied_by_hand` shares fifteen characters with
          // the prefix and must not slip through a sloppier predicate.
          action: "security.denied_by_hand",
          entityType: "issue",
          entityId: "arm-1-entity",
        });
    } catch (err) {
      caught = err;
    }
    expect(caught, "a null-company non-denial row was ACCEPTED — the retained NOT NULL is gone").not.toBeNull();
    const e = pgError(caught);
    // ★ THE DISCRIMINATOR. 23514 = check_violation. Against the pre-ruling tree
    // this row was refused too, but by 23502 (not_null_violation) with no
    // constraint name — so asserting only "it threw" would pass without the
    // CHECK ever existing, and this arm would be a check that nothing runs.
    expect(e.code, `expected check_violation 23514, got ${e.code}: ${e.message}`).toBe("23514");
    expect(e.constraint).toBe(CHECK_NAME);
  });

  // ── ARM 2 ── the relaxation is REAL inside the namespace.
  it("arm 2 — a security.denied.* row with a null company_id is ACCEPTED", async () => {
    const id = await recordSecurityDenial(f().appDb, {
      companyId: null,
      // No organization either — this is the DOUBLY NULL shape. Of DE-03's NINE
      // `recordProof` refusals, two are conditionally doubly null
      // (`worker-enrollment.ts:315` with an unrouted code, and
      // `middleware/worker-session-auth.ts:151` at platform scope); the pre-code
      // refusal at `worker-enrollment.ts:295` — not one of the nine — is doubly
      // null unconditionally, and is the shape reproduced here. It is the
      // weakest row the sink must still accept.
      crossing: "DE-03",
      surface: "worker_enrollment",
      reason: "enrollment_route_expired",
      actorType: "system",
      actorId: "device-thumbprint-arm-2",
      entityType: "worker_enrollment_code",
      entityId: "arm-2-entity",
      control: "server/src/services/worker-enrollment.ts:295",
    });
    // `recordSecurityDenial` NEVER throws — it logs and returns null. So a null
    // return is exactly the pre-ruling failure, and asserting the id is what
    // makes this arm falsifiable.
    expect(id, "the recorder swallowed the write — the tenantless denial was NOT stored").not.toBeNull();

    const [row] = await f()
      .appDb.select({
        companyId: activityLog.companyId,
        organizationId: activityLog.organizationId,
        action: activityLog.action,
      })
      .from(activityLog)
      .where(eq(activityLog.id, id!));
    expect(row).toBeDefined();
    expect(row!.companyId).toBeNull();
    expect(row!.organizationId).toBeNull();
    expect(row!.action).toBe(`${SECURITY_DENIAL_ACTION_PREFIX}worker_enrollment`);
  });

  // ── ARM 3 ── the second axis actually records something.
  it("arm 3 — a tenantless denial carries its VERIFIED organization_id", async () => {
    const id = await recordSecurityDenial(f().appDb, {
      companyId: null,
      // In production this value is token-attested: it comes off a control-plane
      // -minted, HMAC-verified worker session token
      // (`worker-operation-proof.ts:47-60`), never off the wire. The fixture
      // stands in for that by using the seeded organization's real id.
      organizationId: ORG,
      crossing: "DE-03",
      surface: "worker_session_auth",
      reason: "proof_replayed",
      actorType: "system",
      actorId: "worker-arm-3",
      entityType: "worker_session",
      entityId: "arm-3-entity",
      control: "server/src/middleware/worker-session-auth.ts:151",
    });
    expect(id, "the org-attributed denial was not stored").not.toBeNull();

    const [row] = await f()
      .appDb.select({
        companyId: activityLog.companyId,
        organizationId: activityLog.organizationId,
      })
      .from(activityLog)
      .where(eq(activityLog.id, id!));
    expect(row).toBeDefined();
    expect(row!.companyId).toBeNull();
    // ★ The org on the row is the one the refusing control verified — not a
    // caller-chosen destination (that is option (c), which was NOT ruled).
    expect(row!.organizationId).toBe(ORG);

    // …and the FK is real: the value references `organizations`, so a fabricated
    // org id cannot be stored at all.
    let caught: unknown = null;
    try {
      await f()
        .appDb.insert(activityLog)
        .values({
          companyId: null,
          organizationId: "f0130000-0000-4000-8000-0000000000ff",
          actorType: "system",
          actorId: "arm-3-forged",
          action: `${SECURITY_DENIAL_ACTION_PREFIX}forged`,
          entityType: "worker_session",
          entityId: "arm-3-forged-entity",
        });
    } catch (err) {
      caught = err;
    }
    expect(pgError(caught).code, "organization_id accepted a non-existent organization").toBe("23503");
  });

  // ── ARM 4 ── NAMED POSITIVE CONTROL. Nothing above may move this.
  it("arm 4 — POSITIVE CONTROL: an ordinary product write is unaffected", async () => {
    const [inserted] = await f()
      .appDb.insert(activityLog)
      .values({
        companyId: COMPANY,
        actorType: "user",
        actorId: "arm-4-founder",
        action: "issue.created",
        entityType: "issue",
        entityId: "arm-4-entity",
        details: { title: "an ordinary product row" },
      })
      .returning({ id: activityLog.id });
    expect(inserted?.id).toBeDefined();

    // It reads back through the company-scoped shape every one of the twelve
    // company-scoped readers uses — and the tenantless rows arms 2 and 3 wrote
    // do NOT appear in it, because a NULL never matches `eq(company_id, X)`.
    const scoped = await f()
      .appDb.select({ id: activityLog.id, action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, COMPANY), eq(activityLog.entityId, "arm-4-entity")));
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.action).toBe("issue.created");

    const [{ count }] = await f().appDb.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM activity_log WHERE company_id = ${COMPANY}`);
    expect(count).toBe(1);
  });

  // ── ARM 5 ── REPLAY SAFETY. The readiness gate RE-APPLIES the pending tail, so
  // a migration that is not idempotent breaks recovery rather than the deploy —
  // and it breaks it at the worst possible moment. Re-run 0274 statement by
  // statement against a database that already has it, as the OWNER (migrations
  // run as the database owner, not as `aoa_app`).
  //
  // RED-FIRST DISCIPLINE: strip the `IF NOT EXISTS` from the `ADD COLUMN` line
  // and this arm reds with 42701 (duplicate_column); strip a
  // `DROP CONSTRAINT IF EXISTS` and it reds with 42710 (duplicate_object). Both
  // were observed.
  it("arm 5 — the migration is REPLAY-SAFE: re-applying 0274 is a no-op", async () => {
    const migrationPath = fileURLToPath(
      new URL(
        "../../../packages/db/src/migrations/0274_activity_log_denial_sink.sql",
        import.meta.url,
      ),
    );
    const body = await readFile(migrationPath, "utf8");
    const statements = body
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Guard against a silently-empty replay: if the split ever yields nothing,
    // this arm would pass having executed no SQL at all.
    expect(statements.length).toBeGreaterThanOrEqual(5);

    for (const statement of statements) {
      await f().admin.unsafe(statement);
    }

    // The schema is still exactly what it should be after the second pass.
    const [column] = await f().admin<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'activity_log' AND column_name = 'company_id'`;
    expect(column!.is_nullable).toBe("YES");
    const [orgColumn] = await f().admin<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'activity_log' AND column_name = 'organization_id'`;
    expect(orgColumn!.is_nullable).toBe("YES");
    const checks = await f().admin<{ conname: string }[]>`
      SELECT c.conname FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'activity_log' AND c.conname = ${CHECK_NAME}`;
    // Exactly one — a replay that appended a duplicate constraint would show two.
    expect(checks).toHaveLength(1);

    // And the invariant still bites after the replay.
    let caught: unknown = null;
    try {
      await f()
        .appDb.insert(activityLog)
        .values({
          companyId: null,
          actorType: "system",
          actorId: "arm-5-after-replay",
          action: "issue.created",
          entityType: "issue",
          entityId: "arm-5-entity",
        });
    } catch (err) {
      caught = err;
    }
    expect(pgError(caught).code).toBe("23514");
  });

  // ── ARM 6 ── N/N-1 COMPATIBILITY (expand phase).
  //
  // `remote-compose-deploy.sh` rolls the BINARY back without reverting the
  // DATABASE, so the N-1 binary must keep working against the N schema. The N-1
  // binary's drizzle model has no `organization_id` and treats `company_id` as
  // NOT NULL, so its emitted SQL is exactly the column list below — reproduced
  // verbatim rather than approximated, because the compatibility claim is about
  // the SQL the old code actually sends.
  it("arm 6 — the N-1 binary still WRITES and READS correctly against the new schema", async () => {
    // N-1 INSERT: names its columns explicitly, omits `organization_id` entirely.
    const [written] = await f().appDb.execute<{ id: string }>(sql`
      INSERT INTO activity_log
        ("company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "details")
      VALUES (${COMPANY}, 'agent', 'n-1-binary', 'goal.updated', 'goal', 'arm-6-entity', ${sql.raw(
        "'{}'::jsonb",
      )})
      RETURNING id`);
    expect(written?.id).toBeDefined();

    // N-1 READ: the old column list, with no knowledge of `organization_id`.
    const read = await f().appDb.execute<{
      id: string;
      company_id: string;
      action: string;
    }>(sql`
      SELECT "id", "company_id", "actor_type", "actor_id", "action", "entity_type",
             "entity_id", "agent_id", "run_id", "details", "created_at"
      FROM activity_log
      WHERE "company_id" = ${COMPANY} AND "entity_id" = 'arm-6-entity'`);
    expect(read).toHaveLength(1);
    expect(read[0]!.company_id).toBe(COMPANY);
    expect(read[0]!.action).toBe("goal.updated");

    // ★ And the tenantless rows arms 2 and 3 wrote are INVISIBLE to it. Every
    // N-1 read path filters on `company_id`, and a NULL matches no such filter —
    // which is why the expand step cannot surprise the old binary with a row it
    // has no column for.
    const [{ count }] = await f().appDb.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM activity_log WHERE "company_id" = ${COMPANY}`);
    expect(count).toBe(2); // arm 4's row and this one. Neither tenantless row.
  });

  // ── ARM 7 ── THE TRAP THIS PR LAYS FOR THE WIRING UNIT (Codex P2, PR #403).
  //
  // `organizationId` is token-attested, which makes it trustworthy ATTRIBUTION —
  // but a signed id is not proof that the `organizations` row still EXISTS. The
  // FK added by this migration cannot tell the difference. Delete an
  // organization, then replay a worker token minted before the delete, and the
  // insert reds 23503 — and `recordSecurityDenial` never throws, so without a
  // fallback that error lands in the swallow and THE ONE denial class most worth
  // keeping (a replayed credential from a torn-down tenant) is the one that
  // records nothing.
  //
  // RED-FIRST: observed red against this PR's own first draft, where the single
  // `catch` logged and returned null. It failed on `expect(id).not.toBeNull()` —
  // a different failure from every other arm, because it is a different defect.
  //
  // ★ THREE MUTATIONS WERE RUN, AND EACH RED THIS ARM ALONE (arms 0-6 green
  // throughout, arm 4's positive control included):
  //   1. disable the fallback (`false && attested !== null`) → RED on
  //      `expect(id).not.toBeNull()`. The fallback is load bearing.
  //   2. point `ORGANIZATION_FK_CONSTRAINT` at the COMPANY foreign key → RED the
  //      same way. The constraint NAME is load bearing, not just the SQLSTATE.
  //   3. widen the retry to any 23503 AND make it drop `company_id` too → RED on
  //      the narrowness assertion below (`a bad company FK was laundered…`), not
  //      on the first. So the second half of this arm discriminates too, rather
  //      than passing for free.
  //
  // ★ It is unreachable through production callers today (none passes
  // `organizationId`), which is exactly why it is proven here rather than left
  // as a note for the unit that would have tripped over it.
  it("arm 7 — an attested organization that no longer exists DEGRADES to the tenantless sink", async () => {
    const GONE_ORG = "f0130000-0000-4000-8000-000000000003";
    // Mint the organization, then destroy it — the real sequence, not a
    // fabricated id. A token attesting GONE_ORG is still perfectly valid HMAC.
    await f().admin`INSERT INTO organizations (id, name, slug)
      VALUES (${GONE_ORG}, 'E0-F013 deleted org', 'e0-f013-gone')`;
    await f().admin`DELETE FROM organizations WHERE id = ${GONE_ORG}`;

    const id = await recordSecurityDenial(f().appDb, {
      companyId: null,
      organizationId: GONE_ORG,
      crossing: "DE-03",
      surface: "worker_session_auth",
      reason: "proof_replayed",
      actorType: "system",
      actorId: "worker-arm-7",
      entityType: "worker_session",
      entityId: "arm-7-entity",
      control: "server/src/middleware/worker-session-auth.ts:151",
    });
    expect(
      id,
      "the stale-credential denial went UNAUDITED — the 23503 was swallowed instead of falling back",
    ).not.toBeNull();

    const [row] = await f()
      .appDb.select({
        companyId: activityLog.companyId,
        organizationId: activityLog.organizationId,
        action: activityLog.action,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.id, id!));
    expect(row).toBeDefined();
    expect(row!.companyId).toBeNull();
    expect(row!.organizationId).toBeNull();
    expect(row!.action).toBe(`${SECURITY_DENIAL_ACTION_PREFIX}worker_session_auth`);
    // ★ DEGRADED, NOT LOST. The attested id survives in `details`, so a reader
    // can still say WHICH organization was attested and that the FK — not the
    // caller, and not a missing attestation — is why the column is null.
    expect(row!.details?.organizationAttributionDropped).toBe(true);
    expect(row!.details?.unresolvedOrganizationId).toBe(GONE_ORG);
    // The ordinary fields are not collateral damage of the retry.
    expect(row!.details?.crossing).toBe("DE-03");
    expect(row!.details?.reason).toBe("proof_replayed");

    // ★ NARROWNESS. The fallback fires for the ORGANIZATION foreign key only. A
    // denial naming a company that does not exist must still fail closed rather
    // than being silently rewritten into the tenantless sink — a company FK
    // violation is a caller bug, not a torn-down tenant, and laundering it into
    // an unattributed row would hide it.
    const orphanCompany = await recordSecurityDenial(f().appDb, {
      companyId: "f0130000-0000-4000-8000-0000000000fe",
      crossing: "DE-03",
      surface: "worker_session_auth",
      reason: "proof_replayed",
      actorType: "system",
      actorId: "worker-arm-7-orphan",
      entityType: "worker_session",
      entityId: "arm-7-orphan-entity",
      control: "server/src/middleware/worker-session-auth.ts:151",
    });
    expect(orphanCompany, "a bad company FK was laundered into the tenantless sink").toBeNull();
    const [{ count: orphanRows }] = await f().appDb.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM activity_log WHERE entity_id = 'arm-7-orphan-entity'`);
    expect(orphanRows).toBe(0);
  });
});
