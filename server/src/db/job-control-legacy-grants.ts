import { getTableColumns, getTableName, type Table } from "drizzle-orm";
import * as dbSchema from "@armyofagents/db";

export type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

type ServingRolePrivileges = Readonly<Record<
  "aoa_app" | "aoa_operator",
  readonly TablePrivilege[]
>>;

export interface AclTupleManifest {
  readonly grantor: "RELATION_OWNER";
  readonly grantee: "RELATION_OWNER" | "PUBLIC" | "aoa_app" | "aoa_operator";
  readonly privilegeType: string;
  readonly isGrantable: boolean;
}

export interface AclManifestEntry {
  readonly aclIsNull: boolean;
  readonly tuples: readonly AclTupleManifest[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Corrective E2 prerequisite (E3-F001): the operation-level aoa_app allowlist
 * traced from the existing JOB-010..014 engines. This is deliberately not broad
 * DML: each privilege corresponds to a current query in checkout/heartbeat,
 * approvals/runtime-decision, budget/cost, concurrency, or output-summary code.
 * New legacy access must be added by a reviewed trace, never by an owner fallback.
 */
// DO NOT ADD A NEW TABLE HERE. This object is not merely a grant list: `rls-tenant.ts`
// RECONSTRUCTS the bodies of the ALREADY-APPLIED, IMMUTABLE migrations 0213 and 0214 by walking
// it, so a new entry retroactively rewrites two migrations that have already run and the
// byte-identity test in `tenant-rls-enforcement-unit.test.ts` fails ~30 minutes into `verify`.
// (DSK-001 Lane B hit this and added `GRANTED_AFTER_0213`/`GRANTED_AFTER_0214`; REL-004 Lane C
// hit it again by following 0259's coupling comment, which does not mention it.)
//
// A NEW grant goes in its OWN `*_APP_GRANTS` / `*_NEW_PATH_GRANTS` constant below — the
// reconstructors never see those, so the hazard becomes unrepresentable rather than remembered.
// `job-control-legacy-grants.contract.test.ts` pins this object's exact key set so the mistake
// fails with an instruction instead of a forty-line SQL byte diff.
export const JOB_CONTROL_LEGACY_GRANTS = Object.freeze({
  issues: ["SELECT", "UPDATE"],
  agents: ["SELECT", "UPDATE"],
  task_dependencies: ["SELECT"],
  issue_labels: ["SELECT"],
  labels: ["SELECT"],
  notifications: ["SELECT", "INSERT", "UPDATE"],
  user_roles: ["SELECT"],
  company_memberships: ["SELECT"],
  // DSK-001 Lane B (D12/3). The fenced secret-resolve tx admits a device_local handle
  // only when its provider_credentials row is state='verified' and the owner triple
  // agrees. Read-only, and the table stores NO secret value -- "logical credential
  // ownership only"; provider-native subscription files stay in the owning execution
  // target. Table-level SELECT mirrors company_memberships, which is the same class of
  // read: a legacy company-scoped authorization fact consulted inside the fence.
  provider_credentials: ["SELECT"],
  notification_preferences: ["SELECT"],
  notification_digest_items: ["SELECT", "INSERT"],
  hub_counter_snapshots: ["SELECT", "UPDATE"],
  hub_audit: ["INSERT"],
  heartbeat_runs: ["SELECT", "INSERT", "UPDATE"],
  agent_wakeup_requests: ["SELECT", "INSERT", "UPDATE"],
  discussion_entries: ["SELECT", "UPDATE"],
  internal_agent_runs: ["SELECT", "INSERT", "UPDATE"],
  thread_orchestration_state: ["SELECT", "UPDATE"],
  internal_agent_conversations: ["SELECT"],
  internal_agent_messages: ["SELECT"],
  internal_agent_config: ["SELECT"],
  companies: ["SELECT", "UPDATE"],
  organizations: ["SELECT"],
  approvals: ["SELECT", "INSERT", "UPDATE"],
  agent_runtime_decisions: ["SELECT", "INSERT", "UPDATE"],
  agent_runtime_trust_rules: ["SELECT", "INSERT", "UPDATE"],
  internal_agent_runtime_approvals: ["SELECT", "INSERT", "UPDATE"],
  internal_agent_tool_trust_rules: ["SELECT", "INSERT", "UPDATE"],
  budget_policies: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  budget_incidents: ["SELECT", "INSERT", "UPDATE"],
  cost_events: ["SELECT", "INSERT"],
  activity_log: ["SELECT", "INSERT"],
  projects: ["SELECT"],
  task_outputs: ["SELECT", "INSERT", "UPDATE"],
  issue_comments: ["INSERT"],
  artifacts: ["SELECT"],
  artifact_versions: ["SELECT"],
  assets: ["SELECT"],
  execution_workspaces: ["SELECT"],
  workspace_runtime_services: ["SELECT"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/** Columns needed to revalidate the already-authenticated MCP key in-transaction. */
export const APP_MCP_API_KEY_COLUMN_GRANTS = Object.freeze([
  "id",
  "company_id",
  "user_id",
  "revoked_at",
] as const);

/**
 * Existing E2 new-path DML retained by aoa_app after the corrective ACL reset.
 * Kept separate from the legacy trace so the two authorization seams stay
 * reviewable independently.
 */
export const JOB_CONTROL_NEW_PATH_GRANTS = Object.freeze({
  jobs: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  job_attempts: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  leases: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  workers: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  services: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  service_instances: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  job_artifacts: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  job_secret_handles: ["SELECT", "INSERT", "UPDATE", "DELETE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/** JOB-001-only legacy reads, versioned away from the immutable 0213/0214 inputs. */
export const JOB_SUBMISSION_LEGACY_GRANTS = Object.freeze({
  organization_memberships: ["SELECT"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/** JOB-001-only new-path authority introduced after the immutable 0214 artifact. */
export const JOB_SUBMISSION_NEW_PATH_GRANTS = Object.freeze({
  job_outbox: ["SELECT", "INSERT", "UPDATE", "DELETE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/** JOB-003-only receipt authority, versioned after the immutable E2 grant set. */
export const JOB_LEASING_NEW_PATH_GRANTS = Object.freeze({
  worker_operation_receipts: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  worker_lease_rejections: ["SELECT", "INSERT", "UPDATE", "DELETE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/** JOB-005-only event ledger + projection idempotency authority, versioned after
 * the immutable JOB-003 leasing grant delta. */
export const JOB_EVENTS_NEW_PATH_GRANTS = Object.freeze({
  job_events: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  job_projection_receipts: ["SELECT", "INSERT", "UPDATE", "DELETE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/** JOB-006-only durable control-command channel authority, versioned after the
 * immutable JOB-005 event-ledger grant delta. */
export const JOB_CONTROL_COMMANDS_NEW_PATH_GRANTS = Object.freeze({
  job_control_commands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/** DAT-006-only local-folder-grant admission authority, versioned after the immutable
 * JOB-006 control-command grant delta. The NEW `folder_grants` table (TEN-006 per-table
 * RLS, migration 0253) is aoa_app-only tenant DML with no operator authority — mirrors
 * job_control_commands. This is the ONE keystone reconciliation DAT-006 forces. */
export const FOLDER_GRANTS_NEW_PATH_GRANTS = Object.freeze({
  folder_grants: ["SELECT", "INSERT", "UPDATE", "DELETE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/** DEP-009-only shared worker-admission rate-limit authority, versioned after the immutable
 * DAT-006 folder-grant delta. The NEW `worker_admission_rate_limits` table (migration 0255)
 * is aoa_app-only tenant DML with no operator authority — mirrors folder_grants. aoa_app needs
 * SELECT/INSERT/UPDATE (atomic upsert-increment counter) + DELETE (best-effort retention sweep
 * of expired windows). This is the ONE keystone reconciliation DEP-009 forces. */
export const WORKER_ADMISSION_RATE_LIMITS_NEW_PATH_GRANTS = Object.freeze({
  worker_admission_rate_limits: ["SELECT", "INSERT", "UPDATE", "DELETE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/**
 * REL-004 Lane C kill-switch policy read, versioned after the immutable DEP-009 rate-limit
 * delta. `instance_settings` is a PRE-EXISTING legacy singleton, not a new table — but the grant
 * is new (migration 0261), and it lives in its own constant rather than in
 * `JOB_CONTROL_LEGACY_GRANTS` for a structural reason: that object reconstructs the immutable
 * 0213/0214 migration bodies, so an entry there needs a matching exclusion in BOTH
 * `GRANTED_AFTER_0213` and `GRANTED_AFTER_0214` or it rewrites migrations that already ran.
 * Here, the reconstructors never see it.
 *
 * The worker poll reads `instance_settings.kill_switches` on the aoa_app pool BEFORE opening the
 * lease transaction; without the grant the read fails at RUNTIME with permission denied, not at
 * compile time. Table-level for the reason 0259 records: the column-level form exists to keep a
 * WRITEABLE, worker-owned table narrow and carries a bespoke allowlist plus a
 * has_column_privilege pass; a second such mechanism for a read-only singleton lookup would be
 * more machinery, not less exposure. Exposure verified rather than assumed: instance_settings
 * stores NO secret — UI flags, a feedback-sharing preference, a retention policy, and migration
 * snapshots. SELECT only; no operator authority.
 */
export const KILL_SWITCH_POLICY_APP_GRANTS = Object.freeze({
  instance_settings: ["SELECT"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/** MIG-003 (E10 realtime foundation) durable realtime event-log authority, versioned after the
 * immutable DEP-009 rate-limit delta. The NEW `live_event_log` + `live_event_sequences` tables
 * (migration 0257) are aoa_app-only tenant DML with no operator authority — mirror job_events.
 * aoa_app needs SELECT/INSERT/UPDATE/DELETE on the log (append + read + bounded retention trim)
 * and SELECT/INSERT/UPDATE on the per-company sequence counter (atomic UPDATE ... RETURNING
 * upsert; the row is never deleted). These mirror the reviewed C14 grants in 0257 exactly. */
export const LIVE_EVENT_LOG_NEW_PATH_GRANTS = Object.freeze({
  live_event_log: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  live_event_sequences: ["SELECT", "INSERT", "UPDATE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/**
 * SVC-001 immutable service generations (migration 0264). SELECT + INSERT ONLY.
 *
 * The omission of UPDATE and DELETE is the ENTIRE enforcement mechanism for the ticket's
 * clause (a) ("updates create a new immutable generation"): this repo contains zero
 * CREATE TRIGGER / CREATE RULE statements across all 264 migrations, so there is no DB
 * backstop, and the exact-match relation ACL is what makes the omission binding rather
 * than aspirational. Widening this to UPDATE or DELETE silently destroys the guarantee
 * and must not happen without a successor decision.
 *
 * NOTE the companion constraint that lives in the migration, not here: the parent FK to
 * `services` is ON DELETE RESTRICT. A referential action runs with the CONSTRAINT's
 * rights, not the caller's, so a cascade would let `DELETE FROM services` erase these
 * rows despite this grant. The two halves only work together.
 */
export const SERVICE_GENERATIONS_NEW_PATH_GRANTS = Object.freeze({
  service_generations: ["SELECT", "INSERT"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/**
 * Current heartbeat execution-target resolver projection for aoa_app. This is
 * column-level because the table also stores worker_token_hash and unrelated
 * enrollment/ownership metadata that the tenant-serving path must not read.
 */
export const APP_EXECUTION_TARGET_COLUMN_GRANTS = Object.freeze([
  "id",
  "slug",
  "kind",
  "trust_class",
  "status",
  "organization_id",
  "config",
] as const);

/**
 * E2-D06 operator-read seam. Enrollment credentials, ownership, routing config,
 * status/revocation mutations, and all DELETE authority remain deferred to
 * JOB-002; the current operator is metadata-read-only.
 */
export const OPERATOR_METADATA_COLUMN_GRANTS = Object.freeze({
  workers: [
    "id",
    "scope",
    "organization_id",
    "label",
    "status",
    "created_at",
    "updated_at",
  ],
  execution_targets: [
    "id",
    "organization_id",
    "slug",
    "kind",
    "trust_class",
    "status",
    "capabilities",
    "last_seen_at",
    "created_at",
    "updated_at",
  ],
} satisfies Readonly<Record<string, readonly string[]>>);

/** JOB-002 tenant authority, versioned after the immutable E2/JOB-001 grants. */
export const WORKER_ENROLLMENT_APP_GRANTS = Object.freeze({
  worker_enrollment_code_routes: ["SELECT", "INSERT", "DELETE"],
  worker_enrollment_codes: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  worker_proof_replays: ["SELECT", "INSERT", "DELETE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/** JOB-002 platform metadata authority; RLS restricts every mutable row to null-Org. */
export const WORKER_ENROLLMENT_OPERATOR_GRANTS = Object.freeze({
  workers: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  worker_enrollment_code_routes: ["SELECT", "INSERT", "DELETE"],
  worker_enrollment_codes: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  worker_proof_replays: ["SELECT", "INSERT", "DELETE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/**
 * DEP-003 operator-gated 0188 cutover marker (migration 0233). aoa_operator writes
 * the durable marker (no DELETE); aoa_app reads it ONLY outside a tenant transaction
 * (RLS app-read policy). These mirror the reviewed C14 grants in 0233 exactly — a
 * grant change there must update these constants and survive review.
 */
export const CUTOVER_MARKER_APP_GRANTS = Object.freeze({
  distributed_cutover_markers: ["SELECT"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);
export const CUTOVER_MARKER_OPERATOR_GRANTS = Object.freeze({
  distributed_cutover_markers: ["SELECT", "INSERT", "UPDATE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/**
 * JOB-007 operator-metadata target-generation-cutoff fanout record (migration 0239).
 * aoa_operator writes the durable record (no DELETE — records are durable) + advances
 * the bounded scan/cursor/retry state; aoa_app reads it ONLY outside a tenant
 * transaction (RLS app-read policy) so the fanout driver can converge each admitted
 * Organization separately. These mirror the reviewed C14 grants in 0239 exactly — a
 * grant change there must update these constants and survive review. Same
 * operator-metadata shape as CUTOVER_MARKER_* above.
 */
export const EXECUTION_TARGET_REVOCATION_APP_GRANTS = Object.freeze({
  execution_target_revocations: ["SELECT"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);
export const EXECUTION_TARGET_REVOCATION_OPERATOR_GRANTS = Object.freeze({
  execution_target_revocations: ["SELECT", "INSERT", "UPDATE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/**
 * MIG-008 (E10 desktop-migration) append-only legacy-lease/resource reconciliation
 * crosswalk (migration 0256). aoa_operator writes the durable reconciliation records
 * (no DELETE — records are durable); aoa_app reads the closure store ONLY outside a
 * tenant transaction (RLS app-read policy). These mirror the reviewed C14 grants in
 * 0256 exactly — a grant change there must update these constants and survive review.
 * Same operator-metadata shape as CUTOVER_MARKER_* / EXECUTION_TARGET_REVOCATION_* above.
 */
export const LEGACY_RESOURCE_RECONCILIATION_APP_GRANTS = Object.freeze({
  legacy_resource_reconciliation: ["SELECT"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);
export const LEGACY_RESOURCE_RECONCILIATION_OPERATOR_GRANTS = Object.freeze({
  legacy_resource_reconciliation: ["SELECT", "INSERT", "UPDATE"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/**
 * MIG-010 Unit 2.4 (BLOCKER E-2/E-3) reconciliation-pass MARKER (migration 0269).
 * aoa_operator SELECT + INSERT: the operator-authored pass writes a marker per Company and
 * the canary gate — which runs on the same operator pool since Unit 1.7 — reads the latest
 * one. No UPDATE and no DELETE: a marker is durable EVIDENCE of a completed pass, and a pass
 * that can rewrite its own marker is not evidence.
 *
 * ★ THERE IS NO MATCHING `*_APP_GRANTS` CONSTANT, and that is the point. The three
 * operator-metadata precedents (CUTOVER_MARKER_*, EXECUTION_TARGET_REVOCATION_*,
 * LEGACY_RESOURCE_RECONCILIATION_*) each pair operator write with aoa_app SELECT. Nothing on
 * the aoa_app pool reads this marker, and BLOCKER E-1's lesson is that the GRANTEE is the
 * boundary — a grant with no reader is authority handed over for symmetry. If a control-plane
 * reader appears, add the constant and the GRANT together, in their own reviewed diff.
 *
 * These mirror the reviewed C14 grants in 0269 exactly — a grant change there must update
 * this constant and survive review.
 */
export const LEGACY_RECONCILIATION_PASS_OPERATOR_GRANTS = Object.freeze({
  legacy_reconciliation_passes: ["SELECT", "INSERT"],
} satisfies Readonly<Record<string, readonly TablePrivilege[]>>);

/** Tenant target metadata needed to issue/consume enrollment and retire bootstrap auth. */
export const APP_ENROLLMENT_TARGET_SELECT_COLUMNS = Object.freeze([
  "id", "organization_id", "owner_user_id", "scope", "target_authority_key",
  "status", "device_generation", "capabilities",
] as const);
export const APP_ENROLLMENT_TARGET_UPDATE_COLUMNS = Object.freeze([
  "worker_token_hash", "device_generation", "status", "last_seen_at", "updated_at",
] as const);

/** Platform target projection keeps config and bootstrap hashes unreadable. */
export const OPERATOR_ENROLLMENT_TARGET_SELECT_COLUMNS = Object.freeze([
  "id", "organization_id", "owner_user_id", "slug", "kind", "trust_class",
  "status", "capabilities", "scope", "target_authority_key", "device_generation",
  "last_seen_at", "created_at", "updated_at",
] as const);
export const OPERATOR_ENROLLMENT_TARGET_UPDATE_COLUMNS = Object.freeze([
  "worker_token_hash", "device_generation", "status", "last_seen_at", "updated_at",
] as const);

/**
 * JOB-009 placement profile authority. These columns contain only the
 * server-registered capability and provider ceilings used to place an attempt;
 * enrollment secrets, worker tokens, routing config, and job details remain
 * outside both projections.
 */
export const APP_JOB_PLACEMENT_TARGET_SELECT_COLUMNS = Object.freeze([
  "slug", "kind", "trust_class", "last_seen_at", "registered_profile",
  "registered_profile_hash", "provider_constraint_profile",
] as const);
export const OPERATOR_JOB_PLACEMENT_TARGET_SELECT_COLUMNS = Object.freeze([
  "registered_profile", "registered_profile_hash", "provider_constraint_profile",
] as const);
export const APP_JOB_PLACEMENT_TARGET_UPDATE_COLUMNS = Object.freeze([
  "registered_profile", "registered_profile_hash", "provider_constraint_profile", "updated_at",
] as const);
export const OPERATOR_JOB_PLACEMENT_TARGET_UPDATE_COLUMNS = APP_JOB_PLACEMENT_TARGET_UPDATE_COLUMNS;

function sortedUnion(...collections: readonly (readonly string[])[]): readonly string[] {
  return Object.freeze([...new Set(collections.flat())].sort());
}

/** The app serving inventory is derived once from every table and column grant source. */
export const APP_SERVING_RELATIONS = sortedUnion(
  Object.keys(JOB_CONTROL_LEGACY_GRANTS),
  Object.keys(JOB_CONTROL_NEW_PATH_GRANTS),
  Object.keys(JOB_SUBMISSION_LEGACY_GRANTS),
  Object.keys(JOB_SUBMISSION_NEW_PATH_GRANTS),
  Object.keys(WORKER_ENROLLMENT_APP_GRANTS),
  Object.keys(JOB_LEASING_NEW_PATH_GRANTS),
  Object.keys(JOB_EVENTS_NEW_PATH_GRANTS),
  Object.keys(JOB_CONTROL_COMMANDS_NEW_PATH_GRANTS),
  Object.keys(FOLDER_GRANTS_NEW_PATH_GRANTS),
  Object.keys(WORKER_ADMISSION_RATE_LIMITS_NEW_PATH_GRANTS),
  Object.keys(LIVE_EVENT_LOG_NEW_PATH_GRANTS),
  Object.keys(SERVICE_GENERATIONS_NEW_PATH_GRANTS),
  Object.keys(KILL_SWITCH_POLICY_APP_GRANTS),
  Object.keys(CUTOVER_MARKER_APP_GRANTS),
  Object.keys(EXECUTION_TARGET_REVOCATION_APP_GRANTS),
  Object.keys(LEGACY_RESOURCE_RECONCILIATION_APP_GRANTS),
  ["mcp_api_keys", "execution_targets"],
);

/** The operator serving inventory is derived once from every table and column grant source. */
export const OPERATOR_SERVING_RELATIONS = sortedUnion(
  Object.keys(WORKER_ENROLLMENT_OPERATOR_GRANTS),
  Object.keys(OPERATOR_METADATA_COLUMN_GRANTS),
  Object.keys(CUTOVER_MARKER_OPERATOR_GRANTS),
  Object.keys(EXECUTION_TARGET_REVOCATION_OPERATOR_GRANTS),
  Object.keys(LEGACY_RESOURCE_RECONCILIATION_OPERATOR_GRANTS),
  Object.keys(LEGACY_RECONCILIATION_PASS_OPERATOR_GRANTS),
  ["execution_targets"],
);

export const RLS_RELATIONS = Object.freeze([
  "jobs", "job_attempts", "leases", "workers", "services", "service_instances",
  "job_artifacts", "job_secret_handles", "job_outbox", "worker_enrollment_code_routes",
  "worker_enrollment_codes", "worker_proof_replays", "execution_targets",
  "worker_operation_receipts", "worker_lease_rejections", "distributed_cutover_markers",
  "job_events", "job_projection_receipts", "job_control_commands",
  "execution_target_revocations",
  // DAT-006 (TEN-006 per-table RLS): the new local-folder-grant admission table.
  "folder_grants",
  // DEP-009: the shared worker-admission rate-limit counter table (migration 0255).
  "worker_admission_rate_limits",
  // MIG-008: the append-only legacy-lease/resource reconciliation crosswalk (migration 0256).
  "legacy_resource_reconciliation",
  // MIG-003: the durable realtime event log + per-company sequence counter (migration 0257).
  "live_event_log",
  "live_event_sequences",
  // SVC-001: the immutable service-definition table (migration 0264). FORCE RLS like
  // every other tenant relation; its aoa_app grant is SELECT + INSERT only, which is
  // what makes generations immutable.
  "service_generations",
  // MIG-010 Unit 2.4: the reconciliation-pass marker (migration 0269). Operator-only —
  // it carries ONE policy, not the two every other operator-metadata table carries,
  // because there is no aoa_app read to authorize.
  "legacy_reconciliation_passes",
] as const);

export const FORCE_RLS_RELATIONS = Object.freeze(
  RLS_RELATIONS.filter((relation) => relation !== "execution_targets"),
);

export const NON_FORCE_RLS_RELATIONS = Object.freeze(["execution_targets"] as const);

export const POLICY_COUNTS = deepFreeze({
  jobs: 1,
  job_attempts: 1,
  leases: 1,
  workers: 2,
  services: 1,
  service_instances: 1,
  job_artifacts: 1,
  job_secret_handles: 1,
  job_outbox: 1,
  worker_enrollment_code_routes: 3,
  worker_enrollment_codes: 2,
  worker_proof_replays: 2,
  execution_targets: 3,
  worker_operation_receipts: 1,
  worker_lease_rejections: 1,
  distributed_cutover_markers: 2,
  job_events: 1,
  job_projection_receipts: 1,
  job_control_commands: 1,
  execution_target_revocations: 2,
  // DAT-006: one aoa_app org-scoped tenant-isolation policy (migration 0253).
  folder_grants: 1,
  // DEP-009: one aoa_app org-scoped tenant-isolation policy (migration 0255).
  worker_admission_rate_limits: 1,
  // MIG-008: operator-write + app-read (mirrors distributed_cutover_markers, migration 0256).
  legacy_resource_reconciliation: 2,
  // MIG-003: one aoa_app org-scoped tenant-isolation policy per table (migration 0257).
  live_event_log: 1,
  live_event_sequences: 1,
  // ORDER MATTERS HERE, not just membership. `assertExactCatalogCertificate` compares
  // `Object.fromEntries(RLS_RELATIONS.map(...))` against this object with JSON.stringify
  // equality, so these keys must appear in RLS_RELATIONS' order. `service_generations` is
  // LAST in RLS_RELATIONS, so it must be last here. Placing it beside `services` — which reads
  // more naturally — produces an object with identical keys and identical values that still
  // fails startup with `catalog certificate drift: policy counts`, surfaced only as the opaque
  // `distributed_execution_app_authority`. SVC-001 shipped that and it cost three CI rounds.
  service_generations: 1,
  // MIG-010 Unit 2.4: operator-write ONLY (migration 0269). ONE policy, not the two the
  // other operator-metadata tables carry — aoa_app holds no grant on the marker, so there
  // is no app-read policy to pair with it. Placed LAST because `legacy_reconciliation_passes`
  // is last in RLS_RELATIONS; see the ORDER MATTERS note above.
  legacy_reconciliation_passes: 1,
} as const);

const ORGANIZATION_QUAL =
  "(organization_id = (current_setting('aoa.organization_id'::text, true))::uuid)";
const CANDIDATE_ORGANIZATION_QUAL =
  "(candidate_organization_id = (current_setting('aoa.organization_id'::text, true))::uuid)";
const NULL_ORGANIZATION_QUAL = "(organization_id IS NULL)";
const NULL_CANDIDATE_ORGANIZATION_QUAL = "(candidate_organization_id IS NULL)";
const PLATFORM_WORKER_QUAL = "((organization_id IS NULL) AND (scope = 'platform'::text))";
const TENANT_TARGET_QUAL =
  "((organization_id IS NULL) OR (organization_id = (current_setting('aoa.organization_id'::text, true))::uuid))";
const PLATFORM_TARGET_QUAL = "((organization_id IS NULL) AND (owner_user_id IS NULL))";
// 0233 app-read: aoa_app sees the marker ONLY when no tenant GUC is set (control plane
// outside a tenant transaction). PostgreSQL normalizes current_setting(...) with ::text.
const CUTOVER_APP_READ_QUAL = "(current_setting('aoa.organization_id'::text, true) IS NULL)";

function policy(
  relation: string,
  name: string,
  command: string,
  role: string,
  qual: string,
  check: string | null,
) {
  return { relation, name, command, role, permissive: true, qual, check } as const;
}

export const RLS_POLICY_MANIFEST = deepFreeze([
  policy("jobs", "jobs_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("job_attempts", "job_attempts_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("leases", "leases_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("workers", "workers_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("services", "services_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("service_instances", "service_instances_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("service_generations", "service_generations_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("job_artifacts", "job_artifacts_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("job_secret_handles", "job_secret_handles_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("job_outbox", "job_outbox_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("worker_enrollment_code_routes", "worker_enrollment_code_routes_tenant_isolation", "ALL", "aoa_app", CANDIDATE_ORGANIZATION_QUAL, CANDIDATE_ORGANIZATION_QUAL),
  policy("worker_enrollment_code_routes", "worker_enrollment_code_routes_platform_operator", "ALL", "aoa_operator", NULL_CANDIDATE_ORGANIZATION_QUAL, NULL_CANDIDATE_ORGANIZATION_QUAL),
  policy("worker_enrollment_code_routes", "worker_enrollment_code_routes_operator_discovery", "SELECT", "aoa_operator", "true", null),
  policy("worker_enrollment_codes", "worker_enrollment_codes_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("worker_enrollment_codes", "worker_enrollment_codes_platform_operator", "ALL", "aoa_operator", NULL_ORGANIZATION_QUAL, NULL_ORGANIZATION_QUAL),
  policy("worker_proof_replays", "worker_proof_replays_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("worker_proof_replays", "worker_proof_replays_platform_operator", "ALL", "aoa_operator", NULL_ORGANIZATION_QUAL, NULL_ORGANIZATION_QUAL),
  policy("workers", "workers_platform_operator", "ALL", "aoa_operator", PLATFORM_WORKER_QUAL, PLATFORM_WORKER_QUAL),
  policy("execution_targets", "execution_targets_tenant_serving", "SELECT", "aoa_app", TENANT_TARGET_QUAL, null),
  policy("execution_targets", "execution_targets_platform_operator", "ALL", "aoa_operator", PLATFORM_TARGET_QUAL, PLATFORM_TARGET_QUAL),
  policy("execution_targets", "execution_targets_tenant_enrollment_update", "UPDATE", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("worker_operation_receipts", "worker_operation_receipts_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("worker_lease_rejections", "worker_lease_rejections_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  // DEP-003 0188 cutover marker (migration 0233): operator writes (USING/CHECK true),
  // app reads only outside a tenant transaction (aoa.organization_id GUC unset).
  policy("distributed_cutover_markers", "distributed_cutover_markers_operator_write", "ALL", "aoa_operator", "true", "true"),
  policy("distributed_cutover_markers", "distributed_cutover_markers_app_read", "SELECT", "aoa_app", CUTOVER_APP_READ_QUAL, null),
  policy("job_events", "job_events_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("job_projection_receipts", "job_projection_receipts_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("job_control_commands", "job_control_commands_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  // JOB-007 target-revocation fanout record (migration 0239): operator writes
  // (USING/CHECK true), app reads only outside a tenant transaction (aoa.organization_id
  // GUC unset). Same operator-metadata shape as the 0188 cutover marker above.
  policy("execution_target_revocations", "execution_target_revocations_operator_write", "ALL", "aoa_operator", "true", "true"),
  policy("execution_target_revocations", "execution_target_revocations_app_read", "SELECT", "aoa_app", CUTOVER_APP_READ_QUAL, null),
  // DAT-006 folder-grant admission (migration 0253): aoa_app-only org-scoped tenant
  // isolation, FORCE RLS, no operator authority. Same shape as job_control_commands.
  policy("folder_grants", "folder_grants_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  // DEP-009 worker-admission rate-limit (migration 0255): aoa_app-only org-scoped tenant
  // isolation, FORCE RLS, no operator authority. Same shape as folder_grants.
  policy("worker_admission_rate_limits", "worker_admission_rate_limits_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  // MIG-008 legacy-lease/resource reconciliation crosswalk (migration 0256): operator
  // writes (USING/CHECK true), app reads only outside a tenant transaction
  // (aoa.organization_id GUC unset). Same operator-metadata shape as the 0188 cutover marker.
  policy("legacy_resource_reconciliation", "legacy_resource_reconciliation_operator_write", "ALL", "aoa_operator", "true", "true"),
  policy("legacy_resource_reconciliation", "legacy_resource_reconciliation_app_read", "SELECT", "aoa_app", CUTOVER_APP_READ_QUAL, null),
  // MIG-003 durable realtime event log (migration 0257): aoa_app-only org-scoped tenant
  // isolation, FORCE RLS, no operator authority. Same shape as job_events / folder_grants.
  policy("live_event_log", "live_event_log_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  policy("live_event_sequences", "live_event_sequences_tenant_isolation", "ALL", "aoa_app", ORGANIZATION_QUAL, ORGANIZATION_QUAL),
  // MIG-010 Unit 2.4 reconciliation-pass marker (migration 0269): operator writes
  // (USING/CHECK true). Deliberately NO app-read policy — aoa_app holds no grant on this
  // table at all, so unlike the 0233/0239/0256 operator-metadata tables there is nothing
  // for a second policy to authorize.
  policy("legacy_reconciliation_passes", "legacy_reconciliation_passes_operator_write", "ALL", "aoa_operator", "true", "true"),
] as const);

/*
 * Hand-transcribed from the accepted bounded-grant plan. It is intentionally
 * independent of the mutable production grant constants above: a grant change
 * must update this certificate explicitly and survive review.
 */
const PLAN_DERIVED_ACL_MATRIX = deepFreeze({
  relations: {
    activity_log: { aoa_app: ["SELECT", "INSERT"], aoa_operator: [] },
    agent_runtime_decisions: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    agent_runtime_trust_rules: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    agent_wakeup_requests: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    agents: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: [] },
    approvals: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    artifact_versions: { aoa_app: ["SELECT"], aoa_operator: [] },
    artifacts: { aoa_app: ["SELECT"], aoa_operator: [] },
    assets: { aoa_app: ["SELECT"], aoa_operator: [] },
    budget_incidents: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    budget_policies: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    companies: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: [] },
    company_memberships: { aoa_app: ["SELECT"], aoa_operator: [] },
    cost_events: { aoa_app: ["SELECT", "INSERT"], aoa_operator: [] },
    provider_credentials: { aoa_app: ["SELECT"], aoa_operator: [] },
    discussion_entries: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: [] },
    distributed_cutover_markers: { aoa_app: ["SELECT"], aoa_operator: ["SELECT", "INSERT", "UPDATE"] },
    execution_target_revocations: { aoa_app: ["SELECT"], aoa_operator: ["SELECT", "INSERT", "UPDATE"] },
    execution_targets: { aoa_app: [], aoa_operator: [] },
    // REL-004 Lane C: read-only kill-switch policy lookup on the worker poll path
    // (migration 0261). No RLS — an instance singleton with no organization column.
    instance_settings: { aoa_app: ["SELECT"], aoa_operator: [] },
    execution_workspaces: { aoa_app: ["SELECT"], aoa_operator: [] },
    folder_grants: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    heartbeat_runs: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    hub_audit: { aoa_app: ["INSERT"], aoa_operator: [] },
    hub_counter_snapshots: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: [] },
    internal_agent_config: { aoa_app: ["SELECT"], aoa_operator: [] },
    internal_agent_conversations: { aoa_app: ["SELECT"], aoa_operator: [] },
    internal_agent_messages: { aoa_app: ["SELECT"], aoa_operator: [] },
    internal_agent_runs: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    internal_agent_runtime_approvals: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    internal_agent_tool_trust_rules: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    issue_comments: { aoa_app: ["INSERT"], aoa_operator: [] },
    issue_labels: { aoa_app: ["SELECT"], aoa_operator: [] },
    issues: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: [] },
    job_artifacts: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    job_attempts: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    job_control_commands: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    job_events: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    job_outbox: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    job_projection_receipts: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    job_secret_handles: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    jobs: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    labels: { aoa_app: ["SELECT"], aoa_operator: [] },
    leases: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    // MIG-010 Unit 2.4: aoa_app is EMPTY on purpose (nothing on that pool reads the marker);
    // aoa_operator holds SELECT + INSERT only, because markers are durable evidence.
    legacy_reconciliation_passes: { aoa_app: [], aoa_operator: ["SELECT", "INSERT"] },
    legacy_resource_reconciliation: { aoa_app: ["SELECT"], aoa_operator: ["SELECT", "INSERT", "UPDATE"] },
    live_event_log: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    live_event_sequences: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    mcp_api_keys: { aoa_app: [], aoa_operator: [] },
    notification_digest_items: { aoa_app: ["SELECT", "INSERT"], aoa_operator: [] },
    notification_preferences: { aoa_app: ["SELECT"], aoa_operator: [] },
    notifications: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    organization_memberships: { aoa_app: ["SELECT"], aoa_operator: [] },
    organizations: { aoa_app: ["SELECT"], aoa_operator: [] },
    projects: { aoa_app: ["SELECT"], aoa_operator: [] },
    service_instances: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    // SVC-001: SELECT + INSERT ONLY. The absence of UPDATE and DELETE is not an
    // oversight - it IS how clause (a)'s immutability is enforced, since this repo has
    // zero triggers/rules to fall back on. Do not widen without a successor decision.
    service_generations: { aoa_app: ["SELECT", "INSERT"], aoa_operator: [] },
    services: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    task_dependencies: { aoa_app: ["SELECT"], aoa_operator: [] },
    task_outputs: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    thread_orchestration_state: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: [] },
    user_roles: { aoa_app: ["SELECT"], aoa_operator: [] },
    worker_admission_rate_limits: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    worker_enrollment_code_routes: { aoa_app: ["SELECT", "INSERT", "DELETE"], aoa_operator: ["SELECT", "INSERT", "DELETE"] },
    worker_enrollment_codes: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
    worker_lease_rejections: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    worker_operation_receipts: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    worker_proof_replays: { aoa_app: ["SELECT", "INSERT", "DELETE"], aoa_operator: ["SELECT", "INSERT", "DELETE"] },
    workers: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
    workspace_runtime_services: { aoa_app: ["SELECT"], aoa_operator: [] },
  },
  columns: {
    mcp_api_keys: {
      id: { aoa_app: ["SELECT"], aoa_operator: [] },
      company_id: { aoa_app: ["SELECT"], aoa_operator: [] },
      user_id: { aoa_app: ["SELECT"], aoa_operator: [] },
      revoked_at: { aoa_app: ["SELECT"], aoa_operator: [] },
    },
    workers: {
      id: { aoa_app: [], aoa_operator: ["SELECT"] },
      scope: { aoa_app: [], aoa_operator: ["SELECT"] },
      organization_id: { aoa_app: [], aoa_operator: ["SELECT"] },
      label: { aoa_app: [], aoa_operator: ["SELECT"] },
      status: { aoa_app: [], aoa_operator: ["SELECT"] },
      created_at: { aoa_app: [], aoa_operator: ["SELECT"] },
      updated_at: { aoa_app: [], aoa_operator: ["SELECT"] },
    },
    execution_targets: {
      id: { aoa_app: ["SELECT"], aoa_operator: ["SELECT"] },
      organization_id: { aoa_app: ["SELECT"], aoa_operator: ["SELECT"] },
      owner_user_id: { aoa_app: ["SELECT"], aoa_operator: ["SELECT"] },
      slug: { aoa_app: ["SELECT"], aoa_operator: ["SELECT"] },
      kind: { aoa_app: ["SELECT"], aoa_operator: ["SELECT"] },
      trust_class: { aoa_app: ["SELECT"], aoa_operator: ["SELECT"] },
      status: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: ["SELECT", "UPDATE"] },
      capabilities: { aoa_app: ["SELECT"], aoa_operator: ["SELECT"] },
      scope: { aoa_app: ["SELECT"], aoa_operator: ["SELECT"] },
      target_authority_key: { aoa_app: ["SELECT"], aoa_operator: ["SELECT"] },
      device_generation: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: ["SELECT", "UPDATE"] },
      worker_token_hash: { aoa_app: ["UPDATE"], aoa_operator: ["UPDATE"] },
      config: { aoa_app: ["SELECT"], aoa_operator: [] },
      last_seen_at: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: ["SELECT", "UPDATE"] },
      created_at: { aoa_app: [], aoa_operator: ["SELECT"] },
      updated_at: { aoa_app: ["UPDATE"], aoa_operator: ["SELECT", "UPDATE"] },
      registered_profile: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: ["SELECT", "UPDATE"] },
      registered_profile_hash: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: ["SELECT", "UPDATE"] },
      provider_constraint_profile: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: ["SELECT", "UPDATE"] },
    },
  },
} as const satisfies {
  relations: Readonly<Record<string, ServingRolePrivileges>>;
  columns: Readonly<Record<string, Readonly<Record<string, ServingRolePrivileges>>>>;
});

function aclTupleKey(tuple: AclTupleManifest): string {
  return [tuple.grantor, tuple.grantee, tuple.privilegeType, String(tuple.isGrantable)].join(":");
}

function sortedAclTuples(tuples: readonly AclTupleManifest[]): AclTupleManifest[] {
  return [...tuples].sort((left, right) => aclTupleKey(left).localeCompare(aclTupleKey(right)));
}

const OWNER_TABLE_PRIVILEGES = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN",
] as const;
const ALL_SERVING_RELATIONS = sortedUnion(APP_SERVING_RELATIONS, OPERATOR_SERVING_RELATIONS);

/*
 * PostgreSQL records relacl nullness independently from effective privileges.
 * This is an explicit PostgreSQL 18 catalog certificate: table-granted relations
 * and both column-only relations have materialized owner ACLs.
 */
const RELATION_ACL_NULLNESS_CERTIFICATE = deepFreeze({
  activity_log: false,
  agent_runtime_decisions: false,
  agent_runtime_trust_rules: false,
  agent_wakeup_requests: false,
  agents: false,
  approvals: false,
  artifact_versions: false,
  artifacts: false,
  assets: false,
  budget_incidents: false,
  budget_policies: false,
  companies: false,
  company_memberships: false,
  cost_events: false,
  provider_credentials: false,
  discussion_entries: false,
  distributed_cutover_markers: false,
  execution_target_revocations: false,
  execution_targets: false,
  execution_workspaces: false,
  instance_settings: false,
  folder_grants: false,
  heartbeat_runs: false,
  hub_audit: false,
  hub_counter_snapshots: false,
  internal_agent_config: false,
  internal_agent_conversations: false,
  internal_agent_messages: false,
  internal_agent_runs: false,
  internal_agent_runtime_approvals: false,
  internal_agent_tool_trust_rules: false,
  issue_comments: false,
  issue_labels: false,
  issues: false,
  job_artifacts: false,
  job_attempts: false,
  job_control_commands: false,
  job_events: false,
  job_outbox: false,
  job_projection_receipts: false,
  job_secret_handles: false,
  jobs: false,
  labels: false,
  leases: false,
  legacy_reconciliation_passes: false,
  legacy_resource_reconciliation: false,
  live_event_log: false,
  live_event_sequences: false,
  mcp_api_keys: false,
  notification_digest_items: false,
  notification_preferences: false,
  notifications: false,
  organization_memberships: false,
  organizations: false,
  projects: false,
  service_instances: false,
  service_generations: false,
  services: false,
  task_dependencies: false,
  task_outputs: false,
  thread_orchestration_state: false,
  user_roles: false,
  worker_admission_rate_limits: false,
  worker_enrollment_code_routes: false,
  worker_enrollment_codes: false,
  worker_lease_rejections: false,
  worker_operation_receipts: false,
  worker_proof_replays: false,
  workers: false,
  workspace_runtime_services: false,
} as const satisfies Readonly<Record<keyof typeof PLAN_DERIVED_ACL_MATRIX.relations, boolean>>);

export const RELATION_ACL_MANIFEST: Readonly<Record<string, AclManifestEntry>> = deepFreeze(
  Object.fromEntries(ALL_SERVING_RELATIONS.map((relation) => {
    const privileges = (PLAN_DERIVED_ACL_MATRIX.relations as
      Readonly<Record<string, ServingRolePrivileges>>)[relation];
    if (!privileges) throw new Error(`Missing plan-derived relation ACL certificate for ${relation}`);
    const aclIsNull = RELATION_ACL_NULLNESS_CERTIFICATE[
      relation as keyof typeof RELATION_ACL_NULLNESS_CERTIFICATE
    ];
    if (aclIsNull === undefined) {
      throw new Error(`Missing PostgreSQL 18 relacl nullness certificate for ${relation}`);
    }
    const tuples = aclIsNull ? [] : sortedAclTuples([
      ...OWNER_TABLE_PRIVILEGES.map((privilegeType) => ({
        grantor: "RELATION_OWNER" as const,
        grantee: "RELATION_OWNER" as const,
        privilegeType,
        isGrantable: false,
      })),
      ...privileges.aoa_app.map((privilegeType) => ({
        grantor: "RELATION_OWNER" as const,
        grantee: "aoa_app" as const,
        privilegeType,
        isGrantable: false,
      })),
      ...privileges.aoa_operator.map((privilegeType) => ({
        grantor: "RELATION_OWNER" as const,
        grantee: "aoa_operator" as const,
        privilegeType,
        isGrantable: false,
      })),
    ]);
    return [relation, { aclIsNull, tuples }];
  })),
);

const schemaColumnsByRelation = new Map<string, string[]>();
for (const candidate of Object.values(dbSchema)) {
  try {
    const table = candidate as Table;
    schemaColumnsByRelation.set(
      getTableName(table),
      Object.values(getTableColumns(table)).map((column) => column.name).sort(),
    );
  } catch {
    // The db barrel also exports helpers and constants; only Drizzle tables participate.
  }
}

export const COLUMN_ACL_MANIFEST: Readonly<
  Record<string, Readonly<Record<string, AclManifestEntry>>>
> = deepFreeze(Object.fromEntries(ALL_SERVING_RELATIONS.map((relation) => {
  const columns = schemaColumnsByRelation.get(relation);
  if (!columns) throw new Error(`Missing checked-in Drizzle table for serving relation ${relation}`);
  const explicitColumns = (PLAN_DERIVED_ACL_MATRIX.columns as Readonly<Record<
    string,
    Readonly<Record<string, ServingRolePrivileges>>
  >>)[relation] ?? {};
  return [relation, Object.fromEntries(columns.map((column) => {
    const privileges = explicitColumns[column];
    const tuples = privileges ? sortedAclTuples([
      ...privileges.aoa_app.map((privilegeType) => ({
        grantor: "RELATION_OWNER" as const,
        grantee: "aoa_app" as const,
        privilegeType,
        isGrantable: false,
      })),
      ...privileges.aoa_operator.map((privilegeType) => ({
        grantor: "RELATION_OWNER" as const,
        grantee: "aoa_operator" as const,
        privilegeType,
        isGrantable: false,
      })),
    ]) : [];
    return [column, { aclIsNull: tuples.length === 0, tuples }];
  }))];
})),
);
