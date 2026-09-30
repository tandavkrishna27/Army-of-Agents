-- C14 hand-authored security DDL (Decision #122, 2026-09-01 amendment): drizzle-kit cannot
-- emit functions or their ACLs. Every statement below is idempotent.
--
-- MIG-010 Unit 2.3 — the classification read for the legacy reconciliation pass (E10-F002).
--
-- WHY A NEW FUNCTION AND NOT A REUSE. `canary_preflight_evidence_leases` projects `lease_id`
-- ONLY. The gate needs nothing else, because `resourceKeyForLease` is the identity function.
-- The PASS needs to CLASSIFY, and `classifyLease` / `resolveResourceType` /
-- `computeResourceLabelsHash` / `buildLeaseRecord` read eleven columns between them. So this
-- is an additional function, not a widened one — no arity change, no `DROP`, no 42725
-- ambiguous-call trap, and `canary_preflight_evidence_leases` is untouched by this migration.
--
-- WHY IT MUST EXIST AT ALL. `OPERATOR_SERVING_RELATIONS`
-- (server/src/services/job-control-legacy-grants.ts:319-321) grants `aoa_operator` exactly one
-- crosswalk relation — `legacy_resource_reconciliation` — and NOTHING on `environment_leases`.
-- The pass therefore cannot read its own input; it raises 42501 on its first statement
-- (reproduced in mig-010-unit-2-3-pass.integration.test.ts). Owner-owned SECURITY DEFINER is
-- how E-1 solved the identical problem for the gate, and this is that shape again.
--
-- ★ WHAT BINDS. The GRANTEE is the boundary, not the parameter. `p_organization_id` is
-- caller-supplied — a caller that can enumerate companies can enumerate organizations — so the
-- EXISTS clause below is defence in depth. The one thing a caller cannot forge is the role it
-- connects as, and EXECUTE lives on `aoa_operator` alone (Decision #122, 2026-09-01 amendment).
--
-- ★ THE PROJECTION IS THE SECURITY BOUNDARY, so state the EXCLUSIONS as decisions rather than
-- leaving them to read as oversights:
--   * `metadata` is EXCLUDED. It is secret-bearing AT REST — `sanitizeProviderMetadata` strips
--     `apiKey` / `resolvedApiKey` at read time, in memory, not on disk. A definer function that
--     returned it would hand owner-authority secret material to every EXECUTE holder. The
--     reconciler never reads it.
--   * `failure_reason` is EXCLUDED. Operator free text, unbounded, and read by nothing in the
--     pass.
--   * `issue_id` and `heartbeat_run_id` are EXCLUDED. They are declared on `LegacyLeaseInput`
--     and read by NOTHING (verified: the only `lease.<field>` reads in
--     legacy-resource-reconciliation.ts are the eleven columns below). Declared-but-unread is
--     not a reason to widen a definer projection.
-- Every column returned is a uuid, a text status/policy/provider tag, or a provider handle —
-- the return type structurally cannot carry key material.
--
-- ★ NO PARAMETER CARRIES A DEFAULT, NOW OR EVER. The boot certificate is BLIND to
-- `proargdefaults`: it selects proname, pg_get_function_identity_arguments, proowner,
-- proconfig, proleakproof, prosrc and proacl and nothing else, and
-- `pg_get_function_identity_arguments` omits default expressions by definition. A
-- `CREATE OR REPLACE` that changes only a DEFAULT leaves identity_arguments, proconfig, proacl
-- and sha256(prosrc) byte-identical while changing what the function returns — a fail-open
-- with a green certificate. Measured, not reasoned (design 2026-09-01-blocker-e-2-e-3 §10.2).
--
-- search_path is pinned EMPTY and every relation is schema-qualified, so a caller's search_path
-- cannot redirect the body. pg_catalog stays implicitly resolvable.

-- ORGANIZATION-BOUND, mirroring canary_preflight_evidence_leases: the EXISTS clause makes the
-- ORG the unit of authority, so a company outside the organization being reconciled yields zero
-- rows whatever the caller passes.
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (drizzle-orm's pg-core
-- exposes no function/routine primitive at any level); CREATE OR REPLACE is idempotent.
CREATE OR REPLACE FUNCTION public.legacy_reconciliation_leases(
  p_organization_id uuid, p_company_id uuid)
RETURNS TABLE (
  id uuid, company_id uuid, environment_id uuid, status text, lease_policy text,
  provider text, provider_lease_id text, agent_id uuid, commander_conversation_id uuid,
  execution_workspace_id uuid, cleanup_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT l.id, l.company_id, l.environment_id, l.status, l.lease_policy,
         l.provider, l.provider_lease_id, l.agent_id, l.commander_conversation_id,
         l.execution_workspace_id, l.cleanup_status
  FROM public.environment_leases l
  WHERE l.company_id = p_company_id
    AND EXISTS (SELECT 1 FROM public.companies c
                WHERE c.id = p_company_id AND c.organization_id = p_organization_id);
$$;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- REVOKE is idempotent. Strips PostgreSQL's default PUBLIC EXECUTE on a new function.
REVOKE ALL ON FUNCTION public.legacy_reconciliation_leases(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- REVOKE is idempotent. `aoa_app` is the tenant-facing pool (HTTP requests, outbox worker,
-- admission bridge, live-event log); owner authority must not be reachable from it.
REVOKE ALL ON FUNCTION public.legacy_reconciliation_leases(uuid, uuid) FROM "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- GRANT is idempotent. The operator pool is the sole grantee -- see Decision #122's 2026-09-01
-- amendment. This is the boundary; the organization predicate above is not.
GRANT EXECUTE ON FUNCTION public.legacy_reconciliation_leases(uuid, uuid) TO "aoa_operator";
