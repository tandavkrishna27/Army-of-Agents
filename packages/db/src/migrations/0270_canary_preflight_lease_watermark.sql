-- C14 hand-authored security DDL (Decision #122, 2026-09-01 amendment): drizzle-kit cannot
-- emit functions or their ACLs. Every statement below is idempotent.
--
-- MIG-010 Unit 2.4b — the canary gate's lease inventory gains a WATERMARK (E7-F004).
--
-- WHAT E7-F004 IS. The gate re-derives its inventory from LIVE `environment_leases` rows, so
-- a lease created one second after a reconciliation pass is an unmapped key and the gate
-- re-closes. On a box taking legacy traffic it can never open — a permanently losing race,
-- not a transient. The fix narrows the inventory to the leases a completed pass could have
-- seen: `created_at <= <the pass's DB-clock snapshot instant>` (migration 0269's marker).
--
-- ★★★ WHY THE DROP IS MANDATORY, AND WHY THE REASON ON RECORD WAS WRONG.
--
-- Design §10.3 justified dropping the 2-argument form by a 42725 `function is not unique`
-- error. MEASURED (mig-010-unit-2-4-probes.integration.test.ts, PostgreSQL 18.1): that error
-- occurs ONLY when the new parameter carries a DEFAULT. With the REQUIRED, no-DEFAULT
-- parameter this migration uses, a surviving 2-argument call does not error AT ALL — it
-- resolves SILENTLY to the old, UNNARROWED function and returns every lease. A missed call
-- site would not fail loudly into `preflight_error`; it would fail OPEN, quietly, with the
-- gate reading an unnarrowed inventory it believes is narrowed. The DROP is what converts
-- that silent fail-open into a visible 42883 (measured: `does not exist`, not 42501 —
-- function resolution precedes the ACL check).
--
-- Two further measured facts make the DROP unavoidable regardless:
--   * `CREATE OR REPLACE FUNCTION` cannot change a return type (SQLSTATE 42P13, "Use DROP
--     FUNCTION first"), and this changes `RETURNS TABLE (lease_id uuid)` into the one-row
--     contract below.
--   * An arity change CREATES a new function rather than replacing the old one, so without
--     the DROP the 2-argument form survives WITH its aoa_operator EXECUTE grant.
--
-- ★★★ NO DEFAULT ON `p_watermark`, NOW OR EVER. The boot certificate is BLIND to
-- `proargdefaults`: it selects proname, pg_get_function_identity_arguments, proowner,
-- proconfig, proleakproof, prosrc and proacl and nothing else, and
-- `pg_get_function_identity_arguments` omits default expressions by definition. MEASURED in
-- the same probe file: a `CREATE OR REPLACE` that changes only a DEFAULT leaves
-- identity_arguments, proconfig, proacl and sha256(prosrc) BYTE-IDENTICAL while changing what
-- the function returns — a fail-open with a green certificate (design §10.2).
--
-- ★★★ ONE ROW, ALWAYS — and this is the whole reason the shape changed. Design §11.1
-- measured that a `RETURNS TABLE` of the MATCHES returns ZERO ROWS when the watermark
-- predates every lease, so the unnarrowed total — the fact the churn guard needs — is
-- unobservable EXACTLY in the case it exists to detect, and it fails silent rather than loud.
-- The one-row contract is the shape `canary_preflight_evidence_scalars` already uses in
-- `0267` for the same reason. `array_agg` over an empty set yields NULL (measured, not `[]`)
-- and `count(*)` over the UNNARROWED set yields the total, so
-- `lease_ids IS NULL AND unnarrowed_total > 0` is observable: "the pass predates the entire
-- current fleet", which the gate refuses as `reconciliation_stale`.
--
-- ★ WHAT BINDS is the GRANT, not the parameter. `p_organization_id` is caller-supplied, so
-- the organization predicate is defence in depth; EXECUTE lives on `aoa_operator` alone
-- (Decision #122, 2026-09-01 amendment). The return type is a uuid array and a bigint, so it
-- structurally cannot carry `environment_leases.metadata`, which is secret-bearing at rest.
--
-- search_path is pinned EMPTY and every relation is schema-qualified, so a caller's
-- search_path cannot redirect the body. pg_catalog stays implicitly resolvable.

-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (pg-core exposes no
-- function primitive); IF EXISTS makes it idempotent. THIS IS THE FAIL-OPEN CLOSER — see the
-- header: with a required third parameter a surviving 2-arg call is SILENT, not an error.
DROP FUNCTION IF EXISTS public.canary_preflight_evidence_leases(uuid, uuid);
--> statement-breakpoint

-- ORGANIZATION-BOUND, as `0267` was: the EXISTS clause makes the ORG the unit of authority,
-- so a company outside the organization being gated yields the empty answer whatever the
-- caller passes. Note that "empty" here is still ONE ROW (`lease_ids` NULL,
-- `unnarrowed_total` 0), never zero rows -- the contract holds for the out-of-org case too.
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (drizzle-orm's pg-core
-- exposes no function/routine primitive at any level); CREATE OR REPLACE is idempotent.
CREATE OR REPLACE FUNCTION public.canary_preflight_evidence_leases(
  p_organization_id uuid, p_company_id uuid, p_watermark timestamp with time zone)
RETURNS TABLE (lease_ids uuid[], unnarrowed_total bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  -- ONE ROW, ALWAYS. array_agg over an empty narrowed set yields NULL, count() yields 0, and
  -- the row still exists -- which is the whole point: `unnarrowed_total > 0 AND lease_ids IS
  -- NULL` is the "the pass predates the entire fleet" case, and a RETURNS TABLE of the
  -- matches cannot express it (design section 11.1, measured).
  --
  -- The FILTER narrows; the count() does NOT. Both halves are deliberate: the gate needs the
  -- narrowed inventory to assert closure over, and the unnarrowed total to tell "this company
  -- has no leases at all" (fine) apart from "this pass predates every lease it has" (stale).
  -- An empty inventory satisfies assertClosure vacuously, so without the total a NULL or
  -- ancient watermark would ADMIT an unreconciled fleet silently (design section 10.1(b)).
  SELECT array_agg(l.id) FILTER (WHERE l.created_at <= p_watermark),
         count(*)
  FROM public.environment_leases l
  WHERE l.company_id = p_company_id
    AND EXISTS (SELECT 1 FROM public.companies c
                WHERE c.id = p_company_id AND c.organization_id = p_organization_id);
$$;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- REVOKE is idempotent. Strips PostgreSQL's default PUBLIC EXECUTE on a new function.
REVOKE ALL ON FUNCTION public.canary_preflight_evidence_leases(uuid, uuid, timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- REVOKE is idempotent. `aoa_app` is the tenant-facing pool; owner authority must not be
-- reachable from it. This mirrors 0267's boundary exactly across the arity change.
REVOKE ALL ON FUNCTION public.canary_preflight_evidence_leases(uuid, uuid, timestamp with time zone) FROM "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- GRANT is idempotent. The operator pool is the sole grantee -- see Decision #122's 2026-09-01
-- amendment. This is the boundary; the organization predicate above is not.
GRANT EXECUTE ON FUNCTION public.canary_preflight_evidence_leases(uuid, uuid, timestamp with time zone) TO "aoa_operator";
