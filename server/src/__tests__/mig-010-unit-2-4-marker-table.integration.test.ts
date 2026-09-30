// MIG-010 Unit 2.4a Task 2 — the marker table's REAL catalog posture.
//
// The keystone constants (`LEGACY_RECONCILIATION_PASS_OPERATOR_GRANTS`, `RLS_RELATIONS`,
// `POLICY_COUNTS`, `RLS_POLICY_MANIFEST`, `PLAN_DERIVED_ACL_MATRIX`) are checked against each
// other by `job-control-legacy-grants.contract.test.ts`. That is a check of the DOCUMENT
// against itself: every one of those constants could agree perfectly and still not describe
// what migration 0269 actually did.
//
// So this file asserts the OTHER side — a migrated PostgreSQL, read through pg_catalog and
// `has_table_privilege`, which is exactly what `assertExactServingRoleAuthority` and
// `assertExactCatalogCertificate` do at boot. A drift between 0269 and the constants fails
// here in seconds instead of as an opaque `distributed_execution_app_authority` at startup.
//
// ★ The aoa_app assertions are the load-bearing ones. This table deliberately breaks with the
// three operator-metadata precedents (0233 / 0239 / 0256), which all grant aoa_app SELECT.
// A future "consistency" edit that re-adds that grant is exactly the kind of change that
// looks like tidying, and it reds here.
//
// Windows-skipped unless AOA_RUN_WIN_INTEGRATION=1 (Issue #114); Linux CI is the authority.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  LEGACY_RECONCILIATION_PASS_OPERATOR_GRANTS,
  POLICY_COUNTS,
  RLS_RELATIONS,
} from "../db/job-control-legacy-grants.js";
import { startMigratedDatabase } from "./helpers/migrated-database.js";

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";
const RELATION = "legacy_reconciliation_passes";

type Fixture = { admin: Sql; teardown: () => Promise<void> };
let fixture: Fixture | null = null;

describe.skipIf(!RUN)("MIG-010 Unit 2.4 — the reconciliation-pass marker table, as migrated", () => {
  beforeAll(async () => {
    const database = await startMigratedDatabase({ label: "aoa-mig-010-marker-" });
    fixture = { admin: database.admin, teardown: database.teardown };
  }, 180_000);

  afterAll(async () => {
    await fixture?.teardown();
    fixture = null;
  }, 60_000);

  it("exists with the columns the design derived from 'completion, scope and identity'", async () => {
    const rows = await fixture!.admin<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${RELATION}
      ORDER BY column_name`;
    expect(rows.map((row) => row.column_name)).toEqual([
      "company_id", "completed_at", "created_at", "id",
      "key_generation", "organization_id", "pass_id", "snapshot_at",
    ]);
    const byName = Object.fromEntries(rows.map((row) => [row.column_name, row]));
    // ★★★ E7-F005 / design §13: NOT NULL, so the NULL that disables the shipped gate's
    // superseded filter is UNREPRESENTABLE in the marker. This assertion is the whole
    // reason the column is typed the way it is.
    expect(byName.key_generation!.is_nullable).toBe("NO");
    expect(byName.snapshot_at!.data_type).toBe("timestamp with time zone");
    expect(byName.completed_at!.is_nullable).toBe("NO");
    expect(byName.pass_id!.is_nullable).toBe("NO");
  });

  it("grants aoa_operator exactly SELECT + INSERT, and aoa_app NOTHING", async () => {
    const probe = async (role: string) => {
      const rows = await fixture!.admin<
        { s: boolean; i: boolean; u: boolean; d: boolean }[]
      >`SELECT has_table_privilege(${role}, ${"public." + RELATION}, 'SELECT') AS s,
               has_table_privilege(${role}, ${"public." + RELATION}, 'INSERT') AS i,
               has_table_privilege(${role}, ${"public." + RELATION}, 'UPDATE') AS u,
               has_table_privilege(${role}, ${"public." + RELATION}, 'DELETE') AS d`;
      const row = rows[0]!;
      return { SELECT: row.s, INSERT: row.i, UPDATE: row.u, DELETE: row.d };
    };
    // Derived from the production constant, not restated, so a widening there without a
    // matching migration change reds here rather than being blessed by a copied literal.
    const declared = new Set(LEGACY_RECONCILIATION_PASS_OPERATOR_GRANTS[RELATION]);
    expect([...declared].sort()).toEqual(["INSERT", "SELECT"]);
    expect(await probe("aoa_operator")).toEqual({
      SELECT: declared.has("SELECT"),
      INSERT: declared.has("INSERT"),
      // ★ No UPDATE, no DELETE: a marker is durable evidence of a completed pass, and a
      // pass that can rewrite its own marker is not evidence (design §9.2's argument).
      UPDATE: false,
      DELETE: false,
    });
    // ★ The deliberate break with 0233 / 0239 / 0256. Nothing on the aoa_app pool reads the
    // marker, so it holds nothing on it.
    expect(await probe("aoa_app")).toEqual({
      SELECT: false, INSERT: false, UPDATE: false, DELETE: false,
    });
  });

  it("has RLS ENABLED and FORCED, with exactly the one manifested operator policy", async () => {
    const relRows = await fixture!.admin<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`SELECT c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ${RELATION}`;
    expect(relRows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policyRows = await fixture!.admin<
      { polname: string; permissive: string; roles: string; cmd: string }[]
    >`SELECT p.policyname AS polname, p.permissive, array_to_string(p.roles, ',') AS roles,
             p.cmd
      FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = ${RELATION}
      ORDER BY p.policyname`;
    expect(policyRows).toHaveLength(1);
    expect(policyRows[0]!.polname).toBe("legacy_reconciliation_passes_operator_write");
    expect(policyRows[0]!.roles).toBe("aoa_operator");
    expect(policyRows[0]!.cmd).toBe("ALL");
    // The count the boot certificate compares against, read from the real catalog.
    expect(policyRows).toHaveLength(POLICY_COUNTS[RELATION]!);
  });

  it("is enrolled LAST in RLS_RELATIONS, because POLICY_COUNTS key ORDER is load-bearing", async () => {
    // `assertExactCatalogCertificate` builds its actual counts by mapping over RLS_RELATIONS
    // and compares with JSON.stringify equality, which is order-SENSITIVE. SVC-001 shipped a
    // same-keys-same-values-different-order POLICY_COUNTS and it cost three CI rounds.
    expect(RLS_RELATIONS[RLS_RELATIONS.length - 1]).toBe(RELATION);
    expect(Object.keys(POLICY_COUNTS)).toEqual([...RLS_RELATIONS]);
  });
});
