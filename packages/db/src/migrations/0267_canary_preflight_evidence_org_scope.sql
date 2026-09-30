-- C14 hand-authored security DDL (Decision #122, 2026-09-01 amendment): drizzle-kit cannot
-- emit functions or their ACLs. Every statement below is idempotent.
--
-- ROUND-7 P1 — supersedes 0266's two functions. REPRODUCED against real PostgreSQL before
-- this file was written:
--
--     an aoa_app session named a company it has no relationship to and received that
--     company's lease ids through OWNER authority
--
-- 0266 scoped each function to a caller-supplied `p_company_id` and then compared that
-- argument only to ITSELF. That closes the cross-ARGUMENT oracle (company A's id with
-- company B's environment id) and nothing else: passing the VICTIM's company id satisfies
-- the predicate trivially. `p_company_id` was never authorization -- it is a lookup key, and
-- any session holding EXECUTE could supply any value. `companies` carries no row-level
-- security and `aoa_app` holds SELECT on it, so the caller did not even have to guess.
--
-- ★ WHY A NEW FILE AND NOT AN EDIT OF 0266. `__drizzle_migrations` is
-- (id SERIAL, hash text, created_at bigint) -- there is NO `name` column -- so the
-- existence predicate in client.ts degenerates to `hash = <new hash>` and MISSES on an
-- edited file. Stock `migratePg` runs first and re-applies on
-- `created_at < folderMillis`. An in-place edit on a database that already applied the
-- pre-edit 0266 therefore inserts a SECOND ledger row: more applied rows than migration
-- files, which makes schema-compatibility report "newer" and readiness false permanently,
-- and trips the migration-identity assertion at boot. CI would stay green throughout,
-- because every CI database is fresh. A new file is correct on both a fresh box and a dev
-- box carrying old-0266.
--
-- ★ WHAT ACTUALLY BINDS. The organization predicates below are defence in depth, NOT the
-- boundary: `p_organization_id` is caller-supplied too, and a caller that can enumerate
-- companies can enumerate organizations. The boundary is the EXECUTE grant -- `aoa_app`
-- loses it, `aoa_operator` gains it. The one thing a caller cannot forge is the role it
-- connects as. State it that way anywhere this is summarised.
--
-- ★ AND SAY THE OTHER HALF: for `aoa_operator` this is a WIDENING.
-- `canary_preflight_evidence_companies` is a brand-new capability -- `aoa_operator` holds no
-- grant on `companies` or `organizations` at all. This moves a capability off a broad pool
-- onto a narrow one; it does not delete it.
--
-- search_path is pinned EMPTY and every relation is schema-qualified, so a caller's
-- search_path cannot redirect any body. pg_catalog stays implicitly resolvable.

-- An arity change CREATES A NEW FUNCTION; it does not replace the old one. Without these
-- drops 0266's overloads survive WITH their aoa_app EXECUTE grant -- the fix would look
-- applied while the hole stayed open -- and would then trip
-- assertNoUnmanifestedSecurityDefinerFunctions on the flag-on path.
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (pg-core exposes no
-- function primitive); IF EXISTS makes it idempotent.
DROP FUNCTION IF EXISTS public.canary_preflight_evidence_leases(uuid);
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (pg-core exposes no
-- function primitive); IF EXISTS makes it idempotent.
DROP FUNCTION IF EXISTS public.canary_preflight_evidence_scalars(uuid, uuid);
--> statement-breakpoint

-- Replaces the direct `companies` read in canary-preflight-store.ts. THIS is what lets
-- EXECUTE move to aoa_operator, which holds no grant on companies or organizations: the
-- enumeration moves inside the definer surface rather than requiring a table grant.
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (drizzle-orm's pg-core
-- exposes no function/routine primitive at any level); CREATE OR REPLACE is idempotent.
CREATE OR REPLACE FUNCTION public.canary_preflight_evidence_companies(p_organization_id uuid)
RETURNS TABLE (company_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id FROM public.companies c WHERE c.organization_id = p_organization_id;
$$;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- REVOKE is idempotent. Strips PostgreSQL's default PUBLIC EXECUTE on a new function.
REVOKE ALL ON FUNCTION public.canary_preflight_evidence_companies(uuid) FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- REVOKE is idempotent. THIS is the round-7 boundary: the tenant-facing pool loses owner authority.
REVOKE ALL ON FUNCTION public.canary_preflight_evidence_companies(uuid) FROM "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- GRANT is idempotent. The operator pool is the sole grantee -- see Decision #122's 2026-09-01 amendment.
GRANT EXECUTE ON FUNCTION public.canary_preflight_evidence_companies(uuid) TO "aoa_operator";
--> statement-breakpoint

-- ORGANIZATION-BOUND. The EXISTS clause makes the ORG the unit of authority: a company
-- outside the organization being gated yields zero rows whatever the caller passes.
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (drizzle-orm's pg-core
-- exposes no function/routine primitive at any level); CREATE OR REPLACE is idempotent.
CREATE OR REPLACE FUNCTION public.canary_preflight_evidence_leases(
  p_organization_id uuid, p_company_id uuid)
RETURNS TABLE (lease_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT l.id FROM public.environment_leases l
  WHERE l.company_id = p_company_id
    AND EXISTS (SELECT 1 FROM public.companies c
                WHERE c.id = p_company_id AND c.organization_id = p_organization_id);
$$;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- REVOKE is idempotent. Strips PostgreSQL's default PUBLIC EXECUTE on a new function.
REVOKE ALL ON FUNCTION public.canary_preflight_evidence_leases(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- REVOKE is idempotent. THIS is the round-7 boundary: the tenant-facing pool loses owner authority.
REVOKE ALL ON FUNCTION public.canary_preflight_evidence_leases(uuid, uuid) FROM "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- GRANT is idempotent. The operator pool is the sole grantee -- see Decision #122's 2026-09-01 amendment.
GRANT EXECUTE ON FUNCTION public.canary_preflight_evidence_leases(uuid, uuid) TO "aoa_operator";
--> statement-breakpoint

-- `scoped` returning no row makes BOTH scalar sub-selects NULL, so the "exactly one row,
-- always" contract holds and an out-of-org company reads as "no evidence", never an error.
-- That distinction matters: the caller must never confuse "no leases" with "no key
-- generation", which is the conflation this whole surface exists to remove.
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (drizzle-orm's pg-core
-- exposes no function/routine primitive at any level); CREATE OR REPLACE is idempotent.
CREATE OR REPLACE FUNCTION public.canary_preflight_evidence_scalars(
  p_organization_id uuid, p_company_id uuid, p_default_env_id uuid)
RETURNS TABLE (
  platform_default_environment_id uuid,
  key_generation text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH scoped AS (
    SELECT c.id FROM public.companies c
    WHERE c.id = p_company_id AND c.organization_id = p_organization_id
  ),
  default_env AS (
    -- p_default_env_id stays caller-supplied: it is a TypeScript uuidv5 and PostgreSQL has
    -- no builtin SHA-1, so it cannot be recomputed here, and a natural-key lookup would be a
    -- second derivation that drifts SILENTLY. It is now a pure FILTER -- e.company_id is
    -- bound to `scoped`, so an environment id from another org matches nothing.
    SELECT e.id FROM public.environments e
    WHERE e.id = p_default_env_id
      AND e.company_id = (SELECT id FROM scoped)
    LIMIT 1
  ),
  keygen AS (
    -- INNER JOIN LATERAL is deliberate. A runtime_provider_keys row with no
    -- status='current' version must yield NO keygen row, so key_generation is NULL --
    -- matching deriveE2bKeyGeneration. A LEFT JOIN would emit `secretId:` with a null
    -- version and change behaviour.
    SELECT k.secret_id, v.version
    FROM public.runtime_provider_keys k
    JOIN LATERAL (
      SELECT cv.version FROM public.company_secret_versions cv
      WHERE cv.secret_id = k.secret_id AND cv.status = 'current'
      ORDER BY cv.version DESC LIMIT 1
    ) v ON TRUE
    WHERE k.company_id = (SELECT id FROM scoped)
      AND k.provider = 'e2b' AND k.is_default = TRUE
    LIMIT 1
  )
  SELECT (SELECT id FROM default_env),
         (SELECT secret_id::text || ':' || version::text FROM keygen);
$$;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- REVOKE is idempotent. Strips PostgreSQL's default PUBLIC EXECUTE on a new function.
REVOKE ALL ON FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- REVOKE is idempotent. THIS is the round-7 boundary: the tenant-facing pool loses owner authority.
REVOKE ALL ON FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid) FROM "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement (no ACL primitive exists);
-- GRANT is idempotent. The operator pool is the sole grantee -- see Decision #122's 2026-09-01 amendment.
GRANT EXECUTE ON FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid) TO "aoa_operator";
