import { describe, expect, it } from "vitest";
import {
  APP_MCP_API_KEY_COLUMN_GRANTS,
  JOB_CONTROL_LEGACY_GRANTS,
  JOB_CONTROL_NEW_PATH_GRANTS,
  JOB_LEASING_NEW_PATH_GRANTS,
} from "../db/job-control-legacy-grants.js";
import * as grants from "../db/job-control-legacy-grants.js";
import {
  appTablePrivileges,
  operatorTablePrivileges,
} from "../db/distributed-execution-databases.js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableColumns, getTableName, type Table } from "drizzle-orm";
import * as dbSchema from "../../../packages/db/src/schema/index.js";

type PlanGrantedPrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";
type PlanRolePrivileges = Readonly<Record<
  "aoa_app" | "aoa_operator",
  readonly PlanGrantedPrivilege[]
>>;

function deepFreezeFixture<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreezeFixture(nested);
    }
    Object.freeze(value);
  }
  return value;
}

// Hand-transcribed from the accepted bounded-grant and column-projection plan. This fixture is
// intentionally independent of the production grant constants so changing a production
// privilege cannot silently rewrite both the implementation and the expected ACL certificate.
const PLAN_DERIVED_ACL_MATRIX = deepFreezeFixture({
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
    // DSK-001 Lane B (D12/3): the fenced secret-resolve tx must read
    // provider_credentials.state to admit ONLY a verified credential. Read-only, and
    // the table holds no secret value -- "logical credential ownership only".
    provider_credentials: { aoa_app: ["SELECT"], aoa_operator: [] },
    discussion_entries: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: [] },
    distributed_cutover_markers: { aoa_app: ["SELECT"], aoa_operator: ["SELECT", "INSERT", "UPDATE"] },
    execution_target_revocations: { aoa_app: ["SELECT"], aoa_operator: ["SELECT", "INSERT", "UPDATE"] },
    execution_targets: { aoa_app: [], aoa_operator: [] },
    // REL-004 Lane C: the worker poll reads instance_settings.kill_switches on the aoa_app
    // pool before opening the lease transaction. Read-only; the table holds no secret.
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
    // MIG-010 Unit 2.4: aoa_app is EMPTY on purpose — nothing on that pool reads the marker.
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
    // SVC-001: SELECT + INSERT only. The omitted UPDATE/DELETE IS the immutability
    // mechanism for service generations - widening this silently destroys clause (a).
    service_generations: { aoa_app: ["SELECT", "INSERT"], aoa_operator: [] },
    services: { aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"], aoa_operator: [] },
    task_dependencies: { aoa_app: ["SELECT"], aoa_operator: [] },
    task_outputs: { aoa_app: ["SELECT", "INSERT", "UPDATE"], aoa_operator: [] },
    thread_orchestration_state: { aoa_app: ["SELECT", "UPDATE"], aoa_operator: [] },
    user_roles: { aoa_app: ["SELECT"], aoa_operator: [] },
    worker_admission_rate_limits: {
      aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      aoa_operator: [],
    },
    worker_enrollment_code_routes: {
      aoa_app: ["SELECT", "INSERT", "DELETE"],
      aoa_operator: ["SELECT", "INSERT", "DELETE"],
    },
    worker_enrollment_codes: {
      aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      aoa_operator: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    },
    worker_lease_rejections: {
      aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      aoa_operator: [],
    },
    worker_operation_receipts: {
      aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      aoa_operator: [],
    },
    worker_proof_replays: {
      aoa_app: ["SELECT", "INSERT", "DELETE"],
      aoa_operator: ["SELECT", "INSERT", "DELETE"],
    },
    workers: {
      aoa_app: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      aoa_operator: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    },
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
      provider_constraint_profile: {
        aoa_app: ["SELECT", "UPDATE"],
        aoa_operator: ["SELECT", "UPDATE"],
      },
    },
  },
} as const satisfies {
  relations: Readonly<Record<string, PlanRolePrivileges>>;
  columns: Readonly<Record<string, Readonly<Record<string, PlanRolePrivileges>>>>;
});

// PostgreSQL stores relacl nullness independently from effective privileges. Keep one literal
// entry for every serving relation so column-only authority cannot make an owner ACL disappear
// from this oracle, and a newly materialized ACL cannot be inferred away by the grant matrix.
const PLAN_DERIVED_RELATION_ACL_NULLNESS = deepFreezeFixture({
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

describe("JOB-001 bounded aoa_app authority", () => {
  it("adds the outbox as a forced-RLS new-path table with exact DML", () => {
    const submissionNewPath = (grants as typeof grants & {
      JOB_SUBMISSION_NEW_PATH_GRANTS?: Record<string, readonly string[]>;
    }).JOB_SUBMISSION_NEW_PATH_GRANTS;
    expect(JOB_CONTROL_NEW_PATH_GRANTS).not.toHaveProperty("job_outbox");
    expect(submissionNewPath).toHaveProperty("job_outbox", [
      "SELECT", "INSERT", "UPDATE", "DELETE",
    ]);
    const migration = readFileSync(
      fileURLToPath(new URL("../../../packages/db/src/migrations/0218_job_control_submission_rls.sql", import.meta.url)),
      "utf8",
    );
    expect(migration).toContain('ALTER TABLE "job_outbox" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY "job_outbox_tenant_isolation"');
  });

  it("admits the org/company/membership edge and source agent with read-only legacy grants", () => {
    const submissionLegacy = (grants as typeof grants & {
      JOB_SUBMISSION_LEGACY_GRANTS?: Record<string, readonly string[]>;
    }).JOB_SUBMISSION_LEGACY_GRANTS;
    expect(JOB_CONTROL_LEGACY_GRANTS).toMatchObject({
      organizations: ["SELECT"],
      companies: expect.arrayContaining(["SELECT"]),
      company_memberships: ["SELECT"],
      agents: expect.arrayContaining(["SELECT"]),
      heartbeat_runs: expect.arrayContaining(["SELECT"]),
      issues: expect.arrayContaining(["SELECT"]),
    });
    expect(JOB_CONTROL_LEGACY_GRANTS).not.toHaveProperty("organization_memberships");
    expect(submissionLegacy).toHaveProperty("organization_memberships", ["SELECT"]);
    expect(submissionLegacy?.organization_memberships).not.toEqual(
      expect.arrayContaining(["INSERT", "UPDATE", "DELETE"]),
    );
    expect(JOB_CONTROL_LEGACY_GRANTS).not.toHaveProperty("mcp_api_keys");
    expect(APP_MCP_API_KEY_COLUMN_GRANTS).toEqual(["id", "company_id", "user_id", "revoked_at"]);
  });

  it("does not grant worker contact or target placement authority", () => {
    expect(JOB_CONTROL_LEGACY_GRANTS).not.toHaveProperty("execution_targets");
    expect(JOB_CONTROL_LEGACY_GRANTS).not.toHaveProperty("worker_sessions");
    expect(JOB_CONTROL_LEGACY_GRANTS).not.toHaveProperty("worker_enrollment_codes");
  });
});

describe("JOB-003 bounded aoa_app authority", () => {
  it("keeps receipt and rejection-certificate DML in the exact versioned leasing grant delta", () => {
    expect(JOB_CONTROL_NEW_PATH_GRANTS).not.toHaveProperty("worker_operation_receipts");
    expect(JOB_LEASING_NEW_PATH_GRANTS).toEqual({
      worker_operation_receipts: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      worker_lease_rejections: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    });

    const migration = readFileSync(
      fileURLToPath(new URL("../../../packages/db/src/migrations/0228_job_leasing_rls.sql", import.meta.url)),
      "utf8",
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "worker_operation_receipts" TO "aoa_app"',
    );
    expect(migration).toContain('ALTER TABLE "worker_operation_receipts" FORCE ROW LEVEL SECURITY');

    const migrationDirectory = fileURLToPath(
      new URL("../../../packages/db/src/migrations/", import.meta.url),
    );
    const rlsSuccessors = readdirSync(migrationDirectory).filter((name) => /^0231_.*\.sql$/.test(name));
    expect.soft(rlsSuccessors).toHaveLength(1);
    if (rlsSuccessors.length !== 1) return;
    const certificateMigration = readFileSync(`${migrationDirectory}/${rlsSuccessors[0]}`, "utf8");
    expect(certificateMigration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "worker_lease_rejections" TO "aoa_app"',
    );
    expect(certificateMigration).toMatch(
      /REVOKE ALL ON(?: TABLE)? "worker_lease_rejections" FROM "aoa_operator"/,
    );
    expect(certificateMigration).toContain(
      'ALTER TABLE "worker_lease_rejections" FORCE ROW LEVEL SECURITY',
    );
  });

  it("derives one immutable serving-relation inventory from every table and column grant", () => {
    // Mutation caught: a hand-maintained startup list can omit a column-only relation or retain
    // a removed grant while the authority constants continue to look correct in isolation.
    const manifest = grants as typeof grants & {
      APP_SERVING_RELATIONS?: readonly string[];
      OPERATOR_SERVING_RELATIONS?: readonly string[];
    };
    const appExpected = [...new Set([
      ...Object.keys(grants.JOB_CONTROL_LEGACY_GRANTS),
      ...Object.keys(grants.JOB_CONTROL_NEW_PATH_GRANTS),
      ...Object.keys(grants.JOB_SUBMISSION_LEGACY_GRANTS),
      ...Object.keys(grants.JOB_SUBMISSION_NEW_PATH_GRANTS),
      ...Object.keys(grants.WORKER_ENROLLMENT_APP_GRANTS),
      ...Object.keys(grants.JOB_LEASING_NEW_PATH_GRANTS),
      ...Object.keys(grants.JOB_EVENTS_NEW_PATH_GRANTS),
      ...Object.keys(grants.JOB_CONTROL_COMMANDS_NEW_PATH_GRANTS),
      ...Object.keys(grants.FOLDER_GRANTS_NEW_PATH_GRANTS),
      ...Object.keys(grants.WORKER_ADMISSION_RATE_LIMITS_NEW_PATH_GRANTS),
      ...Object.keys(grants.LIVE_EVENT_LOG_NEW_PATH_GRANTS),
      ...Object.keys(grants.SERVICE_GENERATIONS_NEW_PATH_GRANTS),
      ...Object.keys(grants.KILL_SWITCH_POLICY_APP_GRANTS),
      ...Object.keys(grants.CUTOVER_MARKER_APP_GRANTS),
      ...Object.keys(grants.EXECUTION_TARGET_REVOCATION_APP_GRANTS),
      ...Object.keys(grants.LEGACY_RESOURCE_RECONCILIATION_APP_GRANTS),
      "mcp_api_keys",
      "execution_targets",
    ])].sort();
    const operatorExpected = [...new Set([
      ...Object.keys(grants.WORKER_ENROLLMENT_OPERATOR_GRANTS),
      ...Object.keys(grants.OPERATOR_METADATA_COLUMN_GRANTS),
      ...Object.keys(grants.CUTOVER_MARKER_OPERATOR_GRANTS),
      ...Object.keys(grants.EXECUTION_TARGET_REVOCATION_OPERATOR_GRANTS),
      ...Object.keys(grants.LEGACY_RESOURCE_RECONCILIATION_OPERATOR_GRANTS),
      // MIG-010 Unit 2.4: the reconciliation-pass marker. Operator-only — there is
      // deliberately no matching *_APP_GRANTS constant to add to appExpected above.
      ...Object.keys(grants.LEGACY_RECONCILIATION_PASS_OPERATOR_GRANTS),
      "execution_targets",
    ])].sort();
    expect(manifest.APP_SERVING_RELATIONS).toEqual(appExpected);
    expect(manifest.OPERATOR_SERVING_RELATIONS).toEqual(operatorExpected);
    expect(Object.isFrozen(manifest.APP_SERVING_RELATIONS)).toBe(true);
    expect(Object.isFrozen(manifest.OPERATOR_SERVING_RELATIONS)).toBe(true);
  });

  it("pins the exact 27-table RLS, 26-table FORCE, and 37-row permissive policy certificate", () => {
    const manifest = grants as typeof grants & {
      RLS_RELATIONS?: readonly string[];
      FORCE_RLS_RELATIONS?: readonly string[];
      NON_FORCE_RLS_RELATIONS?: readonly string[];
      POLICY_COUNTS?: Readonly<Record<string, number>>;
      RLS_POLICY_MANIFEST?: readonly Array<{
        relation: string;
        name: string;
        command: string;
        role: string;
        permissive: boolean;
        qual: string | null;
        check: string | null;
      }>;
    };
    const rls = [
      "jobs", "job_attempts", "leases", "workers", "services", "service_instances",
      "job_artifacts", "job_secret_handles", "job_outbox", "worker_enrollment_code_routes",
      "worker_enrollment_codes", "worker_proof_replays", "execution_targets",
      "worker_operation_receipts", "worker_lease_rejections", "distributed_cutover_markers",
      "job_events", "job_projection_receipts", "job_control_commands",
      "execution_target_revocations", "folder_grants", "worker_admission_rate_limits",
      "legacy_resource_reconciliation", "live_event_log", "live_event_sequences",
      "service_generations",
      "legacy_reconciliation_passes",
    ];
    const counts = {
      jobs: 1, job_attempts: 1, leases: 1, workers: 2, services: 1,
      service_instances: 1, job_artifacts: 1, job_secret_handles: 1, job_outbox: 1,
      worker_enrollment_code_routes: 3, worker_enrollment_codes: 2,
      worker_proof_replays: 2, execution_targets: 3, worker_operation_receipts: 1,
      worker_lease_rejections: 1, distributed_cutover_markers: 2,
      job_events: 1, job_projection_receipts: 1, job_control_commands: 1,
      execution_target_revocations: 2, folder_grants: 1,
      worker_admission_rate_limits: 1,
      legacy_resource_reconciliation: 2,
      live_event_log: 1,
      live_event_sequences: 1,
      service_generations: 1,
      // MIG-010 Unit 2.4: ONE policy, not two. aoa_app holds no grant on the marker, so
      // there is no app-read policy to pair with the operator write.
      legacy_reconciliation_passes: 1,
    };
    const ORG = "(organization_id = (current_setting('aoa.organization_id'::text, true))::uuid)";
    const CANDIDATE_ORG = "(candidate_organization_id = (current_setting('aoa.organization_id'::text, true))::uuid)";
    const NULL_ORG = "(organization_id IS NULL)";
    const NULL_CANDIDATE_ORG = "(candidate_organization_id IS NULL)";
    const PLATFORM_WORKER = "((organization_id IS NULL) AND (scope = 'platform'::text))";
    const TENANT_TARGET = "((organization_id IS NULL) OR (organization_id = (current_setting('aoa.organization_id'::text, true))::uuid))";
    const PLATFORM_TARGET = "((organization_id IS NULL) AND (owner_user_id IS NULL))";
    const policy = (
      relation: string,
      name: string,
      command: string,
      role: string,
      qual: string,
      check: string | null,
    ) => ({ relation, name, command, role, permissive: true, qual, check });
    const policies = [
      policy("jobs", "jobs_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("job_attempts", "job_attempts_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("leases", "leases_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("workers", "workers_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("services", "services_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("service_instances", "service_instances_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("service_generations", "service_generations_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("job_artifacts", "job_artifacts_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("job_secret_handles", "job_secret_handles_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("job_outbox", "job_outbox_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("worker_enrollment_code_routes", "worker_enrollment_code_routes_tenant_isolation", "ALL", "aoa_app", CANDIDATE_ORG, CANDIDATE_ORG),
      policy("worker_enrollment_code_routes", "worker_enrollment_code_routes_platform_operator", "ALL", "aoa_operator", NULL_CANDIDATE_ORG, NULL_CANDIDATE_ORG),
      policy("worker_enrollment_code_routes", "worker_enrollment_code_routes_operator_discovery", "SELECT", "aoa_operator", "true", null),
      policy("worker_enrollment_codes", "worker_enrollment_codes_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("worker_enrollment_codes", "worker_enrollment_codes_platform_operator", "ALL", "aoa_operator", NULL_ORG, NULL_ORG),
      policy("worker_proof_replays", "worker_proof_replays_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("worker_proof_replays", "worker_proof_replays_platform_operator", "ALL", "aoa_operator", NULL_ORG, NULL_ORG),
      policy("workers", "workers_platform_operator", "ALL", "aoa_operator", PLATFORM_WORKER, PLATFORM_WORKER),
      policy("execution_targets", "execution_targets_tenant_serving", "SELECT", "aoa_app", TENANT_TARGET, null),
      policy("execution_targets", "execution_targets_platform_operator", "ALL", "aoa_operator", PLATFORM_TARGET, PLATFORM_TARGET),
      policy("execution_targets", "execution_targets_tenant_enrollment_update", "UPDATE", "aoa_app", ORG, ORG),
      policy("worker_operation_receipts", "worker_operation_receipts_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("worker_lease_rejections", "worker_lease_rejections_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("distributed_cutover_markers", "distributed_cutover_markers_operator_write", "ALL", "aoa_operator", "true", "true"),
      policy("distributed_cutover_markers", "distributed_cutover_markers_app_read", "SELECT", "aoa_app", "(current_setting('aoa.organization_id'::text, true) IS NULL)", null),
      policy("job_events", "job_events_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("job_projection_receipts", "job_projection_receipts_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("job_control_commands", "job_control_commands_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("execution_target_revocations", "execution_target_revocations_operator_write", "ALL", "aoa_operator", "true", "true"),
      policy("execution_target_revocations", "execution_target_revocations_app_read", "SELECT", "aoa_app", "(current_setting('aoa.organization_id'::text, true) IS NULL)", null),
      policy("folder_grants", "folder_grants_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("worker_admission_rate_limits", "worker_admission_rate_limits_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("legacy_resource_reconciliation", "legacy_resource_reconciliation_operator_write", "ALL", "aoa_operator", "true", "true"),
      policy("legacy_resource_reconciliation", "legacy_resource_reconciliation_app_read", "SELECT", "aoa_app", "(current_setting('aoa.organization_id'::text, true) IS NULL)", null),
      policy("live_event_log", "live_event_log_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("live_event_sequences", "live_event_sequences_tenant_isolation", "ALL", "aoa_app", ORG, ORG),
      policy("legacy_reconciliation_passes", "legacy_reconciliation_passes_operator_write", "ALL", "aoa_operator", "true", "true"),
    ];
    expect(manifest.RLS_RELATIONS).toEqual(rls);
    expect(manifest.FORCE_RLS_RELATIONS).toEqual(rls.filter((relation) => relation !== "execution_targets"));
    expect(manifest.NON_FORCE_RLS_RELATIONS).toEqual(["execution_targets"]);
    expect(manifest.POLICY_COUNTS).toEqual(counts);

    // ★ KEY ORDER IS LOAD-BEARING, and `toEqual` on an object CANNOT see it.
    //
    // The production check is `assertExactJson(actualPolicyCounts, POLICY_COUNTS, "policy counts")`
    // and `exactJson` is `JSON.stringify(a) === JSON.stringify(b)` — order-SENSITIVE on object
    // keys. `actualPolicyCounts` is built by mapping over RLS_RELATIONS, so its key order IS
    // RLS_RELATIONS' order. A POLICY_COUNTS whose keys carry the same names and the same values
    // in a DIFFERENT order therefore fails startup while every by-key comparison says it is
    // identical.
    //
    // SVC-001 shipped exactly that: `service_generations` last in RLS_RELATIONS, index 5 in
    // POLICY_COUNTS. It cost three CI rounds and eight clean diagnostics to find, because every
    // diagnostic compared counts BY KEY. The assertion above passed the whole time. This is the
    // assertion that would have caught it in seconds.
    expect(Object.keys(manifest.POLICY_COUNTS ?? {})).toEqual([...(manifest.RLS_RELATIONS ?? [])]);
    expect(manifest.RLS_POLICY_MANIFEST).toEqual(policies);
    expect(manifest.RLS_POLICY_MANIFEST?.reduce<Record<string, number>>((actual, row) => {
      actual[row.relation] = (actual[row.relation] ?? 0) + 1;
      return actual;
    }, {})).toEqual(counts);
    expect(Object.isFrozen(manifest.RLS_POLICY_MANIFEST)).toBe(true);
  });

  it("derives exact relation and column ACL tuple manifests for every serving relation", () => {
    // Mutation caught: deriving the oracle from the production grant constants lets an
    // accidental privilege expansion change both sides of the assertion and pass unnoticed.
    const expectDeepFrozenFixture = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const nested of Object.values(value as Record<string, unknown>)) {
        expectDeepFrozenFixture(nested);
      }
    };
    expectDeepFrozenFixture(PLAN_DERIVED_ACL_MATRIX);
    expectDeepFrozenFixture(PLAN_DERIVED_RELATION_ACL_NULLNESS);
    const manifest = grants as typeof grants & {
      APP_SERVING_RELATIONS?: readonly string[];
      OPERATOR_SERVING_RELATIONS?: readonly string[];
      RELATION_ACL_MANIFEST?: Readonly<Record<string, Readonly<{
        aclIsNull: boolean;
        tuples: readonly {
          grantor: "RELATION_OWNER";
          grantee: "RELATION_OWNER" | "PUBLIC" | "aoa_app" | "aoa_operator";
          privilegeType: string;
          isGrantable: boolean;
        }[];
      }>>>;
      COLUMN_ACL_MANIFEST?: Readonly<Record<string, Readonly<Record<string, Readonly<{
        aclIsNull: boolean;
        tuples: readonly {
          grantor: "RELATION_OWNER";
          grantee: "RELATION_OWNER" | "PUBLIC" | "aoa_app" | "aoa_operator";
          privilegeType: string;
          isGrantable: boolean;
        }[];
      }>>>>>;
    };
    const relations = [...new Set([
      ...Object.keys(grants.JOB_CONTROL_LEGACY_GRANTS),
      ...Object.keys(grants.JOB_CONTROL_NEW_PATH_GRANTS),
      ...Object.keys(grants.JOB_SUBMISSION_LEGACY_GRANTS),
      ...Object.keys(grants.JOB_SUBMISSION_NEW_PATH_GRANTS),
      ...Object.keys(grants.WORKER_ENROLLMENT_APP_GRANTS),
      ...Object.keys(grants.JOB_LEASING_NEW_PATH_GRANTS),
      ...Object.keys(grants.JOB_EVENTS_NEW_PATH_GRANTS),
      ...Object.keys(grants.JOB_CONTROL_COMMANDS_NEW_PATH_GRANTS),
      ...Object.keys(grants.FOLDER_GRANTS_NEW_PATH_GRANTS),
      ...Object.keys(grants.WORKER_ADMISSION_RATE_LIMITS_NEW_PATH_GRANTS),
      ...Object.keys(grants.LIVE_EVENT_LOG_NEW_PATH_GRANTS),
      ...Object.keys(grants.SERVICE_GENERATIONS_NEW_PATH_GRANTS),
      ...Object.keys(grants.KILL_SWITCH_POLICY_APP_GRANTS),
      ...Object.keys(grants.WORKER_ENROLLMENT_OPERATOR_GRANTS),
      ...Object.keys(grants.OPERATOR_METADATA_COLUMN_GRANTS),
      ...Object.keys(grants.CUTOVER_MARKER_APP_GRANTS),
      ...Object.keys(grants.EXECUTION_TARGET_REVOCATION_APP_GRANTS),
      ...Object.keys(grants.EXECUTION_TARGET_REVOCATION_OPERATOR_GRANTS),
      ...Object.keys(grants.LEGACY_RESOURCE_RECONCILIATION_APP_GRANTS),
      ...Object.keys(grants.LEGACY_RESOURCE_RECONCILIATION_OPERATOR_GRANTS),
      ...Object.keys(grants.LEGACY_RECONCILIATION_PASS_OPERATOR_GRANTS),
      "mcp_api_keys",
      "execution_targets",
    ])].sort();
    type ExpectedTuple = {
      grantor: "RELATION_OWNER";
      grantee: "RELATION_OWNER" | "aoa_app" | "aoa_operator";
      privilegeType: string;
      isGrantable: boolean;
    };
    const tupleKey = (tuple: ExpectedTuple) => [
      tuple.grantor, tuple.grantee, tuple.privilegeType, String(tuple.isGrantable),
    ].join(":");
    const sorted = (tuples: readonly ExpectedTuple[]) => [...tuples].sort((left, right) =>
      tupleKey(left).localeCompare(tupleKey(right)));
    const ownerTablePrivileges = [
      "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN",
    ] as const;
    const expectedRelations: Record<string, { aclIsNull: boolean; tuples: ExpectedTuple[] }> = {};
    expect(Object.keys(PLAN_DERIVED_ACL_MATRIX.relations).sort()).toEqual(relations);
    expect(Object.keys(PLAN_DERIVED_RELATION_ACL_NULLNESS).sort()).toEqual(relations);
    for (const relation of relations) {
      const planPrivileges = (PLAN_DERIVED_ACL_MATRIX.relations as
        Readonly<Record<string, PlanRolePrivileges>>)[relation];
      expect(planPrivileges, `${relation} must have one literal plan-derived ACL row`).toBeDefined();
      if (!planPrivileges) continue;
      const app = planPrivileges.aoa_app;
      const operator = planPrivileges.aoa_operator;
      const aclIsNull = PLAN_DERIVED_RELATION_ACL_NULLNESS[
        relation as keyof typeof PLAN_DERIVED_RELATION_ACL_NULLNESS
      ];
      expectedRelations[relation] = {
        aclIsNull,
        tuples: aclIsNull ? [] : sorted([
          ...ownerTablePrivileges.map((privilegeType) => ({
            grantor: "RELATION_OWNER" as const,
            grantee: "RELATION_OWNER" as const,
            privilegeType,
            isGrantable: false,
          })),
          ...app.map((privilegeType) => ({
            grantor: "RELATION_OWNER" as const,
            grantee: "aoa_app" as const,
            privilegeType,
            isGrantable: false,
          })),
          ...operator.map((privilegeType) => ({
            grantor: "RELATION_OWNER" as const,
            grantee: "aoa_operator" as const,
            privilegeType,
            isGrantable: false,
          })),
        ]),
      };
    }

    const columnsByRelation = new Map<string, string[]>();
    for (const candidate of Object.values(dbSchema)) {
      try {
        const table = candidate as Table;
        const name = getTableName(table);
        columnsByRelation.set(name, Object.values(getTableColumns(table)).map((column) => column.name).sort());
      } catch { /* schema export is not a table */ }
    }
    const explicitColumns = new Map<string, Map<string, ExpectedTuple[]>>();
    for (const [relation, columns] of Object.entries(PLAN_DERIVED_ACL_MATRIX.columns)) {
      expect(relations, `${relation} column ACL fixture must name a serving relation`).toContain(relation);
      expect(columnsByRelation.get(relation), `${relation} must resolve to one checked-in Drizzle table`)
        .toEqual(expect.arrayContaining(Object.keys(columns)));
      const relationColumns = new Map<string, ExpectedTuple[]>();
      explicitColumns.set(relation, relationColumns);
      for (const [column, privilegesByRole] of Object.entries(columns)) {
        const tuples: ExpectedTuple[] = [];
        for (const role of ["aoa_app", "aoa_operator"] as const) {
          for (const privilegeType of privilegesByRole[role]) {
            tuples.push({
              grantor: "RELATION_OWNER", grantee: role, privilegeType, isGrantable: false,
            });
          }
        }
        relationColumns.set(column, sorted(tuples));
      }
    }
    const expectedColumns: Record<string, Record<string, {
      aclIsNull: boolean;
      tuples: ExpectedTuple[];
    }>> = {};
    for (const relation of relations) {
      const columns = columnsByRelation.get(relation);
      expect(columns, `${relation} must resolve to one checked-in Drizzle table`).toBeDefined();
      expectedColumns[relation] = {};
      for (const column of columns ?? []) {
        const tuples = sorted(explicitColumns.get(relation)?.get(column) ?? []);
        expectedColumns[relation]![column] = { aclIsNull: tuples.length === 0, tuples };
      }
    }

    const actualRelations = Object.fromEntries(Object.entries(manifest.RELATION_ACL_MANIFEST ?? {})
      .map(([relation, acl]) => [relation, { ...acl, tuples: sorted(acl.tuples as ExpectedTuple[]) }]));
    const actualColumns = Object.fromEntries(Object.entries(manifest.COLUMN_ACL_MANIFEST ?? {})
      .map(([relation, columns]) => [relation, Object.fromEntries(Object.entries(columns).map(
        ([column, acl]) => [column, { ...acl, tuples: sorted(acl.tuples as ExpectedTuple[]) }],
      ))]));
    expect(actualRelations).toEqual(expectedRelations);
    expect(actualColumns).toEqual(expectedColumns);
    expect(Object.isFrozen(manifest.RELATION_ACL_MANIFEST)).toBe(true);
    expect(Object.isFrozen(manifest.COLUMN_ACL_MANIFEST)).toBe(true);
  });
});

describe("startup serving-role authority table map matches the plan-derived matrix", () => {
  // DEP-009 regression guard. `assertExactServingRoleAuthority` compares the LIVE aoa_app /
  // aoa_operator table privileges against `appTablePrivileges()` / `operatorTablePrivileges()`
  // in distributed-execution-databases.ts — a SECOND registration surface, hand-composed by
  // spreading the grant constants. The keystone manifests (APP_SERVING_RELATIONS, RLS_*, the ACL
  // matrix) are one surface; this spread is another. A new distributed-plane table registered in
  // the manifests but NOT spread here makes `expectedTables[table] ?? []` empty while the live
  // role holds the migration's grant, so BOTH replicas throw `distributed_execution_app_authority`
  // at boot — a crash the manifest contract tests above cannot see. This pins the startup spread
  // to the same independent plan fixture, so the omission fails locally instead of only in CI.
  const nonEmpty = (
    role: "aoa_app" | "aoa_operator",
  ): Record<string, PlanGrantedPrivilege[]> => {
    const expected: Record<string, PlanGrantedPrivilege[]> = {};
    for (const [relation, privileges] of Object.entries(PLAN_DERIVED_ACL_MATRIX.relations)) {
      const forRole = privileges[role];
      if (forRole.length > 0) expected[relation] = [...forRole].sort();
    }
    return expected;
  };
  const normalize = (
    map: Readonly<Record<string, readonly string[]>>,
  ): Record<string, string[]> =>
    Object.fromEntries(Object.entries(map).map(([relation, privileges]) => [
      relation,
      [...privileges].sort(),
    ]));

  it("registers exactly the app table-level grants the plan assigns aoa_app", () => {
    expect(normalize(appTablePrivileges())).toEqual(nonEmpty("aoa_app"));
  });

  it("registers exactly the operator table-level grants the plan assigns aoa_operator", () => {
    expect(normalize(operatorTablePrivileges())).toEqual(nonEmpty("aoa_operator"));
  });
});

describe("REL-004 Lane C/I11 — instance_settings is reachable by aoa_app", () => {
  // The worker poll reads `instance_settings.kill_switches` on the aoa_app pool BEFORE opening
  // the lease transaction. `assertExactServingRoleAuthority` enforces EXACT ACLs across every
  // non-system table, so without this grant the role holds ZERO privileges on it and the read
  // fails at RUNTIME with permission denied — not at compile time, and not in any unit test.
  //
  // These assertions pin manifest-to-manifest. The only artifact that proves the GRANT in
  // migration 0261 actually exists in the DATABASE is
  // `distributed-execution-db-startup.integration.test.ts`, which applies the migrations,
  // provisions the real roles and calls `openDistributedExecutionDatabases`.
  it("grants exactly SELECT to aoa_app and nothing to aoa_operator", () => {
    expect(appTablePrivileges().instance_settings).toEqual(["SELECT"]);
    expect(operatorTablePrivileges().instance_settings).toBeUndefined();
  });

  it("appears in the app serving inventory", () => {
    expect(grants.APP_SERVING_RELATIONS).toContain("instance_settings");
  });

  it("carries no RLS — it is an instance singleton with no organization column", () => {
    // `assertExactCatalogCertificate` enumerates every relation with row security enabled and
    // requires exact equality with RLS_RELATIONS, so enabling RLS here would itself be drift.
    expect(grants.RLS_RELATIONS).not.toContain("instance_settings");
    expect(grants.POLICY_COUNTS).not.toHaveProperty("instance_settings");
  });
});

describe("JOB_CONTROL_LEGACY_GRANTS is the FROZEN 0213/0214 body — do not grow it", () => {
  /**
   * This object is not merely a grant list. `server/src/db/rls-tenant.ts` RECONSTRUCTS the
   * bodies of the already-applied, IMMUTABLE migrations 0213 and 0214 by walking it, so adding
   * one key retroactively rewrites two migrations that have already run.
   *
   * That has now happened TWICE. DSK-001 Lane B hit it and added the
   * `GRANTED_AFTER_0213` / `GRANTED_AFTER_0214` exclusion sets; its design doc says plainly
   * "the terrain map counted five artifacts — there are SEVEN". But the coupling comment that
   * ticket shipped in migration 0259, which is the artifact a successor actually copies, still
   * lists only five. REL-004 Lane C followed that comment and hit the identical trap.
   *
   * The byte-identity test in `tenant-rls-enforcement-unit.test.ts` catches it — as a forty-line
   * SQL diff, ~30 minutes into `verify`. This pins the key set instead, so the failure names the
   * mistake and the fix in one line.
   */
  const FROZEN_0213_0214_TABLES = [
    "activity_log", "agent_runtime_decisions", "agent_runtime_trust_rules", "agent_wakeup_requests",
    "agents", "approvals", "artifact_versions", "artifacts", "assets", "budget_incidents",
    "budget_policies", "companies", "company_memberships", "cost_events", "discussion_entries",
    "execution_workspaces", "heartbeat_runs", "hub_audit", "hub_counter_snapshots",
    "internal_agent_config", "internal_agent_conversations", "internal_agent_messages",
    "internal_agent_runs", "internal_agent_runtime_approvals", "internal_agent_tool_trust_rules",
    "issue_comments", "issue_labels", "issues", "labels", "notification_digest_items",
    "notification_preferences", "notifications", "organizations", "projects",
    "provider_credentials", "task_dependencies", "task_outputs", "thread_orchestration_state",
    "user_roles", "workspace_runtime_services",
  ].sort();

  it("holds exactly the tables the immutable 0213/0214 reconstruction expects", () => {
    expect(
      Object.keys(JOB_CONTROL_LEGACY_GRANTS).sort(),
      "JOB_CONTROL_LEGACY_GRANTS reconstructs the IMMUTABLE migrations 0213/0214 " +
        "(server/src/db/rls-tenant.ts). Do NOT add a table here: put the new grant in its own " +
        "`*_APP_GRANTS` / `*_NEW_PATH_GRANTS` constant, spread it into appTablePrivileges() and " +
        "the APP_SERVING_RELATIONS union, and ship it in its own C14 migration. Adding here " +
        "instead ALSO requires an entry in BOTH GRANTED_AFTER_0213 and GRANTED_AFTER_0214.",
    ).toEqual(FROZEN_0213_0214_TABLES);
  });

  it("also freezes JOB_CONTROL_NEW_PATH_GRANTS, which 0214 reconstructs with NO exclusion set", () => {
    // Found while fixing the above. `buildServingRoleHardeningMigrationSql` walks BOTH
    // `JOB_CONTROL_NEW_PATH_GRANTS` (rls-tenant.ts, unconditionally) and
    // `JOB_CONTROL_LEGACY_GRANTS` (gated on GRANTED_AFTER_0214). The legacy one has an
    // exclusion set; the new-path one has NOTHING — so a table added there rewrites applied
    // migration 0214 and there is no mechanism to opt out. Same pin, same reason, and this one
    // has never been guarded at all.
    expect(
      Object.keys(JOB_CONTROL_NEW_PATH_GRANTS).sort(),
      "JOB_CONTROL_NEW_PATH_GRANTS is reconstructed into the IMMUTABLE migration 0214 with NO " +
        "exclusion mechanism (server/src/db/rls-tenant.ts). Do NOT add a table here. Put the " +
        "new grant in its own `*_APP_GRANTS` / `*_NEW_PATH_GRANTS` constant and spread it into " +
        "appTablePrivileges() + the APP_SERVING_RELATIONS union.",
    ).toEqual([
      "job_artifacts", "job_attempts", "job_secret_handles", "jobs", "leases",
      "service_instances", "services", "workers",
    ]);
  });

  it("keeps the kill-switch grant OUT of the frozen body, in its own constant", () => {
    // Non-vacuity for the pin above, and a regression guard for the specific mistake made.
    expect(JOB_CONTROL_LEGACY_GRANTS).not.toHaveProperty("instance_settings");
    expect(grants.KILL_SWITCH_POLICY_APP_GRANTS).toEqual({ instance_settings: ["SELECT"] });
    expect(appTablePrivileges().instance_settings).toEqual(["SELECT"]);
  });

  it("needs no 0213/0214 exclusion entry, because the reconstructors never see it", () => {
    const rlsTenant = readFileSync(
      fileURLToPath(new URL("../db/rls-tenant.ts", import.meta.url)),
      "utf8",
    );
    // If a future change moves the grant back into the frozen body, this flips and the pin
    // above fires first with the actionable message.
    expect(rlsTenant).not.toContain('"instance_settings"');
  });
});
