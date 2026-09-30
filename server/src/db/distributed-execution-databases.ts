import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  assertNonOwnerConnection,
  createOperatorDbConnection,
  createTenantAppDbConnection,
  type Db,
  type NonOwnerDbConnection,
  type RequiredMigrationIdentity,
} from "@armyofagents/db";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { logger } from "../middleware/logger.js";
import {
  APP_EXECUTION_TARGET_COLUMN_GRANTS,
  APP_ENROLLMENT_TARGET_SELECT_COLUMNS,
  APP_ENROLLMENT_TARGET_UPDATE_COLUMNS,
  APP_JOB_PLACEMENT_TARGET_SELECT_COLUMNS,
  APP_JOB_PLACEMENT_TARGET_UPDATE_COLUMNS,
  APP_MCP_API_KEY_COLUMN_GRANTS,
  CUTOVER_MARKER_APP_GRANTS,
  CUTOVER_MARKER_OPERATOR_GRANTS,
  EXECUTION_TARGET_REVOCATION_APP_GRANTS,
  EXECUTION_TARGET_REVOCATION_OPERATOR_GRANTS,
  FOLDER_GRANTS_NEW_PATH_GRANTS,
  JOB_CONTROL_COMMANDS_NEW_PATH_GRANTS,
  JOB_CONTROL_LEGACY_GRANTS,
  JOB_CONTROL_NEW_PATH_GRANTS,
  JOB_EVENTS_NEW_PATH_GRANTS,
  JOB_LEASING_NEW_PATH_GRANTS,
  JOB_SUBMISSION_LEGACY_GRANTS,
  JOB_SUBMISSION_NEW_PATH_GRANTS,
  KILL_SWITCH_POLICY_APP_GRANTS,
  LEGACY_RESOURCE_RECONCILIATION_APP_GRANTS,
  LEGACY_RESOURCE_RECONCILIATION_OPERATOR_GRANTS,
  LEGACY_RECONCILIATION_PASS_OPERATOR_GRANTS,
  LIVE_EVENT_LOG_NEW_PATH_GRANTS,
  SERVICE_GENERATIONS_NEW_PATH_GRANTS,
  OPERATOR_METADATA_COLUMN_GRANTS,
  OPERATOR_ENROLLMENT_TARGET_SELECT_COLUMNS,
  OPERATOR_ENROLLMENT_TARGET_UPDATE_COLUMNS,
  OPERATOR_JOB_PLACEMENT_TARGET_SELECT_COLUMNS,
  OPERATOR_JOB_PLACEMENT_TARGET_UPDATE_COLUMNS,
  APP_SERVING_RELATIONS,
  COLUMN_ACL_MANIFEST,
  FORCE_RLS_RELATIONS,
  NON_FORCE_RLS_RELATIONS,
  POLICY_COUNTS,
  RELATION_ACL_MANIFEST,
  RLS_POLICY_MANIFEST,
  RLS_RELATIONS,
  WORKER_ADMISSION_RATE_LIMITS_NEW_PATH_GRANTS,
  WORKER_ENROLLMENT_APP_GRANTS,
  WORKER_ENROLLMENT_OPERATOR_GRANTS,
  type TablePrivilege,
} from "./job-control-legacy-grants.js";
import { SECURITY_DEFINER_FUNCTION_MANIFEST } from "./security-definer-manifest.js";

export interface DistributedExecutionDatabases {
  appDb: Db;
  operatorDb: Db;
  close(): Promise<void>;
}

type ServingRole = "aoa_app" | "aoa_operator";
const SERVING_ROLES: readonly ServingRole[] = Object.freeze(["aoa_app", "aoa_operator"] as const);
type ParticipantRole = "owner" | ServingRole;
type SqlExecutor = Pick<Db, "execute">;
type OwnerTransportOptions = Record<string, unknown> & {
  host: string[];
  port: number[];
  path: string | undefined;
  database: string;
  user: string;
  pass: string | (() => string | Promise<string>);
  ssl: "require" | "allow" | "prefer" | "verify-full" | boolean | object;
  connection: Record<string, string | number | boolean>;
  prepare: boolean;
  target_session_attrs: "read-write" | "read-only" | "primary" | "standby" |
    "prefer-standby" | null;
  fetch_types: boolean;
  types: Record<string, postgres.PostgresType>;
};

type BackendIdentity = Readonly<{
  pid: number;
  backendStart: string;
  sessionRole: string;
  databaseName: string;
  applicationName: string;
}>;

type TrackedIdentity = Readonly<{
  role: ParticipantRole;
  identity: BackendIdentity;
}>;

type DedicatedOwnerSession = Readonly<{
  applicationName: string;
  db: Db;
  end(): Promise<void>;
  disposeNow(): Promise<void>;
}>;

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

export function appTablePrivileges(): Readonly<Record<string, readonly TablePrivilege[]>> {
  return {
    ...JOB_CONTROL_NEW_PATH_GRANTS,
    ...JOB_CONTROL_LEGACY_GRANTS,
    ...JOB_SUBMISSION_NEW_PATH_GRANTS,
    ...JOB_SUBMISSION_LEGACY_GRANTS,
    ...WORKER_ENROLLMENT_APP_GRANTS,
    ...JOB_LEASING_NEW_PATH_GRANTS,
    ...JOB_EVENTS_NEW_PATH_GRANTS,
    ...JOB_CONTROL_COMMANDS_NEW_PATH_GRANTS,
    ...FOLDER_GRANTS_NEW_PATH_GRANTS,
    ...CUTOVER_MARKER_APP_GRANTS,
    ...EXECUTION_TARGET_REVOCATION_APP_GRANTS,
    ...WORKER_ADMISSION_RATE_LIMITS_NEW_PATH_GRANTS,
    ...LEGACY_RESOURCE_RECONCILIATION_APP_GRANTS,
    ...LIVE_EVENT_LOG_NEW_PATH_GRANTS,
    ...SERVICE_GENERATIONS_NEW_PATH_GRANTS,
    ...KILL_SWITCH_POLICY_APP_GRANTS,
  };
}

export function operatorTablePrivileges(): Readonly<Record<string, readonly TablePrivilege[]>> {
  return {
    ...WORKER_ENROLLMENT_OPERATOR_GRANTS,
    ...CUTOVER_MARKER_OPERATOR_GRANTS,
    ...EXECUTION_TARGET_REVOCATION_OPERATOR_GRANTS,
    ...LEGACY_RESOURCE_RECONCILIATION_OPERATOR_GRANTS,
    // MIG-010 Unit 2.4: the reconciliation-pass marker (migration 0269). Operator-only —
    // there is no matching entry in `appTablePrivileges()` because aoa_app holds nothing
    // on this table, which `assertExactServingRoleAuthority` then asserts as an absence.
    ...LEGACY_RECONCILIATION_PASS_OPERATOR_GRANTS,
  };
}

/** Fail closed unless effective ACLs are exact across every non-system table-like object. */
async function assertExactServingRoleAuthority(db: Db, role: ServingRole): Promise<void> {
  const schemaRows = rowsOf<{ schema_name: string; usage: boolean; create: boolean }>(await db.execute(sql`
    SELECT
      namespace.nspname AS schema_name,
      has_schema_privilege(current_user, namespace.oid, 'USAGE') AS usage,
      has_schema_privilege(current_user, namespace.oid, 'CREATE') AS create
    FROM pg_namespace namespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_%'
    ORDER BY namespace.nspname
  `));
  for (const schemaPosture of schemaRows) {
    const expectedUsage = schemaPosture.schema_name === "public";
    if (schemaPosture.usage !== expectedUsage || schemaPosture.create) {
      throw new Error(
        `${role} effective schema authority is not exact for ${schemaPosture.schema_name} ` +
          `(USAGE=${schemaPosture.usage} expected ${expectedUsage}, CREATE=${schemaPosture.create})`,
      );
    }
  }

  const tableRows = rowsOf<{
    schema_name: string;
    table_name: string;
    select_allowed: boolean;
    insert_allowed: boolean;
    update_allowed: boolean;
    delete_allowed: boolean;
    truncate_allowed: boolean;
    references_allowed: boolean;
    trigger_allowed: boolean;
    maintain_allowed: boolean;
  }>(await db.execute(sql`
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS table_name,
      has_table_privilege(current_user, relation.oid, 'SELECT') AS select_allowed,
      has_table_privilege(current_user, relation.oid, 'INSERT') AS insert_allowed,
      has_table_privilege(current_user, relation.oid, 'UPDATE') AS update_allowed,
      has_table_privilege(current_user, relation.oid, 'DELETE') AS delete_allowed,
      has_table_privilege(current_user, relation.oid, 'TRUNCATE') AS truncate_allowed,
      has_table_privilege(current_user, relation.oid, 'REFERENCES') AS references_allowed,
      has_table_privilege(current_user, relation.oid, 'TRIGGER') AS trigger_allowed,
      has_table_privilege(current_user, relation.oid, 'MAINTAIN') AS maintain_allowed
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_%'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY relation.relname
  `));
  const expectedTables = role === "aoa_app" ? appTablePrivileges() : operatorTablePrivileges();
  const tableOperations = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
  for (const row of tableRows) {
    const expected = new Set(
      row.schema_name === "public" ? expectedTables[row.table_name] ?? [] : [],
    );
    const actualByOperation: Record<TablePrivilege, boolean> = {
      SELECT: row.select_allowed,
      INSERT: row.insert_allowed,
      UPDATE: row.update_allowed,
      DELETE: row.delete_allowed,
    };
    for (const operation of tableOperations) {
      const actual = actualByOperation[operation];
      if (actual !== expected.has(operation)) {
        throw new Error(
          `${role} effective table authority drift: ${row.schema_name}.${row.table_name} ${operation}=` +
            `${actual} expected ${expected.has(operation)}`,
        );
      }
    }
    for (const [operation, allowed] of [
      ["TRUNCATE", row.truncate_allowed],
      ["REFERENCES", row.references_allowed],
      ["TRIGGER", row.trigger_allowed],
      ["MAINTAIN", row.maintain_allowed],
    ] as const) {
      if (allowed) {
        throw new Error(
          `${role} effective table authority drift: ${row.schema_name}.${row.table_name} ${operation}=true`,
        );
      }
    }
  }

  const columnRows = rowsOf<{
    schema_name: string;
    table_name: string;
    column_name: string;
    select_allowed: boolean;
    insert_allowed: boolean;
    update_allowed: boolean;
    references_allowed: boolean;
  }>(await db.execute(sql`
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS table_name,
      attribute.attname AS column_name,
      has_column_privilege(current_user, relation.oid, attribute.attnum, 'SELECT') AS select_allowed,
      has_column_privilege(current_user, relation.oid, attribute.attnum, 'INSERT') AS insert_allowed,
      has_column_privilege(current_user, relation.oid, attribute.attnum, 'UPDATE') AS update_allowed,
      has_column_privilege(current_user, relation.oid, attribute.attnum, 'REFERENCES') AS references_allowed
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_%'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY relation.relname, attribute.attnum
  `));
  for (const row of columnRows) {
    const appExpected = new Set(
      row.schema_name === "public" ? expectedTables[row.table_name] ?? [] : [],
    );
    const operatorColumns = new Set([
      ...((OPERATOR_METADATA_COLUMN_GRANTS as Readonly<Record<string, readonly string[]>>)[row.table_name] ?? []),
      ...(row.table_name === "execution_targets" ? OPERATOR_ENROLLMENT_TARGET_SELECT_COLUMNS : []),
      ...(row.table_name === "execution_targets" ? OPERATOR_JOB_PLACEMENT_TARGET_SELECT_COLUMNS : []),
    ]);
    const appColumnSelect = row.schema_name === "public" && (
      (row.table_name === "execution_targets" && (
        APP_EXECUTION_TARGET_COLUMN_GRANTS.includes(
          row.column_name as (typeof APP_EXECUTION_TARGET_COLUMN_GRANTS)[number]
        ) || APP_ENROLLMENT_TARGET_SELECT_COLUMNS.includes(
          row.column_name as (typeof APP_ENROLLMENT_TARGET_SELECT_COLUMNS)[number]
        ) || APP_JOB_PLACEMENT_TARGET_SELECT_COLUMNS.includes(
          row.column_name as (typeof APP_JOB_PLACEMENT_TARGET_SELECT_COLUMNS)[number]
        )
      )) ||
      (row.table_name === "mcp_api_keys" &&
        APP_MCP_API_KEY_COLUMN_GRANTS.includes(
          row.column_name as (typeof APP_MCP_API_KEY_COLUMN_GRANTS)[number],
        ))
    );
    const expectedSelect = role === "aoa_app"
      ? appExpected.has("SELECT") || appColumnSelect
      : row.schema_name === "public" && (appExpected.has("SELECT") || operatorColumns.has(row.column_name));
    const expectedInsert = appExpected.has("INSERT");
    const expectedUpdate = appExpected.has("UPDATE") || (
      row.schema_name === "public" && row.table_name === "execution_targets" && (
        role === "aoa_app"
          ? APP_ENROLLMENT_TARGET_UPDATE_COLUMNS.includes(
              row.column_name as (typeof APP_ENROLLMENT_TARGET_UPDATE_COLUMNS)[number]
            ) || APP_JOB_PLACEMENT_TARGET_UPDATE_COLUMNS.includes(
              row.column_name as (typeof APP_JOB_PLACEMENT_TARGET_UPDATE_COLUMNS)[number]
            )
          : OPERATOR_ENROLLMENT_TARGET_UPDATE_COLUMNS.includes(
              row.column_name as (typeof OPERATOR_ENROLLMENT_TARGET_UPDATE_COLUMNS)[number]
            ) || OPERATOR_JOB_PLACEMENT_TARGET_UPDATE_COLUMNS.includes(
              row.column_name as (typeof OPERATOR_JOB_PLACEMENT_TARGET_UPDATE_COLUMNS)[number]
            )
      )
    );
    for (const [operation, actual, expected] of [
      ["SELECT", row.select_allowed, expectedSelect],
      ["INSERT", row.insert_allowed, expectedInsert],
      ["UPDATE", row.update_allowed, expectedUpdate],
      ["REFERENCES", row.references_allowed, false],
    ] as const) {
      if (actual !== expected) {
        throw new Error(
          `${role} effective column authority drift: ${row.schema_name}.${row.table_name}.${row.column_name} ` +
            `${operation}=${actual} expected ${expected}`,
        );
      }
    }
  }

  const sequenceRows = rowsOf<{
    schema_name: string;
    sequence_name: string;
    usage_allowed: boolean;
    select_allowed: boolean;
    update_allowed: boolean;
  }>(await db.execute(sql`
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS sequence_name,
      has_sequence_privilege(current_user, relation.oid, 'USAGE') AS usage_allowed,
      has_sequence_privilege(current_user, relation.oid, 'SELECT') AS select_allowed,
      has_sequence_privilege(current_user, relation.oid, 'UPDATE') AS update_allowed
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_%'
      AND relation.relkind = 'S'
    ORDER BY relation.relname
  `));
  const sequenceDrift = sequenceRows.find(
    (row) => row.usage_allowed || row.select_allowed || row.update_allowed,
  );
  if (sequenceDrift) {
    throw new Error(
      `${role} effective sequence authority drift: ` +
        `${sequenceDrift.schema_name}.${sequenceDrift.sequence_name}`,
    );
  }

  // The scans above enumerate tables, columns and sequences. None of them can see a
  // SECURITY DEFINER function, which runs with the OWNER's authority regardless of caller
  // and is therefore the whole remaining privilege-escalation surface.
  await assertSecurityDefinerManifest(db, role);
}

function securityDefinerKey(schema: string, name: string, identityArguments: string): string {
  return `${schema}.${name}(${identityArguments})`;
}

/**
 * Certificate the SECURITY DEFINER surface against
 * {@link SECURITY_DEFINER_FUNCTION_MANIFEST}: exactly the manifested functions may exist,
 * and every manifested function must exist.
 *
 * Role-independent by construction — `prosecdef` is a property of the FUNCTION, not of the
 * caller. It is invoked once per serving role only because that is where the existing
 * assertion path runs; the `role` argument appears in the message for provenance, and the
 * verdict is identical for both roles.
 */
type DefinerCatalog = {
  found: Map<string, {
    owner: string;
    executionConfig: string[];
    leakproof: boolean;
    bodySha256: string;
    aclIsNull: boolean;
    tuples: string[];
  }>;
  relationOwners: Map<string, string>;
};

async function readSecurityDefinerCatalog(db: SqlExecutor): Promise<DefinerCatalog> {
  // KEYED ON prosecdef, NOT effective EXECUTE. On a fleet with pgvector, `CREATE EXTENSION
  // vector` (no SCHEMA clause: 0038_marvelous_vapor.sql:1, 0115_enable_pgvector.sql:29)
  // installs ~100 functions into `public` carrying PostgreSQL's default PUBLIC EXECUTE, so
  // an EXECUTE-keyed certificate would fail boot there. `prosecdef` is also the
  // security-correct axis: a SECURITY INVOKER function confers nothing beyond the caller's
  // own authority.
  //
  // The owner and ACL columns below are asserted ONLY for rows this `prosecdef` filter
  // already returned. That keeps the pgvector constraint intact — those functions are
  // SECURITY INVOKER, so they never enter this set — while closing the half of the
  // certificate that identity comparison alone leaves open: a MANIFESTED definer function
  // whose EXECUTE widens is owner-authority code reachable by a role that was never meant
  // to reach it, and no table/column/sequence scan can see it.
  const rows = rowsOf<{
    schema_name: string;
    function_name: string;
    identity_arguments: string;
    owner_name: string;
    execution_config: string[] | null;
    leakproof: boolean;
    body_sha256: string;
    acl_is_null: boolean;
    grantor: string | null;
    grantee: string | null;
    privilege_type: string | null;
    is_grantable: boolean | null;
  }>(
    await db.execute(sql`
      SELECT
        namespace.nspname AS schema_name,
        proc.proname AS function_name,
        pg_get_function_identity_arguments(proc.oid) AS identity_arguments,
        owner.rolname AS owner_name,
        proc.proconfig AS execution_config,
        proc.proleakproof AS leakproof,
        -- Carriage returns stripped: packages/db/src/migrations/ has no eol=lf pin in
        -- .gitattributes, so a Windows checkout stores the body with CRLF and Linux CI with
        -- LF. Hashing raw would pin one platform and fail boot on the other.
        encode(
          sha256(convert_to(replace(proc.prosrc, chr(13), ''), 'UTF8')), 'hex'
        ) AS body_sha256,
        proc.proacl IS NULL AS acl_is_null,
        CASE
          WHEN acl.grantor = proc.proowner THEN 'FUNCTION_OWNER'
          ELSE COALESCE(grantor.rolname, acl.grantor::text)
        END AS grantor,
        CASE
          WHEN acl.grantee = 0 THEN 'PUBLIC'
          WHEN acl.grantee = proc.proowner THEN 'FUNCTION_OWNER'
          ELSE COALESCE(grantee.rolname, acl.grantee::text)
        END AS grantee,
        acl.privilege_type, acl.is_grantable
      FROM pg_proc proc
      JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
      JOIN pg_roles owner ON owner.oid = proc.proowner
      LEFT JOIN LATERAL aclexplode(proc.proacl) acl ON TRUE
      LEFT JOIN pg_roles grantor ON grantor.oid = acl.grantor
      LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
      WHERE proc.prosecdef
        AND namespace.nspname <> 'information_schema'
        AND namespace.nspname NOT LIKE 'pg_%'
    `),
  );

  // Compare as SETS keyed by identity, never by sorted index: Postgres orders by
  // (nspname, proname, identity_arguments) while JS localeCompare orders differently, so
  // index pairing would spuriously red boot the moment a second definer function exists.
  const manifested = new Map(
    SECURITY_DEFINER_FUNCTION_MANIFEST.map((fn) => [
      securityDefinerKey(fn.schema, fn.name, fn.identityArguments),
      fn,
    ]),
  );

  // `aclexplode` is LATERAL-joined, so one function yields one row per ACL tuple (and a
  // single all-null row when `proacl IS NULL`). Fold back to one entry per function.
  const found = new Map<string, {
    owner: string;
    executionConfig: string[];
    leakproof: boolean;
    bodySha256: string;
    aclIsNull: boolean;
    tuples: string[];
  }>();
  for (const row of rows) {
    const key = securityDefinerKey(row.schema_name, row.function_name, row.identity_arguments);
    const entry = (found.get(key) ?? {
      owner: row.owner_name,
      executionConfig: row.execution_config ?? [],
      leakproof: row.leakproof,
      bodySha256: row.body_sha256,
      aclIsNull: row.acl_is_null,
      tuples: [] as string[],
    });
    if (
      row.grantor !== null && row.grantee !== null &&
      row.privilege_type !== null && row.is_grantable !== null
    ) {
      entry.tuples.push(`${row.grantor}->${row.grantee}:${row.privilege_type}:${row.is_grantable}`);
    }
    found.set(key, entry);
  }

  // Relation owners, for the owner pin below. Read once for every application relation
  // rather than per function: the manifest is small but the join is not free, and this
  // keeps the query shape identical no matter how many definer functions are manifested.
  const relationOwners = new Map<string, string>(
    rowsOf<{ schema_name: string; relation_name: string; owner_name: string }>(
      await db.execute(sql`
        SELECT
          namespace.nspname AS schema_name,
          relation.relname AS relation_name,
          owner.rolname AS owner_name
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_roles owner ON owner.oid = relation.relowner
        WHERE relation.relkind IN ('r', 'p')
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname NOT LIKE 'pg_%'
      `),
    ).map((row) => [`${row.schema_name}.${row.relation_name}`, row.owner_name] as const),
  );

  return { found, relationOwners };
}

/**
 * The POSITIVE arm of the certificate: every manifested definer function must exist with
 * exactly its pinned owner, ACL, execution config and body, and must not be LEAKPROOF.
 *
 * Runs on EVERY boot, flag on or off. The function is created by a migration that runs on
 * every deployment, and `aoa_app` keeps `EXECUTE` on it regardless of the flag — and a box
 * that was once flag-on keeps the LOGIN credential, because
 * `maybeProvisionDistributedExecutionRoles` is a strict no-op when the flag is off and never
 * restores NOLOGIN. So the privileged surface exists on flag-off deployments too, and a
 * certificate that only ran under the flag would leave it uncertified exactly where nothing
 * else is watching.
 */
export async function assertManifestedSecurityDefinerFunctions(
  db: SqlExecutor,
  context: string,
): Promise<void> {
  const { found, relationOwners } = await readSecurityDefinerCatalog(db);
  for (const expected of SECURITY_DEFINER_FUNCTION_MANIFEST) {
    const key = securityDefinerKey(expected.schema, expected.name, expected.identityArguments);
    const actual = found.get(key);
    if (!actual) {
      throw new Error(
        `${context} security-definer drift: manifested SECURITY DEFINER function ${key} is absent`,
      );
    }
    // 0214_e2_serving_role_hardening.sql:10,31 RAISEs if a serving role owns an application
    // object. A definer function owned by a serving role is that same violation, in the one
    // place the table/column/sequence scans cannot look.
    if (SERVING_ROLES.includes(actual.owner as ServingRole)) {
      throw new Error(
        `${context} security-definer drift: ${key} is owned by serving role ${actual.owner}`,
      );
    }

    // OWNER IS PINNED, NOT MERELY BOUNDED. `ALTER FUNCTION … OWNER TO` rewrites the ACL's
    // grantor/grantee entries to the new owner, and the sentinel normalization above maps
    // them straight back to FUNCTION_OWNER — so an owner swap to any non-serving role is
    // INVISIBLE to the exact-ACL comparison below. Pin it against the relations the body
    // reads: that hardcodes no role name (so it holds on every deployment) and states the
    // real invariant — a definer function may hold exactly the authority of the data it
    // reads. A less-privileged owner silently restores the BLOCKER E `preflight_error`
    // outage; a more-privileged one silently widens the definer context.
    for (const relation of expected.authorityRelations) {
      const relationOwner = relationOwners.get(relation);
      if (relationOwner === undefined) {
        throw new Error(
          `${context} security-definer drift: ${key} declares authority relation ${relation}, ` +
            "which does not exist",
        );
      }
      if (relationOwner !== actual.owner) {
        throw new Error(
          `${context} security-definer owner drift: ${key} is owned by ${actual.owner} but its ` +
            `authority relation ${relation} is owned by ${relationOwner}`,
        );
      }
    }

    // A NULL `proacl` is not "no privileges" — it is PostgreSQL's DEFAULT ACL, and the
    // default for a function is EXECUTE to PUBLIC. A DROP + CREATE that forgets to re-issue
    // the REVOKE lands here, silently re-opened.
    if (actual.aclIsNull) {
      throw new Error(
        `${context} security-definer execute authority drift: ${key} has a NULL ACL ` +
          "(PostgreSQL's default grants EXECUTE to PUBLIC)",
      );
    }

    // EXECUTION DEFINITION. `CREATE OR REPLACE FUNCTION` PRESERVES the owner and the ACL,
    // so a replacement keeping the identity and the SECURITY DEFINER setting passes every
    // check above while silently changing what the function DOES. Two things it can drop:
    // the empty `search_path` pin (making name resolution inside owner-authority code
    // caller-controlled) and a tenant predicate (turning this into a cross-tenant existence
    // oracle — the exact defect review caught in this plan's first revision).
    if (!exactJson(actual.executionConfig, expected.executionConfig)) {
      throw new Error(
        `${context} security-definer execution config drift: ${key} has ` +
          `${JSON.stringify(actual.executionConfig)} expected ` +
          `${JSON.stringify(expected.executionConfig)}`,
      );
    }
    if (actual.bodySha256 !== expected.bodySha256) {
      throw new Error(
        `${context} security-definer body fingerprint drift: ${key} body is ` +
          `${actual.bodySha256} expected ${expected.bodySha256}`,
      );
    }
    // LEAKPROOF lets the planner push a function below security barriers and RLS quals.
    // Owner-authority code reading secret-bearing tables must never carry it.
    if (actual.leakproof) {
      throw new Error(
        `${context} security-definer drift: ${key} is marked LEAKPROOF`,
      );
    }

    const expectedTuples = sortedStrings([
      "FUNCTION_OWNER->FUNCTION_OWNER:EXECUTE:false",
      ...expected.executeGrantees.map(
        (grantee) => `FUNCTION_OWNER->${grantee}:EXECUTE:false`,
      ),
    ]);
    const actualTuples = sortedStrings(actual.tuples);
    if (!exactJson(actualTuples, expectedTuples)) {
      throw new Error(
        `${context} security-definer execute authority drift: ${key} ACL is ` +
          `${JSON.stringify(actualTuples)} expected ${JSON.stringify(expectedTuples)}`,
      );
    }
  }
}

/**
 * The EXHAUSTIVE arm: no SECURITY DEFINER function outside the manifest may exist.
 *
 * Deliberately NOT run on every boot. It asserts a property of the WHOLE database, which
 * only holds on a controlled distributed-execution fleet — the same fleet where
 * `assertExactServingRoleAuthority` already fails boot on any unexpected schema. AoA also
 * supports `external-postgres` against a database the operator owns, where a vendor or
 * extension definer function in some other schema is legitimate and unknowable to us; making
 * this unconditional would turn those deployments into hard boot failures. The positive arm
 * above closes the drift risk that actually exists there.
 */
export async function assertNoUnmanifestedSecurityDefinerFunctions(
  db: SqlExecutor,
  role: string,
): Promise<void> {
  const { found } = await readSecurityDefinerCatalog(db);
  const manifested = new Set(
    SECURITY_DEFINER_FUNCTION_MANIFEST.map((fn) =>
      securityDefinerKey(fn.schema, fn.name, fn.identityArguments),
    ),
  );
  for (const key of found.keys()) {
    if (!manifested.has(key)) {
      throw new Error(
        `${role} security-definer drift: unmanifested SECURITY DEFINER function ${key}`,
      );
    }
  }
}

/** Both arms, for the flag-on serving-role authority path. */
export async function assertSecurityDefinerManifest(
  db: SqlExecutor,
  role: string,
): Promise<void> {
  await assertNoUnmanifestedSecurityDefinerFunctions(db, role);
  await assertManifestedSecurityDefinerFunctions(db, role);
}

type ActualAclTuple = {
  grantor: string;
  grantee: string;
  privilegeType: string;
  isGrantable: boolean;
};

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function aclTupleKey(tuple: ActualAclTuple): string {
  return [tuple.grantor, tuple.grantee, tuple.privilegeType, String(tuple.isGrantable)].join(":");
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExactJson(actual: unknown, expected: unknown, certificate: string): void {
  if (!exactJson(actual, expected)) throw new Error(`catalog certificate drift: ${certificate}`);
}

const SERVING_RELATIONS = Object.freeze(Object.keys(RELATION_ACL_MANIFEST).sort());
const SERVING_RELATION_SQL = sql.join(SERVING_RELATIONS.map((relation) => sql`${relation}`), sql`, `);

/**
 * Assert physical relation shape plus owner-authored RLS, policy, relacl and attacl posture.
 * These are raw catalog checks, deliberately separate from the effective-privilege scan.
 */
async function assertExactCatalogCertificate(db: Db): Promise<void> {
  const relationRows = rowsOf<{
    relation: string;
    relkind: string;
    rls: boolean;
    force_rls: boolean;
  }>(await db.execute(sql`
    SELECT relation.relname AS relation, relation.relkind,
      relation.relrowsecurity AS rls, relation.relforcerowsecurity AS force_rls
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (${SERVING_RELATION_SQL})
    ORDER BY relation.relname
  `));
  assertExactJson(
    relationRows.map((row) => row.relation),
    SERVING_RELATIONS,
    "relation inventory",
  );
  if (relationRows.some((row) => row.relkind !== "r")) {
    throw new Error("catalog certificate drift: relation kind");
  }

  const rlsRows = rowsOf<{
    relation: string;
    force_rls: boolean;
  }>(await db.execute(sql`
    SELECT relation.relname AS relation, relation.relforcerowsecurity AS force_rls
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relrowsecurity
    ORDER BY relation.relname
  `));
  assertExactJson(
    rlsRows.map((row) => row.relation),
    sortedStrings(RLS_RELATIONS),
    "RLS inventory",
  );
  assertExactJson(
    rlsRows.filter((row) => row.force_rls).map((row) => row.relation),
    sortedStrings(FORCE_RLS_RELATIONS),
    "FORCE RLS inventory",
  );
  assertExactJson(
    rlsRows.filter((row) => !row.force_rls).map((row) => row.relation),
    sortedStrings(NON_FORCE_RLS_RELATIONS),
    "non-FORCE RLS inventory",
  );

  const policyRows = rowsOf<{
    relation: string;
    name: string;
    command: "ALL" | "SELECT" | "UPDATE" | "INSERT" | "DELETE";
    role: string;
    permissive: boolean;
    role_count: number;
    qual: string | null;
    check: string | null;
  }>(await db.execute(sql`
    SELECT relation.relname AS relation, policy.polname AS name,
      CASE policy.polcmd
        WHEN '*' THEN 'ALL'
        WHEN 'r' THEN 'SELECT'
        WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE'
        WHEN 'd' THEN 'DELETE'
      END AS command,
      CASE WHEN policy_role.role_oid = 0 THEN 'PUBLIC' ELSE role.rolname END AS role,
      policy.polpermissive AS permissive,
      cardinality(policy.polroles)::int AS role_count,
      pg_get_expr(policy.polqual, policy.polrelid) AS qual,
      pg_get_expr(policy.polwithcheck, policy.polrelid) AS check
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL unnest(policy.polroles) AS policy_role(role_oid)
    LEFT JOIN pg_roles role ON role.oid = policy_role.role_oid
    WHERE namespace.nspname = 'public'
    ORDER BY relation.relname, policy.polname, role
  `));
  if (policyRows.some((row) => row.role_count !== 1 || !row.role)) {
    throw new Error("catalog certificate drift: policy role cardinality");
  }
  const actualPolicies = policyRows.map(({ role_count: _roleCount, ...row }) => row)
    .sort((left, right) => `${left.relation}:${left.name}:${left.role}`
      .localeCompare(`${right.relation}:${right.name}:${right.role}`));
  const expectedPolicies = [...RLS_POLICY_MANIFEST]
    .sort((left, right) => `${left.relation}:${left.name}:${left.role}`
      .localeCompare(`${right.relation}:${right.name}:${right.role}`));
  assertExactJson(actualPolicies, expectedPolicies, "policy rows");
  const actualPolicyCounts = Object.fromEntries(RLS_RELATIONS.map((relation) => [
    relation,
    actualPolicies.filter((policy) => policy.relation === relation).length,
  ]));
  assertExactJson(actualPolicyCounts, POLICY_COUNTS, "policy counts");

  const relationAclRows = rowsOf<{
    relation: string;
    acl_is_null: boolean;
    grantor: string | null;
    grantee: string | null;
    privilege_type: string | null;
    is_grantable: boolean | null;
  }>(await db.execute(sql`
    SELECT relation.relname AS relation, relation.relacl IS NULL AS acl_is_null,
      CASE
        WHEN acl.grantor = relation.relowner THEN 'RELATION_OWNER'
        ELSE COALESCE(grantor.rolname, acl.grantor::text)
      END AS grantor,
      CASE
        WHEN acl.grantee = 0 THEN 'PUBLIC'
        WHEN acl.grantee = relation.relowner THEN 'RELATION_OWNER'
        ELSE COALESCE(grantee.rolname, acl.grantee::text)
      END AS grantee,
      acl.privilege_type, acl.is_grantable
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN LATERAL aclexplode(relation.relacl) acl ON TRUE
    LEFT JOIN pg_roles grantor ON grantor.oid = acl.grantor
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (${SERVING_RELATION_SQL})
    ORDER BY relation.relname, grantor, grantee, acl.privilege_type, acl.is_grantable
  `));
  const actualRelationAcl: Record<string, { aclIsNull: boolean; tuples: ActualAclTuple[] }> = {};
  for (const row of relationAclRows) {
    const entry = actualRelationAcl[row.relation] ??= { aclIsNull: row.acl_is_null, tuples: [] };
    if (row.grantor !== null && row.grantee !== null && row.privilege_type !== null &&
      row.is_grantable !== null) {
      entry.tuples.push({
        grantor: row.grantor,
        grantee: row.grantee,
        privilegeType: row.privilege_type,
        isGrantable: row.is_grantable,
      });
    }
  }
  for (const entry of Object.values(actualRelationAcl)) {
    entry.tuples.sort((left, right) => aclTupleKey(left).localeCompare(aclTupleKey(right)));
  }
  assertExactJson(actualRelationAcl, RELATION_ACL_MANIFEST, "relation ACL");

  const columnAclRows = rowsOf<{
    relation: string;
    column_name: string;
    acl_is_null: boolean;
    grantor: string | null;
    grantee: string | null;
    privilege_type: string | null;
    is_grantable: boolean | null;
  }>(await db.execute(sql`
    SELECT relation.relname AS relation, attribute.attname AS column_name,
      attribute.attacl IS NULL AS acl_is_null,
      CASE
        WHEN acl.grantor = relation.relowner THEN 'RELATION_OWNER'
        ELSE COALESCE(grantor.rolname, acl.grantor::text)
      END AS grantor,
      CASE
        WHEN acl.grantee = 0 THEN 'PUBLIC'
        WHEN acl.grantee = relation.relowner THEN 'RELATION_OWNER'
        ELSE COALESCE(grantee.rolname, acl.grantee::text)
      END AS grantee,
      acl.privilege_type, acl.is_grantable
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
    LEFT JOIN LATERAL aclexplode(attribute.attacl) acl ON TRUE
    LEFT JOIN pg_roles grantor ON grantor.oid = acl.grantor
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (${SERVING_RELATION_SQL})
    ORDER BY relation.relname, attribute.attnum, grantor, grantee,
      acl.privilege_type, acl.is_grantable
  `));
  const actualColumnAcl: Record<
    string,
    Record<string, { aclIsNull: boolean; tuples: ActualAclTuple[] }>
  > = Object.fromEntries(SERVING_RELATIONS.map((relation) => [relation, {}]));
  for (const row of columnAclRows) {
    const columns = actualColumnAcl[row.relation];
    if (!columns) throw new Error("catalog certificate drift: unexpected ACL relation");
    const entry = columns[row.column_name] ??= { aclIsNull: row.acl_is_null, tuples: [] };
    if (row.grantor !== null && row.grantee !== null && row.privilege_type !== null &&
      row.is_grantable !== null) {
      entry.tuples.push({
        grantor: row.grantor,
        grantee: row.grantee,
        privilegeType: row.privilege_type,
        isGrantable: row.is_grantable,
      });
    }
  }
  for (const columns of Object.values(actualColumnAcl)) {
    for (const entry of Object.values(columns)) {
      entry.tuples.sort((left, right) => aclTupleKey(left).localeCompare(aclTupleKey(right)));
    }
  }
  const orderedActualColumnAcl = Object.fromEntries(SERVING_RELATIONS.map((relation) => [
    relation,
    Object.fromEntries(Object.entries(actualColumnAcl[relation] ?? {})
      .sort(([left], [right]) => left.localeCompare(right))),
  ]));
  assertExactJson(orderedActualColumnAcl, COLUMN_ACL_MANIFEST, "column ACL");
}

async function assertRequiredMigrationIdentity(
  ownerDb: Db,
  required: RequiredMigrationIdentity,
): Promise<void> {
  const suppliedHashes = [...required.orderedHashes];
  if (suppliedHashes.length === 0 || new Set(suppliedHashes).size !== suppliedHashes.length ||
    suppliedHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
    throw new Error("invalid required migration identity");
  }
  const suppliedLedger = createHash("sha256")
    .update(JSON.stringify(suppliedHashes))
    .digest("hex");
  if (required.ledgerSha256 !== suppliedLedger) {
    throw new Error("invalid required migration ledger digest");
  }
  const databaseRows = rowsOf<{ id: number; hash: string }>(await ownerDb.execute(sql`
    SELECT id, hash
    FROM drizzle.__drizzle_migrations
    WHERE hash IS NOT NULL
  `));
  const databaseHashes = databaseRows.map((row) => row.hash);
  if (new Set(databaseHashes).size !== databaseHashes.length ||
    databaseHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) ||
    !exactJson(sortedStrings(databaseHashes), sortedStrings(suppliedHashes))) {
    throw new Error("database migration identity does not match checked-in migrations");
  }
}

export async function closeBoundedDatabaseConnections(
  connections: readonly Pick<NonOwnerDbConnection, "close">[],
): Promise<void> {
  const results = await Promise.allSettled(
    connections.map((connection) => connection.close({ timeoutSeconds: 5 })),
  );
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to close bounded distributed database pools");
  }
}

const STARTUP_HANDSHAKE_TIMEOUT_MS = 5_000;
const STARTUP_CLOSE_TIMEOUT_MS = 5_000;
const CONTROL_SESSION_DEADLINE_MS = 5_000;
const statement_timeout = 5_000;
const lock_timeout = 750;
const idle_in_transaction_session_timeout = 5_000;
const owner_pool_idle_timeout_seconds = 30;
const STARTUP_POOL_OPTIONS = Object.freeze({
  max: 4,
  connectTimeoutMs: 5_000,
  statementTimeoutMs: statement_timeout,
  lockTimeoutMs: lock_timeout,
  idleInTransactionSessionTimeoutMs: idle_in_transaction_session_timeout,
  idleTimeoutMs: 30_000,
});

type StartupErrorCode =
  | "distributed_execution_configuration"
  | "distributed_execution_migration_identity"
  | "distributed_execution_app_authority"
  | "distributed_execution_operator_authority"
  | "distributed_execution_advisory_domain"
  | "distributed_execution_timeout"
  | "distributed_execution_close";

class DistributedExecutionStartupError extends Error {
  constructor(code: StartupErrorCode) {
    super(code);
    this.name = "DistributedExecutionStartupError";
  }
}

class RejectableBarrier {
  private readonly promise: Promise<void>;
  private resolvePromise!: () => void;
  private rejectPromise!: (error: Error) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
    void this.promise.catch(() => {});
  }

  wait(): Promise<void> {
    return this.promise;
  }

  resolve(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise();
  }

  reject(): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectPromise(new Error("startup barrier cancelled"));
  }
}

class TwoRoleBarrier {
  private readonly gate = new RejectableBarrier();
  private readonly arrived = new Set<ServingRole>();

  async wait(role: ServingRole): Promise<void> {
    this.arrived.add(role);
    if (this.arrived.size === 2) this.gate.resolve();
    await this.gate.wait();
  }

  reject(): void {
    this.gate.reject();
  }
}

class RolePairSequence {
  private readonly gates: RejectableBarrier[];
  private readonly arrived: Array<Set<ServingRole>>;

  constructor(size: number) {
    this.gates = Array.from({ length: size }, () => new RejectableBarrier());
    this.arrived = Array.from({ length: size }, () => new Set<ServingRole>());
    this.gates[0]?.resolve();
  }

  wait(index: number): Promise<void> {
    const gate = this.gates[index];
    if (!gate) return Promise.reject(new Error("invalid advisory pair index"));
    return gate.wait();
  }

  complete(index: number, role: ServingRole): void {
    const arrived = this.arrived[index];
    if (!arrived) throw new Error("invalid advisory pair index");
    arrived.add(role);
    if (arrived.size === 2) this.gates[index + 1]?.resolve();
  }

  reject(): void {
    for (const gate of this.gates) gate.reject();
  }
}

function firstRowBoolean(result: unknown): boolean | undefined {
  for (const row of rowsOf<Record<string, unknown>>(result)) {
    for (const value of Object.values(row)) if (typeof value === "boolean") return value;
  }
  return undefined;
}

function firstRowPid(result: unknown): number | undefined {
  for (const row of rowsOf<Record<string, unknown>>(result)) {
    for (const value of Object.values(row)) if (Number.isSafeInteger(value)) return value as number;
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isTimeoutOrDisconnect(error: unknown): boolean {
  const code = errorCode(error);
  return code === "57014" || code === "55P03" || code === "25P03" ||
    code === "57P01" || code === "57P02" || code === "57P03" ||
    code?.startsWith("08") === true || code === "CONNECTION_DESTROYED" ||
    code === "CONNECTION_CLOSED";
}

function remainingStartupTimeoutMs(startupDeadline: number): number {
  return Math.max(1, Math.ceil(startupDeadline - performance.now()));
}

function identityKey(identity: BackendIdentity): string {
  return JSON.stringify([
    identity.pid,
    identity.backendStart,
    identity.sessionRole,
    identity.databaseName,
    identity.applicationName,
  ]);
}

function readBackendIdentity(result: unknown): BackendIdentity | undefined {
  const [row] = rowsOf<Record<string, unknown>>(result);
  if (!row) return undefined;
  const pid = [row.pid, row.control_pid, row.participant_pid]
    .find((value): value is number => Number.isSafeInteger(value));
  const backendStart = row.backend_start;
  const sessionRole = row.session_role ?? row.role_name ?? row.usename ?? row.session_user;
  const databaseName = row.database_name ?? row.datname;
  const applicationName = row.application_name ?? row.session_tag;
  return pid !== undefined && typeof backendStart === "string" &&
      typeof sessionRole === "string" && typeof databaseName === "string" &&
      typeof applicationName === "string"
    ? { pid, backendStart, sessionRole, databaseName, applicationName }
    : undefined;
}

async function readStartupBackendIdentity(db: SqlExecutor): Promise<BackendIdentity> {
  const [physical] = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT activity.pid,
      activity.backend_start::text AS backend_start,
      activity.xact_start::text AS xact_start
    FROM pg_stat_activity activity
    WHERE activity.pid = pg_backend_pid()
  `));
  const [session] = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT session_user::text AS session_role,
      current_database()::text AS database_name,
      current_setting('application_name')::text AS session_tag
  `));
  const identity = readBackendIdentity([{ ...physical, ...session }]);
  if (!identity) throw new Error("startup participant identity unavailable");
  return identity;
}

async function readControlBackendIdentity(db: SqlExecutor): Promise<BackendIdentity> {
  const identity = readBackendIdentity(await db.execute(sql`
    SELECT activity.pid,
      activity.backend_start::text AS backend_start,
      activity.xact_start::text AS xact_start,
      activity.usename::text AS session_role,
      activity.datname::text AS database_name,
      activity.application_name::text AS application_name
    FROM pg_stat_activity activity
    WHERE activity.pid = pg_backend_pid()
  `));
  if (!identity) throw new Error("owner control identity unavailable");
  return identity;
}

function ownerTransportOptions(ownerDb: Db): OwnerTransportOptions {
  return (ownerDb as unknown as { $client: { options: OwnerTransportOptions } }).$client.options;
}

function createDedicatedOwnerSession(
  ownerOptions: OwnerTransportOptions,
  applicationName: string,
): DedicatedOwnerSession {
  const {
    shared: _shared,
    parameters: _parameters,
    serializers: _serializers,
    parsers: _parsers,
    ...cloneableOptions
  } = ownerOptions;
  // Preserve an explicitly empty owner password losslessly through postgres.js reparsing. A bare
  // "" is falsy, so `o.pass || o.password || env.PGPASSWORD` would silently inherit ambient
  // PGPASSWORD; a truthy password callback returning "" keeps the exact empty credential.
  const clonedPass = typeof ownerOptions.pass === "string" && ownerOptions.pass.length === 0
    ? () => ""
    : ownerOptions.pass;
  const client = postgres({
    ...cloneableOptions,
    pass: clonedPass,
    password: ownerOptions.pass,
    connection: {
      ...ownerOptions.connection,
      application_name: applicationName,
      statement_timeout,
      lock_timeout,
      idle_in_transaction_session_timeout,
    },
    debug: false,
    max: 1,
    connect_timeout: 5,
    idle_timeout: owner_pool_idle_timeout_seconds,
  } as unknown as postgres.Options<{}>);
  const db = drizzlePg(client) as unknown as Db;
  // First-call-wins disposal: whichever of end()/disposeNow() runs first pins the memoized
  // client.end promise, so the control session is torn down exactly once with exactly one timeout.
  // Normal shutdown uses end({ timeout: 5 }); the timer-fired emergency path uses end({ timeout: 0 }).
  let disposal: Promise<void> | null = null;
  return {
    applicationName,
    db,
    end: () => (disposal ??= client.end({ timeout: 5 })),
    disposeNow: () => (disposal ??= client.end({ timeout: 0 })),
  };
}

async function setStartupTransactionTimeouts(
  db: SqlExecutor,
  startupDeadline: number,
): Promise<void> {
  const remainingMs = remainingStartupTimeoutMs(startupDeadline);
  const remainingLockMs = Math.min(lock_timeout, remainingMs);
  const remainingIdleMs = Math.min(
    idle_in_transaction_session_timeout,
    remainingMs + 500,
  );
  await db.execute(sql`
    SELECT set_config('statement_timeout', ${`${remainingMs}ms`}, true),
      set_config('lock_timeout', ${`${remainingLockMs}ms`}, true),
      set_config(
        'idle_in_transaction_session_timeout',
        ${`${remainingIdleMs}ms`},
        true
      )
  `);
}

function rememberIdentity(
  history: Map<string, TrackedIdentity>,
  tracked: TrackedIdentity,
): void {
  history.set(identityKey(tracked.identity), tracked);
}

function readBackendIdentities(result: unknown): BackendIdentity[] {
  return rowsOf<Record<string, unknown>>(result)
    .map((row) => readBackendIdentity([row]))
    .filter((identity): identity is BackendIdentity => identity !== undefined);
}

/**
 * Bound one control/verifier session's acquisition + Drizzle query/poll work under a single
 * immutable {@link CONTROL_SESSION_DEADLINE_MS} absolute session deadline. Exactly one causal
 * timer owns the deadline: if it fires, first-call-wins disposal emergency-closes the session with
 * end({ timeout: 0 }) — the only local mechanism that settles a blackholed acquisition or query —
 * and this rejects. If the scoped work settles first, the timer is cleared and the session is
 * disposed normally with end({ timeout: 5 }). Both the scoped work and the disposal are awaited so
 * nothing is abandoned, and emergency zero-time disposal is reachable only from the timer-fired path.
 */
async function runWithControlSessionDeadline(
  session: DedicatedOwnerSession,
  work: () => Promise<void>,
): Promise<void> {
  const scopedWork = work();
  void scopedWork.catch(() => {});
  const settledWork = scopedWork.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineFired = false;
  let emergencyDisposal: Promise<void> | undefined;
  const expiry = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => {
      deadlineFired = true;
      emergencyDisposal = session.disposeNow();
      void emergencyDisposal.catch(() => {});
      resolve();
    }, CONTROL_SESSION_DEADLINE_MS);
  });
  await Promise.race([settledWork, expiry]);
  if (deadlineFired) {
    await (emergencyDisposal ?? session.disposeNow());
    await settledWork;
    throw new Error("distributed execution control session deadline expired");
  }
  clearTimeout(deadlineTimer);
  await session.end();
  const outcome = await settledWork;
  if (!outcome.ok) throw outcome.error;
}

async function cancelTrackedParticipantQueries(input: {
  ownerOptions: OwnerTransportOptions;
  applicationName: string;
  participantApplicationName: string;
  discoverParticipant: boolean;
  activeIdentities: ReadonlyMap<string, TrackedIdentity>;
  history: Map<string, TrackedIdentity>;
}): Promise<void> {
  const control = createDedicatedOwnerSession(input.ownerOptions, input.applicationName);
  await runWithControlSessionDeadline(control, async () => {
    await control.db.transaction(async (transaction) => {
      const controlIdentity = await readControlBackendIdentity(transaction);
      rememberIdentity(input.history, { role: "owner", identity: controlIdentity });
      const targets = new Map(input.activeIdentities);
      if (input.discoverParticipant) {
        const discovered = readBackendIdentities(await transaction.execute(sql`
          SELECT activity.pid,
            activity.backend_start::text AS backend_start,
            activity.xact_start::text AS xact_start,
            activity.usename::text AS session_role,
            activity.datname::text AS database_name,
            activity.application_name::text AS application_name
          FROM pg_stat_activity activity
          WHERE activity.application_name = ${input.participantApplicationName}
            AND activity.state = 'active'
            AND NOT (
              activity.pid = pg_backend_pid()
              AND activity.backend_start = (
                SELECT current_activity.backend_start
                FROM pg_stat_activity current_activity
                WHERE current_activity.pid = pg_backend_pid()
              )
              AND activity.usename = session_user
              AND activity.datname = current_database()
              AND activity.application_name = current_setting('application_name')
            )
        `));
        if (discovered.length > 1) {
          throw new Error("owner participant tag matched multiple active sessions");
        }
        const [participantIdentity] = discovered;
        if (participantIdentity) {
          const tracked = { role: "owner" as const, identity: participantIdentity };
          targets.set(identityKey(participantIdentity), tracked);
          rememberIdentity(input.history, tracked);
        }
      }
      for (const { identity } of targets.values()) {
        await transaction.execute(sql`
          SELECT pg_cancel_backend(activity.pid) AS cancelled
          FROM pg_stat_activity activity
          WHERE activity.pid = ${identity.pid}
            AND activity.backend_start = ${identity.backendStart}::timestamptz
            AND activity.usename = ${identity.sessionRole}
            AND activity.datname = ${identity.databaseName}
            AND activity.application_name = ${identity.applicationName}
            AND activity.state = 'active'
            AND NOT (
              activity.pid = pg_backend_pid()
              AND activity.backend_start = (
                SELECT current_activity.backend_start
                FROM pg_stat_activity current_activity
                WHERE current_activity.pid = pg_backend_pid()
              )
              AND activity.usename = session_user
              AND activity.datname = current_database()
              AND activity.application_name = current_setting('application_name')
            )
        `);
      }
    });
  });
}

function cleanupIdentityValues(history: ReadonlyMap<string, TrackedIdentity>) {
  const identities = [...history.values()].map(({ identity }) => identity);
  const values = identities.length > 0
    ? identities.map((identity) => sql`(
        ${identity.pid}::integer,
        ${identity.backendStart}::timestamptz,
        ${identity.sessionRole}::text,
        ${identity.databaseName}::text,
        ${identity.applicationName}::text
      )`)
    : [sql`(-1::integer, '-infinity'::timestamptz, ''::text, ''::text, ''::text)`];
  return sql.join(values, sql`, `);
}

async function assertTrackedParticipantsClosed(input: {
  ownerOptions: OwnerTransportOptions;
  applicationName: string;
  history: ReadonlyMap<string, TrackedIdentity>;
}): Promise<void> {
  const verifier = createDedicatedOwnerSession(input.ownerOptions, input.applicationName);
  const priorIdentities = cleanupIdentityValues(input.history);
  await runWithControlSessionDeadline(verifier, async () => {
    const cleanupStartedAt = performance.now();
    do {
      const [receipt] = rowsOf<{
        participant_pids_gone: boolean;
        owner_out_of_transaction: boolean;
        advisory_locks_gone: boolean;
      }>(await verifier.db.transaction(async (control) => {
        await readControlBackendIdentity(control);
        return control.execute(sql`
          WITH prior_identity(
            pid,
            backend_start,
            session_role,
            database_name,
            application_name
          ) AS (VALUES ${priorIdentities})
          SELECT
            NOT EXISTS (
              SELECT 1
              FROM prior_identity prior
              JOIN pg_stat_activity activity
                ON activity.pid = prior.pid
                AND activity.backend_start = prior.backend_start
                AND activity.usename = prior.session_role
                AND activity.datname = prior.database_name
                AND activity.application_name = prior.application_name
              WHERE NOT (
                activity.pid = pg_backend_pid()
                AND activity.backend_start = (
                  SELECT current_activity.backend_start
                  FROM pg_stat_activity current_activity
                  WHERE current_activity.pid = pg_backend_pid()
                )
                AND activity.usename = session_user
                AND activity.datname = current_database()
                AND activity.application_name = current_setting('application_name')
              )
            ) AS participant_pids_gone,
            NOT EXISTS (
              SELECT 1
              FROM prior_identity prior
              JOIN pg_stat_activity activity
                ON activity.pid = prior.pid
                AND activity.backend_start = prior.backend_start
                AND activity.usename = prior.session_role
                AND activity.datname = prior.database_name
                AND activity.application_name = prior.application_name
              WHERE (activity.state <> 'idle' OR activity.xact_start IS NOT NULL)
                AND activity.pid <> pg_backend_pid()
            ) AS owner_out_of_transaction,
            NOT EXISTS (
              SELECT 1
              FROM prior_identity prior
              JOIN pg_stat_activity activity
                ON activity.pid = prior.pid
                AND activity.backend_start = prior.backend_start
                AND activity.usename = prior.session_role
                AND activity.datname = prior.database_name
                AND activity.application_name = prior.application_name
              JOIN pg_locks participant_lock ON participant_lock.pid = activity.pid
              WHERE participant_lock.locktype = 'advisory'
                AND activity.pid <> pg_backend_pid()
            ) AS advisory_locks_gone
        `);
      }));
      if (receipt?.participant_pids_gone && receipt.owner_out_of_transaction &&
        receipt.advisory_locks_gone) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } while (performance.now() - cleanupStartedAt < STARTUP_CLOSE_TIMEOUT_MS);
    throw new Error("distributed execution participant cleanup did not settle");
  });
}

function isRuntimeOwnerDb(value: unknown): value is Db {
  if (typeof value !== "object" || value === null ||
    typeof (value as { execute?: unknown }).execute !== "function" ||
    typeof (value as { transaction?: unknown }).transaction !== "function") return false;
  try {
    const options = (value as {
      $client?: { options?: Partial<OwnerTransportOptions> };
    }).$client?.options;
    if (options === undefined) return false;
    const socket = (options as { socket?: unknown }).socket;
    const sslIsValid = typeof options.ssl === "boolean" ||
      options.ssl === "require" || options.ssl === "allow" ||
      options.ssl === "prefer" || options.ssl === "verify-full" ||
      (typeof options.ssl === "object" && options.ssl !== null);
    // b3d8 stable-endpoint contract: the owner transport must be exactly one native TCP host/port
    // pair or one native Unix path — never a custom `socket` callback and never explicit
    // multi-host. HA/failover belongs behind one stable endpoint; a host list is not one cluster.
    return typeof socket !== "function" &&
      Array.isArray(options.host) && options.host.length === 1 &&
      options.host.every((host) => typeof host === "string" && host.length > 0) &&
      Array.isArray(options.port) && options.port.length === 1 &&
      options.port.every((port) => Number.isSafeInteger(port) && port > 0 && port <= 65_535) &&
      typeof options.database === "string" && options.database.length > 0 &&
      typeof options.user === "string" && options.user.length > 0 &&
      (typeof options.pass === "string" || typeof options.pass === "function") &&
      sslIsValid && typeof options.connection === "object" && options.connection !== null &&
      typeof options.prepare === "boolean" && typeof options.fetch_types === "boolean" &&
      typeof options.types === "object" && options.types !== null;
  } catch {
    return false;
  }
}

function isRuntimeRequiredMigrationIdentity(
  value: unknown,
): value is RequiredMigrationIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { orderedHashes?: unknown; ledgerSha256?: unknown };
  if (!Array.isArray(candidate.orderedHashes) || candidate.orderedHashes.length === 0 ||
    candidate.orderedHashes.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) ||
    new Set(candidate.orderedHashes).size !== candidate.orderedHashes.length ||
    typeof candidate.ledgerSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.ledgerSha256)) return false;
  return candidate.ledgerSha256 === createHash("sha256")
    .update(JSON.stringify(candidate.orderedHashes))
    .digest("hex");
}

function isRuntimeDatabaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  const scheme = /^(postgres(?:ql)?):\/\//u.exec(value);
  if (!scheme) return false;
  try {
    const authorityStart = scheme[0].length;
    const pathStart = value.indexOf("/", authorityStart);
    if (pathStart < 0) return false;
    const authority = value.slice(authorityStart, pathStart);
    const pathAndSuffix = value.slice(pathStart);
    const databasePath = pathAndSuffix.split(/[?#]/u, 1)[0];
    if (authority.length === 0 || databasePath.length <= 1) return false;
    const at = authority.lastIndexOf("@");
    const credentials = at >= 0 ? authority.slice(0, at + 1) : "";
    const hostList = authority.slice(at + 1);
    if (hostList.length === 0) return false;
    const hosts: string[] = [];
    let bracketDepth = 0;
    let hostStart = 0;
    for (let index = 0; index <= hostList.length; index += 1) {
      const character = hostList[index];
      if (character === "[") bracketDepth += 1;
      else if (character === "]") bracketDepth -= 1;
      if (bracketDepth < 0) return false;
      if ((character === "," && bracketDepth === 0) || index === hostList.length) {
        const host = hostList.slice(hostStart, index);
        if (host.length === 0) return false;
        hosts.push(host);
        hostStart = index + 1;
      }
    }
    // b3d8 stable-endpoint contract: an app/operator URL names exactly one native TCP authority.
    // An explicit host list is client-side rotation, not one stable endpoint, and is rejected.
    if (bracketDepth !== 0 || hosts.length !== 1) return false;
    for (const host of hosts) {
      if (/\s/u.test(host)) return false;
      const bracketed = /^\[[^\]]+\](?::([0-9]+))?$/u.exec(host);
      if (host.startsWith("[")) {
        if (!bracketed) return false;
        if (bracketed[1] !== undefined) {
          const port = Number(bracketed[1]);
          if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return false;
        }
        continue;
      }
      if (host.includes("[" ) || host.includes("]")) return false;
      const pieces = host.split(":");
      if (pieces.length > 2 || pieces[0]?.length === 0) return false;
      if (pieces.length === 2) {
        if (!/^[0-9]+$/u.test(pieces[1] ?? "")) return false;
        const port = Number(pieces[1]);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return false;
      }
    }
    const parsed = new URL(`${scheme[1]}://${credentials}${hosts[0]}${pathAndSuffix}`);
    return (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") &&
      parsed.hostname.length > 0 && parsed.pathname.length > 1;
  } catch {
    return false;
  }
}

function throwConfigurationFailure(): never {
  const failure = new DistributedExecutionStartupError("distributed_execution_configuration");
  logger.error(
    { code: failure.message, phase: "configuration" },
    "distributed execution startup rejected",
  );
  throw failure;
}

/**
 * Opens both bounded serving pools as one startup gate. The flag-off branch does
 * not inspect credentials or allocate a pool. The flag-on branch requires both
 * exact roles; any open/identity failure closes what was opened and aborts boot.
 */
export async function openDistributedExecutionDatabases(input: {
  enabled: boolean;
  ownerDb: Db;
  requiredMigrationIdentity: RequiredMigrationIdentity;
  appDatabaseUrl: string | undefined;
  operatorDatabaseUrl: string | undefined;
}): Promise<DistributedExecutionDatabases | null> {
  if (!input.enabled) return null;

  if (input.enabled !== true || !isRuntimeOwnerDb(input.ownerDb) ||
    !isRuntimeRequiredMigrationIdentity(input.requiredMigrationIdentity) ||
    !isRuntimeDatabaseUrl(input.appDatabaseUrl) ||
    !isRuntimeDatabaseUrl(input.operatorDatabaseUrl)) throwConfigurationFailure();

  const requiredMigrationIdentity = input.requiredMigrationIdentity;
  const appDatabaseUrl = input.appDatabaseUrl;
  const operatorDatabaseUrl = input.operatorDatabaseUrl;
  const ownerOptions = ownerTransportOptions(input.ownerDb);
  const tagPrefix = `aoa_e3_${randomUUID().replaceAll("-", "")}`;
  let ownerSessionSequence = 0;
  const nextOwnerApplicationName = (purpose: "participant" | "cancel" | "verify") =>
    `${tagPrefix}_${purpose}_${++ownerSessionSequence}`;
  const participantApplicationName = nextOwnerApplicationName("participant");
  const ownerParticipant = createDedicatedOwnerSession(ownerOptions, participantApplicationName);
  const startupAbort = new AbortController();
  const startupDeadline = performance.now() + STARTUP_HANDSHAKE_TIMEOUT_MS;
  const startupTimer = setTimeout(
    () => {
      if (!startupAbort.signal.aborted) startupAbort.abort();
    },
    Math.max(0, startupDeadline - performance.now()),
  );
  const advisoryKey = randomBytes(8).readBigInt64BE();
  const participants: Promise<unknown>[] = [];
  const activeIdentities = new Map<string, TrackedIdentity>();
  const identityHistory = new Map<string, TrackedIdentity>();
  const ownerBarrier = new RejectableBarrier();
  const ownerLockedBarrier = new RejectableBarrier();
  const negativePairSequence = new RolePairSequence(STARTUP_POOL_OPTIONS.max);
  const positiveBarrier = new TwoRoleBarrier();
  const positivePairSequence = new RolePairSequence(STARTUP_POOL_OPTIONS.max);
  let phase = "configuration";
  let app: NonOwnerDbConnection | null = null;
  let operator: NonOwnerDbConnection | null = null;
  let cancellationTask: Promise<void> | null = null;
  let ownerEndTask: Promise<void> | null = null;
  const servingCloseTasks = new Map<NonOwnerDbConnection, Promise<void>>();
  let teardownStarted = false;
  let ownerTransactionsPending = 0;

  const runPhase = async <T>(_phase: string, work: () => Promise<T>): Promise<T> => {
    if (startupAbort.signal.aborted) {
      throw new DistributedExecutionStartupError("distributed_execution_timeout");
    }
    const cancellation = new Promise<never>((_resolve, reject) => {
      startupAbort.signal.addEventListener(
        "abort",
        () => reject(new Error("startup deadline expired")),
        { once: true },
      );
    });
    return await Promise.race([work(), cancellation]);
  };

  const track = <T>(participant: Promise<T>): Promise<T> => {
    participants.push(participant);
    return participant;
  };

  const runTrackedTransaction = <T>(
    db: Db,
    role: ParticipantRole,
    work: (transaction: Db, identity: BackendIdentity) => Promise<T>,
  ): Promise<T> => {
    let registeredIdentityKey: string | null = null;
    if (role === "owner") ownerTransactionsPending += 1;
    let transactionPromise: Promise<T>;
    try {
      transactionPromise = db.transaction(async (transaction) => {
        await setStartupTransactionTimeouts(transaction, startupDeadline);
        const identity = await readStartupBackendIdentity(transaction);
        const tracked = { role, identity };
        registeredIdentityKey = identityKey(identity);
        activeIdentities.set(registeredIdentityKey, tracked);
        rememberIdentity(identityHistory, tracked);
        if (startupAbort.signal.aborted) {
          throw new DistributedExecutionStartupError("distributed_execution_timeout");
        }
        return work(transaction as unknown as Db, identity);
      }) as Promise<T>;
    } catch (error) {
      if (role === "owner") ownerTransactionsPending -= 1;
      throw error;
    }
    const participant = transactionPromise.finally(() => {
      if (registeredIdentityKey !== null) activeIdentities.delete(registeredIdentityKey);
      if (role === "owner") ownerTransactionsPending -= 1;
    });
    return track(participant);
  };

  const runSharedTransactions = async (
    connection: NonOwnerDbConnection,
    role: ServingRole,
    expected: boolean,
    onAcquired?: () => Promise<void>,
    beforeLock?: (index: number) => Promise<void>,
    afterLock?: (index: number) => void,
  ): Promise<void> => {
    const transactions = Array.from({ length: STARTUP_POOL_OPTIONS.max }, (_, index) =>
      runTrackedTransaction(connection.db, role, async (transaction) => {
        if (beforeLock) await beforeLock(index);
        const lockResult = await transaction.execute(sql`
          SELECT pg_try_advisory_xact_lock_shared(${advisoryKey}) AS acquired
        `);
        if (firstRowBoolean(lockResult) !== expected) {
          throw new Error("unexpected advisory domain result");
        }
        if (onAcquired) await onAcquired();
        if (afterLock) afterLock(index);
      }));
    await Promise.all(transactions);
  };

  const rejectStartupBarriers = () => {
    ownerBarrier.reject();
    ownerLockedBarrier.reject();
    negativePairSequence.reject();
    positiveBarrier.reject();
    positivePairSequence.reject();
  };

  // Idempotently memo-start forced disposal. The b3d8 teardown contract requires owner
  // end({ timeout: 5 }) and every allocated serving close({ timeoutSeconds: 5 }) plus exact
  // cancellation to be STARTED synchronously on abort, before any participant transaction is
  // awaited: a forced pool close is the only local mechanism that settles a blackholed
  // transaction, so it must not wait behind Promise.allSettled(participants). Cancellation is a
  // best-effort interrupt that a dead transport may drop.
  const startTeardown = () => {
    if (teardownStarted) return;
    teardownStarted = true;
    ownerEndTask = ownerParticipant.end();
    void ownerEndTask.catch(() => {});
    for (const serving of [operator, app]) {
      if (serving && !servingCloseTasks.has(serving)) {
        const closing = serving.close({ timeoutSeconds: 5 });
        servingCloseTasks.set(serving, closing);
        void closing.catch(() => {});
      }
    }
    cancellationTask ??= cancelTrackedParticipantQueries({
      ownerOptions,
      applicationName: nextOwnerApplicationName("cancel"),
      participantApplicationName,
      discoverParticipant: ownerTransactionsPending > 0,
      activeIdentities: new Map(activeIdentities),
      history: identityHistory,
    });
    void cancellationTask.catch(() => {});
  };

  const handleStartupAbort = () => {
    rejectStartupBarriers();
    startTeardown();
  };
  startupAbort.signal.addEventListener("abort", handleStartupAbort, { once: true });

  const closeAndVerify = async (
    servingConnections: readonly NonOwnerDbConnection[],
  ): Promise<void> => {
    const closeResults = await Promise.allSettled([
      closeBoundedDatabaseConnections(servingConnections),
      ownerParticipant.end(),
    ]);
    let failed = closeResults.some((result) => result.status === "rejected");
    try {
      await assertTrackedParticipantsClosed({
        ownerOptions,
        applicationName: nextOwnerApplicationName("verify"),
        history: identityHistory,
      });
    } catch {
      failed = true;
    }
    if (failed) throw new Error("distributed execution close did not settle");
  };

  try {
    phase = "migration-identity";
    await runPhase("migration-identity", async () => {
      try {
        await runTrackedTransaction(ownerParticipant.db, "owner", async (transaction) => {
          await assertRequiredMigrationIdentity(transaction, requiredMigrationIdentity);
        });
      } catch (error) {
        if (startupAbort.signal.aborted || isTimeoutOrDisconnect(error)) throw error;
        throw new DistributedExecutionStartupError("distributed_execution_migration_identity");
      }
    });

    phase = "app-authority";
    await runPhase("app-authority", async () => {
      try {
        app = createTenantAppDbConnection(appDatabaseUrl, STARTUP_POOL_OPTIONS);
        await runTrackedTransaction(app.db, "aoa_app", async (transaction) => {
          await assertNonOwnerConnection(transaction, "aoa_app");
          await assertExactServingRoleAuthority(transaction, "aoa_app");
          await assertExactCatalogCertificate(transaction);
        });
      } catch (error) {
        if (startupAbort.signal.aborted || isTimeoutOrDisconnect(error)) throw error;
        throw new DistributedExecutionStartupError("distributed_execution_app_authority");
      }
    });

    phase = "operator-authority";
    await runPhase("operator-authority", async () => {
      try {
        operator = createOperatorDbConnection(operatorDatabaseUrl, STARTUP_POOL_OPTIONS);
        await runTrackedTransaction(operator.db, "aoa_operator", async (transaction) => {
          await assertNonOwnerConnection(transaction, "aoa_operator");
          await assertExactServingRoleAuthority(transaction, "aoa_operator");
        });
      } catch (error) {
        if (startupAbort.signal.aborted || isTimeoutOrDisconnect(error)) throw error;
        throw new DistributedExecutionStartupError("distributed_execution_operator_authority");
      }
    });

    phase = "owner-exclusive";
    const ownerPhase = runPhase("owner-exclusive", async () => {
      await runTrackedTransaction(ownerParticipant.db, "owner", async (transaction) => {
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(${advisoryKey})`);
        ownerLockedBarrier.resolve();
        await ownerBarrier.wait();
      });
    });
    await Promise.race([
      ownerLockedBarrier.wait(),
      ownerPhase.then(() => { throw new Error("owner lock phase ended before peer probes"); }),
    ]);

    phase = "negative-peers";
    await Promise.all([
      runPhase("app-negative", async () => {
        await runSharedTransactions(
          app!,
          "aoa_app",
          false,
          undefined,
          async (index) => negativePairSequence.wait(index),
          (index) => negativePairSequence.complete(index, "aoa_app"),
        );
      }),
      runPhase("operator-negative", async () => {
        await runSharedTransactions(
          operator!,
          "aoa_operator",
          false,
          undefined,
          async (index) => negativePairSequence.wait(index),
          (index) => negativePairSequence.complete(index, "aoa_operator"),
        );
      }),
    ]);
    ownerBarrier.resolve();
    await ownerPhase;

    phase = "positive-peers";
    await Promise.all([
      runPhase("app-positive", async () => {
        await runSharedTransactions(app!, "aoa_app", true, async () => {
          await positiveBarrier.wait("aoa_app");
        }, async (index) => positivePairSequence.wait(index),
        (index) => positivePairSequence.complete(index, "aoa_app"));
      }),
      runPhase("operator-positive", async () => {
        await runSharedTransactions(operator!, "aoa_operator", true, async () => {
          await positiveBarrier.wait("aoa_operator");
        }, async (index) => positivePairSequence.wait(index),
        (index) => positivePairSequence.complete(index, "aoa_operator"));
      }),
    ]);
    const settlements = await Promise.allSettled(participants);
    if (settlements.some((settlement) => settlement.status === "rejected")) {
      throw new Error("advisory participant did not settle successfully");
    }
    if (app === null || operator === null) {
      throw new Error("distributed execution serving pools were not verified");
    }
    const verifiedApp = app as NonOwnerDbConnection;
    const verifiedOperator = operator as NonOwnerDbConnection;
    let closeTask: Promise<void> | null = null;

    return {
      appDb: verifiedApp.db,
      operatorDb: verifiedOperator.db,
      close: () => {
        closeTask ??= closeAndVerify([verifiedOperator, verifiedApp]).catch(() => {
          throw new DistributedExecutionStartupError("distributed_execution_close");
        });
        return closeTask;
      },
    };
  } catch (error) {
    const timedOut = startupAbort.signal.aborted || performance.now() >= startupDeadline ||
      isTimeoutOrDisconnect(error);
    if (!startupAbort.signal.aborted) startupAbort.abort();
    rejectStartupBarriers();
    // Idempotent: the abort above already invoked startTeardown via the abort handler; this call
    // is a no-op that guarantees the forced closes are in-flight before the participant await.
    startTeardown();
    let closeFailed = false;
    // Await cancellation, the memo-started owner end, and every serving close together. Because
    // those forced closes are what settle a blackholed participant, they are not sequenced after
    // participant settlement — awaiting participants here can only proceed once the closes land.
    const disposalSettlements = await Promise.allSettled([
      ...(cancellationTask ? [cancellationTask] : []),
      ...(ownerEndTask ? [ownerEndTask] : []),
      ...servingCloseTasks.values(),
    ]);
    await Promise.allSettled(participants);
    if (disposalSettlements.some((settlement) => settlement.status === "rejected")) {
      closeFailed = true;
    }

    try {
      await assertTrackedParticipantsClosed({
        ownerOptions,
        applicationName: nextOwnerApplicationName("verify"),
        history: identityHistory,
      });
    } catch {
      closeFailed = true;
    }

    const stable = closeFailed
      ? new DistributedExecutionStartupError("distributed_execution_close")
      : error instanceof DistributedExecutionStartupError
        ? error
        : timedOut
          ? new DistributedExecutionStartupError("distributed_execution_timeout")
          : new DistributedExecutionStartupError("distributed_execution_advisory_domain");
    logger.error({ code: stable.message, phase }, "distributed execution startup rejected");
    throw stable;
  } finally {
    clearTimeout(startupTimer);
    startupAbort.signal.removeEventListener("abort", handleStartupAbort);
  }
}
