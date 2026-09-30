import { sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";

/**
 * Runs `fn` inside a transaction with the tenant GUC set TRANSACTION-LOCAL
 * (`set_config(..., is_local => true)`) so the value never leaks across pooled
 * postgres-js connections once the transaction commits/rolls back.
 *
 * The RLS canary policy on `company_secrets` reads
 * `current_setting('aoa.organization_id', true)` — this helper is the sole,
 * injection-safe writer of that GUC (the organizationId is bound as a query
 * parameter, never string-interpolated).
 *
 * NOTE (M3): this is DEFENSE-IN-DEPTH plumbing only. In production for the beta
 * the runtime app connects as the cluster owner/superuser, which BYPASSES RLS,
 * so the GUC has no filtering effect there. The app-layer tenant gate
 * (`assertCompanyAccess`) is the ONLY live isolation boundary. The GUC path is
 * proven against the non-owner `aoa_app` role in `rls-canary.integration.test.ts`
 * for a later full-fleet follow-up.
 */
export async function withTenantTx<T>(
  db: Db,
  organizationId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // is_local = true => the setting is scoped to THIS transaction only.
    await tx.execute(sql`select set_config('aoa.organization_id', ${organizationId}, true)`);
    return fn(tx as unknown as Db);
  });
}
