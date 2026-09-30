// server/src/services/canary-preflight-evidence.ts
//
// BLOCKER E. These reads cross a privilege boundary: `aoa_app` holds ZERO privileges on
// environment_leases / environments / runtime_provider_keys / company_secret_versions. They
// are served by owner-owned SECURITY DEFINER functions (migration
// 0266_canary_preflight_evidence_fn.sql) which narrow both the projection and the predicate --
// the return types structurally cannot carry secret material.
//
// ★ ROUND 7 — THREE functions, organization-bound, and EXECUTE lives on `aoa_operator`.
// `p_company_id` alone was a lateral read of ANY Company's evidence through owner authority.
// The organization predicates are defence in depth; the boundary is the GRANT.
//
// ★ TWO FUNCTIONS BECAME THREE, AND THERE IS STILL NO SHARED STATE. There was one function returning a row per lease plus
// two scalars, which forced a choice between two defects: either the two scalar-only store
// members each hydrated the whole lease inventory to read one scalar, or a single-flight
// coalesced them. The single-flight was store-global and keyed only by company, so two
// OVERLAPPING `check()` calls shared one snapshot and a lease committed between them was
// invisible to the second -- the exact fail-open `canary-preflight.ts:30-33` refuses to cache
// in order to prevent. Splitting dissolves the choice rather than scoping it: each caller reads
// only what it needs, every read is independent, and there is no shared mutable state left to
// get wrong.
//
// So: three store members, three independent reads per `check()`, and ONLY `listLeases` touches
// `environment_leases` -- which is what the pre-BLOCKER-E code did. An earlier comment here
// claimed that parity while three reads were scanning leases; it was wrong, and this is the
// shape that actually has it.

import { sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { derivePlatformDefaultEnvironmentId } from "./platform-default-environment.js";

/**
 * ★ THE ONE-ROW CONTRACT (design §11.1). Not a row per lease — ONE row, always, carrying the
 * narrowed ids AND the unnarrowed total. A `RETURNS TABLE` of the MATCHES returns ZERO rows
 * when the watermark predates every lease, so the total vanishes exactly in the case the
 * churn guard exists to detect. Same shape, same reason, as `canary_preflight_evidence_scalars`.
 *
 * The field types are MEASURED, not assumed (mig-010-unit-2-4-probes.integration.test.ts,
 * PostgreSQL 18.1 / postgres.js 3.4.8 / drizzle-orm 0.45.2):
 *   * `lease_ids` is `null` when the narrowed set is empty — `array_agg` over an empty set is
 *     NULL, NOT `[]`. Test `=== null`, never `.length === 0`.
 *   * `unnarrowed_total` arrives as a STRING ("3"), through both the raw client and
 *     `db.execute`. It is converted with an explicit `Number()` below; a bare `total > 0` on
 *     a string is the silent bug §11.1 names, and no type error catches it.
 */
type LeaseRow = { lease_ids: string[] | null; unnarrowed_total: unknown };
type ScalarRow = {
  platform_default_environment_id: string | null;
  key_generation: string | null;
};

/** What one Company's lease inventory looks like once narrowed to a pass's watermark. */
export type CanaryPreflightLeaseInventory = {
  /** The leases at or before the watermark. Empty when the pass predates the whole fleet. */
  readonly leaseIds: readonly string[];
  /**
   * Every lease the Company holds, watermark or no watermark. `unnarrowedTotal > 0` with an
   * EMPTY `leaseIds` is the churn signal: the pass predates the entire current fleet, which
   * an empty inventory alone cannot express because `assertClosure` satisfies it vacuously.
   */
  readonly unnarrowedTotal: number;
};

export type CanaryPreflightScalars = {
  readonly platformDefaultEnvironmentId: string | null;
  readonly keyGeneration: string | null;
};

function rowsOf<T>(result: unknown): T[] {
  // `db.execute` returns an array on some drivers and `{rows}` on others. Both shapes are
  // handled deliberately; do not "simplify" without checking which driver `appDb` uses.
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

/**
 * Company ids for one Organization, read through owner authority so the gate's pool needs no
 * `companies` grant. That absence is what lets EXECUTE live on `aoa_operator`, which holds no
 * grant on `companies` or `organizations` at all.
 */
export async function readCanaryPreflightCompanyIds(
  db: Db,
  organizationId: string,
): Promise<readonly string[]> {
  const result = await db.execute(
    sql`SELECT company_id FROM public.canary_preflight_evidence_companies(${organizationId}::uuid)`,
  );
  return rowsOf<{ company_id: string | null }>(result)
    .map((row) => row.company_id)
    .filter((id): id is string => id !== null);
}

/**
 * One Company's lease inventory, narrowed to `watermark`. The only evidence read that touches
 * `environment_leases`.
 *
 * ★ RETURNS BOTH FACTS, and the caller must carry both. §11.4 measured that
 * `SELECT lease_id FROM fn(…)` against a two-column `RETURNS TABLE` returns rows keyed only
 * `["lease_id"]` with NO error — so a half-updated caller that projects by name loses the
 * churn guard SILENTLY. The projection below names both columns and the return type carries
 * both, which is what stops that being possible one edit at a time.
 *
 * ★ THE WATERMARK IS REQUIRED, here and in SQL. There is no overload to fall back to
 * (migration 0270 DROPped the 2-argument form) and no DEFAULT to supply one. A caller with no
 * marker must refuse BEFORE reaching this function, which is what `canary-preflight.ts` does —
 * so the "no watermark" path never reaches the database and `preflight_error` stays off the
 * reachable path.
 */
export async function readCanaryPreflightLeaseInventory(
  db: Db,
  organizationId: string,
  companyId: string,
  watermark: Date,
): Promise<CanaryPreflightLeaseInventory> {
  // ★ THE WATERMARK CROSSES AS AN ISO-8601 STRING, not as a `Date`. Two reasons, the first
  // measured: this driver rejects a raw `Date` bound through `db.execute` with a Node
  // `ERR_INVALID_ARG_TYPE`, which the gate's catch folds into `preflight_error` — the
  // unfalsifiable "I could not read" refusal BLOCKER E-1 existed to remove, reintroduced by a
  // parameter type. Second, `toISOString()` is UTC with an explicit `Z`, so the `::timestamptz`
  // cast cannot be reinterpreted by the session's TimeZone setting; a local-format string
  // could be.
  const result = await db.execute(
    sql`SELECT lease_ids, unnarrowed_total FROM public.canary_preflight_evidence_leases(
          ${organizationId}::uuid, ${companyId}::uuid, ${watermark.toISOString()}::timestamptz)`,
  );
  const row = rowsOf<LeaseRow>(result)[0];
  // ONE ROW, ALWAYS — including for an out-of-org company, which reads as the empty answer
  // rather than as an error. A missing row would mean the contract itself broke, and treating
  // it as "no leases, no total" would be the vacuous-closure fail-open; refuse instead.
  if (!row) {
    throw new Error(
      "canary_preflight_evidence_leases returned no row; the one-row contract is broken",
    );
  }
  return {
    // `array_agg` over an empty set is NULL, measured — not `[]`.
    leaseIds: (row.lease_ids ?? []).filter((id): id is string => id !== null),
    // EXPLICIT conversion: the driver hands back a string, measured.
    unnarrowedTotal: Number(row.unnarrowed_total),
  };
}

/**
 * The platform-default environment id and the current provider-control key generation.
 * Always exactly one row, so "no leases" can never be confused with "no key generation".
 */
export async function readCanaryPreflightScalars(
  db: Db,
  organizationId: string,
  companyId: string,
): Promise<CanaryPreflightScalars> {
  // The default-env id is derived HERE and passed in: it is a TypeScript uuidv5
  // (platform-default-environment.ts) with no SQL equivalent, and a second derivation would
  // drift SILENTLY -- a mismatched id reads as "no default env" rather than raising.
  const defaultEnvId = derivePlatformDefaultEnvironmentId(companyId);
  const result = await db.execute(
    sql`SELECT platform_default_environment_id, key_generation
        FROM public.canary_preflight_evidence_scalars(
          ${organizationId}::uuid, ${companyId}::uuid, ${defaultEnvId}::uuid)`,
  );
  const row = rowsOf<ScalarRow>(result)[0];
  return {
    platformDefaultEnvironmentId: row?.platform_default_environment_id ?? null,
    keyGeneration: row?.key_generation ?? null,
  };
}
