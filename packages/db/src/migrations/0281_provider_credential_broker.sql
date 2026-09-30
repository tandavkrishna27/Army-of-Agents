-- C14 hand-authored security DDL (Decision #122, 2026-09-01 amendment): drizzle-kit cannot
-- emit functions or their ACLs. Every statement below is idempotent. Delta-free --custom
-- migration (no table/column/index/FK change); the 0281 snapshot differs from 0280 in
-- id/prevId only.
--
-- E7-1 provider-credential broker. The five credential-model relations
-- (provider_assignments, provider_connections, company_secrets, company_secret_versions,
-- company_secret_bindings, company_secret_provider_configs) are OWNER-ONLY: neither serving
-- role (aoa_app, aoa_operator) holds any grant, and that absence is ENFORCED at control-plane
-- boot by assertExactServingRoleAuthority. A distributed/isolated agent run therefore cannot
-- resolve the Company's provider key and fails `no_assignment` at resolveProviderCredential.
--
-- ★ WHY DEFINER FUNCTIONS, NOT A TABLE GRANT. A plain `GRANT SELECT ... TO aoa_app/aoa_operator`
-- violates that boot assertion (verified live: the CP exits on
-- `distributed_execution_app_authority`). The sanctioned widening is a SECURITY DEFINER function
-- EXECUTE-granted to aoa_operator ONLY, exactly as canary_preflight_evidence_* (0266/0267) let
-- the operator pool read company_secret_versions without a table grant. The boundary is the
-- EXECUTE grant (the caller cannot forge the role it connects as); the org/company predicates
-- are defence in depth. search_path is pinned EMPTY and every relation schema-qualified.
--
-- ★ DECRYPTION + POLICY STAY IN NODE. These functions return rows/material only. AES-256-GCM
-- decryption (app-held master key) and every check (status/deleted/binding/version selection)
-- remain in the audited Node layer (provider-resolution-deps.ts). Function B's return type
-- DOES carry company_secret_versions.material (encrypted) — that is the point: aoa_operator
-- must materialize the Company key to run the agent. It never enters the wire (FORBIDDEN_WIRE_KEYS).

-- ---------------------------------------------------------------------------------------------
-- Idempotent DROPs (an arity/return change CREATEs a new function rather than replacing; drop
-- first so a re-run leaves exactly one definition carrying exactly the ACL below).
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.resolve_provider_assignment_candidates(uuid, uuid, text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.resolve_company_secret_bundle(uuid, uuid, integer, text, text, text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.record_company_secret_access(uuid, uuid, integer, text, text, text, text, text, uuid, uuid, uuid, text, text, text);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Function A — provider-assignment candidates. Mirrors the loadCandidateRows SELECT
-- (provider-resolution-deps.ts): assignment JOIN connection, scoped to the company (or an
-- org_default row for the run's organization) for an active assignment of the given provider.
-- No secret material. candidateMatchesScope stays in Node.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_provider_assignment_candidates(
  p_organization_id uuid,
  p_company_id      uuid,
  p_provider        text
)
RETURNS TABLE (
  connection_id              uuid,
  auth_method                text,
  scope_type                 text,
  scope_id                   text,
  priority                   integer,
  connection_updated_at      timestamptz,
  state                      text,
  terms_attested_at          timestamptz,
  sharing_policy             text,
  connection_company_id      uuid,
  connection_organization_id uuid,
  connection_owner_user_id   text,
  execution_target_id        text,
  config                     jsonb,
  secret_ref                 uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pc.id, pc.auth_method, pa.scope_type, pa.scope_id, pa.priority,
         pc.updated_at, pc.state, pc.terms_attested_at, pc.sharing_policy,
         pc.company_id, pc.organization_id, pc.owner_user_id,
         pc.execution_target_id, pc.config, pc.secret_ref
  FROM public.provider_assignments pa
  INNER JOIN public.provider_connections pc ON pc.id = pa.connection_id
  WHERE pa.provider = p_provider
    AND pa.state = 'active'
    AND ( pa.company_id = p_company_id
       OR ( pa.company_id IS NULL
            AND pa.scope_type = 'org_default'
            AND p_organization_id IS NOT NULL
            AND pa.organization_id = p_organization_id ) );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_provider_assignment_candidates(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_provider_assignment_candidates(uuid, uuid, text) FROM "aoa_app";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_provider_assignment_candidates(uuid, uuid, text) TO "aoa_operator";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Function B — secret bundle read. One row (or zero when no secret with that id belongs to the
-- company), carrying everything resolveSecretValue's DB layer reads: the secret metadata
-- (including provider_metadata, so the R3 mcp-oauth guard is reproducible in Node), the resolved
-- version's encrypted material (COALESCE(p_version, latest_version)), the provider-config row
-- (if any), and whether a binding exists for the given consumer path. The row is scoped by
-- `cs.company_id = p_company_id` (defence in depth: A and C scope by company too, and this is the
-- one material-bearing definer — it fails closed at the DB rather than trusting only the Node
-- company check). Every policy check (status='active', deleted_at IS NULL, company match,
-- mcp-oauth guard, binding-required, provider-config disabled, version present) still runs in
-- Node. p_version NULL means "latest".
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_company_secret_bundle(
  p_company_id   uuid,
  p_secret_id    uuid,
  p_version      integer,
  p_target_type  text,
  p_target_id    text,
  p_config_path  text
)
RETURNS TABLE (
  secret_found            boolean,
  secret_company_id       uuid,
  secret_status           text,
  secret_is_deleted       boolean,
  secret_provider         text,
  secret_external_ref     text,
  secret_provider_metadata jsonb,
  secret_latest_version   integer,
  secret_provider_config_id uuid,
  resolved_version        integer,
  version_found           boolean,
  version_material        jsonb,
  provider_config_found   boolean,
  provider_config_company_id uuid,
  provider_config_provider   text,
  provider_config_status     text,
  provider_config_disabled   boolean,
  provider_config_config     jsonb,
  binding_found           boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    true AS secret_found,
    cs.company_id,
    cs.status,
    (cs.deleted_at IS NOT NULL) AS secret_is_deleted,
    cs.provider,
    cs.external_ref,
    cs.provider_metadata,
    cs.latest_version,
    cs.provider_config_id,
    COALESCE(p_version, cs.latest_version) AS resolved_version,
    (csv.id IS NOT NULL) AS version_found,
    csv.material,
    (pcfg.id IS NOT NULL) AS provider_config_found,
    pcfg.company_id,
    pcfg.provider,
    pcfg.status,
    (pcfg.disabled_at IS NOT NULL OR pcfg.status = 'disabled') AS provider_config_disabled,
    pcfg.config,
    EXISTS (
      SELECT 1 FROM public.company_secret_bindings b
      WHERE b.company_id = cs.company_id
        AND b.secret_id = cs.id
        AND b.target_type = p_target_type
        AND b.target_id = p_target_id
        AND b.config_path = p_config_path
    ) AS binding_found
  FROM public.company_secrets cs
  LEFT JOIN public.company_secret_versions csv
    ON csv.secret_id = cs.id AND csv.version = COALESCE(p_version, cs.latest_version)
  LEFT JOIN public.company_secret_provider_configs pcfg
    ON pcfg.id = cs.provider_config_id
  WHERE cs.id = p_secret_id
    AND cs.company_id = p_company_id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_company_secret_bundle(uuid, uuid, integer, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_company_secret_bundle(uuid, uuid, integer, text, text, text) FROM "aoa_app";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_company_secret_bundle(uuid, uuid, integer, text, text, text) TO "aoa_operator";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Function C — the writes resolveSecretValue performs that aoa_operator cannot: the
-- secret_access_events audit INSERT (called on BOTH success and failure, after Node decrypts)
-- and, on success only, the company_secrets.last_resolved_at/updated_at touch. Returns void.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_company_secret_access(
  p_company_id        uuid,
  p_secret_id         uuid,
  p_version           integer,
  p_provider          text,
  p_actor_type        text,
  p_actor_id          text,
  p_consumer_type     text,
  p_consumer_id       text,
  p_issue_id          uuid,
  p_heartbeat_run_id  uuid,
  p_plugin_id         uuid,
  p_config_path       text,
  p_outcome           text,
  p_error_code        text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.secret_access_events (
    company_id, secret_id, version, provider,
    actor_type, actor_id, consumer_type, consumer_id,
    config_path, issue_id, heartbeat_run_id, plugin_id,
    outcome, error_code
  ) VALUES (
    p_company_id, p_secret_id, p_version, p_provider,
    p_actor_type, p_actor_id, p_consumer_type, p_consumer_id,
    p_config_path, p_issue_id, p_heartbeat_run_id, p_plugin_id,
    p_outcome, p_error_code
  );
  IF p_outcome = 'success' THEN
    UPDATE public.company_secrets
       SET last_resolved_at = now(), updated_at = now()
     WHERE id = p_secret_id AND company_id = p_company_id;
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_company_secret_access(uuid, uuid, integer, text, text, text, text, text, uuid, uuid, uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_company_secret_access(uuid, uuid, integer, text, text, text, text, text, uuid, uuid, uuid, text, text, text) FROM "aoa_app";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_company_secret_access(uuid, uuid, integer, text, text, text, text, text, uuid, uuid, uuid, text, text, text) TO "aoa_operator";
