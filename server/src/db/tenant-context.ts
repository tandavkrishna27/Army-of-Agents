import { tenantRepositories, type TenantRepositories, type Db } from "@armyofagents/db";
import { withReadOnlyTenantTx, withTenantTx } from "./with-tenant-tx.js";

/**
 * THE mandatory Organization context for the new-path (distributed-execution)
 * repositories (TEN-003, E2-D02).
 *
 * Opens a transaction on the caller-supplied NON-OWNER pool (`createTenantAppDb`,
 * role `aoa_app` — NOSUPERUSER/NOBYPASSRLS), writes the transaction-local
 * `aoa.organization_id` GUC via the proven `withTenantTx` writer (the org id is
 * bound as a query PARAMETER, never string-interpolated), builds the tenant
 * repositories from that transaction handle, and runs `fn` against them. Forced RLS
 * (TEN-002) then filters every query to the Organization in the GUC — a query with
 * no context reaches zero new-path rows, so routing through `runInTenant` is
 * mandatory to touch these tables at all.
 *
 * Because the GUC is set `is_local => true`, it is scoped to THIS transaction and
 * cannot leak across pooled postgres-js connections once the transaction commits or
 * rolls back — a later borrower of the same physical connection never inherits a
 * previous tenant's context.
 *
 * The transaction handle and the repositories it builds MUST NOT escape `fn`: only
 * `fn`'s DATA result is returned. `organizationId` must be a non-empty string — an
 * empty/blank value is rejected up front (fail closed, no DB round-trip) because
 * `set_config('aoa.organization_id', '')` would make a later `''::uuid` cast throw.
 *
 * Scope (E2-D04): at E2 no HTTP / scheduler / reconciliation / worker-event path
 * calls this yet — those tables are E3/E4 and real entry-point adoption is a forward
 * declaration that rides E3+. The wrapper plus its pool-reuse / rollback / nested /
 * background property proofs land now; adoption is E3.
 *
 * `appDb` is supplied by the caller (E3 will; the tests do) — this function never
 * opens its own pool, keeping the fail-closed non-owner-pool contract (E2-F007) with
 * `createTenantAppDb`.
 *
 * JOB-010 — callback-local tx as a legacy-composable `Db`. `fn` receives the raw
 * transaction handle as its SECOND argument, already typed as `Db`. A legacy service
 * factory (e.g. `issueService(tx)`) takes a `Db` and calls `.transaction()` internally;
 * on postgres-js, opening `.transaction()` on a transaction handle nests a SAVEPOINT
 * that commits/rolls back with THIS outer transaction. The admission bridge therefore
 * drives the existing assignment authority (checkout/ownership) through `tx` and persists
 * the distributed submission via the same `repos`, so both land in ONE authoritative
 * transaction — a pre-commit throw rolls back the legacy claim atomically (nothing to
 * release), and after-commit publications are the caller's responsibility to defer.
 */
export async function runInTenant<T>(
  appDb: Db,
  organizationId: string,
  fn: (repos: TenantRepositories, tx: Db) => Promise<T>,
): Promise<T> {
  if (typeof organizationId !== "string" || organizationId.trim() === "") {
    throw new Error(
      "runInTenant requires a non-empty organizationId; an empty/blank Organization is " +
        "rejected before opening a transaction (set_config('aoa.organization_id', '') would " +
        "make a later ''::uuid cast throw). New-path repositories must run inside a resolved " +
        "Organization context.",
    );
  }
  return withTenantTx(appDb, organizationId, (tx) => fn(tenantRepositories(tx), tx));
}

/**
 * `runInTenant`, but the transaction is READ ONLY at the database level (D5a).
 *
 * For probes that must observe tenant state without the possibility of changing it —
 * today, the MIG-005/006/007 shadow admissibility probe, which runs on live Commander /
 * crew / one-shot paths. Effect-freeness is enforced by PostgreSQL (25006 on any write),
 * not by a reviewer believing the callback only selects.
 */
export async function runInTenantReadOnly<T>(
  appDb: Db,
  organizationId: string,
  fn: (repos: TenantRepositories, tx: Db) => Promise<T>,
): Promise<T> {
  if (typeof organizationId !== "string" || organizationId.trim() === "") {
    throw new Error(
      "runInTenantReadOnly requires a non-empty organizationId; an empty/blank " +
        "Organization is rejected before opening a transaction, exactly as runInTenant does.",
    );
  }
  return withReadOnlyTenantTx(appDb, organizationId, (tx) => fn(tenantRepositories(tx), tx));
}
