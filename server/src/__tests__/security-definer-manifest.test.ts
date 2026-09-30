// The SECURITY DEFINER certificate.
//
// `assertExactServingRoleAuthority` scans tables, columns and sequences. It never scanned
// functions — before migration 0266 there was not one `prosecdef` reference in this
// repository. A definer function runs with the OWNER's authority regardless of caller, so
// shipping one without a certificate would turn a documented ACL model into one with an
// undocumented hole.
//
// The shape cases below are properties of a constant and cannot fail for any reason that
// matters on their own; the integration cases exercise the REAL query against a REAL
// database, including a mutant definer function the scan must reject.
//
// Windows-skipped unless AOA_RUN_WIN_INTEGRATION=1 (Issue #114); Linux CI is the authority.

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { SECURITY_DEFINER_FUNCTION_MANIFEST } from "../db/security-definer-manifest.js";
import {
  assertManifestedSecurityDefinerFunctions,
  assertNoUnmanifestedSecurityDefinerFunctions,
  assertSecurityDefinerManifest,
} from "../db/distributed-execution-databases.js";
import { startMigratedDatabase } from "./helpers/migrated-database.js";

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

function manifestKeys(): Set<string> {
  return new Set(
    SECURITY_DEFINER_FUNCTION_MANIFEST.map(
      (fn) => `${fn.schema}.${fn.name}(${fn.identityArguments})`,
    ),
  );
}

/**
 * The WHOLE manifest, name by name and signature by signature.
 *
 * ★ THIS WAS PREFIX-MATCHED, AND MIG-010 UNIT 2.3 WIDENED IT DELIBERATELY. The test used to
 * filter on `name.startsWith("canary_preflight_evidence")` and assert a three-name array. A
 * fourth definer function with a different prefix therefore did not red it — which is another
 * way of saying it was not covered BY it. Unit 2.3 adds exactly such a function
 * (`legacy_reconciliation_leases`), so the choice was: add a sibling assertion for the new
 * name, or pin the whole manifest.
 *
 * A sibling assertion leaves the hole open one function later — a FIFTH name with yet another
 * prefix would slip past both, which is the same recurrence class E10-F002 itself is. Pinning
 * the whole manifest closes the "slips past" direction permanently: every definer function
 * must be enrolled here deliberately, with its signature, or this test reds.
 *
 * It reds on ANY manifest addition, and that is the intent, not a cost — the identity is the
 * thing `pg_get_function_identity_arguments` is compared against at boot with EXACT equality
 * (parameter names included), and a grep-driven sweep over "(uuid, uuid)" cannot find it.
 */
const EXPECTED_MANIFEST_IDENTITIES: Readonly<Record<string, string>> = {
  "public.canary_preflight_evidence_companies": "p_organization_id uuid",
  // ★ MIG-010 Unit 2.4b widened this to THREE arguments (migration 0270), and this fixture is
  // what noticed — a `(uuid, uuid)` grep would not have found it. `timestamp with time zone`,
  // not `timestamptz`: the catalog renders the former and the manifest is compared with exact
  // equality, so the short spelling is a fatal EVERY-BOOT failure (measured).
  "public.canary_preflight_evidence_leases":
    "p_organization_id uuid, p_company_id uuid, p_watermark timestamp with time zone",
  "public.canary_preflight_evidence_scalars":
    "p_organization_id uuid, p_company_id uuid, p_default_env_id uuid",
  "public.legacy_reconciliation_leases": "p_organization_id uuid, p_company_id uuid",
  // E7-1 provider-credential broker (migration 0281). Three definer functions the operator
  // pool calls to resolve the Company key without a grant on the owner-only credential model.
  // These identities are what `pg_get_function_identity_arguments` renders for the 0281 bodies
  // (all uuid/text/integer params, no timestamptz) and are compared with EXACT equality at boot.
  "public.resolve_provider_assignment_candidates":
    "p_organization_id uuid, p_company_id uuid, p_provider text",
  "public.resolve_company_secret_bundle":
    "p_company_id uuid, p_secret_id uuid, p_version integer, p_target_type text, p_target_id text, p_config_path text",
  "public.record_company_secret_access":
    "p_company_id uuid, p_secret_id uuid, p_version integer, p_provider text, p_actor_type text, p_actor_id text, p_consumer_type text, p_consumer_id text, p_issue_id uuid, p_heartbeat_run_id uuid, p_plugin_id uuid, p_config_path text, p_outcome text, p_error_code text",
};

describe("SECURITY DEFINER manifest — shape", () => {
  it("pins EVERY manifested function's identity, once each — not just one prefix", () => {
    const actual = Object.fromEntries(
      SECURITY_DEFINER_FUNCTION_MANIFEST.map((fn) => [
        `${fn.schema}.${fn.name}`,
        fn.identityArguments,
      ]),
    );
    // One assertion over the whole set: it catches an addition, a removal, a half-finished
    // rename, and a signature drift, in both directions.
    expect(actual).toEqual(EXPECTED_MANIFEST_IDENTITIES);
    expect(SECURITY_DEFINER_FUNCTION_MANIFEST.length).toBe(
      Object.keys(EXPECTED_MANIFEST_IDENTITIES).length,
    );
    // The boundary: EXECUTE must be operator-only on every one of them.
    for (const fn of SECURITY_DEFINER_FUNCTION_MANIFEST) {
      expect(fn.executeGrantees, fn.name).toEqual(["aoa_operator"]);
    }
  });

  it("requires a rationale on every entry — owner authority is never granted silently", () => {
    for (const fn of SECURITY_DEFINER_FUNCTION_MANIFEST) {
      expect(fn.rationale.length, `${fn.name} has no rationale`).toBeGreaterThan(40);
    }
  });

  it("never allows PUBLIC, and always names at least one execute grantee", () => {
    // A definer function executable by PUBLIC is precisely the escalation this manifest
    // exists to prevent; an empty grantee list would be a function nothing can call.
    for (const fn of SECURITY_DEFINER_FUNCTION_MANIFEST) {
      expect(fn.executeGrantees.length, `${fn.name} names no execute grantee`).toBeGreaterThan(0);
      expect(fn.executeGrantees, fn.name).not.toContain("PUBLIC");
      expect(fn.executeGrantees, fn.name).not.toContain("public");
      expect(fn.executeGrantees, fn.name).not.toContain("FUNCTION_OWNER");
    }
  });

  it("never grants a definer function to the tenant-facing serving role", () => {
    // ★ Decision #122 (2026-09-01 amendment) says a definer function must be justified on its
    // GRANTEE first, and a tenant predicate may be cited only as a second layer. That condition
    // had no mechanism: the boot certificate derives its expected ACL FROM this manifest, so a
    // new entry declaring `executeGrantees: ["aoa_app"]` would match whatever the migration
    // granted and pass every check. The exact defect migration 0267 exists to fix was therefore
    // re-introducible without tripping anything.
    //
    // `aoa_app` is the pool serving tenant HTTP requests, the outbox worker, the admission
    // bridge and the live-event log. Owner authority must not be reachable from it. A future
    // function that genuinely needs a different grantee should change this test deliberately,
    // with the reasoning — which is the point of pinning it here rather than in prose.
    for (const fn of SECURITY_DEFINER_FUNCTION_MANIFEST) {
      expect(
        fn.executeGrantees,
        `${fn.name} grants EXECUTE to aoa_app — owner authority reachable from the tenant pool`,
      ).not.toContain("aoa_app");
    }
  });

  it("names the relations whose authority each function borrows", () => {
    // Owner must be PINNED, not merely bounded — an empty list would silently disable the
    // owner check and leave `ALTER FUNCTION … OWNER TO` invisible again.
    for (const fn of SECURITY_DEFINER_FUNCTION_MANIFEST) {
      expect(fn.authorityRelations.length, `${fn.name} declares no authority relation`)
        .toBeGreaterThan(0);
      for (const relation of fn.authorityRelations) {
        expect(relation, `${fn.name}: ${relation} must be schema-qualified`).toMatch(/^[a-z_]+\.[a-z_]+$/);
      }
    }
  });

  it("pins each function's execution definition", () => {
    // These two are what make CREATE OR REPLACE a reviewed act rather than a silent one.
    for (const fn of SECURITY_DEFINER_FUNCTION_MANIFEST) {
      expect(fn.bodySha256, `${fn.name} body fingerprint`).toMatch(/^[0-9a-f]{64}$/);
      expect(
        fn.executionConfig.some((entry) => entry.startsWith("search_path=")),
        `${fn.name} must pin search_path — otherwise name resolution inside owner-authority code is caller-controlled`,
      ).toBe(true);
    }
  });

  it("has no duplicate identities", () => {
    expect(manifestKeys().size).toBe(SECURITY_DEFINER_FUNCTION_MANIFEST.length);
  });
});

describe.skipIf(!RUN)("SECURITY DEFINER manifest — the scan actually matches the database", () => {
  it("finds exactly the manifested set after migrations", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-manifest-" });
    try {
      const rows = (await database.appDb.execute(sql`
        SELECT
          namespace.nspname AS schema_name,
          proc.proname AS function_name,
          pg_get_function_identity_arguments(proc.oid) AS identity_arguments
        FROM pg_proc proc
        JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
        WHERE proc.prosecdef
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname NOT LIKE 'pg_%'
      `)) as unknown as Array<{
        schema_name: string;
        function_name: string;
        identity_arguments: string;
      }>;
      const actual = new Set(
        rows.map((row) => `${row.schema_name}.${row.function_name}(${row.identity_arguments})`),
      );
      expect(actual).toEqual(manifestKeys());

      // And the production assertion itself accepts that database.
      await expect(
        assertSecurityDefinerManifest(database.appDb, "aoa_app"),
      ).resolves.toBeUndefined();
    } finally {
      await database.teardown();
    }
  }, 180_000);

  // The mutation check, AUTOMATED. A hand-run check is not a regression guard.
  it("REJECTS an unmanifested definer function", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-mutant-" });
    try {
      await database.admin.unsafe(
        "CREATE FUNCTION public.mutant_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'",
      );
      await expect(assertSecurityDefinerManifest(database.appDb, "aoa_app")).rejects.toThrow(
        /unmanifested SECURITY DEFINER function public\.mutant_definer\(\)/,
      );
    } finally {
      await database.teardown();
    }
  }, 180_000);

  // ── ACL / ownership drift on a MANIFESTED definer function ──────────────────────
  //
  // Enumerating the definer surface is only half the certificate. A manifested function
  // whose ACL widens is owner-authority code reachable by a role that was never meant to
  // reach it, and the identity scan alone cannot see that. Each case below is a real
  // escalation path, not a hypothetical.

  it("REJECTS EXECUTE granted to PUBLIC on a manifested definer function", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-public-" });
    try {
      await database.admin.unsafe(
        "GRANT EXECUTE ON FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid) TO PUBLIC",
      );
      await expect(assertSecurityDefinerManifest(database.appDb, "aoa_app")).rejects.toThrow(
        /execute authority drift/i,
      );
    } finally {
      await database.teardown();
    }
  }, 180_000);

  it("REJECTS EXECUTE granted to a role outside the manifest", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-role-" });
    try {
      await database.admin.unsafe('CREATE ROLE "aoa_definer_intruder" NOLOGIN');
      await database.admin.unsafe(
        'GRANT EXECUTE ON FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid) TO "aoa_definer_intruder"',
      );
      await expect(assertSecurityDefinerManifest(database.appDb, "aoa_app")).rejects.toThrow(
        /execute authority drift/i,
      );
    } finally {
      await database.teardown();
    }
  }, 180_000);

  // A DROP + CREATE resets `proacl` to NULL, which in PostgreSQL means the DEFAULT ACL —
  // and the default for a function is EXECUTE to PUBLIC. A migration that recreates the
  // function without re-issuing the REVOKE therefore re-opens it SILENTLY.
  //
  // NOTE: this fixture is not perfectly isolated — recreating with a stub body also trips
  // the body fingerprint. What isolates it is assertion ORDER: `aclIsNull` is checked before
  // the execution-definition block, because "executable by PUBLIC" is the more urgent
  // message of the two. The regex below pins that, so a reorder fails here rather than
  // silently changing which drift an operator is told about first.
  it("REJECTS a definer function whose ACL is NULL (PostgreSQL default = PUBLIC EXECUTE)", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-nullacl-" });
    try {
      await database.admin.unsafe("DROP FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid)");
      await database.admin.unsafe(
        "CREATE FUNCTION public.canary_preflight_evidence_scalars(p_organization_id uuid, p_company_id uuid, p_default_env_id uuid) " +
          "RETURNS TABLE (lease_id uuid, platform_default_environment_id uuid, key_generation text) " +
          "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$ SELECT NULL::uuid, NULL::uuid, NULL::text $fn$",
      );
      await expect(assertSecurityDefinerManifest(database.appDb, "aoa_app")).rejects.toThrow(
        /execute authority drift/i,
      );
    } finally {
      await database.teardown();
    }
  }, 180_000);

  // 0214_e2_serving_role_hardening.sql RAISEs if a serving role owns an application object.
  // A definer function owned by the serving role is that same violation, in the one place
  // the table/column/sequence scans cannot look.
  it("REJECTS a definer function owned by a serving role", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-owner-" });
    try {
      // ALTER FUNCTION … OWNER TO requires CREATE on the schema; granting it is exactly the
      // drift being simulated.
      await database.admin.unsafe('GRANT CREATE ON SCHEMA public TO "aoa_app"');
      await database.admin.unsafe(
        'ALTER FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid) OWNER TO "aoa_app"',
      );
      await expect(assertSecurityDefinerManifest(database.appDb, "aoa_app")).rejects.toThrow(
        /owned by serving role/i,
      );
    } finally {
      await database.teardown();
    }
  }, 180_000);

  // Owner drift to a NON-serving role. The serving-role check above does not catch this,
  // and neither can the ACL comparison: PostgreSQL rewrites the ACL's grantor/grantee
  // entries to the NEW owner on `ALTER FUNCTION … OWNER TO`, and the scan normalizes those
  // to the `FUNCTION_OWNER` sentinel — so the exact-ACL check still passes while the
  // function now executes with a completely different authority. A less-privileged owner
  // silently restores the BLOCKER E `preflight_error` outage; a more-privileged one
  // silently widens the definer context.
  it("REJECTS a definer function whose owner is not the owner of the relations it reads", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-altowner-" });
    try {
      await database.admin.unsafe('CREATE ROLE "aoa_definer_alt_owner" NOLOGIN');
      await database.admin.unsafe('GRANT CREATE ON SCHEMA public TO "aoa_definer_alt_owner"');
      await database.admin.unsafe(
        'ALTER FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid) OWNER TO "aoa_definer_alt_owner"',
      );
      await expect(assertSecurityDefinerManifest(database.appDb, "aoa_app")).rejects.toThrow(
        /owner drift/i,
      );
    } finally {
      await database.teardown();
    }
  }, 180_000);

  // ── EXECUTION-DEFINITION drift ───────────────────────────────────────────────────
  //
  // `CREATE OR REPLACE FUNCTION` keeps the existing owner AND the existing ACL. So a
  // replacement that keeps the identity and the SECURITY DEFINER setting, but drops the
  // empty `search_path` pin or a tenant predicate, is invisible to every identity/owner/ACL
  // assertion above. Each regex below names the SPECIFIC guard that must fire — a loose
  // regex would let one of the other checks pass the test for the wrong reason.

  it("REJECTS a definer function that lost its empty search_path pin", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-searchpath-" });
    try {
      // Same identity, same SECURITY DEFINER, no `SET search_path` — the classic definer
      // hazard: name resolution inside owner-authority code becomes caller-controlled.
      await database.admin.unsafe(
        "CREATE OR REPLACE FUNCTION public.canary_preflight_evidence_scalars(p_organization_id uuid, p_company_id uuid, p_default_env_id uuid) " +
          "RETURNS TABLE (platform_default_environment_id uuid, key_generation text) " +
          "LANGUAGE sql STABLE SECURITY DEFINER AS $fn$ SELECT NULL::uuid, NULL::text $fn$",
      );
      await expect(assertSecurityDefinerManifest(database.appDb, "aoa_app")).rejects.toThrow(
        /execution config drift/i,
      );
    } finally {
      await database.teardown();
    }
  }, 180_000);

  it("REJECTS a definer function whose BODY changed (e.g. a dropped tenant predicate)", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-body-" });
    try {
      // Keeps the search_path pin, so only a body fingerprint can catch it. Dropping
      // `AND e.company_id = p_company_id` is exactly the cross-tenant existence oracle
      // review caught in this plan's first revision.
      await database.admin.unsafe(
        "CREATE OR REPLACE FUNCTION public.canary_preflight_evidence_scalars(p_organization_id uuid, p_company_id uuid, p_default_env_id uuid) " +
          "RETURNS TABLE (platform_default_environment_id uuid, key_generation text) " +
          "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$ " +
          "SELECT (SELECT e.id FROM public.environments e WHERE e.id = p_default_env_id LIMIT 1), NULL::text $fn$",
      );
      await expect(assertSecurityDefinerManifest(database.appDb, "aoa_app")).rejects.toThrow(
        /body fingerprint drift/i,
      );
    } finally {
      await database.teardown();
    }
  }, 180_000);

  it("REJECTS a definer function marked LEAKPROOF", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-leakproof-" });
    try {
      // LEAKPROOF lets the planner push a function below security barriers and RLS quals.
      // On owner-authority code reading secret-bearing tables that must never flip silently.
      await database.admin.unsafe(
        "ALTER FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid) LEAKPROOF",
      );
      await expect(assertSecurityDefinerManifest(database.appDb, "aoa_app")).rejects.toThrow(
        /leakproof/i,
      );
    } finally {
      await database.teardown();
    }
  }, 180_000);

  // ── The two arms are split ON PURPOSE, and the split is load-bearing ───────────────
  //
  // The POSITIVE arm runs on EVERY boot (index.ts), because migration 0266 creates the
  // owner-authority function on every deployment. The EXHAUSTIVE arm stays flag-gated: it
  // asserts a property of the WHOLE database, and AoA supports `external-postgres` against
  // an operator-owned database where a vendor or extension definer function in another
  // schema is legitimate and unknowable to us. If these ever collapse back into one, an
  // unconditional exhaustive scan would turn those deployments into hard boot failures.
  it("the POSITIVE arm tolerates an unmanifested function; the EXHAUSTIVE arm rejects it", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-arms-" });
    try {
      await database.admin.unsafe(
        "CREATE FUNCTION public.vendor_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'",
      );
      // Every manifested function is still exactly as pinned, so the every-boot arm passes.
      await expect(
        assertManifestedSecurityDefinerFunctions(database.appDb, "startup"),
      ).resolves.toBeUndefined();
      // The flag-on arm is the one that owns "nothing unmanifested exists".
      await expect(
        assertNoUnmanifestedSecurityDefinerFunctions(database.appDb, "aoa_app"),
      ).rejects.toThrow(/unmanifested SECURITY DEFINER function public\.vendor_definer\(\)/);
    } finally {
      await database.teardown();
    }
  }, 180_000);

  // The other direction: a manifest entry whose function is missing is drift too. Dropping
  // the real function proves the "is absent" arm can fire, which a set-difference in only
  // one direction would never show.
  it("REJECTS a manifested definer function that is absent", async () => {
    const database = await startMigratedDatabase({ label: "aoa-definer-absent-" });
    try {
      await database.admin.unsafe(
        "DROP FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid)",
      );
      await expect(assertSecurityDefinerManifest(database.appDb, "aoa_app")).rejects.toThrow(
        /manifested SECURITY DEFINER function public\.canary_preflight_evidence_scalars\(p_organization_id uuid, p_company_id uuid, p_default_env_id uuid\) is absent/,
      );
    } finally {
      await database.teardown();
    }
  }, 180_000);
});
