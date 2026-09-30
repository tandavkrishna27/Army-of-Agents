-- C14 class (b) hand-authored cluster/security DDL, in an EMPTY --custom stub (there is no
-- schema delta to diff onto). Every statement is naturally idempotent (CREATE OR REPLACE /
-- idempotent REVOKE + GRANT).
--
-- NO GENERATOR ROUTE EXISTS. drizzle-orm's pg-core exposes no function/routine/procedure
-- primitive at all (verified: zero exports matching /function|routine|proc/), and this
-- repo's drizzle.config.ts declares neither `entities.roles` nor `pgPolicy`. There is
-- therefore nothing `pnpm db:generate` could emit here, in the same way there was nothing
-- it could emit for 0211's CREATE ROLE or 0261's GRANT.
--
-- ★ HONEST ABOUT THE PRECEDENT: this is the FIRST `CREATE FUNCTION` in 266 migrations. The
-- adjacent precedent (0211/0213/0214/0259/0261 — 26 migrations of hand-authored roles,
-- grants, RLS and policies) is LOCKED as Decision #122, which enumerates the class as
-- RLS/role/GRANT/FORCE-RLS/CREATE-POLICY DDL and does NOT name functions. Decision #122 was
-- therefore AMENDED (2026-09-01) to cover `CREATE FUNCTION` plus its ACL, on the same
-- provably-not-emittable footing, with three added conditions for `SECURITY DEFINER`:
-- a manifest entry (security-definer-manifest.ts), a boot certificate whose drift is fatal
-- (assertSecurityDefinerManifest), and an empty pinned search_path with tenant-scoped
-- predicates on every branch. Read Decision #122 before adding a second one of these.
--
-- NO TABLE, COLUMN, INDEX OR CONSTRAINT DDL IS HAND-AUTHORED HERE. The accompanying
-- meta/0266_snapshot.json differs from 0265's in `id`/`prevId` ONLY — i.e. this migration
-- carries a zero schema delta, which is the checkable form of that claim.
--
-- WHY. The canary preflight (server/src/services/canary-preflight.ts:139-145) fires its
-- evidence reads on the NON-OWNER `aoa_app` pool (server/src/index.ts). Three of them
-- hit tables `aoa_app` holds ZERO privileges on; each raises 42501, the catch at
-- canary-preflight.ts:191-200 folds it into reason="preflight_error", and
-- run-execution-owner.ts:254-257 returns owner="legacy". The gate could never open, and
-- worse, it could never say WHY it was closed: an unreadability refusal is unfalsifiable
-- and indistinguishable from a policy decision.
--
-- WHY NOT A GRANT. `company_secret_versions.material` is AES-256-GCM secret material and
-- `environment_leases.metadata` is secret-bearing AT REST (sanitizeProviderMetadata strips
-- only apiKey|resolvedApiKey, at read time, in memory). The gate needs THREE SCALARS. A
-- definer function narrows the PREDICATE as well as the projection; a column grant would
-- narrow only the projection and still let `aoa_app` enumerate every company's rows. It
-- also avoids the nine-artifact manifest coupling a table grant carries (see 0261) --
-- because it adds no relation to the serving inventory at all.
--
-- OWNERSHIP is load-bearing: migrations run as the database owner, and
-- 0214_e2_serving_role_hardening.sql:10,31 RAISEs if a serving role owns an application
-- object. The function is therefore owner-owned by construction.
--
-- search_path is pinned EMPTY and every relation is schema-qualified, so a caller's
-- search_path cannot redirect the body. pg_catalog stays implicitly resolvable.
--
-- The `leases` CTE below is NOT `public.leases` (the job-control table). A CTE name always
-- shadows a relation, and with an empty search_path an unqualified name resolves to nothing
-- anyway; every real table in this body is schema-qualified.
-- ROUND-6 SPLIT. This was ONE function returning one row per lease plus two scalars, which
-- forced a choice between two defects: either the two scalar-only callers each hydrated the
-- company's entire lease inventory to read a single scalar (the efficiency finding), or a
-- shared single-flight coalesced them -- and a store-global single-flight let two OVERLAPPING
-- `check()` calls share one snapshot, so a lease committed between them was invisible to the
-- second. That is precisely the fail-open `canary-preflight.ts:30-33` forbids by refusing to
-- cache. Splitting removes the choice: the two jobs are unrelated, each caller reads only what
-- it needs, every read is independent, and there is no shared mutable state to scope.

CREATE OR REPLACE FUNCTION public.canary_preflight_evidence_leases(p_company_id uuid)
RETURNS TABLE (lease_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT l.id FROM public.environment_leases l WHERE l.company_id = p_company_id;
$$;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON FUNCTION public.canary_preflight_evidence_leases(uuid) FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; GRANT is idempotent.
GRANT EXECUTE ON FUNCTION public.canary_preflight_evidence_leases(uuid) TO "aoa_app";
--> statement-breakpoint
-- Exactly ONE row, always -- so a company with no leases still yields both scalars, and the
-- caller can never confuse "no leases" with "no key generation". Touches no lease row.
CREATE OR REPLACE FUNCTION public.canary_preflight_evidence_scalars(p_company_id uuid, p_default_env_id uuid)
RETURNS TABLE (
  platform_default_environment_id uuid,
  key_generation text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH default_env AS (
    -- COMPANY-SCOPED. Without `company_id = p_company_id` this is a cross-tenant existence
    -- oracle: a caller passing company A with company B's environment id gets B's row echoed
    -- back through an OWNER-authority function. `ensurePlatformDefaultEnvironmentRow` writes
    -- the row with that companyId, so this predicate is behaviour-preserving.
    SELECT e.id FROM public.environments e
    WHERE e.id = p_default_env_id AND e.company_id = p_company_id
    LIMIT 1
  ),
  keygen AS (
    -- INNER JOIN LATERAL is deliberate. A `runtime_provider_keys` row with no status='current'
    -- version must yield NO keygen row, so `key_generation` is NULL -- matching
    -- deriveE2bKeyGeneration, which returns null in that case. A LEFT JOIN would emit
    -- `secretId:` with a null version and change behaviour.
    SELECT k.secret_id, v.version
    FROM public.runtime_provider_keys k
    JOIN LATERAL (
      SELECT cv.version FROM public.company_secret_versions cv
      WHERE cv.secret_id = k.secret_id AND cv.status = 'current'
      ORDER BY cv.version DESC LIMIT 1
    ) v ON TRUE
    WHERE k.company_id = p_company_id AND k.provider = 'e2b' AND k.is_default = TRUE
    LIMIT 1
  )
  SELECT (SELECT id FROM default_env),
         (SELECT secret_id::text || ':' || version::text FROM keygen);
$$;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; GRANT is idempotent.
GRANT EXECUTE ON FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid) TO "aoa_app";
