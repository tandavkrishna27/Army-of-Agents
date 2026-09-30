// server/src/db/security-definer-manifest.ts
//
// Every SECURITY DEFINER function in the application schema, as data.
//
// A definer function runs with the OWNER's authority regardless of caller, so it is the
// entire privilege-escalation surface that the table, column and sequence scans in
// `assertExactServingRoleAuthority` cannot see — before migration 0266 there was no
// `prosecdef` reference anywhere in this repository. Anything not listed here is drift,
// and drift is a fatal boot error.

export type SecurityDefinerFunction = {
  readonly schema: string;
  readonly name: string;
  /** `pg_get_function_identity_arguments` output, matched exactly. */
  readonly identityArguments: string;
  /**
   * The ONLY roles that may hold `EXECUTE`, besides the function owner (which always may,
   * implicitly). Enumerating the definer surface is only half a certificate: a manifested
   * function whose ACL widens is owner-authority code reachable by a role that was never
   * meant to reach it, and the identity scan alone cannot see that. `PUBLIC` is never a
   * legal entry here — a definer function executable by PUBLIC is the escalation this
   * manifest exists to prevent.
   */
  readonly executeGrantees: readonly string[];
  /**
   * The schema-qualified relations whose authority this function borrows — i.e. every
   * relation its body reads. The function's owner MUST own all of them.
   *
   * Owner is not a bounded axis, it is a pinned one. `ALTER FUNCTION … OWNER TO` rewrites
   * the ACL's grantor/grantee entries to the new owner, so an owner swap is INVISIBLE to
   * an exact-ACL comparison that normalizes against the current owner. A less-privileged
   * owner silently restores the BLOCKER E `preflight_error` outage (the body loses the
   * privileges it depends on); a more-privileged one silently widens the definer context.
   * Pinning against the relations themselves is deployment-independent — it hardcodes no
   * role name, and it states the actual invariant: a definer function may hold exactly the
   * authority of the data it reads.
   */
  readonly authorityRelations: readonly string[];
  /**
   * Expected `pg_proc.proconfig` — the per-function `SET` clauses, matched exactly.
   *
   * `CREATE OR REPLACE FUNCTION` PRESERVES the owner and the ACL, so a replacement that
   * keeps the identity and the `SECURITY DEFINER` setting but drops `SET search_path = ''`
   * is invisible to every identity, owner and ACL assertion. Without that pin, name
   * resolution inside owner-authority code becomes caller-controlled.
   */
  readonly executionConfig: readonly string[];
  /**
   * SHA-256 of `pg_proc.prosrc` with carriage returns stripped, lowercase hex.
   *
   * The last thing `CREATE OR REPLACE` can change invisibly is the BODY — dropping a
   * `company_id` predicate turns this into the cross-tenant existence oracle that review
   * caught in this plan's first revision. Pinning the body makes any change to owner-
   * authority code a deliberate, reviewed manifest edit.
   *
   * CR-stripped because `packages/db/src/migrations/` carries no `eol=lf` pin in
   * `.gitattributes`: a Windows checkout with `core.autocrlf=true` stores the migration
   * with CRLF and Linux CI with LF, so a raw hash would pin one platform and fail boot on
   * the other. The scan normalizes the same way.
   */
  readonly bodySha256: string;
  /** Why this function may hold owner authority. */
  readonly rationale: string;
};

export const SECURITY_DEFINER_FUNCTION_MANIFEST: readonly SecurityDefinerFunction[] = [
  {
    schema: "public",
    name: "canary_preflight_evidence_companies",
    identityArguments: "p_organization_id uuid",
    executeGrantees: ["aoa_operator"],
    // The enumeration moved INSIDE the definer surface (migration 0267) precisely so the
    // gate's pool needs no `companies` grant. That absence is what let EXECUTE move off
    // aoa_app -- aoa_operator holds no grant on companies or organizations at all.
    authorityRelations: ["public.companies"],
    executionConfig: ['search_path=""'],
    bodySha256: "f225bf33116c15d8b5a6e4a9960f166cab1b442ba5850b9e2eeae7a1d12ca0e4",
    rationale:
      "BLOCKER E / round 7. Enumerates one Organization's Companies so the canary gate needs " +
      "no companies grant on its pool. EXECUTE is aoa_operator ONLY. Note this is a WIDENING " +
      "for aoa_operator, which holds no grant on companies or organizations -- the capability " +
      "moves off a broad pool onto a narrow one rather than being removed.",
  },
  {
    schema: "public",
    name: "canary_preflight_evidence_leases",
    // ★ `timestamp with time zone`, NOT `timestamptz`. The catalog renders the former and the
    // manifest is compared with exact equality, so a `timestamptz` entry here is a fatal
    // EVERY-BOOT failure, not a cosmetic difference (measured in
    // mig-010-unit-2-4-probes.integration.test.ts).
    identityArguments:
      "p_organization_id uuid, p_company_id uuid, p_watermark timestamp with time zone",
    executeGrantees: ["aoa_operator"],
    authorityRelations: ["public.environment_leases", "public.companies"],
    executionConfig: ['search_path=""'],
    // Generated by `node scripts/definer-body-sha256.mjs
    // packages/db/src/migrations/0270_canary_preflight_lease_watermark.sql`, after proving the
    // generator reproduces 0267's three pinned hashes byte for byte. A wrong-but-well-formed
    // hash passes every check runnable without a database and then bricks EVERY boot.
    bodySha256: "ed76b678f89feaf9df8d8450d943d2b92ecd750258ec6b0a9c38e10a9e0ea936",
    rationale:
      "BLOCKER E / round 7, re-armed by MIG-010 Unit 2.4b (E7-F004). Returns one Company's " +
      "lease inventory from a table the serving roles hold zero privileges on, NARROWED to a " +
      "reconciliation pass's DB-clock snapshot instant so a lease created after the pass no " +
      "longer re-closes the gate forever. EXECUTE is granted to aoa_operator ONLY: aoa_app is " +
      "the tenant-facing pool (HTTP requests, outbox worker, admission bridge, live-event log), " +
      "so keeping the grant there narrows WHICH surface can reach owner authority. The " +
      "organization predicate is defence in depth, NOT a boundary -- p_organization_id is " +
      "caller-supplied and companies carries no RLS. The binder is the grantee, not the " +
      "parameter. Return type is a uuid ARRAY plus a bigint, so it cannot carry " +
      "environment_leases.metadata, which is secret-bearing at rest. " +
      "p_watermark carries NO DEFAULT and never may: the certificate reads proname, identity " +
      "arguments, proowner, proconfig, proleakproof, prosrc and proacl and is BLIND to " +
      "proargdefaults, so a DEFAULT-only CREATE OR REPLACE leaves all eight checks passing " +
      "while emptying every inventory (design section 10.2, measured). The shape is ONE ROW " +
      "ALWAYS -- array_agg over the narrowed set plus count over the unnarrowed one -- because " +
      "a RETURNS TABLE of the matches returns ZERO rows exactly when the churn guard needs the " +
      "total (section 11.1, measured). Migration 0270 DROPs the 2-argument form: with a " +
      "REQUIRED third parameter a stale 2-arg call does not raise 42725, it resolves silently " +
      "to the old unnarrowed function (section 11.2, measured).",
  },
  {
    schema: "public",
    name: "canary_preflight_evidence_scalars",
    identityArguments: "p_organization_id uuid, p_company_id uuid, p_default_env_id uuid",
    executeGrantees: ["aoa_operator"],
    // Deliberately does NOT read environment_leases: the round-6 split keeps the scalar
    // reads off the lease inventory, and the round-7 change must not silently undo it.
    authorityRelations: [
      "public.environments",
      "public.runtime_provider_keys",
      "public.company_secret_versions",
      "public.companies",
    ],
    executionConfig: ['search_path=""'],
    bodySha256: "1aad28e0fa0ba14aebbf708d6469025f6bb0e46bcc78c1d64b37db1fc9a03e14",
    rationale:
      "BLOCKER E / round 7. Returns exactly one row carrying the platform-default environment " +
      "id and the current provider-control key generation. EXECUTE is aoa_operator ONLY -- that " +
      "grant is the boundary; the organization predicate is defence in depth. The return type " +
      "structurally cannot carry company_secret_versions.material.",
  },
  {
    schema: "public",
    name: "legacy_reconciliation_leases",
    identityArguments: "p_organization_id uuid, p_company_id uuid",
    executeGrantees: ["aoa_operator"],
    // Both relations the body reads. The owner pin walks each DECLARED relation, so omitting
    // `public.companies` -- which only appears inside the EXISTS clause -- would not be a
    // no-op: it would leave that relation's owner unpinned.
    authorityRelations: ["public.environment_leases", "public.companies"],
    executionConfig: ['search_path=""'],
    bodySha256: "4f0fec604c062683446a12f7475a5a2784828f0c9e8c03f8dceb464c3cb5ac3f",
    rationale:
      "MIG-010 Unit 2.3 (E10-F002). The CLASSIFICATION read for the legacy reconciliation " +
      "pass, which aoa_operator cannot perform directly: OPERATOR_SERVING_RELATIONS grants it " +
      "one crosswalk relation and nothing on environment_leases, so the pass raised 42501 on " +
      "its first statement. Distinct from canary_preflight_evidence_leases rather than a " +
      "widening of it: that one projects lease_id only (all the GATE consumes), while the pass " +
      "must classify and reads eleven columns -- so there is no arity change, no DROP, and no " +
      "42725 ambiguous-call trap. EXECUTE is aoa_operator ONLY; the binder is the grantee, not " +
      "the caller-supplied organization parameter. The projection deliberately EXCLUDES " +
      "environment_leases.metadata, which is secret-bearing at rest, and failure_reason, so " +
      "the return type structurally cannot carry key material.",
  },
  {
    schema: "public",
    name: "resolve_provider_assignment_candidates",
    identityArguments: "p_organization_id uuid, p_company_id uuid, p_provider text",
    executeGrantees: ["aoa_operator"],
    authorityRelations: ["public.provider_assignments", "public.provider_connections"],
    executionConfig: ['search_path=""'],
    bodySha256: "1316da40fc578b72df4373f58c9464552fc06651ff3a76b2739ea46d2ef0784f",
    rationale:
      "E7-1 provider-credential broker (migration 0281). Returns the provider_assignment JOIN " +
      "provider_connection candidates for a distributed/isolated run so aoa_operator resolves the " +
      "Company provider key without a table grant on the owner-only credential model. EXECUTE is " +
      "aoa_operator ONLY -- the boundary; the org/company predicates are defence in depth " +
      "(caller-supplied, and candidateMatchesScope re-checks in Node). No secret material in the " +
      "return type.",
  },
  {
    schema: "public",
    name: "resolve_company_secret_bundle",
    identityArguments:
      "p_company_id uuid, p_secret_id uuid, p_version integer, p_target_type text, p_target_id text, p_config_path text",
    executeGrantees: ["aoa_operator"],
    authorityRelations: [
      "public.company_secrets",
      "public.company_secret_versions",
      "public.company_secret_provider_configs",
      "public.company_secret_bindings",
    ],
    executionConfig: ['search_path=""'],
    bodySha256: "b1106fd8f4928b7169eb90521174feb04e828ba707fcf77e9d830e1c954a8095",
    rationale:
      "E7-1 provider-credential broker (migration 0281). Returns one Company secret's metadata, " +
      "the resolved version's ENCRYPTED material, the provider-config row, and whether a binding " +
      "exists for the consumer path. Unlike canary_preflight_evidence_scalars this DOES carry " +
      "company_secret_versions.material -- that is the point: aoa_operator must materialize the " +
      "Company key to run the agent. AES-256-GCM decryption and every policy check " +
      "(status/deleted/binding/version) stay in Node. EXECUTE is aoa_operator ONLY; the material " +
      "never enters the wire (FORBIDDEN_WIRE_KEYS).",
  },
  {
    schema: "public",
    name: "record_company_secret_access",
    identityArguments:
      "p_company_id uuid, p_secret_id uuid, p_version integer, p_provider text, p_actor_type text, p_actor_id text, p_consumer_type text, p_consumer_id text, p_issue_id uuid, p_heartbeat_run_id uuid, p_plugin_id uuid, p_config_path text, p_outcome text, p_error_code text",
    executeGrantees: ["aoa_operator"],
    authorityRelations: ["public.secret_access_events", "public.company_secrets"],
    executionConfig: ['search_path=""'],
    bodySha256: "ca7312f6680aba21874953cde233927ec3765fd77c4d1a291fc096b90a38d94d",
    rationale:
      "E7-1 provider-credential broker (migration 0281). Performs the two writes resolveSecretValue " +
      "makes that aoa_operator cannot: the secret_access_events audit INSERT (success AND failure) " +
      "and, on success only, the company_secrets.last_resolved_at touch. Called from Node after " +
      "decryption with the final outcome so audit timing matches the in-process path. EXECUTE is " +
      "aoa_operator ONLY.",
  },
];
