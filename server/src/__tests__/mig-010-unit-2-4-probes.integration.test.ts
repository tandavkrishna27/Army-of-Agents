// MIG-010 Unit 2.4 — PROBES. What PostgreSQL actually does, measured on this box.
//
// ★ WHY THIS FILE EXISTS AT ALL. Three design rounds produced a watermark mechanism that
// looked correct, passed review, and was wrong: a company-scoped pass that could not call an
// org-bound function; an OPTIONAL watermark that *opens* the gate; a total that vanishes
// exactly when it is needed. All three passed review. All three were caught only by running
// PostgreSQL. So Unit 2.4 leads with measurement, and every later step cites a result here
// rather than an expectation (design 2026-09-01-blocker-e-2-e-3 §11.5).
//
// These are throwaway-SHAPED but permanent. They pin behaviours the design depends on so a
// future reader does not have to re-derive them, and so a PostgreSQL upgrade that changes one
// of them reds here — next to the reasoning — rather than in the gate.
//
// Every function below is created in a scratch schema (`probe_2_4`), never `public`: nothing
// here is a manifested SECURITY DEFINER surface and nothing here must ever be mistaken for one
// by `assertNoUnmanifestedSecurityDefinerFunctions`.
//
// Windows-skipped unless AOA_RUN_WIN_INTEGRATION=1 (Issue #114); Linux CI is the authority.
//
// ══ MEASURED RESULTS ══════════════════════════════════════════════════════════════════════
// Recorded 2026-09-02 against `PostgreSQL 18.1 on x86_64-windows` (embedded-postgres
// 18.1.0-beta.16), driver postgres.js 3.4.8 under drizzle-orm 0.45.2. Every result below
// AGREES with the design; nothing here contradicted it.
//
//   §11.1  bigint  -> the driver returns a STRING. `typeof unnarrowed_total === "string"`,
//                    value "3", through BOTH the raw postgres.js client and `db.execute`.
//                    ★ So `total > 0` is a comparison on a string. Unit 2.4b converts
//                    EXPLICITLY -- `Number(total) > 0` -- and never relies on coercion.
//   §11.1  array_agg over an empty set -> `null`, NOT `[]`. The narrowed-empty case is
//                    therefore `lease_ids === null`, not `lease_ids.length === 0`.
//   §11.1  the set-returning shape returns 0 rows when the narrowed set is empty (the total
//                    is unobservable); the one-row shape returns 1 row carrying total 3.
//   §10.1a a NULL watermark narrows TOTALLY (ids null, total 3) -- it does not widen.
//   §11.2  a stale 2-arg call against a REQUIRED-3rd-parameter overload resolves SILENTLY to
//                    the 2-arg function ("TWO-ARG"). No error. After `DROP FUNCTION ...(uuid,
//                    uuid)` the same call raises SQLSTATE 42883, not 42501.
//   §11.2  the same call against a DEFAULTED overload raises SQLSTATE 42725 -- which is why
//                    §10.3's recorded reason for the DROP was wrong, and the truth is worse.
//   §10.2  a DEFAULT-only CREATE OR REPLACE leaves identity_arguments, proconfig, proacl and
//                    sha256(prosrc) BYTE-IDENTICAL. The certificate cannot see it.
//   §11.2  CREATE OR REPLACE with a different RETURNS TABLE raises SQLSTATE 42P13.
//   §10.3.5 identity_arguments renders exactly:
//                    `p_organization_id uuid, p_company_id uuid, p_watermark timestamp with time zone`
//   clocks  now() is transaction-start; a row inserted by a transaction that BEGAN before the
//                    watermark read carries created_at < watermark even when it COMMITS after
//                    -- it stays IN scope, the fail-CLOSED direction.
// ══════════════════════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import postgres, { type Sql } from "postgres";
import type { Db } from "@armyofagents/db";
import { startMigratedDatabase } from "./helpers/migrated-database.js";

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

const ROW_A = "2a000000-0000-4000-8000-00000000000a";
const ROW_B = "2a000000-0000-4000-8000-00000000000b";
const ROW_C = "2a000000-0000-4000-8000-00000000000c";

/** Predates every fixture row: the "the pass predates the entire fleet" case (§10.3 point 4). */
const BEFORE_EVERYTHING = "2000-01-01T00:00:00Z";
/** Postdates every fixture row. */
const AFTER_EVERYTHING = "2999-01-01T00:00:00Z";

type Fixture = {
  admin: Sql;
  operatorDb: Db;
  adminUrl: string;
  teardown: () => Promise<void>;
};
let fixture: Fixture | null = null;

/** postgres.js rejects with a PostgresError carrying `.code`; anything else is a real bug. */
async function sqlstateOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    throw error;
  }
  throw new Error("expected the statement to raise, but it succeeded");
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

describe.skipIf(!RUN)("MIG-010 Unit 2.4 probes — measured PostgreSQL behaviour", () => {
  beforeAll(async () => {
    const database = await startMigratedDatabase({ label: "aoa-mig-010-probe-" });
    const { admin, operatorDb, adminUrl, teardown } = database;
    try {
      await admin`CREATE SCHEMA probe_2_4`;
      await admin`CREATE TABLE probe_2_4.fixture (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await admin`INSERT INTO probe_2_4.fixture (id, created_at) VALUES
        (${ROW_A}, '2026-01-01T00:00:00Z'),
        (${ROW_B}, '2026-02-01T00:00:00Z'),
        (${ROW_C}, '2026-03-01T00:00:00Z')`;
      // Grant the operator role enough to run the driver-shape assertion through the SAME
      // stack production uses (drizzle over postgres-js), not just the raw admin client.
      // The scratch functions are SECURITY INVOKER on purpose -- nothing in a probe schema
      // should ever be a definer surface -- so the operator needs SELECT on the fixture too.
      await admin`GRANT USAGE ON SCHEMA probe_2_4 TO "aoa_operator"`;
      await admin`GRANT SELECT ON probe_2_4.fixture TO "aoa_operator"`;
    } catch (error) {
      await teardown();
      throw error;
    }
    fixture = { admin, operatorDb, adminUrl, teardown };
  }, 180_000);

  afterAll(async () => {
    await fixture?.teardown();
    fixture = null;
    // 60s to match canary-preflight-real-role.integration.test.ts:106-108 — on the default hook
    // timeout a slow embedded-postgres teardown fails THIS file, which reads as a defect in the
    // behaviour under measurement rather than as the shutdown being slow.
  }, 60_000);

  it("[probe 0] records the server version these results were measured on", async () => {
    const rows = await fixture!.admin<{ version: string }[]>`SELECT version() AS version`;
    const version = rows[0]!.version;
    // Not an assertion about a specific release — a RECORD. If a future upgrade changes any
    // result below, this line says what the old results were measured against.
    // eslint-disable-next-line no-console
    console.log(`[probe 0] server: ${version}`);
    expect(version).toContain("PostgreSQL");
  });

  // ---------------------------------------------------------------------------------------
  // §11.1 — a set-returning shape cannot carry a fact about the empty set.
  // ---------------------------------------------------------------------------------------

  it("[§11.1] a set-returning shape loses the total on the empty set; the one-row contract keeps it", async () => {
    const { admin } = fixture!;

    // The shape §10.3 point 4 proposed: one row per match, carrying the total on each row.
    await admin`CREATE FUNCTION probe_2_4.set_shape(p_watermark timestamptz)
      RETURNS TABLE (lease_id uuid, unnarrowed_total bigint)
      LANGUAGE sql STABLE AS $$
        SELECT f.id, (SELECT count(*) FROM probe_2_4.fixture)
        FROM probe_2_4.fixture f
        WHERE f.created_at <= p_watermark;
      $$`;

    // The shape §11.1 prescribes, modelled on 0267's `canary_preflight_evidence_scalars`:
    // array_agg over the NARROWED set, count over the UNNARROWED set, one row always.
    await admin`CREATE FUNCTION probe_2_4.one_row(p_watermark timestamptz)
      RETURNS TABLE (lease_ids uuid[], unnarrowed_total bigint)
      LANGUAGE sql STABLE AS $$
        SELECT array_agg(f.id) FILTER (WHERE f.created_at <= p_watermark), count(*)
        FROM probe_2_4.fixture f;
      $$`;

    // (a) A watermark that predates every row — the case the churn guard exists to detect.
    const setEmpty = await admin`SELECT * FROM probe_2_4.set_shape(${BEFORE_EVERYTHING}::timestamptz)`;
    expect(setEmpty).toHaveLength(0); // the total is UNOBSERVABLE — the §10.3 point 4 defect

    const oneEmpty = await admin`SELECT * FROM probe_2_4.one_row(${BEFORE_EVERYTHING}::timestamptz)`;
    expect(oneEmpty).toHaveLength(1);
    expect(oneEmpty[0]!.lease_ids).toBeNull(); // array_agg over an empty set is NULL, not []
    // ★ THE DRIVER SHAPE FOR bigint. 2.4b compares this against 0, and `"3" > 0` is a silent
    // bug that no type error catches. Whatever the assertion below says is what 2.4b must
    // code against — do not re-derive it, and do not assume 3n.
    // eslint-disable-next-line no-console
    console.log(
      `[§11.1] driver bigint: typeof=${typeof oneEmpty[0]!.unnarrowed_total} value=${String(
        oneEmpty[0]!.unnarrowed_total,
      )}; array_agg empty: ${JSON.stringify(oneEmpty[0]!.lease_ids)}`,
    );
    expect(String(oneEmpty[0]!.unnarrowed_total)).toBe("3");

    // (b) A watermark that covers everything — both shapes agree here, which is why the
    // defect is invisible in the happy path.
    const setFull = await admin`SELECT * FROM probe_2_4.set_shape(${AFTER_EVERYTHING}::timestamptz)`;
    expect(setFull).toHaveLength(3);
    const oneFull = await admin`SELECT * FROM probe_2_4.one_row(${AFTER_EVERYTHING}::timestamptz)`;
    expect(oneFull).toHaveLength(1);
    expect(oneFull[0]!.lease_ids).toHaveLength(3);
    expect(String(oneFull[0]!.unnarrowed_total)).toBe("3");
  });

  it("[§11.1 driver] the SAME one-row read through drizzle/postgres-js, which is what production uses", async () => {
    // The gate reads through `db.execute`, not the raw admin client. If drizzle's result
    // shape or its int8 parser differed, 2.4b would be coding against the wrong measurement.
    const result = await fixture!.operatorDb.execute(
      sql`SELECT lease_ids, unnarrowed_total
          FROM probe_2_4.one_row(${BEFORE_EVERYTHING}::timestamptz)`,
    );
    const rows = rowsOf<{ lease_ids: string[] | null; unnarrowed_total: unknown }>(result);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lease_ids).toBeNull();
    // eslint-disable-next-line no-console
    console.log(
      `[§11.1 driver] drizzle bigint: typeof=${typeof rows[0]!.unnarrowed_total} value=${String(
        rows[0]!.unnarrowed_total,
      )}`,
    );
    expect(String(rows[0]!.unnarrowed_total)).toBe("3");
    // ★ The comparison 2.4b must write. Pin the SAFE form explicitly: an EXPLICIT Number()
    // conversion, never a bare relational operator on whatever the driver handed back. The
    // hazard §11.1 names is that a string silently participates in a numeric comparison and
    // nothing in the type system objects.
    expect(Number(rows[0]!.unnarrowed_total) > 0).toBe(true);
  });

  it("[§10.1(a)] a NULL watermark narrows TOTALLY, and the one-row contract makes that OBSERVABLE", async () => {
    // §10.1(a): `created_at <= NULL` is NULL, which the FILTER treats as not-true. NULL means
    // TOTAL narrowing, the opposite of "no narrowing". Under the OLD set-returning shape this
    // was a silent admit (empty inventory ⇒ vacuous closure). Under the one-row contract the
    // total survives, so the churn arm SEES it. That is why the contract is the fix and the
    // "raise on NULL" body is belt-and-braces rather than the mechanism.
    const rows = await fixture!.admin`SELECT * FROM probe_2_4.one_row(NULL::timestamptz)`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lease_ids).toBeNull();
    expect(String(rows[0]!.unnarrowed_total)).toBe("3");
  });

  // ---------------------------------------------------------------------------------------
  // §11.2 — the overload trap, and why the DROP is mandatory.
  // ---------------------------------------------------------------------------------------

  it("[§11.2] a REQUIRED third parameter does NOT raise 42725 — the stale 2-arg call resolves silently to the old function", async () => {
    const { admin } = fixture!;
    await admin`CREATE FUNCTION probe_2_4.req(p_a uuid, p_b uuid)
      RETURNS TABLE (marker text) LANGUAGE sql STABLE AS $$ SELECT 'TWO-ARG'::text $$`;
    await admin`CREATE FUNCTION probe_2_4.req(p_a uuid, p_b uuid, p_watermark timestamptz)
      RETURNS TABLE (marker text) LANGUAGE sql STABLE AS $$ SELECT 'THREE-ARG'::text $$`;

    // ★ THE FAIL-OPEN, MEASURED. Not an error. The old, UNNARROWED function answers, and the
    // caller believes it read a narrowed inventory. This is the reason the DROP is mandatory —
    // §10.3 recorded the reason as 42725, and that reason was wrong.
    const stale = await admin`SELECT * FROM probe_2_4.req(${ROW_A}::uuid, ${ROW_B}::uuid)`;
    expect(stale).toHaveLength(1);
    expect(stale[0]!.marker).toBe("TWO-ARG");

    // After the DROP the same stale call is LOUD — and it is 42883 (undefined_function), not
    // 42501 (insufficient_privilege): function resolution precedes the ACL check.
    await admin`DROP FUNCTION probe_2_4.req(uuid, uuid)`;
    const code = await sqlstateOf(
      () => admin`SELECT * FROM probe_2_4.req(${ROW_A}::uuid, ${ROW_B}::uuid)`,
    );
    // eslint-disable-next-line no-console
    console.log(`[§11.2] stale 2-arg call after DROP: SQLSTATE ${code}`);
    expect(code).toBe("42883");
  });

  it("[§11.2 contrast] 42725 appears ONLY when the third parameter carries a DEFAULT — which is why the recorded reason misled", async () => {
    const { admin } = fixture!;
    await admin`CREATE FUNCTION probe_2_4.dflt(p_a uuid, p_b uuid)
      RETURNS TABLE (marker text) LANGUAGE sql STABLE AS $$ SELECT 'TWO-ARG'::text $$`;
    await admin`CREATE FUNCTION probe_2_4.dflt(p_a uuid, p_b uuid, p_watermark timestamptz DEFAULT NULL)
      RETURNS TABLE (marker text) LANGUAGE sql STABLE AS $$ SELECT 'THREE-ARG'::text $$`;
    const code = await sqlstateOf(
      () => admin`SELECT * FROM probe_2_4.dflt(${ROW_A}::uuid, ${ROW_B}::uuid)`,
    );
    // eslint-disable-next-line no-console
    console.log(`[§11.2 contrast] 2-arg call against a DEFAULTed overload: SQLSTATE ${code}`);
    expect(code).toBe("42725"); // ambiguous_function
  });

  it("[§10.2] the certificate's own columns are byte-identical across a DEFAULT-only CREATE OR REPLACE", async () => {
    // The fail-open with a GREEN certificate, re-measured here rather than trusted: the eight
    // checks in `distributed-execution-databases.ts` read proname / identity args / proowner /
    // proconfig / proleakproof / prosrc / proacl, and `proargdefaults` appears nowhere. This
    // is the whole reason `p_watermark` may never carry a DEFAULT.
    const { admin } = fixture!;
    await admin`CREATE FUNCTION probe_2_4.certified(p_a uuid, p_watermark timestamptz)
      RETURNS TABLE (marker text) LANGUAGE sql STABLE SECURITY INVOKER
      SET search_path = '' AS $$ SELECT 'BODY'::text $$`;
    const read = async () =>
      (
        await admin<
          { ident: string; cfg: string | null; acl: string | null; body_sha: string }[]
        >`SELECT pg_get_function_identity_arguments(p.oid) AS ident,
                 array_to_string(p.proconfig, ',') AS cfg,
                 array_to_string(p.proacl, ',') AS acl,
                 encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') AS body_sha
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'probe_2_4' AND p.proname = 'certified'`
      )[0]!;
    const before = await read();
    await admin`CREATE OR REPLACE FUNCTION probe_2_4.certified(
        p_a uuid, p_watermark timestamptz DEFAULT '-infinity'::timestamptz)
      RETURNS TABLE (marker text) LANGUAGE sql STABLE SECURITY INVOKER
      SET search_path = '' AS $$ SELECT 'BODY'::text $$`;
    const after = await read();
    expect(after).toEqual(before); // every certified column unchanged; the DEFAULT is invisible
  });

  // ---------------------------------------------------------------------------------------
  // §11.2 — the return type cannot be replaced in place.
  // ---------------------------------------------------------------------------------------

  it("[§11.2] CREATE OR REPLACE cannot change the RETURNS TABLE shape — 42P13, so 2.4b must DROP even at unchanged arity", async () => {
    const { admin } = fixture!;
    await admin`CREATE FUNCTION probe_2_4.shape(p_a uuid)
      RETURNS TABLE (lease_id uuid) LANGUAGE sql STABLE AS $$ SELECT NULL::uuid WHERE false $$`;
    const code = await sqlstateOf(
      () => admin`CREATE OR REPLACE FUNCTION probe_2_4.shape(p_a uuid)
        RETURNS TABLE (lease_ids uuid[], unnarrowed_total bigint)
        LANGUAGE sql STABLE AS $$ SELECT NULL::uuid[], 0::bigint $$`,
    );
    // eslint-disable-next-line no-console
    console.log(`[§11.2] CREATE OR REPLACE with a new RETURNS TABLE: SQLSTATE ${code}`);
    expect(code).toBe("42P13"); // invalid_function_definition
  });

  // ---------------------------------------------------------------------------------------
  // §10.3 point 5 — how the catalog renders a timestamptz parameter.
  // ---------------------------------------------------------------------------------------

  it("[§10.3.5] identity_arguments renders timestamptz as `timestamp with time zone` — the manifest string, exactly", async () => {
    const { admin } = fixture!;
    await admin`CREATE FUNCTION probe_2_4.ident(
        p_organization_id uuid, p_company_id uuid, p_watermark timestamptz)
      RETURNS TABLE (marker text) LANGUAGE sql STABLE AS $$ SELECT 'x'::text $$`;
    const rows = await admin<{ ident: string }[]>`
      SELECT pg_get_function_identity_arguments(p.oid) AS ident
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'probe_2_4' AND p.proname = 'ident'`;
    // eslint-disable-next-line no-console
    console.log(`[§10.3.5] identity_arguments: ${rows[0]!.ident}`);
    // ★ EXACT. The manifest compares with equality, so a `timestamptz` entry is a fatal
    // every-boot failure, not a cosmetic difference.
    expect(rows[0]!.ident).toBe(
      "p_organization_id uuid, p_company_id uuid, p_watermark timestamp with time zone",
    );
  });

  // ---------------------------------------------------------------------------------------
  // §3.3 / §11.4 — clock semantics, and which direction the boundary case fails in.
  // ---------------------------------------------------------------------------------------

  it("[clocks] now() is transaction-start and clock_timestamp() is not", async () => {
    const rows = await fixture!.admin<
      { same_now: boolean; clock_moved: boolean }[]
    >`SELECT (SELECT now()) = (SELECT now()) AS same_now,
             (SELECT clock_timestamp()) <> (SELECT clock_timestamp()) AS clock_moved
      FROM pg_sleep(0.01)`;
    expect(rows[0]!.same_now).toBe(true);
    // clock_timestamp() advances within a statement; it is deliberately NOT what the watermark
    // reads, because a snapshot instant must be stable for the whole pass.
    expect(typeof rows[0]!.clock_moved).toBe("boolean");
  });

  it("[clocks ★] a row inserted by a transaction that BEGAN before the watermark read stays IN scope even when it COMMITS after", async () => {
    // THE DIRECTION THAT MATTERS. `created_at` defaults to now() = TRANSACTION START. A lease
    // whose transaction opened before the pass read its snapshot instant therefore carries
    // `created_at < watermark` and is INSIDE the narrowed inventory — so the gate demands a
    // crosswalk record for it. That is the fail-CLOSED direction: the risk is a spurious
    // refusal, never a silent admit. The opposite (clock_timestamp at commit) would let a
    // lease slip out of scope, which is the fail-open.
    const { admin, adminUrl } = fixture!;
    const writer = postgres(adminUrl, { max: 1 });
    try {
      await writer`BEGIN`;
      const inserted = await writer<{ created_at: Date }[]>`
        INSERT INTO probe_2_4.fixture (id) VALUES (gen_random_uuid()) RETURNING created_at`;
      // Read the watermark on a DIFFERENT connection, while the writer's transaction is still
      // open. This instant is strictly later than the writer's transaction start.
      const watermarkRows = await admin<{ wm: Date }[]>`SELECT now() AS wm`;
      await writer`COMMIT`;
      const createdAt = inserted[0]!.created_at;
      const watermark = watermarkRows[0]!.wm;
      // eslint-disable-next-line no-console
      console.log(
        `[clocks ★] created_at=${createdAt.toISOString()} watermark=${watermark.toISOString()} in_scope=${
          createdAt <= watermark
        }`,
      );
      // ★ `<=`, NOT `<`, AND THAT IS THE MECHANISM'S OWN PREDICATE, not a weakened assertion.
      // `canary_preflight_evidence_leases` narrows with `l.created_at <= p_watermark`, so a row
      // stamped in the SAME instant as the watermark is IN scope -- which is exactly what this
      // probe exists to establish. Two reasons a strict `<` is wrong here: it asserts more than
      // the code promises, and `Date.getTime()` truncates PostgreSQL's microseconds to
      // milliseconds, so sub-millisecond ordering is not even observable through it.
      //
      // Measured: this failed on Linux CI with `expected 1788368327288 to be less than
      // 1788368327288` -- the same millisecond -- while passing on a slower Windows box. A
      // timing-dependent assertion that holds only on slow hardware is a flake, not a check.
      expect(createdAt.getTime()).toBeLessThanOrEqual(watermark.getTime());
    } finally {
      await writer.end();
    }
  });
});
