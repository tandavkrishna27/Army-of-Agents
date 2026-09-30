// server/src/services/legacy-reconciliation-evidence.ts
//
// MIG-010 Unit 2.3 — the reconciliation pass's CLASSIFICATION read, across the privilege
// boundary.
//
// `aoa_operator` — the role the pass must connect as, because the crosswalk's own security
// model makes this an operator pass (0256) — holds ZERO privileges on `environment_leases`.
// `OPERATOR_SERVING_RELATIONS` (job-control-legacy-grants.ts:319-321) grants it exactly one
// relation, `legacy_resource_reconciliation`, and the authority manifest is an exact
// allowlist rather than a partial one. So the pass raised 42501 on its first statement, and
// the caller E10-F002 asks for would not have helped.
//
// This is the same shape BLOCKER E-1 used for the gate (`canary-preflight-evidence.ts`,
// migrations 0266/0267), applied to the writer: an owner-owned SECURITY DEFINER function
// that narrows both the projection and the predicate, so the return type structurally cannot
// carry secret material.
//
// ★ WHAT BINDS IS THE GRANT. `p_organization_id` is caller-supplied — a caller that can
// enumerate companies can enumerate organizations — so the organization predicate inside
// `legacy_reconciliation_leases` is defence in depth. The boundary is the EXECUTE grant:
// `aoa_app` is revoked, `aoa_operator` alone holds it (Decision #122, 2026-09-01 amendment).
// State it that way anywhere this is summarised.
//
// ★ NO SHARED STATE, ONE EXPORTED FUNCTION PER READ — deliberately mirroring
// `canary-preflight-evidence.ts` rather than inventing a second shape. The round-6/7 history
// there is worth not repeating: a store-global single-flight keyed by company let two
// overlapping reads share one snapshot, so a row committed between them was invisible to the
// second. Independent reads dissolve that instead of scoping it.

import { sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import type { LegacyLeaseInput } from "./legacy-resource-reconciliation.js";

/**
 * The eleven columns `legacy_reconciliation_leases` projects — the exact union of what
 * `resolveResourceType`, `classifyLease`, `computeResourceLabelsHash` and `buildLeaseRecord`
 * read. `metadata` (secret-bearing at rest) and `failure_reason` are excluded by the
 * function's return type, not merely unselected here.
 */
type LegacyLeaseRow = {
  id: string;
  company_id: string;
  environment_id: string | null;
  status: string;
  lease_policy: string;
  provider: string | null;
  provider_lease_id: string | null;
  agent_id: string | null;
  commander_conversation_id: string | null;
  execution_workspace_id: string | null;
  cleanup_status: string | null;
};

function rowsOf<T>(result: unknown): T[] {
  // `db.execute` returns an array on some drivers and `{rows}` on others. Both shapes are
  // handled deliberately; do not "simplify" without checking which driver the pass uses.
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

/**
 * Every `environment_leases` row for one Company, projected to the classification columns,
 * read through owner authority.
 *
 * ★ THE MAPPING IS BY NAME, NOT BY POSITION. `RETURNS TABLE` gives the driver named columns,
 * and every field is assigned from its own key below. Two adjacent `uuid` columns — or two
 * adjacent `text` ones — swapped positionally would be invisible to the type system and
 * would write permanent, wrong rows into an append-only crosswalk that has no clear path.
 */
export async function readLegacyReconciliationLeases(
  db: Db,
  organizationId: string,
  companyId: string,
): Promise<readonly LegacyLeaseInput[]> {
  const result = await db.execute(
    sql`SELECT id, company_id, environment_id, status, lease_policy, provider,
               provider_lease_id, agent_id, commander_conversation_id,
               execution_workspace_id, cleanup_status
        FROM public.legacy_reconciliation_leases(
          ${organizationId}::uuid, ${companyId}::uuid)`,
  );
  return rowsOf<LegacyLeaseRow>(result).map((row) => ({
    id: row.id,
    companyId: row.company_id,
    environmentId: row.environment_id,
    status: row.status,
    leasePolicy: row.lease_policy,
    provider: row.provider,
    providerLeaseId: row.provider_lease_id,
    agentId: row.agent_id,
    commanderConversationId: row.commander_conversation_id,
    executionWorkspaceId: row.execution_workspace_id,
    // Declared on LegacyLeaseInput and read by NOTHING (verified against every `lease.<field>`
    // read in legacy-resource-reconciliation.ts). The definer function does not project them,
    // so they are null here rather than silently wrong — widening a definer projection to feed
    // fields no code reads is not a trade worth making.
    issueId: null,
    heartbeatRunId: null,
    cleanupStatus: row.cleanup_status,
  }));
}
