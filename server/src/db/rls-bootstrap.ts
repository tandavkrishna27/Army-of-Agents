import postgres from "postgres";

/**
 * Pure, cross-platform-testable validation of a Postgres role name that will be
 * interpolated into DDL (roles cannot be bound as query parameters). Kept as a
 * standalone predicate so it is unit-tested on every platform, even though the
 * RLS enforcement test that consumes it is Linux-only (embedded-postgres).
 *
 * Mirrors `isSafeIdentifier` in `packages/db/src/client.ts`.
 */
export function isSafeRoleName(role: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(role);
}

/** Throws on an unsafe role name; returns the role unchanged when safe. */
export function assertSafeRoleName(role: string): string {
  if (!isSafeRoleName(role)) throw new Error(`Unsafe role name: ${role}`);
  return role;
}

/**
 * Flag-gated RLS canary bootstrap (idempotent). DEFENSE-IN-DEPTH ONLY.
 *
 * Creates a NON-OWNER, non-superuser login role (`appRole`) and enables RLS on
 * `company_secrets` with a policy that filters that role by the transaction-local
 * `aoa.organization_id` GUC (written by `withTenantTx`).
 *
 * INERT IN PRODUCTION FOR THE BETA — deliberately NO `FORCE ROW LEVEL SECURITY`:
 * the table owner (the real runtime app, which connects as the cluster
 * owner/superuser) is EXEMPT from RLS and is NEVER filtered by this canary, so it
 * can never lock the app out of `company_secrets`. Only the non-owner `appRole`
 * is constrained. The live isolation boundary in the beta is the app-layer tenant
 * gate (`assertCompanyAccess`); this canary merely proves the GUC/policy plumbing
 * for a later full-fleet follow-up. Role/GRANT/CREATE POLICY are cluster DDL that
 * `drizzle-kit generate` does not emit, so this is an idempotent bootstrap
 * (precedent: `ensurePostgresDatabase`, `client.ts`), not a migration.
 */
export async function bootstrapRlsCanary(
  adminUrl: string,
  appRole: string,
  appPassword: string,
): Promise<void> {
  assertSafeRoleName(appRole);
  const escapedPassword = appPassword.replace(/'/g, "''");
  const sql = postgres(adminUrl, { max: 1 });
  try {
    // Idempotent role provisioning (non-owner, non-superuser, no BYPASSRLS).
    // The role may already exist as NOLOGIN — migrations 0211/0233 pre-create
    // aoa_app/aoa_operator NOLOGIN for the distributed serving pools — so on the
    // ELSE branch we must still grant LOGIN + the canary password; otherwise the
    // later `${appRole}:<pw>` connection fails auth (the role stays NOLOGIN,
    // password unset). ALTER ROLE is idempotent and does not touch the role's
    // NOSUPERUSER/NOBYPASSRLS posture set at creation.
    await sql.unsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appRole}') THEN CREATE ROLE "${appRole}" LOGIN PASSWORD '${escapedPassword}'; ELSE ALTER ROLE "${appRole}" LOGIN PASSWORD '${escapedPassword}'; END IF; END $$;`,
    );
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON company_secrets TO "${appRole}"`);
    await sql.unsafe(`ALTER TABLE company_secrets ENABLE ROW LEVEL SECURITY`);
    // Intentionally NO `FORCE ROW LEVEL SECURITY`: the owner (runtime app) stays
    // exempt so RLS is production-inert for the beta.
    await sql.unsafe(`DROP POLICY IF EXISTS company_secrets_tenant_isolation ON company_secrets`);
    // Policy applies TO the non-owner role only. USING gates reads; WITH CHECK gates writes.
    await sql.unsafe(
      `CREATE POLICY company_secrets_tenant_isolation ON company_secrets TO "${appRole}" USING (organization_id = current_setting('aoa.organization_id', true)::uuid) WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid)`,
    );
  } finally {
    await sql.end();
  }
}
