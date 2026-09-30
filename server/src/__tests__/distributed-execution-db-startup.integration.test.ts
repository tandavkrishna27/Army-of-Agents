import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres, { type Sql } from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, type Db } from "@armyofagents/db";
import * as dbSchema from "@armyofagents/db";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import {
  provisionTenantAppRoleLoginSql,
  TENANT_APP_ROLE,
} from "../db/rls-tenant.js";
import { openDistributedExecutionDatabases } from "../db/distributed-execution-databases.js";
import * as legacyGrants from "../db/job-control-legacy-grants.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const APP_PASSWORD = "startup-app-password";
const OPERATOR_PASSWORD = "startup-operator-password";
const LEGACY_OWNER_PASSWORD = "startup-legacy-owner-password";
const DRIVER_CAUSE_SENTINEL = "JOB003_DRIVER_CAUSE_SENTINEL_7F4C";
const SQL_SENTINEL = "JOB003_SQL_SENTINEL_91DA";
const STARTUP_ERROR_CODES = new Set([
  "distributed_execution_configuration",
  "distributed_execution_migration_identity",
  "distributed_execution_app_authority",
  "distributed_execution_operator_authority",
  "distributed_execution_advisory_domain",
  "distributed_execution_timeout",
  "distributed_execution_close",
]);
const STARTUP_LOG_PHASES = new Set([
  "configuration",
  "migration-identity",
  "app-authority",
  "operator-authority",
  "owner-exclusive",
  "negative-peers",
  "positive-peers",
]);

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let adminUrl = "";
let appUrl = "";
let operatorUrl = "";
let legacyOwnerUrl = "";
let otherAdminUrl = "";
let otherAppUrl = "";
let otherOperatorUrl = "";
let admin: Sql | null = null;
let ownerClient: Sql | null = null;
let ownerDb: Db | null = null;
let setupError: unknown = null;

function guard(): void {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
}

function withStartupRole(url: string, role: "aoa_app" | "aoa_operator"): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}options=${encodeURIComponent(`-c role=${role}`)}`;
}

function withApplicationName(url: string, applicationName: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}application_name=${encodeURIComponent(applicationName)}`;
}

function expectCaseInsensitiveRedaction(surface: string, forbidden: readonly string[]): void {
  const normalized = surface.toLowerCase();
  for (const value of forbidden) {
    expect(normalized, `disclosed forbidden value ${value}`).not.toContain(value.toLowerCase());
  }
}

function assertClosedStartupLogs(logs: readonly unknown[][]): void {
  expect(logs.length, "startup failure must emit one closed structured diagnostic").toBeGreaterThan(0);
  for (const args of logs) {
    expect(args).toHaveLength(2);
    expect(args[1]).toBe("distributed execution startup rejected");
    expect(args[0]).not.toBeNull();
    expect(typeof args[0]).toBe("object");
    const fields = args[0] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["code", "phase"]);
    expect(STARTUP_ERROR_CODES.has(String(fields.code))).toBe(true);
    expect(STARTUP_LOG_PHASES.has(String(fields.phase))).toBe(true);
  }
}

type RequiredMigrationIdentity = { orderedHashes: readonly string[]; ledgerSha256: string };

function checkedInMigrationIdentity(): RequiredMigrationIdentity {
  const journal = JSON.parse(readFileSync(
    new URL("../../../packages/db/src/migrations/meta/_journal.json", import.meta.url),
    "utf8",
  )) as { entries?: Array<{ idx?: number; tag?: string }> };
  const orderedHashes = (journal.entries ?? []).map((entry) => createHash("sha256").update(readFileSync(
      new URL(`../../../packages/db/src/migrations/${entry.tag}.sql`, import.meta.url),
    )).digest("hex"));
  return {
    orderedHashes,
    ledgerSha256: createHash("sha256").update(JSON.stringify(orderedHashes)).digest("hex"),
  };
}

const openFinalStartup = openDistributedExecutionDatabases as unknown as (input: {
  enabled: boolean;
  ownerDb: Db;
  requiredMigrationIdentity: RequiredMigrationIdentity;
  appDatabaseUrl: string | undefined;
  operatorDatabaseUrl: string | undefined;
}) => ReturnType<typeof openDistributedExecutionDatabases>;

function finalStartupInput(input: {
  appDatabaseUrl: string;
  operatorDatabaseUrl: string;
}) {
  if (!ownerDb) throw new Error("owner database was not initialized");
  return {
    enabled: true,
    ownerDb,
    requiredMigrationIdentity: checkedInMigrationIdentity(),
    ...input,
  };
}

async function captureFinalStartupFailure(): Promise<unknown> {
  let accepted: Awaited<ReturnType<typeof openDistributedExecutionDatabases>> = null;
  try {
    accepted = await openFinalStartup(finalStartupInput({
      appDatabaseUrl: appUrl,
      operatorDatabaseUrl: operatorUrl,
    }));
    return undefined;
  } catch (error) {
    return error;
  } finally {
    await accepted?.close().catch(() => {});
  }
}

const LEASE_REJECTION_POLICY_SQL = `CREATE POLICY worker_lease_rejections_tenant_isolation
  ON worker_lease_rejections AS PERMISSIVE FOR ALL TO aoa_app
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid)`;

async function restoreLeaseRejectionPolicy(): Promise<void> {
  await admin!.unsafe(`DROP POLICY IF EXISTS worker_lease_rejections_tenant_isolation
    ON worker_lease_rejections`);
  await admin!.unsafe(LEASE_REJECTION_POLICY_SQL);
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-distributed-startup-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocateEmbeddedPgPort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(adminUrl);
    admin = postgres(adminUrl, { max: 1 });
    ownerClient = postgres(adminUrl, { max: 4 });
    ownerDb = drizzlePg(ownerClient, { schema: dbSchema }) as unknown as Db;
    await admin.unsafe(provisionTenantAppRoleLoginSql(TENANT_APP_ROLE, APP_PASSWORD));
    const exists = await admin<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_operator') AS exists
    `;
    if (!exists[0]?.exists) {
      await admin.unsafe(
        `CREATE ROLE "aoa_operator" LOGIN PASSWORD '${OPERATOR_PASSWORD}' ` +
          "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
    } else {
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", OPERATOR_PASSWORD));
    }
    appUrl = adminUrl.replace("test:test", `aoa_app:${APP_PASSWORD}`);
    operatorUrl = adminUrl.replace("test:test", `aoa_operator:${OPERATOR_PASSWORD}`);
    await admin.unsafe(
      `CREATE ROLE "aoa_legacy_table_owner" LOGIN PASSWORD '${LEGACY_OWNER_PASSWORD}' ` +
        "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION",
    );
    await admin.unsafe(`CREATE DATABASE startup_other`);
    otherAdminUrl = adminUrl.replace(/\/postgres$/, "/startup_other");
    await applyPendingMigrations(otherAdminUrl);
    otherAppUrl = otherAdminUrl.replace("test:test", `aoa_app:${APP_PASSWORD}`);
    otherOperatorUrl = otherAdminUrl.replace("test:test", `aoa_operator:${OPERATOR_PASSWORD}`);
    await admin.unsafe(`CREATE DATABASE startup_legacy_owner`);
    const legacyAdminUrl = adminUrl.replace(/\/postgres$/, "/startup_legacy_owner");
    await applyPendingMigrations(legacyAdminUrl);
    const legacySetup = postgres(legacyAdminUrl, { max: 1 });
    try {
      await legacySetup.unsafe(
        `GRANT USAGE ON SCHEMA public, drizzle TO "aoa_legacy_table_owner"`,
      );
      await legacySetup.unsafe(
        `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "aoa_legacy_table_owner"`,
      );
      await legacySetup.unsafe(
        `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "aoa_legacy_table_owner"`,
      );
      await legacySetup.unsafe(
        `GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO "aoa_legacy_table_owner"`,
      );
      await legacySetup.unsafe(`ALTER TABLE execution_targets OWNER TO "aoa_legacy_table_owner"`);
    } finally {
      await legacySetup.end();
    }
    legacyOwnerUrl = legacyAdminUrl.replace(
      "test:test",
      `aoa_legacy_table_owner:${LEGACY_OWNER_PASSWORD}`,
    );
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await ownerClient?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

async function observeStartup(input: {
  appDatabaseUrl: string;
  operatorDatabaseUrl: string;
  expectedCode?: "distributed_execution_app_authority" | "distributed_execution_operator_authority";
}): Promise<{ exited: boolean; code: number | null; output: string }> {
  return observeServer({
    databaseUrl: adminUrl,
    distributedEnabled: true,
    appDatabaseUrl: input.appDatabaseUrl,
    operatorDatabaseUrl: input.operatorDatabaseUrl,
    expectedFailureCode: input.expectedCode,
    forbiddenFailureValues: [
      DRIVER_CAUSE_SENTINEL,
      SQL_SENTINEL,
      ...checkedInMigrationIdentity().orderedHashes,
      adminUrl,
      input.appDatabaseUrl,
      input.operatorDatabaseUrl,
      APP_PASSWORD,
      OPERATOR_PASSWORD,
      "wrong-password",
      "test:test",
      "postgres://",
      "aoa_app",
      "aoa_operator",
    ],
  });
}

async function observeServer(input: {
  databaseUrl: string;
  distributedEnabled: boolean;
  appDatabaseUrl?: string;
  operatorDatabaseUrl?: string;
  expectedFailureCode?: string;
  forbiddenFailureValues?: readonly string[];
  sentinelMode?: "deny" | "record" | "identity" |
    "bootstrap-record" | "bootstrap-loader-deny" | "bootstrap-env-deny" |
    "bootstrap-allocation-deny";
}): Promise<{ exited: boolean; code: number | null; output: string }> {
  const httpPort = await allocateEmbeddedPgPort();
  const serverEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const sentinel = pathToFileURL(
    fileURLToPath(new URL("./fixtures/job-control-module-load-sentinel.mjs", import.meta.url)),
  ).href;
  const child = spawn(process.execPath, [
    ...(input.sentinelMode ? ["--import", sentinel] : []),
    "--import", "tsx", serverEntry,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: input.databaseUrl,
      AOA_DISTRIBUTED_EXECUTION_ENABLED: input.distributedEnabled ? "true" : "false",
      ...(input.distributedEnabled
        ? { AOA_WORKER_SESSION_SIGNING_KEY: "job003-startup-fixture-signing-key-0001" }
        : {}),
      ...(input.appDatabaseUrl ? { AOA_APP_DATABASE_URL: input.appDatabaseUrl } : {}),
      ...(input.operatorDatabaseUrl ? { AOA_OPERATOR_DATABASE_URL: input.operatorDatabaseUrl } : {}),
      AOA_DEPLOYMENT_MODE: "local_trusted",
      AOA_DEV_LOCAL_IDENTITY: "1",
      AOA_MIGRATION_AUTO_APPLY: "true",
      SERVE_UI: "false",
      HOST: "127.0.0.1",
      PORT: String(httpPort),
      ...(input.sentinelMode ? { AOA_JOB_CONTROL_MODULE_LOAD_SENTINEL: input.sentinelMode } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const exit = new Promise<{ kind: "exit"; code: number | null }>((resolveExit) => {
    child.once("exit", (code) => resolveExit({ kind: "exit", code }));
  });
  const pollAbort = new AbortController();
  const started = (async (): Promise<{ kind: "started"; code: null } | never> => {
    while (!pollAbort.signal.aborted) {
      try {
        const response = await fetch(`http://127.0.0.1:${httpPort}/api/health`);
        if (response.ok) return { kind: "started", code: null };
      } catch {
        // Startup is still in progress or has failed; the exit promise wins on failure.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    return await new Promise<never>(() => {});
  })();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ kind: "timeout"; code: null }>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout({ kind: "timeout", code: null }), 30_000);
  });

  const outcome = await Promise.race([exit, started, timeout]);
  pollAbort.abort();
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (outcome.kind === "timeout") {
    child.kill("SIGTERM");
    await Promise.race([exit, new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))]);
    throw new Error(`server startup timed out before health or exit:\n${output}`);
  }
  if (outcome.kind === "started") {
    child.kill("SIGTERM");
    await Promise.race([exit, new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))]);
    return { exited: false, code: null, output };
  }
  if (input.expectedFailureCode) {
    expect(output).toContain(input.expectedFailureCode);
    expectCaseInsensitiveRedaction(output, input.forbiddenFailureValues ?? []);
  }
  return { exited: true, code: outcome.code, output };
}

type AdvisoryPhase =
  | "owner-exclusive"
  | "app-negative"
  | "operator-negative"
  | "app-positive"
  | "operator-positive";

const ADVISORY_PHASES: readonly AdvisoryPhase[] = [
  "owner-exclusive",
  "app-negative",
  "operator-negative",
  "app-positive",
  "operator-positive",
];

type AdvisoryPendingInjection = `${AdvisoryPhase}-pending`;

type StartupFailureInjection = AdvisoryPhase | AdvisoryPendingInjection |
  "statement-timeout" | "lock-timeout" |
  "idle-timeout" | "forced-end" | "shared-budget" | "shared-budget-pending" |
  "migration-pending" | "app-authority-pending" | "operator-authority-pending" |
  "timeout-setup-pending" | "backend-identity-pending" |
  "transaction-acquisition-pending" |
  "cleanup-pending" | "cleanup-failure-pending" |
  "cleanup-acquisition-pending" | "cleanup-failure-acquisition-pending" |
  "stale-owner-lifecycle" |
  "redaction-sentinel";

type StartupPhase =
  | "migration-identity"
  | "app-authority"
  | "operator-authority"
  | AdvisoryPhase;

type PendingQueryPhase = StartupPhase
  | "timeout-setup"
  | "backend-identity"
  | "transaction-acquisition"
  | "cleanup"
  | "cleanup-acquisition";

type StartupDeadlineReceipt = {
  readonly invocationId: number;
  readonly signal: AbortSignal;
  readonly at: number;
};

type StartupInvocationReceipt = {
  readonly id: number;
  readonly startedAt: number;
  readonly advisoryKeys: bigint[];
  readonly controllers: AbortController[];
  controllerCreatedAt: number | null;
  deadlineReceipt: StartupDeadlineReceipt | null;
  returnedAt: number | null;
};

type StartupTransactionReceipt = {
  readonly invocationId: number;
  readonly role: "owner" | "aoa_app" | "aoa_operator";
  readonly source: "shared-owner-db" | "dedicated-owner" | "serving";
  readonly dedicatedOwnerId: number | null;
  phase: PendingQueryPhase | null;
  readonly startedAt: number;
  settledAt: number | null;
  outcome: "pending" | "fulfilled" | "rejected";
};

type CleanupProbeReceipt = {
  readonly invocationId: number;
  readonly source: "shared-owner-db" | "dedicated-owner";
  readonly controlId: number | null;
  readonly startedAt: number;
  settledAt: number | null;
  outcome: "pending" | "fulfilled" | "rejected";
  participantPidsGone: boolean | null;
};

type OwnerQuerySemantic =
  | "timeout-setup"
  | "backend-identity"
  | "migration-identity"
  | "owner-advisory"
  | "cancellation-discovery"
  | "cancellation"
  | "cleanup"
  | "other";

type OwnerQueryReceipt = {
  readonly invocationId: number;
  readonly source: "shared-owner-db" | "dedicated-owner";
  readonly dedicatedOwnerId: number | null;
  readonly semantic: OwnerQuerySemantic;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly startedAt: number;
  settledAt: number | null;
  outcome: "pending" | "fulfilled" | "rejected";
  dryRun: CancellationDryRunReceipt | null;
};

type DedicatedOwnerIdentity = {
  readonly pid: number;
  readonly backendStart: string;
  readonly sessionRole: string;
  readonly databaseName: string;
  readonly applicationName: string;
};

type CancellationIdentityField = keyof DedicatedOwnerIdentity;

type CancellationDryRunMutation = {
  readonly targetPid: number;
  readonly field: CancellationIdentityField;
  readonly parameterIndex: number;
  readonly candidatePids: readonly number[];
};

type CancellationDryRunSubstitution = {
  readonly targetPid: number;
  readonly candidatePids: readonly number[];
};

type CancellationDryRunReceipt = {
  readonly startedAt: number;
  settledAt: number | null;
  outcome: "pending" | "fulfilled" | "rejected";
  targetAlias: string | null;
  controlIdentity: DedicatedOwnerIdentity | null;
  readonly candidateIdentities: DedicatedOwnerIdentity[];
  readonly targetIdentities: DedicatedOwnerIdentity[];
  readonly originalCandidatePids: number[];
  readonly mutations: CancellationDryRunMutation[];
  readonly controlSubstitutions: CancellationDryRunSubstitution[];
};

type PendingQueryReceipt = {
  readonly invocationId: number;
  readonly phase: PendingQueryPhase;
  readonly role: "owner" | "aoa_app" | "aoa_operator";
  readonly source: StartupTransactionReceipt["source"];
  readonly dedicatedOwnerId: number | null;
  backendPid: number | null;
  effectiveStatementTimeout: string | null;
  readonly signal: AbortSignal | null;
  abortObservedAt: number | null;
  readonly startedAt: number;
  sleepIssuedAt: number | null;
  settledAt: number | null;
};

type DedicatedOwnerReceipt = {
  readonly id: number;
  readonly invocationId: number;
  readonly lifecycle: "open" | "close";
  readonly constructedAt: number;
  readonly options: Record<string, unknown>;
  readonly applicationName: string | null;
  readonly queryReceipts: OwnerQueryReceipt[];
  readonly observedIdentities: DedicatedOwnerIdentity[];
  endStartedAt: number | null;
  endSettledAt: number | null;
  endOutcome: "not-called" | "pending" | "fulfilled" | "rejected";
  endInput: unknown;
  cleanupForcedEnd: boolean;
  externalGoneAt: number | null;
  externalGone: boolean | null;
};

function exactBoundedDedicatedEndBefore(
  receipt: DedicatedOwnerReceipt,
  publicReturnedAt: number | null | undefined,
): boolean {
  const endInput = receipt.endInput;
  const queriedBackendWasCaptured = receipt.queryReceipts.length === 0 ||
    (receipt.observedIdentities.length === 1 && receipt.observedIdentities.every((identity) =>
      identity.applicationName === receipt.applicationName && Number.isSafeInteger(identity.pid) &&
      identity.backendStart.length > 0 && identity.sessionRole.length > 0 &&
      identity.databaseName.length > 0));
  return typeof publicReturnedAt === "number" && !receipt.cleanupForcedEnd &&
    receipt.endOutcome === "fulfilled" && typeof endInput === "object" && endInput !== null &&
    (endInput as { timeout?: unknown }).timeout === 5 &&
    receipt.endStartedAt !== null && receipt.endStartedAt <= publicReturnedAt &&
    receipt.endSettledAt !== null && receipt.endSettledAt <= publicReturnedAt &&
    receipt.externalGone === true && receipt.externalGoneAt !== null &&
    receipt.externalGoneAt <= publicReturnedAt && queriedBackendWasCaptured;
}

// b3d8 Gap-4 emergency disposal: a control/verifier session whose acquisition/query/poll runs to
// the immutable 5,000 ms session deadline is force-disposed by production (not the harness escape
// hatch) with end({ timeout: 0 }). The deadline is armed before acquisition, so it deterministically
// precedes the query's own statement_timeout. Identical to the normal bound except the exact timeout.
function boundedEmergencyEndBefore(
  receipt: DedicatedOwnerReceipt,
  publicReturnedAt: number | null | undefined,
): boolean {
  const endInput = receipt.endInput;
  const queriedBackendWasCaptured = receipt.queryReceipts.length === 0 ||
    (receipt.observedIdentities.length === 1 && receipt.observedIdentities.every((identity) =>
      identity.applicationName === receipt.applicationName && Number.isSafeInteger(identity.pid) &&
      identity.backendStart.length > 0 && identity.sessionRole.length > 0 &&
      identity.databaseName.length > 0));
  return typeof publicReturnedAt === "number" && !receipt.cleanupForcedEnd &&
    receipt.endOutcome === "fulfilled" && typeof endInput === "object" && endInput !== null &&
    (endInput as { timeout?: unknown }).timeout === 0 &&
    receipt.endStartedAt !== null && receipt.endStartedAt <= publicReturnedAt &&
    receipt.endSettledAt !== null && receipt.endSettledAt <= publicReturnedAt &&
    receipt.externalGone === true && receipt.externalGoneAt !== null &&
    receipt.externalGoneAt <= publicReturnedAt && queriedBackendWasCaptured;
}

const CANCELLATION_IDENTITY_FIELDS = [
  { field: "pid", mutant: -2_147_483_648 },
  { field: "backendStart", mutant: "2000-01-01 00:00:00+00" },
  { field: "sessionRole", mutant: "job003_mutant_role" },
  { field: "databaseName", mutant: "job003_mutant_database" },
  { field: "applicationName", mutant: "job003_mutant_application" },
] as const satisfies ReadonlyArray<{
  field: CancellationIdentityField;
  mutant: string | number;
}>;

function exactTypedParameterIndices(
  params: readonly unknown[],
  expected: string | number,
): number[] {
  const indices: number[] = [];
  params.forEach((value, index) => {
    if (typeof value === typeof expected && value === expected) indices.push(index);
  });
  return indices;
}

function identityHasExactTypedParams(
  params: readonly unknown[],
  identity: DedicatedOwnerIdentity,
): boolean {
  return CANCELLATION_IDENTITY_FIELDS.every(({ field }) =>
    exactTypedParameterIndices(params, identity[field]).length > 0);
}

async function runCancellationDryRun(
  control: Sql,
  query: Pick<OwnerQueryReceipt, "sql" | "params">,
): Promise<CancellationDryRunReceipt> {
  const receipt: CancellationDryRunReceipt = {
    startedAt: performance.now(),
    settledAt: null,
    outcome: "pending",
    targetAlias: null,
    controlIdentity: null,
    candidateIdentities: [],
    targetIdentities: [],
    originalCandidatePids: [],
    mutations: [],
    controlSubstitutions: [],
  };
  let savepointCreated = false;
  try {
    const cancelCalls = [...query.sql.matchAll(
      /\bpg_cancel_backend\s*\(\s*([a-z_][a-z0-9_]*)\.pid\s*\)/giu,
    )];
    if (cancelCalls.length !== 1) throw new Error("dry-run requires one cancellation call");
    const cancelCall = cancelCalls[0]!;
    const targetAlias = cancelCall[1]!;
    receipt.targetAlias = targetAlias;
    const callStart = cancelCall.index ?? -1;
    if (callStart < 0) throw new Error("dry-run cancellation call has no offset");
    const replaySql = query.sql.slice(0, callStart) +
      `pg_temp.job003_record_cancel_candidate(${targetAlias}.pid)` +
      query.sql.slice(callStart + cancelCall[0].length);

    await control.unsafe("SAVEPOINT job003_cancel_dry_run");
    savepointCreated = true;
    await control.unsafe(
      "SELECT set_config('statement_timeout', $1, true)",
      ["750ms"],
    );
    await control.unsafe(`
      CREATE TEMP TABLE IF NOT EXISTS job003_cancel_dry_run_candidates (
        pid integer NOT NULL
      ) ON COMMIT DROP
    `);
    await control.unsafe(`
      CREATE OR REPLACE FUNCTION pg_temp.job003_record_cancel_candidate(candidate_pid integer)
      RETURNS boolean
      LANGUAGE plpgsql
      VOLATILE
      AS $job003$
      BEGIN
        INSERT INTO pg_temp.job003_cancel_dry_run_candidates(pid) VALUES (candidate_pid);
        RETURN true;
      END
      $job003$
    `);

    const [controlRow] = await control.unsafe<Array<{
      pid: number;
      backend_start: string;
      session_role: string;
      database_name: string;
      application_name: string;
    }>>(`
      SELECT pg_backend_pid() AS pid,
        backend_start::text AS backend_start,
        session_user::text AS session_role,
        current_database()::text AS database_name,
        current_setting('application_name')::text AS application_name
      FROM pg_stat_activity
      WHERE pid = pg_backend_pid()
    `);
    if (!controlRow) throw new Error("dry-run control identity unavailable");
    receipt.controlIdentity = {
      pid: controlRow.pid,
      backendStart: controlRow.backend_start,
      sessionRole: controlRow.session_role,
      databaseName: controlRow.database_name,
      applicationName: controlRow.application_name,
    };

    const replay = async (params: readonly unknown[]): Promise<number[]> => {
      await control.unsafe("TRUNCATE pg_temp.job003_cancel_dry_run_candidates");
      await control.unsafe(replaySql, [...params] as never);
      const candidateRows = await control.unsafe<Array<{ pid: number }>>(
        "SELECT pid FROM pg_temp.job003_cancel_dry_run_candidates ORDER BY pid",
      );
      return candidateRows.map(({ pid }) => pid);
    };

    receipt.originalCandidatePids.push(...await replay(query.params));
    const uniqueCandidatePids = [...new Set(receipt.originalCandidatePids)];
    if (uniqueCandidatePids.length > 0) {
      const identityRows = await control.unsafe<Array<{
        pid: number;
        backend_start: string;
        session_role: string;
        database_name: string;
        application_name: string;
      }>>(`
        SELECT pid, backend_start::text AS backend_start,
          usename::text AS session_role, datname::text AS database_name,
          application_name::text AS application_name
        FROM pg_stat_activity
        WHERE pid = ANY($1::integer[])
      `, [uniqueCandidatePids] as never);
      receipt.candidateIdentities.push(...identityRows.map((row) => ({
        pid: row.pid,
        backendStart: row.backend_start,
        sessionRole: row.session_role,
        databaseName: row.database_name,
        applicationName: row.application_name,
      })));
    }
    receipt.targetIdentities.push(...receipt.candidateIdentities.filter((identity) =>
      identityHasExactTypedParams(query.params, identity)));

    for (const target of receipt.targetIdentities) {
      for (const { field, mutant } of CANCELLATION_IDENTITY_FIELDS) {
        for (const parameterIndex of exactTypedParameterIndices(query.params, target[field])) {
          const mutatedParams = [...query.params];
          mutatedParams[parameterIndex] = mutant;
          receipt.mutations.push({
            targetPid: target.pid,
            field,
            parameterIndex,
            candidatePids: await replay(mutatedParams),
          });
        }
      }
      const controlIdentity = receipt.controlIdentity;
      const substitutionParams = [...query.params];
      let completeSubstitution = true;
      for (const { field } of CANCELLATION_IDENTITY_FIELDS) {
        const effectiveMutations = receipt.mutations.filter((mutation) =>
          mutation.targetPid === target.pid && mutation.field === field &&
          !mutation.candidatePids.includes(target.pid));
        if (effectiveMutations.length === 0) {
          completeSubstitution = false;
          break;
        }
        for (const mutation of effectiveMutations) {
          substitutionParams[mutation.parameterIndex] = controlIdentity[field];
        }
      }
      receipt.controlSubstitutions.push({
        targetPid: target.pid,
        candidatePids: completeSubstitution ? await replay(substitutionParams) : [],
      });
      if (!completeSubstitution) receipt.outcome = "rejected";
    }
    if (receipt.outcome === "pending") receipt.outcome = "fulfilled";
  } catch {
    receipt.outcome = "rejected";
  } finally {
    if (savepointCreated) {
      try {
        await control.unsafe("ROLLBACK TO SAVEPOINT job003_cancel_dry_run");
        await control.unsafe("RELEASE SAVEPOINT job003_cancel_dry_run");
      } catch {
        receipt.outcome = "rejected";
      }
    }
    receipt.settledAt = performance.now();
  }
  return receipt;
}

function dryRunProvesExactCancellation(
  dryRun: CancellationDryRunReceipt | null,
  target: DedicatedOwnerIdentity,
  forbiddenPids: readonly number[] = [],
): boolean {
  const identityMatches = (candidate: DedicatedOwnerIdentity) =>
    CANCELLATION_IDENTITY_FIELDS.every(({ field }) => candidate[field] === target[field]);
  const fieldMutationsExcludeTarget = CANCELLATION_IDENTITY_FIELDS.every(({ field }) =>
    dryRun?.mutations.some((mutation) =>
      mutation.targetPid === target.pid && mutation.field === field &&
      !mutation.candidatePids.includes(target.pid)) === true);
  const substitution = dryRun?.controlSubstitutions.find(({ targetPid }) =>
    targetPid === target.pid);
  return dryRun?.outcome === "fulfilled" && typeof dryRun.settledAt === "number" &&
    dryRun.originalCandidatePids.length === 1 && dryRun.originalCandidatePids[0] === target.pid &&
    dryRun.targetIdentities.length === 1 && identityMatches(dryRun.targetIdentities[0]!) &&
    fieldMutationsExcludeTarget && substitution !== undefined &&
    substitution.candidatePids.length === 0 && dryRun.controlIdentity !== null &&
    !dryRun.originalCandidatePids.includes(dryRun.controlIdentity.pid) &&
    forbiddenPids.every((pid) => !dryRun.originalCandidatePids.includes(pid));
}

type ReservedOwnerSql = Awaited<ReturnType<Sql["reserve"]>>;

type OwnerReservationReceipt = {
  readonly connection: ReservedOwnerSql;
  readonly pid: number;
  readonly backendStart: string;
  readonly applicationName: string;
  readonly reservedAt: number;
  releasedAt: number | null;
};

type OwnerReservationGroup = {
  readonly receipts: OwnerReservationReceipt[];
  readonly release: () => Promise<void>;
};

async function createAdvisoryStartupHarness(inject?: StartupFailureInjection) {
  const dialect = new PgDialect();
  const pendingAdvisoryPhase = ADVISORY_PHASES.find((phase) => inject === `${phase}-pending`) ?? null;
  const token = `job003_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const state = {
    phases: [] as AdvisoryPhase[],
    factoryOptions: [] as Array<{ role: "aoa_app" | "aoa_operator"; options: unknown }>,
    slotIds: { aoa_app: new Set<number>(), aoa_operator: new Set<number>() },
    closes: [] as Array<{ role: "aoa_app" | "aoa_operator"; input: unknown }>,
    closeAttempts: [] as Array<{ role: "aoa_app" | "aoa_operator"; at: number }>,
    closeSettled: [] as Array<{ role: "aoa_app" | "aoa_operator"; at: number }>,
    cleanupFailureCloseGateReleasedAt: null as number | null,
    logs: [] as unknown[][],
    positiveWaiters: new Map<"aoa_app" | "aoa_operator", Array<() => void>>(),
    positiveBarrierReached: false,
    injectionTriggered: false,
    injectionTriggeredAt: null as number | null,
    clients: [] as Sql[],
    ownerClient: null as Sql | null,
    blocker: null as Sql | null,
    backendPids: {
      owner: new Set<number>(), aoa_app: new Set<number>(), aoa_operator: new Set<number>(),
    },
    advisoryKeyBindings: [] as bigint[],
    abortControllers: [] as AbortController[],
    abortCalls: 0,
    abortAt: null as number | null,
    observerAliasControls: [] as AbortController[],
    observerAliasControlObserved: null as boolean | null,
    openInvocations: [] as StartupInvocationReceipt[],
    activeInvocation: null as StartupInvocationReceipt | null,
    activeOwnerLifecycle: null as {
      invocation: StartupInvocationReceipt;
      lifecycle: "open" | "close";
    } | null,
    transactionReceipts: [] as StartupTransactionReceipt[],
    ownerQueryReceipts: [] as OwnerQueryReceipt[],
    cleanupProbeReceipts: [] as CleanupProbeReceipt[],
    dedicatedOwnerReceipts: [] as DedicatedOwnerReceipt[],
    dedicatedOwnerClients: [] as Array<{ client: Sql; receipt: DedicatedOwnerReceipt }>,
    sharedOwnerRawOperations: [] as Array<{ invocationId: number; operation: string }>,
    sharedOwnerPrivateReads: [] as Array<{ invocationId: number; property: string }>,
    backendIdentities: [] as Array<{
      invocationId: number;
      role: "owner" | "aoa_app" | "aoa_operator";
      source: "shared-owner-db" | "dedicated-owner";
      dedicatedOwnerId: number | null;
      pid: number;
      backendStart: string;
      xactStart: string;
      sessionRole: string;
      databaseName: string;
      applicationName: string;
    }>,
    ownerReservationGroups: [] as OwnerReservationGroup[],
    sharedProbeOrdinals: new Map<string, number>(),
    budgetWindows: [] as Array<{
      invocationId: number;
      phase: AdvisoryPhase;
      role: "owner" | "aoa_app" | "aoa_operator";
      signal: AbortSignal | null;
      startedAt: number;
      settledAt: number | null;
      abortReceipt: StartupDeadlineReceipt | null;
      cancelledDuringWork: boolean;
      abortObservedWhilePending: boolean;
      releasedAt: number | null;
    }>,
    pendingBudgetWork: [] as Array<{
      invocationId: number;
      phase: AdvisoryPhase;
      release: () => void;
      drained: Promise<void>;
      releasedAt: number | null;
      drainedAt: number | null;
    }>,
    pendingQueryTimeouts: [] as Array<{
      invocationId: number;
      phase: AdvisoryPhase;
      effectiveStatementTimeout: string;
    }>,
    pendingQueries: [] as PendingQueryReceipt[],
  };
  let resolveCleanupFailureCloseGate!: () => void;
  const cleanupFailureCloseGate = new Promise<void>((resolve) => {
    resolveCleanupFailureCloseGate = resolve;
  });
  const namedUrl = (url: string, suffix: string) => {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}application_name=${token}_${suffix}`;
  };
  const appNamedUrl = namedUrl(appUrl, "app");
  const operatorNamedUrl = namedUrl(operatorUrl, "operator");
  const ownerNamedUrl = namedUrl(adminUrl, "owner");

  const reserveOwnerSlots = async (count: number): Promise<OwnerReservationGroup> => {
    if (!state.ownerClient) throw new Error("owner client is unavailable for reservation");
    const receipts: OwnerReservationReceipt[] = [];
    let releaseTask: Promise<void> | null = null;
    const group: OwnerReservationGroup = {
      receipts,
      release: () => {
        releaseTask ??= Promise.all(receipts.map(async (receipt) => {
          if (receipt.releasedAt !== null) return;
          await receipt.connection.release();
          receipt.releasedAt = performance.now();
        })).then(() => undefined);
        return releaseTask;
      },
    };
    state.ownerReservationGroups.push(group);
    try {
      for (let index = 0; index < count; index += 1) {
        const connection = await state.ownerClient.reserve();
        const [identity] = await connection<{
          pid: number;
          backend_start: string;
          application_name: string;
        }[]>`
          SELECT activity.pid,
            activity.backend_start::text AS backend_start,
            activity.application_name
          FROM pg_stat_activity activity
          WHERE activity.pid = pg_backend_pid()
        `;
        if (!identity || !Number.isSafeInteger(identity.pid) || !identity.backend_start) {
          await connection.release();
          throw new Error(`owner reservation ${index} has no exact backend identity`);
        }
        receipts.push({
          connection,
          pid: identity.pid,
          backendStart: identity.backend_start,
          applicationName: identity.application_name,
          reservedAt: performance.now(),
          releasedAt: null,
        });
      }
      return group;
    } catch (error) {
      await group.release();
      throw error;
    }
  };

  const rows = (result: unknown): unknown[] => Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] })?.rows ?? []);
  const observeCleanupProbe = async <T>(
    source: CleanupProbeReceipt["source"],
    controlId: number | null,
    queryText: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    if (!/\bparticipant_pids_gone\b/u.test(queryText)) return work();
    const receipt: CleanupProbeReceipt = {
      invocationId: state.activeInvocation?.id ?? state.openInvocations.at(-1)?.id ?? -1,
      source,
      controlId,
      startedAt: performance.now(),
      settledAt: null,
      outcome: "pending",
      participantPidsGone: null,
    };
    state.cleanupProbeReceipts.push(receipt);
    try {
      const result = await work();
      receipt.outcome = "fulfilled";
      receipt.participantPidsGone = rows(result).some((row) =>
        typeof (row as { participant_pids_gone?: unknown })?.participant_pids_gone === "boolean" &&
        (row as { participant_pids_gone: boolean }).participant_pids_gone);
      return result;
    } catch (error) {
      receipt.outcome = "rejected";
      throw error;
    } finally {
      receipt.settledAt = performance.now();
    }
  };
  const firstBoolean = (result: unknown): boolean | undefined => {
    for (const row of rows(result)) {
      for (const value of Object.values((row ?? {}) as Record<string, unknown>)) {
        if (typeof value === "boolean") return value;
      }
    }
    return undefined;
  };
  const consumeBudget = async (
    phase: "owner-exclusive" | "app-negative" | "operator-negative" |
      "app-positive" | "operator-positive",
  ) => {
    const invocation = state.activeInvocation;
    if (!invocation) throw new Error("shared-budget phase ran outside an open invocation");
    const role = phase === "owner-exclusive"
      ? "owner"
      : phase.startsWith("app-") ? "aoa_app" : "aoa_operator";
    const signal = invocation.controllers.at(-1)?.signal ?? null;
    const window = {
      invocationId: invocation.id,
      phase,
      role,
      signal,
      startedAt: performance.now(),
      settledAt: null as number | null,
      abortReceipt: null as StartupDeadlineReceipt | null,
      cancelledDuringWork: false,
      abortObservedWhilePending: false,
      releasedAt: null as number | null,
    };
    state.budgetWindows.push(window);
    if (inject === "shared-budget-pending" && phase !== "owner-exclusive") {
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      const pending = {
        invocationId: invocation.id,
        phase,
        release: () => {
          if (pending.releasedAt !== null) return;
          pending.releasedAt = performance.now();
          window.releasedAt = pending.releasedAt;
          releaseGate();
        },
        drained: Promise.resolve(),
        releasedAt: null as number | null,
        drainedAt: null as number | null,
      };
      pending.drained = gate.then(() => { pending.drainedAt = performance.now(); });
      state.pendingBudgetWork.push(pending);
      const onAbort = () => {
        window.abortReceipt = invocation.deadlineReceipt;
        window.abortObservedWhilePending = pending.releasedAt === null;
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      return window;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 3_000);
        if (!signal) return;
        const onAbort = () => {
          window.abortReceipt = invocation.deadlineReceipt;
          window.abortObservedWhilePending = window.settledAt === null;
          if (window.settledAt === null) {
            window.cancelledDuringWork = true;
            if (inject === "shared-budget") {
              clearTimeout(timer);
              reject(Object.assign(new Error("shared startup budget cancelled phase work"), {
                code: "INJECT_SHARED_BUDGET_CANCEL",
              }));
            }
          }
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      window.settledAt = performance.now();
    }
    return window;
  };
  const waitForPositivePeer = async (role: "aoa_app" | "aoa_operator") => {
    const peer = role === "aoa_app" ? "aoa_operator" : "aoa_app";
    const peerWaiters = state.positiveWaiters.get(peer);
    const existing = peerWaiters?.shift();
    if (existing) {
      state.positiveBarrierReached = true;
      if (peerWaiters?.length === 0) state.positiveWaiters.delete(peer);
      existing();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiters = state.positiveWaiters.get(role) ?? [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wrapped = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      waiters.push(wrapped);
      state.positiveWaiters.set(role, waiters);
      if (pendingAdvisoryPhase !== null) return;
      timer = setTimeout(() => {
        const remaining = state.positiveWaiters.get(role)?.filter((waiter) => waiter !== wrapped) ?? [];
        if (remaining.length === 0) state.positiveWaiters.delete(role);
        else state.positiveWaiters.set(role, remaining);
        reject(new Error(`positive advisory barrier stranded for ${role}`));
      }, 2_000);
    });
  };

  const createPendingReceipt = (
    role: "owner" | "aoa_app" | "aoa_operator",
    phase: PendingQueryPhase,
    source: StartupTransactionReceipt["source"] = role === "owner" ? "shared-owner-db" : "serving",
    dedicatedOwnerId: number | null = null,
  ) => {
    const receipt = {
      invocationId: state.activeInvocation?.id ?? state.openInvocations.at(-1)?.id ?? -1,
      phase,
      role,
      source,
      dedicatedOwnerId,
      backendPid: null as number | null,
      effectiveStatementTimeout: null as string | null,
      signal: state.activeInvocation?.controllers.at(-1)?.signal ?? null,
      abortObservedAt: null as number | null,
      startedAt: performance.now(),
      sleepIssuedAt: null as number | null,
      settledAt: null as number | null,
    };
    state.pendingQueries.push(receipt);
    const observeAbort = () => { receipt.abortObservedAt ??= performance.now(); };
    if (receipt.signal?.aborted) observeAbort();
    else receipt.signal?.addEventListener("abort", observeAbort, { once: true });
    return receipt;
  };

  const recordTransaction = async <T>(
    role: "owner" | "aoa_app" | "aoa_operator",
    phase: PendingQueryPhase | null,
    work: (receipt: StartupTransactionReceipt) => Promise<T>,
    source: StartupTransactionReceipt["source"] = role === "owner" ? "shared-owner-db" : "serving",
    dedicatedOwnerId: number | null = null,
  ): Promise<T> => {
    const receipt: StartupTransactionReceipt = {
      invocationId: state.activeInvocation?.id ?? -1,
      role,
      source,
      dedicatedOwnerId,
      phase,
      startedAt: performance.now(),
      settledAt: null,
      outcome: "pending",
    };
    state.transactionReceipts.push(receipt);
    try {
      const value = await work(receipt);
      receipt.outcome = "fulfilled";
      return value;
    } catch (error) {
      receipt.outcome = "rejected";
      throw error;
    } finally {
      receipt.settledAt = performance.now();
    }
  };

  const runPendingQuery = async <T extends object>(
    target: T,
    role: "owner" | "aoa_app" | "aoa_operator",
    phase: PendingQueryPhase,
    statement: unknown,
    transactionReceipt: StartupTransactionReceipt | undefined,
    source: StartupTransactionReceipt["source"],
    dedicatedOwnerId: number | null,
  ): Promise<unknown> => {
    const receipt = createPendingReceipt(role, phase, source, dedicatedOwnerId);
    const run = async (transaction: T & { execute(s: unknown): Promise<unknown> }) => {
      const timeoutResult = await transaction.execute(sql`
        SELECT current_setting('statement_timeout') AS statement_timeout`);
      receipt.effectiveStatementTimeout = rows(timeoutResult)
        .flatMap((row) => Object.values((row ?? {}) as Record<string, unknown>))
        .find((value): value is string => typeof value === "string") ?? null;
      const pidResult = await transaction.execute(sql`SELECT pg_backend_pid() AS pid`);
      receipt.backendPid = rows(pidResult)
        .flatMap((row) => Object.values((row ?? {}) as Record<string, unknown>))
        .find((value): value is number => Number.isSafeInteger(value)) ?? null;
      try {
        receipt.sleepIssuedAt = performance.now();
        await transaction.execute(sql`SELECT pg_sleep(60)`);
        return await transaction.execute(statement);
      } finally {
        receipt.settledAt = performance.now();
      }
    };
    if (transactionReceipt) {
      transactionReceipt.phase = phase;
      return run(target as T & { execute(s: unknown): Promise<unknown> });
    }
    return recordTransaction(role, phase, async () =>
      (target as T & {
        transaction(callback: (transaction: T & { execute(s: unknown): Promise<unknown> }) => Promise<unknown>): Promise<unknown>;
      }).transaction(run), source, dedicatedOwnerId);
  };

  const ownerQuerySemantic = (queryText: string): OwnerQuerySemantic => {
    if (/\bpg_cancel_backend\s*\(/u.test(queryText)) return "cancellation";
    if (/\bparticipant_pids_gone\b/u.test(queryText)) return "cleanup";
    if (/\bpg_stat_activity\b/u.test(queryText) && /\bapplication_name\b/u.test(queryText)) {
      return "cancellation-discovery";
    }
    if (/\b__drizzle_migrations\b/u.test(queryText)) return "migration-identity";
    if (/\bpg_advisory_xact_lock\s*\(/u.test(queryText) && !/\bshared\b/u.test(queryText)) {
      return "owner-advisory";
    }
    if (/\bset_config\s*\(\s*'statement_timeout'/u.test(queryText) ||
      /\bset\s+local\s+statement_timeout\b/u.test(queryText)) return "timeout-setup";
    if (/\bpg_backend_pid\s*\(/u.test(queryText) || /\bbackend_start\b/u.test(queryText)) {
      return "backend-identity";
    }
    return "other";
  };

  const instrumentDb = <T extends object>(
    db: T,
    role: "owner" | "aoa_app" | "aoa_operator",
    transactionReceipt?: StartupTransactionReceipt,
    source: StartupTransactionReceipt["source"] = role === "owner" ? "shared-owner-db" : "serving",
    dedicatedOwner?: DedicatedOwnerReceipt,
    fixtureTransactionControl?: Sql,
  ): T => {
    const cache = new Map<PropertyKey, unknown>();
    const invocationId = () => state.activeOwnerLifecycle?.invocation.id ??
      state.activeInvocation?.id ?? state.openInvocations.at(-1)?.id ?? -1;
    return new Proxy(db, {
      get(target, property, receiver) {
        if (cache.has(property)) return cache.get(property);
        if (role === "owner" && source === "shared-owner-db" && property === "$client") {
          const rawClient = Reflect.get(target, property, receiver);
          if ((typeof rawClient !== "object" || rawClient === null) && typeof rawClient !== "function") {
            return rawClient;
          }
          const observedRawClient = new Proxy(rawClient as object, {
            apply(rawTarget, thisArg, args) {
              state.sharedOwnerRawOperations.push({ invocationId: invocationId(), operation: "call" });
              return Reflect.apply(rawTarget as Function, thisArg, args);
            },
            get(rawTarget, rawProperty, rawReceiver) {
              const value = Reflect.get(rawTarget, rawProperty, rawReceiver);
              if (rawProperty === "options") return value;
              if (typeof value === "function") {
                return (...args: unknown[]) => {
                  state.sharedOwnerRawOperations.push({
                    invocationId: invocationId(),
                    operation: String(rawProperty),
                  });
                  return Reflect.apply(value, rawTarget, args);
                };
              }
              state.sharedOwnerPrivateReads.push({
                invocationId: invocationId(),
                property: String(rawProperty),
              });
              return value;
            },
          });
          cache.set(property, observedRawClient);
          return observedRawClient;
        }
        if (role === "owner" && source === "shared-owner-db" &&
          (property === "_" || property === "session")) {
          state.sharedOwnerPrivateReads.push({ invocationId: invocationId(), property: String(property) });
        }
        if (property === "execute") {
          const execute = async (statement: unknown) => {
            let queryText = "";
            let compiledQueryText = "";
            let queryParams: unknown[] = [];
            try {
              const compiled = dialect.sqlToQuery(statement as never);
              compiledQueryText = compiled.sql;
              queryText = compiledQueryText.toLowerCase();
              queryParams = compiled.params;
            } catch { /* non-SQL */ }
            const semantic = ownerQuerySemantic(queryText);
            const ownerQueryReceipt: OwnerQueryReceipt | null = role === "owner"
              ? {
                  invocationId: state.activeOwnerLifecycle?.invocation.id ??
                    state.activeInvocation?.id ?? state.openInvocations.at(-1)?.id ?? -1,
                  source: source === "dedicated-owner" ? "dedicated-owner" : "shared-owner-db",
                  dedicatedOwnerId: dedicatedOwner?.id ?? null,
                  semantic,
                  sql: compiledQueryText,
                  params: [...queryParams],
                  startedAt: performance.now(),
                  settledAt: null,
                  outcome: "pending",
                  dryRun: null,
                }
              : null;
            if (ownerQueryReceipt) {
              state.ownerQueryReceipts.push(ownerQueryReceipt);
              dedicatedOwner?.queryReceipts.push(ownerQueryReceipt);
            }
            if (ownerQueryReceipt?.semantic === "cancellation" &&
              ownerQueryReceipt.source === "dedicated-owner" &&
              fixtureTransactionControl && typeof fixtureTransactionControl.unsafe === "function") {
                // Test-owned same-session replay: deliberately excluded from production raw/private counters.
                ownerQueryReceipt.dryRun = await runCancellationDryRun(
                  fixtureTransactionControl,
                  ownerQueryReceipt,
                );
            }
            const executeCore = async (): Promise<unknown> => {
            const preRegistrationPendingPhase: PendingQueryPhase | null =
              source === "dedicated-owner" && dedicatedOwner !== undefined &&
              inject === "transaction-acquisition-pending" && role === "owner" &&
                semantic === "timeout-setup"
                ? "transaction-acquisition"
                : source === "dedicated-owner" && dedicatedOwner !== undefined &&
                  inject === "timeout-setup-pending" && role === "owner" &&
                queryText.includes("set_config('statement_timeout'")
                ? "timeout-setup"
                : source === "dedicated-owner" && dedicatedOwner !== undefined &&
                    inject === "backend-identity-pending" && role === "owner" &&
                    semantic === "backend-identity"
                  ? "backend-identity"
                  : null;
            if (preRegistrationPendingPhase) {
              state.injectionTriggered = true;
              return runPendingQuery(
                target,
                role,
                preRegistrationPendingPhase,
                statement,
                transactionReceipt,
                source,
                dedicatedOwner?.id ?? null,
              );
            }
            if (inject === "redaction-sentinel" && role === "aoa_app" &&
              queryText.includes("session_role_name")) {
              state.injectionTriggered = true;
              const driverCause = Object.assign(new Error(DRIVER_CAUSE_SENTINEL), {
                code: "JOB003_DRIVER_SENTINEL",
                query: SQL_SENTINEL,
                detail: `${DRIVER_CAUSE_SENTINEL}:${SQL_SENTINEL}`,
              });
              throw Object.assign(new Error(DRIVER_CAUSE_SENTINEL), {
                code: "JOB003_DRIVER_SENTINEL",
                query: SQL_SENTINEL,
                cause: driverCause,
              });
            }
            const pendingPhase: PendingQueryPhase | null =
              inject === "migration-pending" && role === "owner" && source === "dedicated-owner" &&
                queryText.includes("__drizzle_migrations")
                ? "migration-identity"
                : (inject === "app-authority-pending" || inject === "stale-owner-lifecycle") &&
                    role === "aoa_app" &&
                    queryText.includes("session_role_name")
                  ? "app-authority"
                  : inject === "operator-authority-pending" && role === "aoa_operator" &&
                      queryText.includes("session_role_name")
                    ? "operator-authority"
                    : (inject === "cleanup-pending" || inject === "cleanup-failure-pending") &&
                        role === "owner" && source === "dedicated-owner" &&
                        queryText.includes("participant_pids_gone")
                      ? "cleanup"
                      : null;
            if (pendingPhase) {
              return runPendingQuery(
                target,
                role,
                pendingPhase,
                statement,
                transactionReceipt,
                source,
                dedicatedOwner?.id ?? null,
              );
            }
            const ownerLock = role === "owner" && /pg_advisory_xact_lock\s*\(/u.test(queryText) &&
              !queryText.includes("shared");
            if (ownerLock) {
              const key = queryParams.find((value): value is bigint => typeof value === "bigint");
              if (key !== undefined) {
                state.advisoryKeyBindings.push(key);
                state.activeInvocation?.advisoryKeys.push(key);
              }
              if (transactionReceipt) transactionReceipt.phase = "owner-exclusive";
              state.phases.push("owner-exclusive");
              if (pendingAdvisoryPhase === "owner-exclusive" && source === "dedicated-owner") {
                if (!transactionReceipt) {
                  throw new Error("pending owner advisory query must run inside its startup transaction");
                }
                state.injectionTriggered = true;
                await (target as T & { execute(s: unknown): Promise<unknown> })
                  .execute(sql`SET LOCAL statement_timeout = 0`);
                return runPendingQuery(
                  target,
                  role,
                  "owner-exclusive",
                  statement,
                  transactionReceipt,
                  source,
                  dedicatedOwner?.id ?? null,
                );
              }
              if (inject === "shared-budget" || inject === "shared-budget-pending") {
                await consumeBudget("owner-exclusive");
              }
              if (inject === "owner-exclusive") {
                state.injectionTriggered = true;
                throw Object.assign(new Error("owner phase injected"), { code: "INJECT_OWNER" });
              }
              if (inject === "statement-timeout") {
                state.injectionTriggered = true;
                return (target as T & { execute(s: unknown): Promise<unknown> }).execute(sql`SELECT pg_sleep(6)`);
              }
              if (inject === "lock-timeout") {
                state.injectionTriggered = true;
                return (target as T & { execute(s: unknown): Promise<unknown> }).execute(sql`SELECT pg_advisory_xact_lock(903003)`);
              }
              if (inject === "idle-timeout") {
                state.injectionTriggered = true;
                await (target as T & { execute(s: unknown): Promise<unknown> }).execute(sql`SELECT 1`);
                await new Promise((resolve) => setTimeout(resolve, 5_500));
                return (target as T & { execute(s: unknown): Promise<unknown> }).execute(sql`SELECT 1`);
              }
            }
            if (pendingAdvisoryPhase !== null && role !== "owner" &&
              /pg_try_advisory_xact_lock_shared/u.test(queryText)) {
              const rolePrefix = role === "aoa_app" ? "app" : "operator";
              const ordinalKey = `${state.activeInvocation?.id ?? -1}:${role}`;
              const ordinal = state.sharedProbeOrdinals.get(ordinalKey) ?? 0;
              state.sharedProbeOrdinals.set(ordinalKey, ordinal + 1);
              const phase = `${rolePrefix}-${ordinal < 4 ? "negative" : "positive"}` as AdvisoryPhase;
              if (phase === pendingAdvisoryPhase && !state.injectionTriggered) {
                if (!transactionReceipt) {
                  throw new Error("pending peer advisory query must run inside its startup transaction");
                }
                transactionReceipt.phase = phase;
                state.phases.push(phase);
                state.injectionTriggered = true;
                await (target as T & { execute(s: unknown): Promise<unknown> })
                  .execute(sql`SET LOCAL statement_timeout = 0`);
                return runPendingQuery(
                  target,
                  role,
                  phase,
                  statement,
                  transactionReceipt,
                  source,
                  dedicatedOwner?.id ?? null,
                );
              }
            }
            if ((inject === "shared-budget" || inject === "shared-budget-pending") && role !== "owner" &&
              /pg_try_advisory_xact_lock_shared/u.test(queryText)) {
              const rolePrefix = role === "aoa_app" ? "app" : "operator";
              const negativePhase = `${rolePrefix}-negative` as AdvisoryPhase;
              const phase = state.budgetWindows.some((window) =>
                window.invocationId === state.activeInvocation?.id && window.phase === negativePhase)
                ? `${rolePrefix}-positive` as AdvisoryPhase
                : negativePhase;
              if (transactionReceipt) transactionReceipt.phase = phase;
              const budgetWindow = await consumeBudget(phase);
              if (inject === "shared-budget-pending") {
                if (!transactionReceipt) {
                  throw new Error("pending shared-budget query must run inside its startup transaction");
                }
                try {
                  await (target as T & { execute(s: unknown): Promise<unknown> })
                    .execute(sql`SET LOCAL statement_timeout = 0`);
                  const timeoutResult = await (target as T & { execute(s: unknown): Promise<unknown> })
                    .execute(sql`SELECT current_setting('statement_timeout') AS statement_timeout`);
                  const effectiveStatementTimeout = rows(timeoutResult)
                    .flatMap((row) => Object.values((row ?? {}) as Record<string, unknown>))
                    .find((value): value is string => typeof value === "string");
                  if (effectiveStatementTimeout === undefined) {
                    throw new Error("pending shared-budget query could not observe transaction-local timeout");
                  }
                  state.pendingQueryTimeouts.push({
                    invocationId: state.activeInvocation?.id ?? -1,
                    phase,
                    effectiveStatementTimeout,
                  });
                  return await (target as T & { execute(s: unknown): Promise<unknown> })
                    .execute(sql`SELECT pg_sleep(60)`);
                } finally {
                  budgetWindow.settledAt = performance.now();
                }
              }
            }
            const result = await observeCleanupProbe(
              source === "dedicated-owner" ? "dedicated-owner" : "shared-owner-db",
              dedicatedOwner?.id ?? null,
              queryText,
              () => (target as T & { execute(s: unknown): Promise<unknown> }).execute(statement),
            );
            if (/pg_backend_pid\s*\(/u.test(queryText)) {
              for (const row of rows(result)) {
                const pid = Object.values((row ?? {}) as Record<string, unknown>)
                  .find((value): value is number => Number.isSafeInteger(value));
                if (pid !== undefined) state.backendPids[role].add(pid);
              }
            }
            if (role === "owner") {
              for (const rawRow of rows(result)) {
                const identity = (rawRow ?? {}) as Record<string, unknown>;
                const pid = [identity.pid, identity.control_pid, identity.participant_pid]
                  .find((value): value is number => Number.isSafeInteger(value));
                const backendStart = identity.backend_start;
                const xactStart = identity.xact_start;
                const sessionRole = identity.session_role ?? identity.role_name ??
                  identity.usename ?? identity.session_user;
                const databaseName = identity.database_name ?? identity.datname;
                const applicationName = identity.application_name ?? identity.session_tag;
                if (pid === undefined || typeof backendStart !== "string" ||
                  typeof xactStart !== "string" || typeof sessionRole !== "string" ||
                  typeof databaseName !== "string" || typeof applicationName !== "string") continue;
                if (state.backendIdentities.some((candidate) =>
                  candidate.invocationId === ownerQueryReceipt?.invocationId &&
                  candidate.pid === pid && candidate.backendStart === backendStart)) continue;
                state.backendIdentities.push({
                  invocationId: ownerQueryReceipt?.invocationId ?? -1,
                  role,
                  source: source === "dedicated-owner" ? "dedicated-owner" : "shared-owner-db",
                  dedicatedOwnerId: dedicatedOwner?.id ?? null,
                  pid,
                  backendStart,
                  xactStart,
                  sessionRole,
                  databaseName,
                  applicationName,
                });
              }
            }
            if (role !== "owner" && /pg_try_advisory_xact_lock_shared/u.test(queryText)) {
              const success = firstBoolean(result);
              const phase = `${role === "aoa_app" ? "app" : "operator"}-${success ? "positive" : "negative"}` as AdvisoryPhase;
              if (transactionReceipt) transactionReceipt.phase = phase;
              state.phases.push(phase);
              if (inject === phase || (inject === "forced-end" && phase === "operator-positive") ||
                ((inject === "cleanup-failure-pending" ||
                  inject === "cleanup-failure-acquisition-pending") &&
                  phase === "operator-positive")) {
                state.injectionTriggered = true;
                state.injectionTriggeredAt = performance.now();
                throw Object.assign(new Error(`${inject} injected`), { code: `INJECT_${inject}` });
              }
              const hasProductionOwnedPositiveCancellation =
                pendingAdvisoryPhase === "app-positive" ||
                pendingAdvisoryPhase === "operator-positive";
              if (success && !hasProductionOwnedPositiveCancellation) {
                await waitForPositivePeer(role);
              }
            }
            return result;
            };
            try {
              const result = await executeCore();
              if (ownerQueryReceipt) ownerQueryReceipt.outcome = "fulfilled";
              return result;
            } catch (error) {
              if (ownerQueryReceipt) ownerQueryReceipt.outcome = "rejected";
              throw error;
            } finally {
              if (ownerQueryReceipt) ownerQueryReceipt.settledAt = performance.now();
            }
          };
          cache.set(property, execute);
          return execute;
        }
        if (property === "transaction") {
          const transaction = async (callback: (tx: T) => unknown, ...args: unknown[]) => {
            return recordTransaction(role, null, async (receipt) =>
              (target as T & {
                transaction(cb: (tx: T) => unknown, ...rest: unknown[]): Promise<unknown>;
              }).transaction(
                (tx) => callback(instrumentDb(
                  tx,
                  role,
                  receipt,
                  source,
                  dedicatedOwner,
                  dedicatedOwner === undefined
                    ? undefined
                    : dedicatedOwnerTransactionControls.get(dedicatedOwner.id),
                )),
                ...args,
              ), source, dedicatedOwner?.id ?? null);
          };
          cache.set(property, transaction);
          return transaction;
        }
        return Reflect.get(target, property, receiver);
      },
    });
  };

  const createServingConnection = (
    url: string,
    role: "aoa_app" | "aoa_operator",
    options: Record<string, unknown> | undefined,
  ) => {
    state.factoryOptions.push({ role, options });
    const client = postgres(url, {
      max: Number(options?.max ?? 4),
      connect_timeout: 5,
      idle_timeout: 30,
      connection: {
        client_encoding: "UTF8",
        statement_timeout: inject?.endsWith("-pending") ? 0 : 5_000,
        lock_timeout: 750,
        idle_in_transaction_session_timeout: 5_000,
      },
      debug(connectionId) { state.slotIds[role].add(connectionId); },
    });
    state.clients.push(client);
    const db = instrumentDb(drizzlePg(client, { schema: dbSchema }) as unknown as Db, role);
    return {
      db,
      async close(input: { timeoutSeconds: number }) {
        state.closes.push({ role, input });
        state.closeAttempts.push({ role, at: performance.now() });
        if (inject === "cleanup-failure-acquisition-pending") {
          await cleanupFailureCloseGate;
        }
        const seconds = Number(input.timeoutSeconds);
        const sleeping = inject === "forced-end" && state.injectionTriggered
          ? client`SELECT pg_sleep(60)`.catch(() => {})
          : Promise.resolve();
        if (inject === "forced-end" && state.injectionTriggered) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await client.end({ timeout: seconds });
        await sleeping;
        state.closeSettled.push({ role, at: performance.now() });
      },
    };
  };

  vi.resetModules();
  const dedicatedOwnerByClient = new WeakMap<object, DedicatedOwnerReceipt>();
  const dedicatedOwnerTransactionControls = new Map<number, Sql>();
  vi.doMock("postgres", async () => {
    const actual = await vi.importActual<typeof import("postgres")>("postgres");
    const factory = (...args: unknown[]) => {
      const client = Reflect.apply(actual.default as unknown as Function, undefined, args) as Sql;
      const first = args[0];
      const lifecycle = state.activeOwnerLifecycle ?? (state.activeInvocation
        ? { invocation: state.activeInvocation, lifecycle: "open" as const }
        : null);
      if (!lifecycle || typeof first !== "object" || first === null || Array.isArray(first)) {
        return client;
      }
      const options = first as Record<string, unknown>;
      const connection = options.connection;
      const applicationName = typeof connection === "object" && connection !== null &&
          typeof (connection as Record<string, unknown>).application_name === "string"
        ? (connection as Record<string, unknown>).application_name as string
        : null;
      const receipt: DedicatedOwnerReceipt = {
        id: state.dedicatedOwnerReceipts.length + 1,
        invocationId: lifecycle.invocation.id,
        lifecycle: lifecycle.lifecycle,
        constructedAt: performance.now(),
        options,
        applicationName,
        queryReceipts: [],
        observedIdentities: [],
        endStartedAt: null,
        endSettledAt: null,
        endOutcome: "not-called",
        endInput: null,
        cleanupForcedEnd: false,
        externalGoneAt: null,
        externalGone: null,
      };
      state.dedicatedOwnerReceipts.push(receipt);
      const observed = new Proxy(client, {
        get(target, property, receiver) {
          if (property === "begin") {
            const begin = Reflect.get(target, property, receiver) as (...args: unknown[]) => unknown;
            return (...beginArgs: unknown[]) => {
              const callbackIndex = beginArgs.findLastIndex((value) => typeof value === "function");
              if (callbackIndex < 0) return Reflect.apply(begin, target, beginArgs);
              const callback = beginArgs[callbackIndex] as (...args: unknown[]) => unknown;
              const observedArgs = [...beginArgs];
              observedArgs[callbackIndex] = async (transactionControl: Sql, ...callbackArgs: unknown[]) => {
                const previous = dedicatedOwnerTransactionControls.get(receipt.id);
                dedicatedOwnerTransactionControls.set(receipt.id, transactionControl);
                try {
                  return await Reflect.apply(callback, undefined, [transactionControl, ...callbackArgs]);
                } finally {
                  if (previous) dedicatedOwnerTransactionControls.set(receipt.id, previous);
                  else dedicatedOwnerTransactionControls.delete(receipt.id);
                }
              };
              return Reflect.apply(begin, target, observedArgs);
            };
          }
          if (property !== "end") return Reflect.get(target, property, receiver);
          return async (...endArgs: unknown[]) => {
            receipt.endStartedAt = performance.now();
            receipt.endOutcome = "pending";
            receipt.endInput = endArgs[0] ?? null;
            try {
              if (receipt.applicationName) {
                receipt.observedIdentities.push(...await admin!.unsafe<Array<{
                  pid: number;
                  backend_start: string;
                  session_role: string;
                  database_name: string;
                  application_name: string;
                }>>(`
                  SELECT activity.pid,
                    activity.backend_start::text AS backend_start,
                    activity.usename AS session_role,
                    activity.datname AS database_name,
                    activity.application_name
                  FROM pg_stat_activity activity
                  WHERE activity.application_name = $1
                `, [receipt.applicationName]).then((identities) => identities.map((identity) => ({
                  pid: identity.pid,
                  backendStart: identity.backend_start,
                  sessionRole: identity.session_role,
                  databaseName: identity.database_name,
                  applicationName: identity.application_name,
                }))));
              }
              const value = await Reflect.apply(target.end as unknown as Function, target, endArgs);
              receipt.endOutcome = "fulfilled";
              if (receipt.applicationName) {
                const deadline = performance.now() + 2_000;
                do {
                  const identityGone = await Promise.all(receipt.observedIdentities.map(async (identity) => {
                    const [observation] = await admin!.unsafe<Array<{ gone: boolean }>>(`
                      SELECT NOT EXISTS (
                        SELECT 1 FROM pg_stat_activity activity
                        WHERE activity.pid = $1
                          AND activity.backend_start = $2::timestamptz
                          AND activity.usename = $3
                          AND activity.datname = $4
                          AND activity.application_name = $5
                      ) AS gone
                    `, [
                      identity.pid,
                      identity.backendStart,
                      identity.sessionRole,
                      identity.databaseName,
                      identity.applicationName,
                    ]);
                    return observation?.gone === true;
                  }));
                  const [tagObservation] = await admin!.unsafe<Array<{ gone: boolean }>>(`
                    SELECT NOT EXISTS (
                      SELECT 1 FROM pg_stat_activity activity
                      WHERE activity.application_name = $1
                    ) AS gone
                  `, [receipt.applicationName]);
                  if (tagObservation?.gone === true && identityGone.every(Boolean)) {
                    receipt.externalGone = true;
                    receipt.externalGoneAt = performance.now();
                    break;
                  }
                  await new Promise((resolve) => setTimeout(resolve, 20));
                } while (performance.now() < deadline);
                receipt.externalGone ??= false;
              }
              return value;
            } catch (error) {
              receipt.endOutcome = "rejected";
              throw error;
            } finally {
              receipt.endSettledAt = performance.now();
            }
          };
        },
      });
      state.dedicatedOwnerClients.push({ client: observed, receipt });
      dedicatedOwnerByClient.set(observed as unknown as object, receipt);
      return observed;
    };
    return { ...actual, default: factory };
  });
  vi.doMock("drizzle-orm/postgres-js", async () => {
    const actual = await vi.importActual<typeof import("drizzle-orm/postgres-js")>(
      "drizzle-orm/postgres-js",
    );
    const instrumentedDrizzle = (...args: unknown[]) => {
      const db = Reflect.apply(actual.drizzle as unknown as Function, undefined, args) as object;
      const client = args[0];
      const dedicatedOwner = typeof client === "object" && client !== null
        ? dedicatedOwnerByClient.get(client)
        : typeof client === "function" ? dedicatedOwnerByClient.get(client) : undefined;
      return dedicatedOwner
        ? instrumentDb(db, "owner", undefined, "dedicated-owner", dedicatedOwner)
        : db;
    };
    return { ...actual, drizzle: instrumentedDrizzle };
  });
  vi.doMock("@armyofagents/db", async () => {
    const actual = await vi.importActual<typeof import("@armyofagents/db")>("@armyofagents/db");
    return {
      ...actual,
      createTenantAppDbConnection: (url: string, options?: Record<string, unknown>) =>
        createServingConnection(url, "aoa_app", options),
      createOperatorDbConnection: (url: string, options?: Record<string, unknown>) =>
        createServingConnection(url, "aoa_operator", options),
    };
  });
  vi.doMock("../middleware/logger.js", async () => {
    const actual = await vi.importActual<typeof import("../middleware/logger.js")>("../middleware/logger.js");
    const record = (...args: unknown[]) => { state.logs.push(args); };
    return { ...actual, logger: { trace: record, debug: record, info: record, warn: record, error: record } };
  });

  // Install one observer before the isolated import so a production module-scope constructor
  // alias captures the observer too. The WeakMap preserves the owning open after activeInvocation
  // is cleared, while inactive control constructions cannot pollute per-open controller counts.
  const NativeAbortController = globalThis.AbortController;
  const controllerOwners = new WeakMap<AbortController, StartupInvocationReceipt>();
  class ObservedAbortController extends NativeAbortController {
    constructor() {
      super();
      const invocation = state.activeInvocation;
      if (!invocation) return;
      controllerOwners.set(this, invocation);
      invocation.controllerCreatedAt ??= performance.now();
      invocation.controllers.push(this);
      state.abortControllers.push(this);
    }

    override abort(reason?: unknown) {
      const invocation = controllerOwners.get(this);
      if (invocation) {
        state.abortCalls += 1;
        if (!this.signal.aborted) {
          const at = performance.now();
          const receipt: StartupDeadlineReceipt = {
            invocationId: invocation.id,
            signal: this.signal,
            at,
          };
          invocation.deadlineReceipt ??= receipt;
          state.abortAt ??= at;
        }
      }
      super.abort(reason);
    }
  }
  globalThis.AbortController = ObservedAbortController;
  const CapturedBeforeIsolatedImportAbortController = globalThis.AbortController;
  const restoreObservedAbortController = () => {
    if (globalThis.AbortController === ObservedAbortController) {
      globalThis.AbortController = NativeAbortController;
    }
  };
  const restoreHarnessGlobals = () => {
    restoreObservedAbortController();
    vi.doUnmock("postgres");
    vi.doUnmock("drizzle-orm/postgres-js");
    vi.doUnmock("@armyofagents/db");
    vi.doUnmock("../middleware/logger.js");
    vi.resetModules();
  };

  let isolated: typeof import("../db/distributed-execution-databases.js");
  try {
    isolated = await import("../db/distributed-execution-databases.js");
    restoreObservedAbortController();
    const aliasControl = new CapturedBeforeIsolatedImportAbortController();
    state.observerAliasControls.push(aliasControl);
    state.observerAliasControlObserved = aliasControl instanceof ObservedAbortController;
    aliasControl.abort();
  } catch (error) {
    restoreHarnessGlobals();
    throw error;
  }

  let instrumentedOwnerDb: Db;
  try {
    state.ownerClient = postgres(ownerNamedUrl, {
      max: inject === "stale-owner-lifecycle" ? 1 : 4,
      connection: {
        client_encoding: "UTF8",
        statement_timeout: inject?.endsWith("-pending") ? 0 : 5_000,
        lock_timeout: 750,
        idle_in_transaction_session_timeout: 5_000,
      },
    });
    instrumentedOwnerDb = instrumentDb(
      drizzlePg(state.ownerClient, { schema: dbSchema }) as unknown as Db,
      "owner",
    );
    if (inject === "lock-timeout") {
      state.blocker = postgres(namedUrl(adminUrl, "blocker"), { max: 1 });
      await state.blocker`SELECT pg_advisory_lock(903003)`;
    }
  } catch (error) {
    await state.blocker?.end({ timeout: 1 }).catch(() => {});
    await state.ownerClient?.end({ timeout: 1 }).catch(() => {});
    restoreHarnessGlobals();
    throw error;
  }

  const waitForActivePendingQuery = async (
    phase: PendingQueryPhase,
    timeoutMs = 3_500,
    invocationId?: number,
  ) => {
    const deadline = performance.now() + timeoutMs;
    do {
      const receipt = state.pendingQueries.find((candidate) =>
        candidate.phase === phase && candidate.backendPid !== null &&
        (invocationId === undefined || candidate.invocationId === invocationId));
      if (receipt?.backendPid !== null && receipt?.backendPid !== undefined) {
        const [activity] = await admin!.unsafe<Array<{ active: boolean }>>(`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE pid = $1
              AND datname = current_database()
              AND state = 'active'
              AND query ILIKE '%pg_sleep%'
          ) AS active
        `, [receipt.backendPid]);
        if (activity?.active) return receipt;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    return null;
  };

  const cancelBackend = async (pid: number): Promise<boolean> => {
    const [result] = await admin!<{ cancelled: boolean }[]>`
      SELECT pg_cancel_backend(${pid}) AS cancelled
    `;
    return result?.cancelled === true;
  };

  const cleanup = async () => {
    try {
      if (state.cleanupFailureCloseGateReleasedAt === null) {
        state.cleanupFailureCloseGateReleasedAt = performance.now();
        resolveCleanupFailureCloseGate();
      }
      for (const pending of state.pendingBudgetWork) pending.release();
      await Promise.allSettled(state.pendingBudgetWork.map((pending) => pending.drained));
      for (const waiters of state.positiveWaiters.values()) {
        for (const resolve of waiters) resolve();
      }
      state.positiveWaiters.clear();
      if (state.blocker) {
        await state.blocker`SELECT pg_advisory_unlock(903003)`.catch(() => {});
        await state.blocker.end({ timeout: 1 }).catch(() => {});
      }
      for (const group of state.ownerReservationGroups) {
        await group.release().catch(() => {});
      }
      for (const { client, receipt } of state.dedicatedOwnerClients) {
        if (receipt.endSettledAt !== null) continue;
        receipt.cleanupForcedEnd = true;
        await client.end({ timeout: 1 }).catch(() => {});
      }
      await state.ownerClient?.end({ timeout: 1 }).catch(() => {});
      for (const client of state.clients) await client.end({ timeout: 1 }).catch(() => {});
    } finally {
      restoreHarnessGlobals();
    }
  };
  return {
    state,
    appNamedUrl,
    operatorNamedUrl,
    open: (async (input: Parameters<typeof openFinalStartup>[0]) => {
      if (state.activeInvocation) throw new Error("advisory startup harness does not allow overlapping opens");
      const invocation: StartupInvocationReceipt = {
        id: state.openInvocations.length + 1,
        startedAt: performance.now(),
        advisoryKeys: [],
        controllers: [],
        controllerCreatedAt: null,
        deadlineReceipt: null,
        returnedAt: null,
      };
      state.openInvocations.push(invocation);
      state.activeInvocation = invocation;
      state.activeOwnerLifecycle = { invocation, lifecycle: "open" };
      const previousAbortController = globalThis.AbortController;
      globalThis.AbortController = ObservedAbortController;
      try {
        const accepted = await (isolated.openDistributedExecutionDatabases as unknown as typeof openFinalStartup)(input);
        if (accepted === null) return null;
        return {
          ...accepted,
          close: async () => {
            if (state.activeOwnerLifecycle) {
              throw new Error("advisory startup harness does not allow overlapping owner lifecycles");
            }
            state.activeOwnerLifecycle = { invocation, lifecycle: "close" };
            try {
              return await accepted.close();
            } finally {
              state.activeOwnerLifecycle = null;
            }
          },
        };
      } finally {
        invocation.returnedAt = performance.now();
        state.activeInvocation = null;
        if (state.activeOwnerLifecycle?.invocation === invocation &&
          state.activeOwnerLifecycle.lifecycle === "open") state.activeOwnerLifecycle = null;
        if (globalThis.AbortController === ObservedAbortController) {
          globalThis.AbortController = previousAbortController;
        }
      }
    }) as typeof openFinalStartup,
    input: {
      enabled: true,
      ownerDb: instrumentedOwnerDb,
      requiredMigrationIdentity: checkedInMigrationIdentity(),
      appDatabaseUrl: appNamedUrl,
      operatorDatabaseUrl: operatorNamedUrl,
    },
    releasePendingBudgetWork(invocationId?: number) {
      const at = performance.now();
      for (const pending of state.pendingBudgetWork) {
        if (invocationId === undefined || pending.invocationId === invocationId) pending.release();
      }
      return at;
    },
    async waitForPendingBudgetWork(invocationId?: number) {
      await Promise.all(state.pendingBudgetWork
        .filter((pending) => invocationId === undefined || pending.invocationId === invocationId)
        .map((pending) => pending.drained));
    },
    async waitForActivePendingQuery(phase: PendingQueryPhase, timeoutMs = 3_500) {
      const receipt = await waitForActivePendingQuery(phase, timeoutMs);
      if (receipt) return receipt;
      throw new Error(`pending ${phase} query did not reach its exact active backend`);
    },
    tryWaitForActivePendingQuery(
      phase: PendingQueryPhase,
      invocationId: number,
      timeoutMs = 1_500,
    ) {
      return waitForActivePendingQuery(phase, timeoutMs, invocationId);
    },
    reserveOwnerSlots,
    cancelBackend,
    async waitForCloseAttempts(count: number, timeoutMs = 5_000) {
      const deadline = performance.now() + timeoutMs;
      while (state.closeAttempts.length < count && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return state.closeAttempts.length >= count;
    },
    releaseCleanupFailureCloseGate() {
      if (state.cleanupFailureCloseGateReleasedAt === null) {
        state.cleanupFailureCloseGateReleasedAt = performance.now();
        resolveCleanupFailureCloseGate();
      }
    },
    cleanup,
    token,
  };
}

async function observeAdvisoryStartupSettlement(
  token: string,
  dedicatedOwners: readonly DedicatedOwnerReceipt[] = [],
) {
  const legacyOwnerTag = `${token}_owner`;
  const dedicatedTags = [...new Set(dedicatedOwners
    .map(({ applicationName }) => applicationName)
    .filter((value): value is string =>
      typeof value === "string" && value.length > 0 && value !== legacyOwnerTag))];
  const dedicatedPlaceholders = dedicatedTags.map((_, index) => `$${index + 4}`).join(", ");
  const dedicatedPredicate = dedicatedTags.length > 0
    ? `activity.application_name IN (${dedicatedPlaceholders})`
    : "FALSE";
  const [receipt] = await admin!.unsafe<Array<{
    participant_pids: number;
    dedicated_owner_pids: number;
    legacy_owner_pids: number;
    legacy_owner_invalid: number;
    advisory_locks: number;
  }>>(`
    SELECT
      count(DISTINCT activity.pid) FILTER (
        WHERE activity.application_name IN ($1, $2)
      )::int AS participant_pids,
      count(DISTINCT activity.pid) FILTER (
        WHERE ${dedicatedPredicate}
      )::int AS dedicated_owner_pids,
      count(DISTINCT activity.pid) FILTER (
        WHERE activity.application_name = $3
      )::int AS legacy_owner_pids,
      count(DISTINCT activity.pid) FILTER (
        WHERE activity.application_name = $3
          AND (activity.state <> 'idle' OR activity.xact_start IS NOT NULL OR advisory.pid IS NOT NULL)
      )::int AS legacy_owner_invalid,
      count(DISTINCT advisory.pid)::int AS advisory_locks
    FROM pg_stat_activity activity
    LEFT JOIN pg_locks advisory
      ON advisory.pid = activity.pid AND advisory.locktype = 'advisory'
    WHERE activity.application_name IN ($1, $2, $3)
      OR ${dedicatedPredicate}
  `, [`${token}_app`, `${token}_operator`, legacyOwnerTag, ...dedicatedTags]);
  return receipt!;
}

async function withOuterWatchdog<T>(promise: Promise<T>, timeoutMs = 12_000): Promise<
  | { kind: "fulfilled"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "watchdog" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = promise.then(
    (value) => ({ kind: "fulfilled" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  const watchdog = new Promise<{ kind: "watchdog" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "watchdog" }), timeoutMs);
  });
  try {
    return await Promise.race([observed, watchdog]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForReceiptSettlement(
  receipts: readonly { settledAt: number | null }[],
  deadlineAt: number,
): Promise<
  | { kind: "settled"; observedAt: number }
  | { kind: "watchdog"; observedAt: number; unsettled: number }
> {
  while (performance.now() < deadlineAt) {
    if (receipts.every((receipt) => receipt.settledAt !== null)) {
      return { kind: "settled", observedAt: performance.now() };
    }
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.max(0, Math.min(10, deadlineAt - performance.now())),
    ));
  }
  if (receipts.every((receipt) => receipt.settledAt !== null)) {
    return { kind: "settled", observedAt: performance.now() };
  }
  return {
    kind: "watchdog",
    observedAt: performance.now(),
    unsettled: receipts.filter((receipt) => receipt.settledAt === null).length,
  };
}

function statementTimeoutMs(value: string | null): number | null {
  if (value === null) return null;
  if (value === "0") return 0;
  const match = /^(\d+(?:\.\d+)?)(ms|s|min)$/u.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  return match[2] === "ms" ? amount : match[2] === "s" ? amount * 1_000 : amount * 60_000;
}

const EARLY_ABORT_SETTLEMENT_WATCHDOG_MS = 2_000;
const EARLY_ABORT_PUBLIC_WATCHDOG_MS = 12_000;

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "distributed-execution non-owner startup gate",
  () => {
    it("observes a constructor alias captured before isolated import without polluting opens", async () => {
      guard();
      const harness = await createAdvisoryStartupHarness();
      try {
        const observerControls = harness.state.observerAliasControls;
        expect(observerControls).toHaveLength(1);
        expect(harness.state.observerAliasControlObserved).toBe(true);
        expect(observerControls[0]?.signal.aborted).toBe(true);
        expect(harness.state.openInvocations).toEqual([]);
        expect(harness.state.abortControllers).toEqual([]);
        expect(harness.state.abortCalls).toBe(0);
        expect(harness.state.abortAt).toBeNull();
      } finally {
        await harness.cleanup();
      }
    }, 20_000);

    it("keeps the prompt cancellation receipt bound independent from public teardown", async () => {
      guard();
      const pendingQuery = { settledAt: null as number | null };
      const pendingTransaction = { settledAt: null as number | null };
      let releasePublic!: () => void;
      const publicOperation = new Promise<string>((resolve) => { releasePublic = () => resolve("closed"); });
      setTimeout(() => {
        const settledAt = performance.now();
        pendingQuery.settledAt = settledAt;
        pendingTransaction.settledAt = settledAt;
      }, 0);

      const prompt = await waitForReceiptSettlement(
        [pendingQuery, pendingTransaction],
        performance.now() + 100,
      );
      expect(prompt).toMatchObject({ kind: "settled", observedAt: expect.any(Number) });
      expect(await withOuterWatchdog(publicOperation, 25)).toEqual({ kind: "watchdog" });

      releasePublic();
      expect(await withOuterWatchdog(publicOperation, 250)).toEqual({
        kind: "fulfilled",
        value: "closed",
      });
    }, 5_000);

    // BLOCKER E-1 / Decision #122 amendment. The definer certificate's POSITIVE arm must run
    // on EVERY boot, not only under the distributed flag: migration 0266 creates the
    // owner-authority function on every deployment and grants `aoa_app` EXECUTE regardless,
    // and a box that was once flag-on keeps the LOGIN credential (the provisioning helper is
    // a strict no-op when the flag is off and never restores NOLOGIN).
    //
    // This spawns the REAL flag-off server, so it proves the wiring in index.ts, not just the
    // assertion function. A control boot bounds it: without one, "the server exited" could
    // mean the fixture is broken rather than that the certificate fired.
    it("aborts a FLAG-OFF boot when the definer function's ACL has drifted", async () => {
      guard();
      const control = await observeServer({
        databaseUrl: legacyOwnerUrl,
        distributedEnabled: false,
      });
      expect(control.exited, `control flag-off boot must stay up:
${control.output}`).toBe(false);

      // The GRANT must run as the FUNCTION OWNER. `legacyOwnerUrl` authenticates as
      // `aoa_legacy_table_owner`, which owns only `execution_targets` — so drive the drift
      // through an admin connection to the same database.
      const legacyOwner = postgres(
        adminUrl.replace(/\/postgres$/, "/startup_legacy_owner"),
        { max: 1 },
      );
      try {
        await legacyOwner.unsafe(
          "GRANT EXECUTE ON FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid) TO PUBLIC",
        );
        const drifted = await observeServer({
          databaseUrl: legacyOwnerUrl,
          distributedEnabled: false,
        });
        expect(drifted.exited, `flag-off boot must ABORT on definer ACL drift:
${drifted.output}`)
          .toBe(true);
        expect(drifted.output).toContain("execute authority drift");
      } finally {
        await legacyOwner.unsafe(
          "REVOKE EXECUTE ON FUNCTION public.canary_preflight_evidence_scalars(uuid, uuid, uuid) FROM PUBLIC",
        ).catch(() => {});
        await legacyOwner.end().catch(() => {});
      }
    }, 180_000);

    it("keeps the real flag-off server usable with a non-superuser execution_targets owner", async () => {
      guard();
      const result = await observeServer({
        databaseUrl: legacyOwnerUrl,
        distributedEnabled: false,
      });
      expect(result.exited, result.output).toBe(false);

      const legacyOwner = postgres(legacyOwnerUrl, { max: 1 });
      try {
        const [identity] = await legacyOwner<{
          current_user: string;
          rolsuper: boolean;
          owns_execution_targets: boolean;
        }[]>`
          SELECT current_user,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper,
            pg_get_userbyid(relation.relowner) = current_user AS owns_execution_targets
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public' AND relation.relname = 'execution_targets'
        `;
        expect(identity).toEqual({
          current_user: "aoa_legacy_table_owner",
          rolsuper: false,
          owns_execution_targets: true,
        });
        await legacyOwner`
          INSERT INTO execution_targets
            (organization_id, slug, kind, trust_class, status, capabilities, config, scope, target_authority_key)
          VALUES
            (NULL, 'flag-off-legacy-owner', 'local_host', 'local_trusted', 'active', '{}', '{}', 'platform', 'platform')
          ON CONFLICT DO NOTHING
        `;
        const rows = await legacyOwner<{ slug: string }[]>`
          SELECT slug FROM execution_targets WHERE slug = 'flag-off-legacy-owner'
        `;
        expect(rows).toEqual([{ slug: "flag-off-legacy-owner" }]);
      } finally {
        await legacyOwner.end();
      }
    }, 60_000);

    it("performs zero migration-loader, E3 environment, or serving-pool work in real flag-off bootstrap", async () => {
      // Mutations caught: an early return inside the helper is too late when index.ts has already
      // hashed the migration tree or evaluated environment properties to build its input object.
      // The three flag-on deny controls make every preload trap executable and non-vacuous.
      guard();
      const flagOff = await observeServer({
        databaseUrl: legacyOwnerUrl,
        distributedEnabled: false,
        sentinelMode: "bootstrap-record",
      });
      const flagOn = await observeServer({
        databaseUrl: adminUrl,
        distributedEnabled: true,
        appDatabaseUrl: appUrl,
        operatorDatabaseUrl: operatorUrl,
        sentinelMode: "bootstrap-record",
      });
      const loaderDenied = await observeServer({
        databaseUrl: adminUrl,
        distributedEnabled: true,
        appDatabaseUrl: appUrl,
        operatorDatabaseUrl: operatorUrl,
        sentinelMode: "bootstrap-loader-deny",
      });
      const envDenied = await observeServer({
        databaseUrl: adminUrl,
        distributedEnabled: true,
        appDatabaseUrl: appUrl,
        operatorDatabaseUrl: operatorUrl,
        sentinelMode: "bootstrap-env-deny",
      });
      const allocationDenied = await observeServer({
        databaseUrl: adminUrl,
        distributedEnabled: true,
        appDatabaseUrl: appUrl,
        operatorDatabaseUrl: operatorUrl,
        sentinelMode: "bootstrap-allocation-deny",
      });

      const bootstrapMarkers = [
        "JOB_CONTROL_BOOTSTRAP_LOADER_READ",
        "JOB_CONTROL_BOOTSTRAP_ENV_READ:AOA_APP_DATABASE_URL",
        "JOB_CONTROL_BOOTSTRAP_ENV_READ:AOA_OPERATOR_DATABASE_URL",
        "JOB_CONTROL_BOOTSTRAP_POOL_ALLOCATION:aoa_app",
        "JOB_CONTROL_BOOTSTRAP_POOL_ALLOCATION:aoa_operator",
      ] as const;
      expect({
        exited: flagOff.exited,
        markerCounts: Object.fromEntries(bootstrapMarkers.map((marker) => [
          marker,
          flagOff.output.split(marker).length - 1,
        ])),
      }).toEqual({
        exited: false,
        markerCounts: Object.fromEntries(bootstrapMarkers.map((marker) => [marker, 0])),
      });

      expect(flagOn.exited, flagOn.output).toBe(false);
      expect(flagOn.output.match(/JOB_CONTROL_BOOTSTRAP_LOADER_READ/g)).toHaveLength(1);
      expect(flagOn.output).toContain("JOB_CONTROL_BOOTSTRAP_ENV_READ:AOA_APP_DATABASE_URL");
      expect(flagOn.output).toContain("JOB_CONTROL_BOOTSTRAP_ENV_READ:AOA_OPERATOR_DATABASE_URL");
      expect(flagOn.output).toContain("JOB_CONTROL_BOOTSTRAP_POOL_ALLOCATION:aoa_app");
      expect(flagOn.output).toContain("JOB_CONTROL_BOOTSTRAP_POOL_ALLOCATION:aoa_operator");

      expect(loaderDenied.exited, loaderDenied.output).toBe(true);
      expect(loaderDenied.output).toContain("JOB_CONTROL_BOOTSTRAP_LOADER_READ");
      expect(loaderDenied.output).toContain("JOB_CONTROL_BOOTSTRAP_LOADER_DENIED");
      expect(envDenied.exited, envDenied.output).toBe(true);
      expect(envDenied.output).toContain("JOB_CONTROL_BOOTSTRAP_ENV_READ:AOA_APP_DATABASE_URL");
      expect(envDenied.output).toContain("JOB_CONTROL_BOOTSTRAP_ENV_DENIED:AOA_APP_DATABASE_URL");
      expect(allocationDenied.exited, allocationDenied.output).toBe(true);
      expect(allocationDenied.output).toContain("JOB_CONTROL_BOOTSTRAP_POOL_ALLOCATION:aoa_app");
    }, 180_000);

    it("fails closed before serving when the aoa_app connection cannot open", async () => {
      guard();
      const result = await observeStartup({
        appDatabaseUrl: withApplicationName(
          appUrl.replace(APP_PASSWORD, DRIVER_CAUSE_SENTINEL),
          SQL_SENTINEL,
        ),
        operatorDatabaseUrl: operatorUrl,
        expectedCode: "distributed_execution_app_authority",
      });
      expect(result.exited).toBe(true);
      expect(result.code).not.toBe(0);
    }, 60_000);

    it("fails closed before serving when the aoa_operator connection cannot open", async () => {
      guard();
      const result = await observeStartup({
        appDatabaseUrl: appUrl,
        operatorDatabaseUrl: withApplicationName(
          operatorUrl.replace(OPERATOR_PASSWORD, DRIVER_CAUSE_SENTINEL),
          SQL_SENTINEL,
        ),
        expectedCode: "distributed_execution_operator_authority",
      });
      expect(result.exited).toBe(true);
      expect(result.code).not.toBe(0);
    }, 60_000);

    it("drops driver causes and SQL payloads from the direct error and closed structured log", async () => {
      guard();
      const harness = await createAdvisoryStartupHarness("redaction-sentinel");
      const operation = harness.open(harness.input);
      try {
        const outcome = await withOuterWatchdog(operation, 5_000);
        expect.soft(outcome).toMatchObject({
          kind: "rejected",
          error: {
            name: "DistributedExecutionStartupError",
            message: "distributed_execution_app_authority",
          },
        });
        expect(harness.state.injectionTriggered).toBe(true);
        const failure = outcome.kind === "rejected" ? outcome.error : undefined;
        expect(failure).toBeInstanceOf(Error);
        expect(Object.getOwnPropertyNames(failure).sort()).toEqual(["message", "name", "stack"]);
        expect(Object.prototype.hasOwnProperty.call(failure, "cause")).toBe(false);
        const ownSurface = Object.fromEntries(Object.getOwnPropertyNames(failure).map((key) => [
          key,
          String((failure as Record<string, unknown>)[key]),
        ]));
        const directSurface = [
          String(failure),
          String((failure as { cause?: unknown } | undefined)?.cause),
          JSON.stringify(failure),
          JSON.stringify(ownSurface),
        ].join("\n");
        assertClosedStartupLogs(harness.state.logs);
        const forbidden = [
          DRIVER_CAUSE_SENTINEL,
          SQL_SENTINEL,
          "JOB003_DRIVER_SENTINEL",
          harness.appNamedUrl,
          harness.operatorNamedUrl,
          adminUrl,
          "aoa_app",
          "aoa_operator",
          "test:test",
          "postgres://",
          ...checkedInMigrationIdentity().orderedHashes,
          ...harness.state.advisoryKeyBindings.map(String),
        ];
        expectCaseInsensitiveRedaction(directSurface, forbidden);
        expectCaseInsensitiveRedaction(JSON.stringify(harness.state.logs), forbidden);
        const expectedRoles = ["aoa_app"];
        expect(harness.state.factoryOptions.map(({ role }) => role)).toEqual(expectedRoles);
        expect(harness.state.closes.map(({ role }) => role)).toEqual(expectedRoles);
        expect(harness.state.closes.map(({ input }) => input)).toEqual([{ timeoutSeconds: 5 }]);
        expect(harness.state.closeSettled.map(({ role }) => role)).toEqual(expectedRoles);
        const returnedAt = harness.state.openInvocations[0]?.returnedAt;
        expect(typeof returnedAt).toBe("number");
        expect(harness.state.closeSettled[0]!.at).toBeLessThanOrEqual(returnedAt ?? -1);
      } finally {
        await harness.cleanup();
        await withOuterWatchdog(operation.then(() => undefined, () => undefined), 5_000);
      }
    }, 20_000);

    it("accepts only the exact aoa_app certificate DML allowlist and denies operator access", async () => {
      guard();
      const [certificate] = await admin!<{
        relation: string | null;
        app_privileges: string[] | null;
        operator_privileges: string[] | null;
      }[]>`
        SELECT to_regclass('public.worker_lease_rejections')::text AS relation,
          CASE WHEN to_regclass('public.worker_lease_rejections') IS NULL THEN NULL ELSE ARRAY(
            SELECT privilege_type FROM information_schema.role_table_grants
            WHERE grantee = 'aoa_app' AND table_schema = 'public'
              AND table_name = 'worker_lease_rejections'
            ORDER BY privilege_type
          ) END AS app_privileges,
          CASE WHEN to_regclass('public.worker_lease_rejections') IS NULL THEN NULL ELSE ARRAY(
            SELECT privilege_type FROM information_schema.role_table_grants
            WHERE grantee = 'aoa_operator' AND table_schema = 'public'
              AND table_name = 'worker_lease_rejections'
            ORDER BY privilege_type
          ) END AS operator_privileges
      `;
      expect.soft(certificate).toEqual({
        relation: "worker_lease_rejections",
        app_privileges: ["DELETE", "INSERT", "SELECT", "UPDATE"],
        operator_privileges: [],
      });
      if (certificate?.relation !== "worker_lease_rejections") return;

      const result = await observeStartup({
        appDatabaseUrl: appUrl,
        operatorDatabaseUrl: operatorUrl,
      });
      expect(result.exited, result.output).toBe(false);
    }, 60_000);

    it.each(["aoa_app", "aoa_operator"] as const)(
      "rejects an owner-pool fallback for %s even when that connection opens",
      async (expectedRole) => {
      guard();
      const result = await observeStartup({
        appDatabaseUrl: expectedRole === "aoa_app" ? adminUrl : appUrl,
        operatorDatabaseUrl: expectedRole === "aoa_operator" ? adminUrl : operatorUrl,
        expectedCode: expectedRole === "aoa_app"
          ? "distributed_execution_app_authority"
          : "distributed_execution_operator_authority",
      });
      expect(result.exited).toBe(true);
      expect(result.code).not.toBe(0);
      },
      60_000,
    );

    it.each(["aoa_app", "aoa_operator"] as const)(
      "rejects a superuser session masked as %s by a startup role option in the direct pool gate",
      async (expectedRole) => {
        guard();
        const maskedOwnerUrl = withStartupRole(adminUrl, expectedRole);
        const maskedOwner = postgres(maskedOwnerUrl, { max: 1 });
        try {
          const [masked] = await maskedOwner<{
            session_user: string;
            current_user: string;
          }[]>`SELECT session_user, current_user`;
          expect(masked).toEqual({ session_user: "test", current_user: expectedRole });
          await maskedOwner`SET ROLE NONE`;
          const [restored] = await maskedOwner<{
            session_user: string;
            current_user: string;
            rolsuper: boolean;
          }[]>`
            SELECT session_user, current_user, role.rolsuper
            FROM pg_roles role
            WHERE role.rolname = current_user
          `;
          expect(restored).toEqual({ session_user: "test", current_user: "test", rolsuper: true });
        } finally {
          await maskedOwner.end();
        }

        let accepted: Awaited<ReturnType<typeof openDistributedExecutionDatabases>> = null;
        let failure: unknown;
        try {
          accepted = await openFinalStartup(finalStartupInput({
            appDatabaseUrl: expectedRole === "aoa_app" ? maskedOwnerUrl : appUrl,
            operatorDatabaseUrl: expectedRole === "aoa_operator" ? maskedOwnerUrl : operatorUrl,
          }));
        } catch (error) {
          failure = error;
        } finally {
          await accepted?.close();
        }
        const expectedCode = expectedRole === "aoa_app"
          ? "distributed_execution_app_authority"
          : "distributed_execution_operator_authority";
        expect(failure).toMatchObject({
          name: "DistributedExecutionStartupError",
          message: expectedCode,
        });
        const serialized = [
          String(failure),
          JSON.stringify(failure),
          String((failure as { cause?: unknown } | undefined)?.cause),
          JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(failure).map((key) => [
            key,
            String((failure as Record<string, unknown>)[key]),
          ]))),
        ].join("\n");
        expect(Object.prototype.hasOwnProperty.call(failure, "cause")).toBe(false);
        expectCaseInsensitiveRedaction(serialized, [
          DRIVER_CAUSE_SENTINEL,
          SQL_SENTINEL,
          ...checkedInMigrationIdentity().orderedHashes,
          maskedOwnerUrl,
          appUrl,
          operatorUrl,
          adminUrl,
          APP_PASSWORD,
          OPERATOR_PASSWORD,
          "test:test",
          "postgres://",
          "aoa_app",
          "aoa_operator",
        ]);
      },
      60_000,
    );

    it.each(["aoa_app", "aoa_operator"] as const)(
      "rejects a superuser session masked as %s before the real server reaches health",
      async (expectedRole) => {
        guard();
        const maskedOwnerUrl = withStartupRole(adminUrl, expectedRole);
        const result = await observeStartup({
          appDatabaseUrl: expectedRole === "aoa_app" ? maskedOwnerUrl : appUrl,
          operatorDatabaseUrl: expectedRole === "aoa_operator" ? maskedOwnerUrl : operatorUrl,
          expectedCode: expectedRole === "aoa_app"
            ? "distributed_execution_app_authority"
            : "distributed_execution_operator_authority",
        });
        expect(result.exited, result.output).toBe(true);
        expect(result.code).not.toBe(0);
      },
      60_000,
    );

    it("rejects an operator-granted view over company_secrets before serving", async () => {
      guard();
      await admin!.unsafe(`CREATE VIEW operator_secret_view AS SELECT id FROM company_secrets`);
      await admin!.unsafe(`GRANT SELECT ON operator_secret_view TO aoa_operator`);
      try {
        const result = await observeStartup({
          appDatabaseUrl: appUrl,
          operatorDatabaseUrl: operatorUrl,
          expectedCode: "distributed_execution_operator_authority",
        });
        expect(result.exited, result.output).toBe(true);
        expect(result.code).not.toBe(0);
      } finally {
        await admin!.unsafe(`DROP VIEW IF EXISTS operator_secret_view`).catch(() => {});
      }
    }, 60_000);

    it("rejects an exact-named app role with inherited secret authority", async () => {
      guard();
      await admin!.unsafe(`CREATE ROLE "aoa_startup_drift_parent" NOLOGIN`);
      await admin!.unsafe(`GRANT SELECT ON company_secrets TO "aoa_startup_drift_parent"`);
      await admin!.unsafe(`GRANT "aoa_startup_drift_parent" TO aoa_app`);
      try {
        const result = await observeStartup({
          appDatabaseUrl: appUrl,
          operatorDatabaseUrl: operatorUrl,
          expectedCode: "distributed_execution_app_authority",
        });
        expect(result.exited).toBe(true);
        expect(result.code).not.toBe(0);
      } finally {
        await admin!.unsafe(`REVOKE "aoa_startup_drift_parent" FROM aoa_app`).catch(() => {});
        await admin!.unsafe(`REVOKE SELECT ON company_secrets FROM "aoa_startup_drift_parent"`).catch(() => {});
        await admin!.unsafe(`DROP ROLE IF EXISTS "aoa_startup_drift_parent"`).catch(() => {});
      }
    }, 60_000);

    it("rejects an exact-named operator role with a stale table grant", async () => {
      guard();
      await admin!.unsafe(`GRANT SELECT ON company_secrets TO aoa_operator`);
      try {
        const result = await observeStartup({
          appDatabaseUrl: appUrl,
          operatorDatabaseUrl: operatorUrl,
          expectedCode: "distributed_execution_operator_authority",
        });
        expect(result.exited).toBe(true);
        expect(result.code).not.toBe(0);
      } finally {
        await admin!.unsafe(`REVOKE SELECT ON company_secrets FROM aoa_operator`).catch(() => {});
      }
    }, 60_000);

    it.each([
      ["aoa_app", "distributed_execution_app_authority", "app"],
      ["aoa_operator", "distributed_execution_operator_authority", "operator"],
    ] as const)("rejects PostgreSQL 18 MAINTAIN on an ephemeral non-manifest table for %s", async (
      role,
      errorCode,
      suffix,
    ) => {
      // Mutation caught: omitting MAINTAIN from the whole-catalog effective-privilege scan
      // accepts authority that is absent from every checked-in serving manifest.
      guard();
      const relation = `job003_maintain_${suffix}_${process.pid}`;
      const [before] = await admin!<{ relation: string | null }[]>`
        SELECT to_regclass(${`public.${relation}`})::text AS relation`;
      expect(before?.relation).toBeNull();
      let created = false;
      let failure: unknown;
      try {
        await admin!.unsafe(`CREATE TABLE "${relation}" (id integer)`);
        created = true;
        await admin!.unsafe(`GRANT MAINTAIN ON TABLE "${relation}" TO "${role}"`);
        const [granted] = await admin!<{ maintain: boolean }[]>`
          SELECT has_table_privilege(${role}, ${`public.${relation}`}, 'MAINTAIN') AS maintain`;
        expect(granted?.maintain).toBe(true);
        failure = await captureFinalStartupFailure();
      } finally {
        if (created) {
          try {
            await admin!.unsafe(`REVOKE MAINTAIN ON TABLE "${relation}" FROM "${role}"`);
          } finally {
            await admin!.unsafe(`DROP TABLE "${relation}"`);
          }
        }
      }
      const [after] = await admin!<{ relation: string | null }[]>`
        SELECT to_regclass(${`public.${relation}`})::text AS relation`;
      expect(after?.relation).toBeNull();
      expect(failure).toMatchObject({ message: errorCode });
    }, 60_000);

    it("rejects an exact-named operator role that owns an application object", async () => {
      guard();
      await admin!.unsafe(`CREATE TABLE startup_owned_drift_probe (id integer)`);
      await admin!.unsafe(`ALTER TABLE startup_owned_drift_probe OWNER TO aoa_operator`);
      try {
        const result = await observeStartup({
          appDatabaseUrl: appUrl,
          operatorDatabaseUrl: operatorUrl,
          expectedCode: "distributed_execution_operator_authority",
        });
        expect(result.exited).toBe(true);
        expect(result.code).not.toBe(0);
      } finally {
        await admin!.unsafe(`DROP TABLE IF EXISTS startup_owned_drift_probe`).catch(() => {});
      }
    }, 60_000);

    it("rejects replication authority on an exact-named serving role", async () => {
      guard();
      await admin!.unsafe(`ALTER ROLE aoa_operator REPLICATION`);
      try {
        const result = await observeStartup({
          appDatabaseUrl: appUrl,
          operatorDatabaseUrl: operatorUrl,
          expectedCode: "distributed_execution_operator_authority",
        });
        expect(result.exited).toBe(true);
        expect(result.code).not.toBe(0);
      } finally {
        await admin!.unsafe(`ALTER ROLE aoa_operator NOREPLICATION`).catch(() => {});
      }
    }, 60_000);

    it.each([
      ["app", () => otherAppUrl, () => operatorUrl],
      ["operator", () => appUrl, () => otherOperatorUrl],
    ] as const)("rejects a fully migrated %s pool on another valid database before returning either pool", async (
      _participant,
      appDatabaseUrl,
      operatorDatabaseUrl,
    ) => {
      guard();
      const selectedAppUrl = appDatabaseUrl();
      const selectedOperatorUrl = operatorDatabaseUrl();
      let accepted: Awaited<ReturnType<typeof openDistributedExecutionDatabases>> = null;
      let failure: unknown;
      try {
        accepted = await openFinalStartup(finalStartupInput({
          appDatabaseUrl: selectedAppUrl,
          operatorDatabaseUrl: selectedOperatorUrl,
        }));
      } catch (error) {
        failure = error;
      } finally {
        await accepted?.close().catch(() => {});
      }
      expect(failure).toMatchObject({ message: "distributed_execution_advisory_domain" });
      expect(String(failure)).not.toContain(selectedAppUrl);
      expect(String(failure)).not.toContain(selectedOperatorUrl);
    }, 60_000);

    it("proves the public startup API exhausts both max-four pools through the real transaction-advisory barrier and leaves no peer", async () => {
      // Mutations caught: comparing URL/database strings, probing one lazy connection, or
      // running the positive peers sequentially cannot produce this real-PG phase receipt.
      guard();
      const harness = await createAdvisoryStartupHarness();
      let accepted: Awaited<ReturnType<typeof openDistributedExecutionDatabases>> = null;
      let failure: unknown;
      let settlement: Awaited<ReturnType<typeof observeAdvisoryStartupSettlement>> | undefined;
      try {
        accepted = await harness.open(harness.input);
      } catch (error) {
        failure = error;
      } finally {
        await accepted?.close().catch(() => {});
        settlement = await observeAdvisoryStartupSettlement(
          harness.token,
          harness.state.dedicatedOwnerReceipts,
        );
        await harness.cleanup();
      }

      expect(failure).toBeUndefined();
      expect(harness.state.factoryOptions).toEqual([
        {
          role: "aoa_app",
          options: {
            max: 4,
            connectTimeoutMs: 5_000,
            statementTimeoutMs: 5_000,
            lockTimeoutMs: 750,
            idleInTransactionSessionTimeoutMs: 5_000,
            idleTimeoutMs: 30_000,
          },
        },
        {
          role: "aoa_operator",
          options: {
            max: 4,
            connectTimeoutMs: 5_000,
            statementTimeoutMs: 5_000,
            lockTimeoutMs: 750,
            idleInTransactionSessionTimeoutMs: 5_000,
            idleTimeoutMs: 30_000,
          },
        },
      ]);
      expect(harness.state.phases[0]).toBe("owner-exclusive");
      expect(harness.state.phases.filter((phase) => phase === "app-negative")).toHaveLength(4);
      expect(harness.state.phases.filter((phase) => phase === "operator-negative")).toHaveLength(4);
      expect(harness.state.phases.filter((phase) => phase === "app-positive")).toHaveLength(4);
      expect(harness.state.phases.filter((phase) => phase === "operator-positive")).toHaveLength(4);
      expect(harness.state.positiveBarrierReached).toBe(true);
      expect(harness.state.abortControllers).toHaveLength(1);
      expect(harness.state.abortCalls).toBe(0);
      expect(harness.state.slotIds.aoa_app.size).toBe(4);
      expect(harness.state.slotIds.aoa_operator.size).toBe(4);
      expect(harness.state.closes).toEqual([
        { role: "aoa_operator", input: { timeoutSeconds: 5 } },
        { role: "aoa_app", input: { timeoutSeconds: 5 } },
      ]);
      expect(harness.state.closeSettled.map(({ role }) => role).sort())
        .toEqual(["aoa_app", "aoa_operator"]);
      expect(settlement).toEqual({
        participant_pids: 0,
        dedicated_owner_pids: 0,
        legacy_owner_pids: expect.any(Number),
        legacy_owner_invalid: 0,
        advisory_locks: 0,
      });
    }, 60_000);

    it("creates a fresh key, controller, and exact deadline for two calls through one isolated module", async () => {
      guard();
      const harness = await createAdvisoryStartupHarness("shared-budget");
      const failures: unknown[] = [];
      const settlements: Awaited<ReturnType<typeof observeAdvisoryStartupSettlement>>[] = [];
      try {
        // One harness owns one isolated import. Recreating it here would conceal module-scoped
        // key/controller/deadline reuse, which is the production mutation this test catches.
        for (let run = 0; run < 2; run += 1) {
        let accepted: Awaited<ReturnType<typeof openDistributedExecutionDatabases>> = null;
        try {
          accepted = await harness.open(harness.input);
          failures.push(undefined);
        } catch (error) {
          failures.push(error);
        } finally {
          await accepted?.close().catch(() => {});
          settlements.push(await observeAdvisoryStartupSettlement(
            harness.token,
            harness.state.dedicatedOwnerReceipts,
          ));
        }
        }
      } finally {
        await harness.cleanup();
      }

      expect.soft(failures).toHaveLength(2);
      for (const failure of failures) {
        expect.soft(failure).toMatchObject({ message: "distributed_execution_timeout" });
      }
      expect.soft(harness.state.openInvocations).toHaveLength(2);
      expect.soft(harness.state.abortCalls).toBe(2);
      const keys = harness.state.openInvocations.flatMap((receipt) => receipt.advisoryKeys);
      expect.soft(keys).toHaveLength(2);
      for (const key of keys) {
        expect.soft(key).toBeGreaterThanOrEqual(-(2n ** 63n));
        expect.soft(key).toBeLessThan(2n ** 63n);
      }
      if (keys.length === 2) expect.soft(keys[0]).not.toBe(keys[1]);

      const controllers = harness.state.openInvocations.flatMap((receipt) => receipt.controllers);
      expect.soft(controllers).toHaveLength(2);
      if (controllers.length === 2) expect.soft(controllers[0]).not.toBe(controllers[1]);
      const deadlines = harness.state.openInvocations.flatMap((receipt) =>
        receipt.deadlineReceipt ? [receipt.deadlineReceipt] : [],
      );
      expect.soft(deadlines).toHaveLength(2);
      if (deadlines.length === 2) {
        expect.soft(deadlines[0]).not.toBe(deadlines[1]);
        expect.soft(deadlines[0]!.signal).not.toBe(deadlines[1]!.signal);
        expect.soft(deadlines[0]!.at).toBeLessThan(deadlines[1]!.at);
      }
      for (const receipt of harness.state.openInvocations) {
        expect.soft(receipt.controllers).toHaveLength(1);
        expect.soft(receipt.deadlineReceipt?.signal).toBe(receipt.controllers[0]?.signal);
        if (receipt.controllerCreatedAt !== null && receipt.deadlineReceipt && receipt.returnedAt !== null) {
          const budgetElapsed = receipt.deadlineReceipt.at - receipt.controllerCreatedAt;
          expect.soft(budgetElapsed).toBeGreaterThanOrEqual(4_500);
          expect.soft(budgetElapsed).toBeLessThan(6_500);
          expect.soft(receipt.returnedAt - receipt.controllerCreatedAt).toBeLessThan(7_500);
        }
      }
      expect.soft(settlements).toEqual([
        {
          participant_pids: 0,
          dedicated_owner_pids: 0,
          legacy_owner_pids: expect.any(Number),
          legacy_owner_invalid: 0,
          advisory_locks: 0,
        },
        {
          participant_pids: 0,
          dedicated_owner_pids: 0,
          legacy_owner_pids: expect.any(Number),
          legacy_owner_invalid: 0,
          advisory_locks: 0,
        },
      ]);
    }, 120_000);

    it("spends one monotonic deadline across sequential owner and concurrent app/operator phases", async () => {
      // Mutation caught: resetting a five-second timeout per participant lets two individually
      // sub-limit delays consume more than the one allowed startup budget and return a pool.
      // The negative phase gates only observe abort; they cannot reject/resolve until this test
      // releases them after the public open call has settled, so a cosmetic production listener
      // cannot borrow fixture-owned cancellation to pass.
      guard();
      const harness = await createAdvisoryStartupHarness("shared-budget-pending");
      let accepted: Awaited<ReturnType<typeof openDistributedExecutionDatabases>> = null;
      type OpenOutcome =
        | { readonly kind: "fulfilled"; readonly value: Awaited<ReturnType<typeof openDistributedExecutionDatabases>> }
        | { readonly kind: "rejected"; readonly error: unknown };
      const openSettlement = harness.open(harness.input).then<OpenOutcome>(
        (value) => ({ kind: "fulfilled", value }),
        (error: unknown) => ({ kind: "rejected", error }),
      );
      let initialOutcome: OpenOutcome | { readonly kind: "watchdog" } | undefined;
      let finalOutcome: OpenOutcome | undefined;
      let watchdogHandle: ReturnType<typeof setTimeout> | undefined;
      let drainWatchdogHandle: ReturnType<typeof setTimeout> | undefined;
      let releaseAt: number | null = null;
      let productionReturnedAtBeforeRelease: number | null = null;
      let fixtureWorkDrainedAt: number | null = null;
      let closeSettledBeforeRelease: typeof harness.state.closeSettled = [];
      let settlement: Awaited<ReturnType<typeof observeAdvisoryStartupSettlement>> | undefined;
      try {
        initialOutcome = await Promise.race([
          openSettlement,
          new Promise<{ readonly kind: "watchdog" }>((resolve) => {
            watchdogHandle = setTimeout(() => resolve({ kind: "watchdog" }), 15_000);
          }),
        ]);
        if (initialOutcome.kind !== "watchdog") finalOutcome = initialOutcome;
      } finally {
        if (watchdogHandle) clearTimeout(watchdogHandle);
        const invocationId = harness.state.openInvocations[0]?.id;
        closeSettledBeforeRelease = [...harness.state.closeSettled];
        productionReturnedAtBeforeRelease = harness.state.openInvocations[0]?.returnedAt ?? null;
        releaseAt = harness.releasePendingBudgetWork(invocationId);
        await harness.waitForPendingBudgetWork(invocationId);
        fixtureWorkDrainedAt = performance.now();
        if (!finalOutcome) {
          const drainedOutcome = await Promise.race([
            openSettlement,
            new Promise<{ readonly kind: "drain-watchdog" }>((resolve) => {
              drainWatchdogHandle = setTimeout(() => resolve({ kind: "drain-watchdog" }), 10_000);
            }),
          ]);
          if (drainedOutcome.kind !== "drain-watchdog") finalOutcome = drainedOutcome;
        }
        if (drainWatchdogHandle) clearTimeout(drainWatchdogHandle);
        accepted = finalOutcome?.kind === "fulfilled" ? finalOutcome.value : null;
        await accepted?.close().catch(() => {});
        const drainDeadline = performance.now() + 5_000;
        while (performance.now() < drainDeadline) {
          const pendingTransactions = harness.state.transactionReceipts.some((receipt) =>
            receipt.invocationId === invocationId && receipt.phase !== null && receipt.settledAt === null,
          );
          if (!pendingTransactions) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const observationDeadline = performance.now() + 5_000;
        do {
          settlement = await observeAdvisoryStartupSettlement(
            harness.token,
            harness.state.dedicatedOwnerReceipts,
          );
          if (settlement.participant_pids === 0 && settlement.dedicated_owner_pids === 0 &&
            settlement.legacy_owner_invalid === 0 && settlement.advisory_locks === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (performance.now() < observationDeadline);
        await harness.cleanup();
      }

      expect(accepted === null, "shared budget expiry must not return either pool").toBe(true);
      expect(initialOutcome?.kind, "public open must settle before the external watchdog").toBe("rejected");
      expect(finalOutcome).toMatchObject({
        kind: "rejected",
        error: { message: "distributed_execution_timeout" },
      });
      expect(harness.state.abortControllers).toHaveLength(1);
      expect(harness.state.abortCalls).toBe(1);
      const [invocation] = harness.state.openInvocations;
      expect.soft(harness.state.openInvocations).toHaveLength(1);
      const windows = harness.state.budgetWindows.filter((window) =>
        window.invocationId === invocation?.id,
      );
      expect.soft(windows.map((window) => window.phase).sort()).toEqual([
        "app-negative", "operator-negative", "owner-exclusive",
      ]);
      expect.soft(windows.some((window) => window.phase.endsWith("positive"))).toBe(false);
      expect.soft(harness.state.phases.some((phase) => phase.endsWith("positive"))).toBe(false);
      const owner = windows.find((window) => window.phase === "owner-exclusive");
      const app = windows.find((window) => window.phase === "app-negative");
      const operator = windows.find((window) => window.phase === "operator-negative");
      const deadline = invocation?.deadlineReceipt ?? null;
      expect.soft(owner?.cancelledDuringWork).toBe(false);
      expect.soft(app?.cancelledDuringWork).toBe(false);
      expect.soft(operator?.cancelledDuringWork).toBe(false);
      expect.soft(app?.abortObservedWhilePending).toBe(true);
      expect.soft(operator?.abortObservedWhilePending).toBe(true);
      for (const window of windows) {
        expect.soft(window.signal).toBe(invocation?.controllers[0]?.signal);
        expect.soft(window.abortReceipt).toBe(deadline);
        expect.soft(typeof window.settledAt).toBe("number");
      }
      expect.soft(closeSettledBeforeRelease.map(({ role }) => role).sort()).toEqual([
        "aoa_app", "aoa_operator",
      ]);
      expect.soft(harness.state.pendingBudgetWork.map(({ phase }) => phase).sort()).toEqual([
        "app-negative", "operator-negative",
      ]);
      expect.soft(harness.state.pendingQueryTimeouts
        .map(({ phase, effectiveStatementTimeout }) => ({ phase, effectiveStatementTimeout }))
        .sort((left, right) => left.phase.localeCompare(right.phase))).toEqual([
        { phase: "app-negative", effectiveStatementTimeout: "0" },
        { phase: "operator-negative", effectiveStatementTimeout: "0" },
      ]);
      expect.soft(harness.state.pendingQueryTimeouts.every(({ invocationId }) =>
        invocationId === invocation?.id)).toBe(true);
      expect.soft(typeof productionReturnedAtBeforeRelease).toBe("number");
      expect.soft(productionReturnedAtBeforeRelease).toBe(invocation?.returnedAt ?? null);
      expect.soft(typeof releaseAt).toBe("number");
      expect.soft(typeof fixtureWorkDrainedAt).toBe("number");
      if (releaseAt !== null && fixtureWorkDrainedAt !== null && invocation?.returnedAt !== null) {
        expect.soft(invocation.returnedAt).toBeLessThan(releaseAt);
        expect.soft(fixtureWorkDrainedAt).toBeGreaterThanOrEqual(releaseAt);
        for (const pending of harness.state.pendingBudgetWork) {
          expect.soft(pending.releasedAt).toBeGreaterThanOrEqual(releaseAt);
          expect.soft(pending.drainedAt).toBeGreaterThanOrEqual(releaseAt);
        }
        for (const peer of [app, operator]) {
          expect.soft(peer?.releasedAt).toBeGreaterThanOrEqual(releaseAt);
          expect.soft(peer?.settledAt).toBeLessThanOrEqual(invocation.returnedAt);
        }
      }
      if (owner?.settledAt !== null && owner && app && operator && deadline &&
        app.settledAt !== null && operator.settledAt !== null &&
        invocation?.controllerCreatedAt !== null && invocation?.returnedAt !== null) {
        const ownerElapsed = owner.settledAt - owner.startedAt;
        expect.soft(ownerElapsed).toBeGreaterThanOrEqual(2_750);
        expect.soft(ownerElapsed).toBeLessThan(4_250);
        expect.soft(app.startedAt).toBeGreaterThanOrEqual(owner.settledAt);
        expect.soft(operator.startedAt).toBeGreaterThanOrEqual(owner.settledAt);
        expect.soft(deadline.at).toBeGreaterThanOrEqual(Math.max(app.startedAt, operator.startedAt));
        expect.soft(deadline.at).toBeGreaterThanOrEqual(invocation.controllerCreatedAt + 4_500);
        expect.soft(deadline.at).toBeLessThan(invocation.controllerCreatedAt + 6_500);
        expect.soft(invocation.returnedAt - invocation.controllerCreatedAt).toBeLessThan(15_000);
      }
      const phaseTransactions = harness.state.transactionReceipts.filter((receipt) =>
        receipt.invocationId === invocation?.id && receipt.phase !== null,
      );
      for (const phase of ["owner-exclusive", "app-negative", "operator-negative"] as const) {
        const transaction = phaseTransactions.find((receipt) => receipt.phase === phase);
        expect.soft(transaction?.outcome, phase).toBe("rejected");
        expect.soft(typeof transaction?.settledAt, phase).toBe("number");
        if (transaction?.settledAt !== null && invocation?.returnedAt !== null) {
          expect.soft(transaction.settledAt, phase).toBeLessThanOrEqual(invocation?.returnedAt ?? -1);
        }
      }
      expect(settlement).toEqual({
        participant_pids: 0,
        dedicated_owner_pids: 0,
        legacy_owner_pids: expect.any(Number),
        legacy_owner_invalid: 0,
        advisory_locks: 0,
      });
    }, 60_000);

    it("calibrates the same-session cancellation dry-run without canceling any backend", async () => {
      guard();
      const token = `job003_dry_run_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const control = postgres(withApplicationName(adminUrl, `${token}_control`), { max: 1 });
      const target = postgres(withApplicationName(adminUrl, `${token}_target`), { max: 1 });
      const distractor = postgres(withApplicationName(adminUrl, `${token}_distractor`), { max: 1 });
      const identityQuery = `
        SELECT pg_backend_pid() AS pid, backend_start::text AS backend_start,
          session_user::text AS session_role, current_database()::text AS database_name,
          current_setting('application_name')::text AS application_name
        FROM pg_stat_activity WHERE pid = pg_backend_pid()
      `;
      try {
        const [targetIdentity] = await target.unsafe<Array<{
          pid: number;
          backend_start: string;
          session_role: string;
          database_name: string;
          application_name: string;
        }>>(identityQuery);
        const [distractorIdentity] = await distractor.unsafe<Array<{ pid: number }>>(identityQuery);
        expect(targetIdentity).toBeDefined();
        expect(typeof targetIdentity?.backend_start).toBe("string");
        expect(distractorIdentity).toBeDefined();
        await control.begin(async (transaction) => {
          const [controlIdentity] = await transaction.unsafe<Array<{
            pid: number;
            backend_start: string;
            session_role: string;
            database_name: string;
            application_name: string;
          }>>(identityQuery);
          expect(controlIdentity).toBeDefined();
          const [targetActivity] = await transaction.unsafe<Array<{
            pid: number;
            backend_start: string;
            session_role: string;
            database_name: string;
            application_name: string;
          }>>(`
            SELECT pid, backend_start::text AS backend_start,
              usename::text AS session_role, datname::text AS database_name,
              application_name::text AS application_name
            FROM pg_stat_activity WHERE pid = $1
          `, [targetIdentity!.pid]);
          expect(targetActivity).toEqual(targetIdentity);
          const [preflight] = await transaction.unsafe<Array<{
            pid_match: boolean;
            backend_start_match: boolean;
            session_role_match: boolean;
            database_name_match: boolean;
            application_name_match: boolean;
          }>>(`
            SELECT activity.pid = $1 AS pid_match,
              activity.backend_start::text = $2 AS backend_start_match,
              activity.usename = $3 AS session_role_match,
              activity.datname = $4 AS database_name_match,
              activity.application_name = $5 AS application_name_match
            FROM pg_stat_activity activity
            WHERE activity.pid = $1
          `, [
            targetIdentity!.pid,
            targetIdentity!.backend_start,
            targetIdentity!.session_role,
            targetIdentity!.database_name,
            targetIdentity!.application_name,
          ]);
          expect(preflight).toEqual({
            pid_match: true,
            backend_start_match: true,
            session_role_match: true,
            database_name_match: true,
            application_name_match: true,
          });
          const dryRun = await runCancellationDryRun(transaction, {
            sql: `
              select pg_cancel_backend(activity.pid)
              from pg_stat_activity activity
              where activity.pid = $1
                and activity.backend_start::text = $2
                and activity.usename = $3
                and activity.datname = $4
                and activity.application_name = $5
                and not (
                  activity.pid = $6
                  and activity.backend_start::text = $7
                  and activity.usename = $8
                  and activity.datname = $9
                  and activity.application_name = $10
                )
            `,
            params: [
              targetIdentity!.pid,
              targetIdentity!.backend_start,
              targetIdentity!.session_role,
              targetIdentity!.database_name,
              targetIdentity!.application_name,
              controlIdentity!.pid,
              controlIdentity!.backend_start,
              controlIdentity!.session_role,
              controlIdentity!.database_name,
              controlIdentity!.application_name,
            ],
          });
          const mutationCoverage = Object.fromEntries(CANCELLATION_IDENTITY_FIELDS.map(({ field }) => [
            field,
            dryRun.mutations.some((mutation) =>
              mutation.targetPid === targetIdentity!.pid && mutation.field === field &&
              !mutation.candidatePids.includes(targetIdentity!.pid)),
          ]));
          expect({
            outcome: dryRun.outcome,
            settled: typeof dryRun.settledAt === "number",
            targetAlias: dryRun.targetAlias,
            originalCandidates: dryRun.originalCandidatePids,
            targets: dryRun.targetIdentities.map(({ pid }) => pid),
            mutationCoverage,
            controlSubstitution: dryRun.controlSubstitutions,
            controlRecorded: dryRun.originalCandidatePids.includes(controlIdentity!.pid),
            distractorRecorded: dryRun.originalCandidatePids.includes(distractorIdentity!.pid),
          }).toEqual({
            outcome: "fulfilled",
            settled: true,
            targetAlias: "activity",
            originalCandidates: [targetIdentity!.pid],
            targets: [targetIdentity!.pid],
            mutationCoverage: {
              pid: true,
              backendStart: true,
              sessionRole: true,
              databaseName: true,
              applicationName: true,
            },
            controlSubstitution: [{ targetPid: targetIdentity!.pid, candidatePids: [] }],
            controlRecorded: false,
            distractorRecorded: false,
          });
        });
      } finally {
        await Promise.all([
          control.end({ timeout: 5 }),
          target.end({ timeout: 5 }),
          distractor.end({ timeout: 5 }),
        ]);
      }
    });

    it("uses a dedicated owner transaction while every literal input-owner slot is reserved", async () => {
      // Mutation caught: queuing begin() on input.ownerDb, or treating an app allocation as a
      // bypass, cannot satisfy this lane. A real dedicated owner transaction must be pending
      // before abort, and production alone must settle and dispose every dedicated session.
      guard();
      const harness = await createAdvisoryStartupHarness("transaction-acquisition-pending");
      const reservations = await harness.reserveOwnerSlots(4);
      const operation = harness.open(harness.input);
      void operation.catch(() => {});
      let dedicatedPending: (typeof harness.state.pendingQueries)[number] | null = null;
      try {
        const [invocation] = harness.state.openInvocations;
        const controller = invocation?.controllers[0];
        dedicatedPending = invocation
          ? await harness.tryWaitForActivePendingQuery("transaction-acquisition", invocation.id, 3_500)
          : null;
        const pendingTransactions = harness.state.transactionReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id && receipt.source === "dedicated-owner" &&
          receipt.phase === "transaction-acquisition" && receipt.settledAt === null);
        const externallyAbortedAt = performance.now();
        controller?.abort();
        const exactAbortAt = invocation?.deadlineReceipt?.at ?? externallyAbortedAt;
        const prompt = dedicatedPending
          ? await waitForReceiptSettlement(
              [dedicatedPending, ...pendingTransactions],
              exactAbortAt + EARLY_ABORT_SETTLEMENT_WATCHDOG_MS,
            )
          : { kind: "missing" as const };
        const outcome = await withOuterWatchdog(operation, EARLY_ABORT_PUBLIC_WATCHDOG_MS);
        const publicReturnedAt = invocation?.returnedAt ?? null;
        const dedicatedOwners = harness.state.dedicatedOwnerReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id);
        const tags = dedicatedOwners.map(({ applicationName }) => applicationName);
        const settlement = await observeAdvisoryStartupSettlement(
          harness.token,
          dedicatedOwners,
        );
        expect({
          reservedDistinctPids: new Set(reservations.receipts.map(({ pid }) => pid)).size,
          reservationsHeld: reservations.receipts.every(({ releasedAt }) => releasedAt === null),
          controllerCount: invocation?.controllers.length ?? 0,
          dedicatedPending: dedicatedPending !== null &&
            dedicatedPending.source === "dedicated-owner" &&
            dedicatedPending.dedicatedOwnerId !== null,
          dedicatedTransactionCount: pendingTransactions.length,
          promptKind: prompt.kind,
          sharedOwnerQueries: harness.state.ownerQueryReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          sharedOwnerTransactions: harness.state.transactionReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          sharedOwnerRawOperations: harness.state.sharedOwnerRawOperations.filter((receipt) =>
            receipt.invocationId === invocation?.id).length,
          sharedOwnerPrivateReads: harness.state.sharedOwnerPrivateReads.filter((receipt) =>
            receipt.invocationId === invocation?.id).length,
          publicKind: outcome.kind,
          errorCode: outcome.kind === "rejected"
            ? (outcome.error as { message?: unknown }).message
            : null,
          returnedWithinBound: typeof publicReturnedAt === "number" &&
            publicReturnedAt - externallyAbortedAt < EARLY_ABORT_PUBLIC_WATCHDOG_MS,
          dedicatedWorkSettledBeforeReturn: typeof publicReturnedAt === "number" &&
            dedicatedPending !== null &&
            [dedicatedPending, ...pendingTransactions].every((receipt) =>
              receipt.settledAt !== null && receipt.settledAt <= publicReturnedAt),
          dedicatedSessionCount: dedicatedOwners.length,
          nonemptyDistinctTags: tags.length > 1 && tags.every((tag) =>
            typeof tag === "string" && tag.length > 0 && tag !== `${harness.token}_owner`) &&
            new Set(tags).size === tags.length,
          productionDisposed: typeof publicReturnedAt === "number" &&
            dedicatedOwners.every((receipt) =>
              exactBoundedDedicatedEndBefore(receipt, publicReturnedAt)),
          settlement,
        }).toEqual({
          reservedDistinctPids: 4,
          reservationsHeld: true,
          controllerCount: 1,
          dedicatedPending: true,
          dedicatedTransactionCount: 1,
          promptKind: "settled",
          sharedOwnerQueries: 0,
          sharedOwnerTransactions: 0,
          sharedOwnerRawOperations: 0,
          sharedOwnerPrivateReads: 0,
          publicKind: "rejected",
          errorCode: "distributed_execution_timeout",
          returnedWithinBound: true,
          dedicatedWorkSettledBeforeReturn: true,
          dedicatedSessionCount: expect.any(Number),
          nonemptyDistinctTags: true,
          productionDisposed: true,
          settlement: {
            participant_pids: 0,
            dedicated_owner_pids: 0,
            legacy_owner_pids: 4,
            legacy_owner_invalid: 0,
            advisory_locks: 0,
          },
        });
      } finally {
        if (dedicatedPending?.backendPid && dedicatedPending.settledAt === null) {
          await harness.cancelBackend(dedicatedPending.backendPid).catch(() => false);
        }
        await reservations.release();
        const drained = await withOuterWatchdog(operation.then(() => true, () => true), 12_000);
        await harness.cleanup();
        expect(drained).toMatchObject({ kind: "fulfilled", value: true });
      }
    }, 35_000);

    it.each([
      ["timeout-setup-pending", "timeout-setup"],
      ["backend-identity-pending", "backend-identity"],
    ] as const)("settles the real owner %s stage before returning from an external abort", async (
      injection,
      phase,
    ) => {
      // Mutation caught: executing either pre-registration stage through input.ownerDb, or
      // omitting a distinct tagged control that excludes itself, cannot settle this lane.
      guard();
      const harness = await createAdvisoryStartupHarness(injection);
      const reservations = await harness.reserveOwnerSlots(4);
      const operation = harness.open(harness.input);
      void operation.catch(() => {});
      let productionPending: (typeof harness.state.pendingQueries)[number] | null = null;
      try {
        const [invocation] = harness.state.openInvocations;
        expect(invocation?.controllers).toHaveLength(1);
        const controller = invocation?.controllers[0];
        expect(controller?.signal.aborted).toBe(false);

        const milestoneDeadline = performance.now() + 3_500;
        do {
          productionPending = harness.state.pendingQueries.find((receipt) =>
            receipt.invocationId === invocation?.id && receipt.phase === phase &&
            receipt.source === "dedicated-owner" && receipt.dedicatedOwnerId !== null &&
            receipt.sleepIssuedAt !== null && receipt.settledAt === null) ?? null;
          if (productionPending) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (performance.now() < milestoneDeadline);

        const abortPending = productionPending;
        const transactionsPendingAtAbort = abortPending
          ? harness.state.transactionReceipts.filter((receipt) =>
              receipt.invocationId === invocation?.id && receipt.phase === abortPending.phase &&
              receipt.outcome === "pending" && receipt.settledAt === null)
          : [];
        if (abortPending) {
          expect(transactionsPendingAtAbort).toHaveLength(1);
          expect(abortPending.settledAt).toBeNull();
        }

        const externallyAbortedAt = performance.now();
        controller?.abort();
        const exactAbortAt = invocation?.deadlineReceipt?.at;

        let promptKind: "settled" | "watchdog" | "missing" = "missing";
        if (abortPending) {
          const promptDeadline = (exactAbortAt ?? Number.NEGATIVE_INFINITY) +
            EARLY_ABORT_SETTLEMENT_WATCHDOG_MS;
          const prompt = await waitForReceiptSettlement(
            [abortPending, ...transactionsPendingAtAbort],
            promptDeadline,
          );
          promptKind = prompt.kind;
        }

        const publicRemaining = Math.max(
          1,
          EARLY_ABORT_PUBLIC_WATCHDOG_MS -
            (performance.now() - (exactAbortAt ?? externallyAbortedAt)),
        );
        const outcome = await withOuterWatchdog(operation, publicRemaining);
        const publicReturnedAt = invocation?.returnedAt;
        const trackedReceipts = abortPending
          ? [abortPending, ...transactionsPendingAtAbort]
          : [];
        const dedicatedOwners = harness.state.dedicatedOwnerReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id);
        const participant = dedicatedOwners.find((receipt) =>
          receipt.id === productionPending?.dedicatedOwnerId);
        const controls = dedicatedOwners.filter((receipt) => receipt.id !== participant?.id &&
          receipt.queryReceipts.some(({ semantic }) =>
            semantic === "cancellation-discovery" || semantic === "cancellation"));
        const tags = dedicatedOwners.map(({ applicationName }) => applicationName);
        const participantIdentity = participant?.observedIdentities[0];
        const cancellationDryRuns = controls.flatMap((control) => control.queryReceipts
          .filter(({ semantic }) => semantic === "cancellation")
          .map(({ dryRun }) => dryRun)
          .filter((dryRun): dryRun is CancellationDryRunReceipt => dryRun !== null));
        const participantCancellationProven = participantIdentity !== undefined &&
          cancellationDryRuns.some((dryRun) =>
            dryRunProvesExactCancellation(dryRun, participantIdentity) &&
            typeof publicReturnedAt === "number" && dryRun.settledAt !== null &&
            dryRun.settledAt <= publicReturnedAt);
        const controlSelfExcluded = participantCancellationProven;
        const participantTupleBound = participantCancellationProven;
        const settlement = await observeAdvisoryStartupSettlement(harness.token, dedicatedOwners);
        expect({
          dedicatedPending: productionPending !== null,
          promptKind,
          publicKind: outcome.kind,
          errorCode: outcome.kind === "rejected"
            ? (outcome.error as { message?: unknown }).message
            : null,
          returned: typeof publicReturnedAt === "number",
          withinBound: typeof publicReturnedAt === "number" &&
            publicReturnedAt - externallyAbortedAt < EARLY_ABORT_PUBLIC_WATCHDOG_MS,
          trackedWorkSettledBeforeReturn: typeof publicReturnedAt === "number" &&
            trackedReceipts.length > 1 &&
            trackedReceipts.every((receipt) =>
              receipt.settledAt !== null && receipt.settledAt <= publicReturnedAt),
          reservationsHeld: reservations.receipts.every(({ releasedAt }) => releasedAt === null),
          sharedOwnerQueries: harness.state.ownerQueryReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          sharedOwnerTransactions: harness.state.transactionReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          sharedOwnerRawOperations: harness.state.sharedOwnerRawOperations.filter((receipt) =>
            receipt.invocationId === invocation?.id).length,
          sharedOwnerPrivateReads: harness.state.sharedOwnerPrivateReads.filter((receipt) =>
            receipt.invocationId === invocation?.id).length,
          distinctTags: tags.length > 1 && tags.every((tag) =>
            typeof tag === "string" && tag.length > 0 && tag !== `${harness.token}_owner`) &&
            new Set(tags).size === tags.length,
          cancellationControlObserved: controls.some((control) => control.queryReceipts.some(({ semantic }) =>
            semantic === "cancellation-discovery" || semantic === "cancellation")),
          controlSelfExcluded,
          participantTupleBound,
          allDedicatedEnded: typeof publicReturnedAt === "number" && dedicatedOwners.length > 1 &&
            dedicatedOwners.every((receipt) =>
              exactBoundedDedicatedEndBefore(receipt, publicReturnedAt)),
          settlement,
        }).toEqual({
          dedicatedPending: true,
          promptKind: "settled",
          publicKind: "rejected",
          errorCode: "distributed_execution_timeout",
          returned: true,
          withinBound: true,
          trackedWorkSettledBeforeReturn: true,
          reservationsHeld: true,
          sharedOwnerQueries: 0,
          sharedOwnerTransactions: 0,
          sharedOwnerRawOperations: 0,
          sharedOwnerPrivateReads: 0,
          distinctTags: true,
          cancellationControlObserved: true,
          controlSelfExcluded: true,
          participantTupleBound: true,
          allDedicatedEnded: true,
          settlement: {
            participant_pids: 0,
            dedicated_owner_pids: 0,
            legacy_owner_pids: 4,
            legacy_owner_invalid: 0,
            advisory_locks: 0,
          },
        });
      } finally {
        const pendingToRelease = productionPending;
        if (pendingToRelease?.backendPid && pendingToRelease.settledAt === null) {
          await harness.cancelBackend(pendingToRelease.backendPid).catch(() => false);
        }
        let drained: Awaited<ReturnType<typeof withOuterWatchdog>> | undefined;
        try {
          await reservations.release();
          drained = await withOuterWatchdog(operation.then(() => true, () => true), 12_000);
        } finally {
          await harness.cleanup();
        }
        expect(drained).toMatchObject({ kind: "fulfilled", value: true });
      }
    }, 40_000);

    it("runs and cancels the migration ledger on a dedicated owner participant", async () => {
      guard();
      const harness = await createAdvisoryStartupHarness("migration-pending");
      const reservations = await harness.reserveOwnerSlots(4);
      const operation = harness.open(harness.input);
      void operation.catch(() => {});
      let pending: (typeof harness.state.pendingQueries)[number] | null = null;
      try {
        const [invocation] = harness.state.openInvocations;
        pending = invocation
          ? await harness.tryWaitForActivePendingQuery("migration-identity", invocation.id, 3_500)
          : null;
        const transactions = harness.state.transactionReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id && receipt.source === "dedicated-owner" &&
          receipt.phase === "migration-identity" && receipt.settledAt === null);
        const controller = invocation?.controllers[0];
        const externallyAbortedAt = performance.now();
        controller?.abort();
        const abortAt = invocation?.deadlineReceipt?.at ?? externallyAbortedAt;
        const prompt = pending
          ? await waitForReceiptSettlement(
              [pending, ...transactions],
              abortAt + EARLY_ABORT_SETTLEMENT_WATCHDOG_MS,
            )
          : { kind: "missing" as const };
        const outcome = await withOuterWatchdog(operation, EARLY_ABORT_PUBLIC_WATCHDOG_MS);
        const publicReturnedAt = invocation?.returnedAt ?? null;
        const owners = harness.state.dedicatedOwnerReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id);
        const participant = owners.find((receipt) => receipt.id === pending?.dedicatedOwnerId);
        const tags = owners.map(({ applicationName }) => applicationName);
        const settlement = await observeAdvisoryStartupSettlement(harness.token, owners);
        expect({
          dedicatedLedgerPending: pending?.source === "dedicated-owner" &&
            pending.dedicatedOwnerId !== null && participant?.queryReceipts.some(({ semantic }) =>
              semantic === "migration-identity"),
          dedicatedTransactions: transactions.length,
          promptKind: prompt.kind,
          publicKind: outcome.kind,
          errorCode: outcome.kind === "rejected"
            ? (outcome.error as { message?: unknown }).message
            : null,
          returnedWithinBound: typeof publicReturnedAt === "number" &&
            publicReturnedAt - externallyAbortedAt < EARLY_ABORT_PUBLIC_WATCHDOG_MS,
          workSettledBeforeReturn: typeof publicReturnedAt === "number" && pending !== null &&
            [pending, ...transactions].every((receipt) =>
              receipt.settledAt !== null && receipt.settledAt <= publicReturnedAt),
          sharedQueries: harness.state.ownerQueryReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          sharedTransactions: harness.state.transactionReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          sharedRawOperations: harness.state.sharedOwnerRawOperations.filter((receipt) =>
            receipt.invocationId === invocation?.id).length,
          sharedPrivateReads: harness.state.sharedOwnerPrivateReads.filter((receipt) =>
            receipt.invocationId === invocation?.id).length,
          reservationsHeld: reservations.receipts.every(({ releasedAt }) => releasedAt === null),
          distinctTags: owners.length > 1 && tags.every((tag) =>
            typeof tag === "string" && tag.length > 0 && tag !== `${harness.token}_owner`) &&
            new Set(tags).size === tags.length,
          allDedicatedEnded: typeof publicReturnedAt === "number" && owners.length > 1 &&
            owners.every((receipt) => exactBoundedDedicatedEndBefore(receipt, publicReturnedAt)),
          settlement,
        }).toEqual({
          dedicatedLedgerPending: true,
          dedicatedTransactions: 1,
          promptKind: "settled",
          publicKind: "rejected",
          errorCode: "distributed_execution_timeout",
          returnedWithinBound: true,
          workSettledBeforeReturn: true,
          sharedQueries: 0,
          sharedTransactions: 0,
          sharedRawOperations: 0,
          sharedPrivateReads: 0,
          reservationsHeld: true,
          distinctTags: true,
          allDedicatedEnded: true,
          settlement: {
            participant_pids: 0,
            dedicated_owner_pids: 0,
            legacy_owner_pids: 4,
            legacy_owner_invalid: 0,
            advisory_locks: 0,
          },
        });
      } finally {
        if (pending?.backendPid && pending.settledAt === null) {
          await harness.cancelBackend(pending.backendPid).catch(() => false);
        }
        await reservations.release();
        const drained = await withOuterWatchdog(operation.then(() => true, () => true), 12_000);
        await harness.cleanup();
        expect(drained).toMatchObject({ kind: "fulfilled", value: true });
      }
    }, 35_000);

    it("causally bounds and settles a statement-timeout-free migration-pending query", async () => {
      guard();
      const harness = await createAdvisoryStartupHarness("migration-pending");
      const operation = harness.open(harness.input);
      void operation.catch(() => {});
      try {
        const outcome = await withOuterWatchdog(operation);
        const [invocation] = harness.state.openInvocations;
        const publicReturnedAt = invocation?.returnedAt;
        const pending = harness.state.pendingQueries.filter((receipt) =>
          receipt.invocationId === invocation?.id && receipt.phase === "migration-identity" &&
          receipt.source === "dedicated-owner");
        const transactions = harness.state.transactionReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id && receipt.phase === "migration-identity" &&
          receipt.source === "dedicated-owner");
        const participant = harness.state.dedicatedOwnerReceipts.find((receipt) =>
          receipt.id === pending[0]?.dedicatedOwnerId);
        const dedicatedOwners = harness.state.dedicatedOwnerReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id);
        const tags = dedicatedOwners.map(({ applicationName }) => applicationName);
        const effectiveTimeoutMs = statementTimeoutMs(pending[0]?.effectiveStatementTimeout ?? null);
        const settlement = await observeAdvisoryStartupSettlement(harness.token, dedicatedOwners);
        expect({
          publicKind: outcome.kind,
          errorCode: outcome.kind === "rejected"
            ? (outcome.error as { message?: unknown }).message
            : null,
          pendingCount: pending.length,
          pendingIdentity: pending[0] && {
            source: pending[0].source,
            dedicatedOwnerId: pending[0].dedicatedOwnerId,
            backendPid: typeof pending[0].backendPid,
            timeoutBounded: effectiveTimeoutMs !== null && effectiveTimeoutMs >= 0 &&
              effectiveTimeoutMs <= 5_000,
            abortObserved: pending[0].abortObservedAt !== null,
          },
          transactionCount: transactions.length,
          transactionSettledBeforeReturn: typeof publicReturnedAt === "number" &&
            transactions.length === 1 && transactions.every((receipt) =>
              receipt.dedicatedOwnerId === participant?.id && receipt.outcome === "rejected" &&
              receipt.settledAt !== null && receipt.settledAt <= publicReturnedAt),
          queryObserved: participant?.queryReceipts.some((receipt) =>
            receipt.semantic === "migration-identity" && receipt.source === "dedicated-owner" &&
            receipt.outcome === "rejected" && receipt.settledAt !== null) === true,
          deadlineElapsed: pending[0]?.abortObservedAt !== null &&
            pending[0]?.abortObservedAt !== undefined && invocation?.controllerCreatedAt !== null &&
            invocation?.controllerCreatedAt !== undefined &&
            pending[0].abortObservedAt - invocation.controllerCreatedAt >= 4_500 &&
            pending[0].abortObservedAt - invocation.controllerCreatedAt <= 6_500,
          pendingSettledBeforeReturn: typeof publicReturnedAt === "number" && pending.length === 1 &&
            pending.every((receipt) => receipt.settledAt !== null && receipt.settledAt <= publicReturnedAt),
          sharedOwnerQueries: harness.state.ownerQueryReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          sharedOwnerTransactions: harness.state.transactionReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          distinctTags: dedicatedOwners.length > 1 && tags.every((tag) =>
            typeof tag === "string" && tag.length > 0 && tag !== `${harness.token}_owner`) &&
            new Set(tags).size === tags.length,
          allDedicatedEnded: typeof publicReturnedAt === "number" && dedicatedOwners.length > 1 &&
            dedicatedOwners.every((receipt) =>
              exactBoundedDedicatedEndBefore(receipt, publicReturnedAt)),
          settlement,
        }).toEqual({
          publicKind: "rejected",
          errorCode: "distributed_execution_timeout",
          pendingCount: 1,
          pendingIdentity: {
            source: "dedicated-owner",
            dedicatedOwnerId: expect.any(Number),
            backendPid: "number",
            timeoutBounded: true,
            abortObserved: true,
          },
          transactionCount: 1,
          transactionSettledBeforeReturn: true,
          queryObserved: true,
          deadlineElapsed: true,
          pendingSettledBeforeReturn: true,
          sharedOwnerQueries: 0,
          sharedOwnerTransactions: 0,
          distinctTags: true,
          allDedicatedEnded: true,
          settlement: {
            participant_pids: 0,
            dedicated_owner_pids: 0,
            legacy_owner_pids: expect.any(Number),
            legacy_owner_invalid: 0,
            advisory_locks: 0,
          },
        });
      } finally {
        await harness.cleanup();
        const drained = await withOuterWatchdog(operation.then(() => true, () => true), 5_000);
        expect(drained).toMatchObject({ kind: "fulfilled", value: true });
      }
    }, 30_000);

    it.each([
      ["app-authority-pending", "app-authority", "aoa_app", ["aoa_app"]],
      ["operator-authority-pending", "operator-authority", "aoa_operator", ["aoa_app", "aoa_operator"]],
    ] as const)("causally bounds and settles a statement-timeout-free %s query", async (
      injection,
      phase,
      role,
      expectedAllocatedRoles,
    ) => {
      // Mutation caught: limiting only the advisory handshake lets a pre-handshake owner or
      // authority query exceed the one immutable startup deadline. The real query ignores abort
      // and has no statement timeout; production must cancel and await it before returning.
      guard();
      const harness = await createAdvisoryStartupHarness(injection);
      const operation = harness.open(harness.input);
      try {
        const outcome = await withOuterWatchdog(operation);
        const [invocation] = harness.state.openInvocations;
        const returnedAt = invocation?.returnedAt;
        const settlement = await observeAdvisoryStartupSettlement(
          harness.token,
          harness.state.dedicatedOwnerReceipts,
        );

        expect.soft(outcome.kind, "public startup must settle before the outer watchdog").toBe("rejected");
        expect.soft(outcome).toMatchObject({
          kind: "rejected",
          error: {
            name: "DistributedExecutionStartupError",
            message: "distributed_execution_timeout",
          },
        });
        expect.soft(typeof returnedAt).toBe("number");
        const publicReturnedAt = returnedAt ?? -1;
        const receipts = harness.state.pendingQueries.filter((receipt) => receipt.phase === phase);
        expect.soft(receipts).toHaveLength(1);
        expect.soft(receipts[0]).toMatchObject({
          phase,
          role,
          effectiveStatementTimeout: expect.any(String),
          backendPid: expect.any(Number),
          settledAt: expect.any(Number),
        });
        const effectiveTimeoutMs = statementTimeoutMs(receipts[0]?.effectiveStatementTimeout ?? null);
        expect.soft(effectiveTimeoutMs).not.toBeNull();
        expect.soft(effectiveTimeoutMs ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(0);
        expect.soft(effectiveTimeoutMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(5_000);
        expect.soft(receipts[0]?.settledAt ?? Number.POSITIVE_INFINITY)
          .toBeLessThanOrEqual(publicReturnedAt);
        expect.soft(receipts[0]?.signal).toBe(invocation?.controllers[0]?.signal);
        expect.soft(receipts[0]?.signal?.aborted).toBe(true);
        expect.soft(receipts[0]?.abortObservedAt ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(
          (invocation?.controllerCreatedAt ?? Number.POSITIVE_INFINITY) + 4_500,
        );
        expect.soft(receipts[0]?.abortObservedAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
          (invocation?.controllerCreatedAt ?? Number.NEGATIVE_INFINITY) + 6_500,
        );
        expect.soft(receipts[0]?.abortObservedAt ?? Number.POSITIVE_INFINITY)
          .toBeLessThanOrEqual(publicReturnedAt);

        const targetTransactions = harness.state.transactionReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id && receipt.phase === phase);
        expect.soft(targetTransactions).toHaveLength(1);
        expect.soft(targetTransactions[0]).toMatchObject({
          role,
          phase,
          outcome: "rejected",
          settledAt: expect.any(Number),
        });
        expect.soft(targetTransactions[0]?.settledAt ?? Number.POSITIVE_INFINITY)
          .toBeLessThanOrEqual(publicReturnedAt);

        const expectedRoles = [...expectedAllocatedRoles].sort();
        expect.soft(harness.state.factoryOptions.map(({ role: allocatedRole }) => allocatedRole).sort())
          .toEqual(expectedRoles);
        expect.soft(harness.state.closes.map(({ role: closedRole }) => closedRole).sort())
          .toEqual(expectedRoles);
        expect.soft(harness.state.closes.map(({ input }) => input))
          .toEqual(expectedRoles.map(() => ({ timeoutSeconds: 5 })));
        expect.soft(harness.state.closeSettled.map(({ role: closedRole }) => closedRole).sort())
          .toEqual(expectedRoles);
        for (const close of harness.state.closeSettled) {
          expect.soft(close.at).toBeLessThanOrEqual(publicReturnedAt);
        }
        expect.soft(settlement).toEqual({
          participant_pids: 0,
          dedicated_owner_pids: 0,
          legacy_owner_pids: expect.any(Number),
          legacy_owner_invalid: 0,
          advisory_locks: 0,
        });
        assertClosedStartupLogs(harness.state.logs);
        expectCaseInsensitiveRedaction(JSON.stringify(harness.state.logs), [
          harness.appNamedUrl,
          harness.operatorNamedUrl,
          adminUrl,
          "aoa_app",
          "aoa_operator",
          "pg_sleep",
          "test:test",
          "postgres://",
          DRIVER_CAUSE_SENTINEL,
          SQL_SENTINEL,
          ...checkedInMigrationIdentity().orderedHashes,
          ...harness.state.advisoryKeyBindings.map(String),
        ]);
      } finally {
        await harness.cleanup();
        const operationDrained = (await withOuterWatchdog(
          operation.then(() => true, () => true),
          5_000,
        )).kind === "fulfilled";
        expect(operationDrained).toBe(true);
      }
    }, 30_000);

    it.each([
      ["migration-pending", "migration-identity", "migration-identity", []],
      ["owner-exclusive-pending", "owner-exclusive", "owner-advisory", ["aoa_app", "aoa_operator"]],
    ] as const)("promptly settles dedicated-owner %s after the exact startup controller is externally aborted", async (
      injection,
      phase,
      semantic,
      expectedAllocatedRoles,
    ) => {
      guard();
      const harness = await createAdvisoryStartupHarness(injection);
      const operation = harness.open(harness.input);
      void operation.catch(() => {});
      let pending: (typeof harness.state.pendingQueries)[number] | null = null;
      try {
        const [invocation] = harness.state.openInvocations;
        pending = await harness.tryWaitForActivePendingQuery(phase, invocation!.id, 3_500);
        const transactionsPendingAtAbort = pending
          ? harness.state.transactionReceipts.filter((receipt) =>
              receipt.invocationId === invocation?.id && receipt.phase === phase &&
              receipt.source === "dedicated-owner" && receipt.outcome === "pending")
          : [];
        const externallyAbortedAt = performance.now();
        invocation?.controllers[0]?.abort();
        const exactAbortAt = invocation?.deadlineReceipt?.at;
        const prompt = pending
          ? await waitForReceiptSettlement(
              [pending, ...transactionsPendingAtAbort],
              (exactAbortAt ?? externallyAbortedAt) + EARLY_ABORT_SETTLEMENT_WATCHDOG_MS,
            )
          : { kind: "missing" as const };
        const publicRemaining = Math.max(
          1,
          EARLY_ABORT_PUBLIC_WATCHDOG_MS -
            (performance.now() - (exactAbortAt ?? externallyAbortedAt)),
        );
        const outcome = await withOuterWatchdog(operation, publicRemaining);
        const publicReturnedAt = invocation?.returnedAt;
        const transactions = harness.state.transactionReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id && receipt.phase === phase &&
          receipt.source === "dedicated-owner");
        const participant = harness.state.dedicatedOwnerReceipts.find((receipt) =>
          receipt.id === pending?.dedicatedOwnerId);
        const dedicatedOwners = harness.state.dedicatedOwnerReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id);
        const tags = dedicatedOwners.map(({ applicationName }) => applicationName);
        const settlement = await observeAdvisoryStartupSettlement(harness.token, dedicatedOwners);
        expect({
          pendingObserved: pending !== null,
          pendingSource: pending?.source ?? null,
          pendingOwnerId: pending?.dedicatedOwnerId ?? null,
          pendingSignalIsController: pending?.signal === invocation?.controllers[0]?.signal,
          promptKind: prompt.kind,
          publicKind: outcome.kind,
          errorCode: outcome.kind === "rejected"
            ? (outcome.error as { message?: unknown }).message
            : null,
          returnedWithinBound: typeof publicReturnedAt === "number" &&
            publicReturnedAt - externallyAbortedAt < EARLY_ABORT_PUBLIC_WATCHDOG_MS,
          transactionCount: transactions.length,
          trackedWorkSettledBeforeReturn: typeof publicReturnedAt === "number" &&
            pending !== null && pending.settledAt !== null && pending.settledAt <= publicReturnedAt &&
            transactions.length === 1 && transactions.every((receipt) =>
              receipt.outcome === "rejected" && receipt.settledAt !== null &&
              receipt.settledAt <= publicReturnedAt),
          semanticQueryObserved: participant?.queryReceipts.some((receipt) =>
            receipt.semantic === semantic && receipt.source === "dedicated-owner" &&
            receipt.settledAt !== null) === true,
          sharedOwnerQueries: harness.state.ownerQueryReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          sharedOwnerTransactions: harness.state.transactionReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          allocatedRoles: harness.state.factoryOptions.map(({ role }) => role).sort(),
          distinctTags: dedicatedOwners.length > 1 && tags.every((tag) =>
            typeof tag === "string" && tag.length > 0 && tag !== `${harness.token}_owner`) &&
            new Set(tags).size === tags.length,
          allDedicatedEnded: typeof publicReturnedAt === "number" && dedicatedOwners.length > 1 &&
            dedicatedOwners.every((receipt) =>
              exactBoundedDedicatedEndBefore(receipt, publicReturnedAt)),
          settlement,
        }).toEqual({
          pendingObserved: true,
          pendingSource: "dedicated-owner",
          pendingOwnerId: expect.any(Number),
          pendingSignalIsController: true,
          promptKind: "settled",
          publicKind: "rejected",
          errorCode: "distributed_execution_timeout",
          returnedWithinBound: true,
          transactionCount: 1,
          trackedWorkSettledBeforeReturn: true,
          semanticQueryObserved: true,
          sharedOwnerQueries: 0,
          sharedOwnerTransactions: 0,
          allocatedRoles: [...expectedAllocatedRoles].sort(),
          distinctTags: true,
          allDedicatedEnded: true,
          settlement: {
            participant_pids: 0,
            dedicated_owner_pids: 0,
            legacy_owner_pids: expect.any(Number),
            legacy_owner_invalid: 0,
            advisory_locks: 0,
          },
        });
      } finally {
        if (pending?.backendPid && pending.settledAt === null) {
          await harness.cancelBackend(pending.backendPid).catch(() => false);
        }
        await harness.cleanup();
        const drained = await withOuterWatchdog(operation.then(() => true, () => true), 5_000);
        expect(drained).toMatchObject({ kind: "fulfilled", value: true });
      }
    }, 30_000);

    it.each([
      ["app-authority-pending", "app-authority", "aoa_app", ["aoa_app"]],
      ["operator-authority-pending", "operator-authority", "aoa_operator", ["aoa_app", "aoa_operator"]],
      ["app-negative-pending", "app-negative", "aoa_app", ["aoa_app", "aoa_operator"]],
      ["operator-negative-pending", "operator-negative", "aoa_operator", ["aoa_app", "aoa_operator"]],
      ["app-positive-pending", "app-positive", "aoa_app", ["aoa_app", "aoa_operator"]],
      ["operator-positive-pending", "operator-positive", "aoa_operator", ["aoa_app", "aoa_operator"]],
    ] as const)("promptly settles %s after the exact startup controller is externally aborted", async (
      injection,
      phase,
      role,
      expectedAllocatedRoles,
    ) => {
      // Fail-first control: receipt observation never cancels or releases the sleep. Only production
      // may turn this exact shared-controller abort into query, transaction, close, and public settle.
      guard();
      const harness = await createAdvisoryStartupHarness(injection);
      const operation = harness.open(harness.input);
      void operation.catch(() => {});
      try {
        const pending = await harness.waitForActivePendingQuery(phase, 3_000);
        const [invocation] = harness.state.openInvocations;
        const matchingPendingQueries = harness.state.pendingQueries.filter((receipt) =>
          receipt.invocationId === invocation?.id && receipt.phase === phase,
        );
        expect(matchingPendingQueries).toHaveLength(1);
        expect(matchingPendingQueries[0]).toBe(pending);
        expect(invocation?.controllers).toHaveLength(1);
        const controller = invocation!.controllers[0]!;
        expect(harness.state.abortControllers).toEqual([controller]);
        expect(pending.signal).toBe(controller.signal);
        expect(controller.signal.aborted).toBe(false);
        expect(invocation?.deadlineReceipt).toBeNull();
        expect(invocation?.returnedAt).toBeNull();
        expect(pending).toMatchObject({
          phase,
          role,
          backendPid: expect.any(Number),
          effectiveStatementTimeout: expect.any(String),
          sleepIssuedAt: expect.any(Number),
          abortObservedAt: null,
          settledAt: null,
        });
        const targetTransactions = harness.state.transactionReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id && receipt.phase === phase);
        expect(targetTransactions).toHaveLength(1);
        expect(targetTransactions[0]).toMatchObject({
          role,
          phase,
          outcome: "pending",
          settledAt: null,
        });
        expect(harness.state.closeAttempts).toEqual([]);
        expect(harness.state.closeSettled).toEqual([]);

        const effectiveTimeoutMs = statementTimeoutMs(pending.effectiveStatementTimeout);
        expect(effectiveTimeoutMs).not.toBeNull();
        const transactionsPendingAtAbort = harness.state.transactionReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id &&
          receipt.outcome === "pending" && receipt.settledAt === null,
        );
        expect(transactionsPendingAtAbort.length).toBeGreaterThan(0);
        expect(transactionsPendingAtAbort).toContain(targetTransactions[0]);
        const externallyAbortedAt = performance.now();
        expect(externallyAbortedAt - (invocation?.controllerCreatedAt ?? Number.NEGATIVE_INFINITY))
          .toBeLessThan(3_500);
        controller.abort();
        const exactAbortAt = invocation?.deadlineReceipt?.at;
        expect(typeof exactAbortAt).toBe("number");
        expect(pending.sleepIssuedAt ?? Number.POSITIVE_INFINITY)
          .toBeLessThanOrEqual(exactAbortAt ?? Number.NEGATIVE_INFINITY);
        const timeoutRemainingAtAbort = effectiveTimeoutMs === 0
          ? 0
          : (effectiveTimeoutMs ?? Number.NEGATIVE_INFINITY) -
            ((exactAbortAt ?? Number.POSITIVE_INFINITY) -
              (pending.sleepIssuedAt ?? Number.NEGATIVE_INFINITY));
        expect(
          timeoutRemainingAtAbort === 0 ||
          timeoutRemainingAtAbort > EARLY_ABORT_SETTLEMENT_WATCHDOG_MS,
          `SQL timeout remaining at abort (${timeoutRemainingAtAbort}ms) must not settle the short watchdog lane`,
        ).toBe(true);

        const promptSettlementDeadline = (exactAbortAt ?? Number.NEGATIVE_INFINITY) +
          EARLY_ABORT_SETTLEMENT_WATCHDOG_MS;
        const promptSettlement = await waitForReceiptSettlement(
          [pending, ...transactionsPendingAtAbort],
          promptSettlementDeadline,
        );
        expect.soft(promptSettlement).toMatchObject({
          kind: "settled",
          observedAt: expect.any(Number),
        });
        expect.soft(pending.settledAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
          promptSettlementDeadline,
        );
        for (const transaction of transactionsPendingAtAbort) {
          expect.soft(transaction.settledAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
            promptSettlementDeadline,
          );
        }
        expect.soft(pending.abortObservedAt ?? Number.NEGATIVE_INFINITY)
          .toBeGreaterThanOrEqual(exactAbortAt ?? Number.POSITIVE_INFINITY);
        expect.soft(pending.settledAt ?? Number.NEGATIVE_INFINITY)
          .toBeGreaterThanOrEqual(pending.abortObservedAt ?? Number.POSITIVE_INFINITY);
        expect.soft(targetTransactions[0]).toMatchObject({
          role,
          phase,
          outcome: "rejected",
          settledAt: expect.any(Number),
        });
        for (const transaction of transactionsPendingAtAbort) {
          expect.soft(transaction.outcome, `${transaction.role}:${transaction.phase}`).not.toBe("pending");
          expect.soft(transaction.settledAt ?? Number.NEGATIVE_INFINITY)
            .toBeGreaterThanOrEqual(pending.abortObservedAt ?? Number.POSITIVE_INFINITY);
        }

        const publicWatchdogRemaining = Math.max(
          1,
          EARLY_ABORT_PUBLIC_WATCHDOG_MS -
            (performance.now() - (exactAbortAt ?? Number.NEGATIVE_INFINITY)),
        );
        const outcome = await withOuterWatchdog(operation, publicWatchdogRemaining);
        const publicReturnedAt = invocation?.returnedAt;
        const settlement = await observeAdvisoryStartupSettlement(
          harness.token,
          harness.state.dedicatedOwnerReceipts,
        );
        expect.soft(outcome).toMatchObject({
          kind: "rejected",
          error: {
            name: "DistributedExecutionStartupError",
            message: "distributed_execution_timeout",
          },
        });
        expect.soft(typeof publicReturnedAt).toBe("number");
        expect.soft(publicReturnedAt ?? Number.NEGATIVE_INFINITY)
          .toBeGreaterThanOrEqual(externallyAbortedAt);
        expect.soft(publicReturnedAt ?? Number.NEGATIVE_INFINITY)
          .toBeGreaterThanOrEqual(exactAbortAt ?? Number.POSITIVE_INFINITY);
        expect.soft((publicReturnedAt ?? Number.POSITIVE_INFINITY) - externallyAbortedAt)
          .toBeLessThan(EARLY_ABORT_PUBLIC_WATCHDOG_MS);
        expect.soft(harness.state.abortCalls).toBe(1);
        expect.soft(harness.state.abortAt ?? Number.NEGATIVE_INFINITY)
          .toBeGreaterThanOrEqual(externallyAbortedAt);
        expect.soft(invocation?.deadlineReceipt).toMatchObject({
          invocationId: invocation?.id,
          signal: controller.signal,
          at: expect.any(Number),
        });
        expect.soft(invocation?.deadlineReceipt?.at ?? Number.NEGATIVE_INFINITY)
          .toBeGreaterThanOrEqual(externallyAbortedAt);
        expect.soft(pending).toMatchObject({
          phase,
          role,
          backendPid: expect.any(Number),
          effectiveStatementTimeout: expect.any(String),
          abortObservedAt: expect.any(Number),
          settledAt: expect.any(Number),
        });
        expect.soft(pending.abortObservedAt ?? Number.NEGATIVE_INFINITY)
          .toBeGreaterThanOrEqual(externallyAbortedAt);
        expect.soft(pending.abortObservedAt ?? Number.NEGATIVE_INFINITY)
          .toBeGreaterThanOrEqual(invocation?.deadlineReceipt?.at ?? Number.POSITIVE_INFINITY);
        expect.soft(pending.abortObservedAt ?? Number.POSITIVE_INFINITY)
          .toBeLessThanOrEqual(publicReturnedAt ?? -1);
        expect.soft(pending.settledAt ?? Number.NEGATIVE_INFINITY)
          .toBeGreaterThanOrEqual(pending.abortObservedAt ?? Number.POSITIVE_INFINITY);
        expect.soft(pending.settledAt ?? Number.POSITIVE_INFINITY)
          .toBeLessThanOrEqual(publicReturnedAt ?? -1);

        expect.soft(targetTransactions[0]).toMatchObject({
          role,
          phase,
          outcome: "rejected",
          settledAt: expect.any(Number),
        });
        expect.soft(targetTransactions[0]?.settledAt ?? Number.NEGATIVE_INFINITY)
          .toBeGreaterThanOrEqual(pending.abortObservedAt ?? Number.POSITIVE_INFINITY);
        expect.soft(targetTransactions[0]?.settledAt ?? Number.POSITIVE_INFINITY)
          .toBeLessThanOrEqual(publicReturnedAt ?? -1);
        for (const transaction of transactionsPendingAtAbort) {
          expect.soft(transaction.outcome, `${transaction.role}:${transaction.phase}`).not.toBe("pending");
          expect.soft(transaction.settledAt ?? Number.NEGATIVE_INFINITY)
            .toBeGreaterThanOrEqual(pending.abortObservedAt ?? Number.POSITIVE_INFINITY);
          expect.soft(transaction.settledAt ?? Number.POSITIVE_INFINITY)
            .toBeLessThanOrEqual(publicReturnedAt ?? -1);
        }

        const expectedRoles = [...expectedAllocatedRoles].sort();
        expect.soft(harness.state.factoryOptions.map(({ role: allocatedRole }) => allocatedRole).sort())
          .toEqual(expectedRoles);
        expect.soft(harness.state.closes.map(({ role: closedRole }) => closedRole).sort())
          .toEqual(expectedRoles);
        expect.soft(harness.state.closes.map(({ input }) => input))
          .toEqual(expectedRoles.map(() => ({ timeoutSeconds: 5 })));
        expect.soft(harness.state.closeAttempts.map(({ role: closedRole }) => closedRole).sort())
          .toEqual(expectedRoles);
        expect.soft(harness.state.closeSettled.map(({ role: closedRole }) => closedRole).sort())
          .toEqual(expectedRoles);
        for (const attempt of harness.state.closeAttempts) {
          // b3d8 teardown ordering (supersedes the prior close-after-participant-settlement rule):
          // the forced serving close is memo-started ON abort, before the pending query observes it,
          // so its lower bound is the external abort trigger — not pending.abortObservedAt. The upper
          // bound and the per-close attempt->settle ordering below are unchanged.
          expect.soft(attempt.at).toBeGreaterThanOrEqual(externallyAbortedAt);
          expect.soft(attempt.at).toBeLessThanOrEqual(publicReturnedAt ?? -1);
          const settled = harness.state.closeSettled.find(({ role: settledRole }) =>
            settledRole === attempt.role);
          expect.soft(settled?.at ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(attempt.at);
          expect.soft(settled?.at ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(publicReturnedAt ?? -1);
        }
        expect.soft(settlement).toEqual({
          participant_pids: 0,
          dedicated_owner_pids: 0,
          legacy_owner_pids: expect.any(Number),
          legacy_owner_invalid: 0,
          advisory_locks: 0,
        });
        assertClosedStartupLogs(harness.state.logs);
        expectCaseInsensitiveRedaction(JSON.stringify(harness.state.logs), [
          harness.appNamedUrl,
          harness.operatorNamedUrl,
          adminUrl,
          "aoa_app",
          "aoa_operator",
          "pg_sleep",
          "test:test",
          "postgres://",
          DRIVER_CAUSE_SENTINEL,
          SQL_SENTINEL,
          ...checkedInMigrationIdentity().orderedHashes,
          ...harness.state.advisoryKeyBindings.map(String),
        ]);
      } finally {
        // Cleanup is deliberately after every production-settlement assertion. It is only the
        // finite RED-lane escape hatch and cannot make the query or public operation look settled.
        await harness.cleanup();
        const drained = await withOuterWatchdog(
          operation.then(() => true, () => true),
          5_000,
        );
        expect(drained).toMatchObject({ kind: "fulfilled", value: true });
      }
    }, 30_000);

    it("bounds owner cleanup acquisition on a normal returned close while the shared pool is reserved", async () => {
      guard();
      const harness = await createAdvisoryStartupHarness("cleanup-acquisition-pending");
      const dedicatedOwnerOffset = harness.state.dedicatedOwnerReceipts.length;
      const accepted = await harness.open(harness.input);
      expect(accepted).not.toBeNull();
      const reservations = await harness.reserveOwnerSlots(4);
      const cleanupProbeOffset = harness.state.cleanupProbeReceipts.length;
      const sharedQueryOffset = harness.state.ownerQueryReceipts.length;
      const sharedTransactionOffset = harness.state.transactionReceipts.length;
      const closeOperation = accepted!.close();
      void closeOperation.catch(() => {});
      try {
        const outcome = await withOuterWatchdog(closeOperation, EARLY_ABORT_PUBLIC_WATCHDOG_MS);
        const publicReturnedAt = outcome.kind === "watchdog" ? null : performance.now();
        const cleanupProbes = harness.state.cleanupProbeReceipts.slice(cleanupProbeOffset);
        const dedicatedOwners = harness.state.dedicatedOwnerReceipts.slice(dedicatedOwnerOffset);
        const verifier = dedicatedOwners.find((receipt) =>
          receipt.lifecycle === "close" && receipt.queryReceipts.some(({ semantic }) => semantic === "cleanup"));
        const verifierQueries = verifier?.queryReceipts.filter(({ semantic }) => semantic === "cleanup") ?? [];
        const verifierIdentity = verifier?.observedIdentities[0];
        const priorPids = [
          ...harness.state.backendPids.aoa_app,
          ...harness.state.backendPids.aoa_operator,
          ...dedicatedOwners.filter((receipt) => receipt.id !== verifier?.id)
            .flatMap((receipt) => receipt.observedIdentities.map(({ pid }) => pid)),
        ];
        const settlement = await observeAdvisoryStartupSettlement(harness.token, dedicatedOwners);
        expect({
          publicKind: outcome.kind,
          returned: typeof publicReturnedAt === "number",
          reservationsHeld: reservations.receipts.every(({ releasedAt }) => releasedAt === null),
          semanticCleanupProbeObserved: cleanupProbes.some((probe) =>
            probe.source === "dedicated-owner" && probe.participantPidsGone === true),
          cleanupProbesSettledBeforeReturn: cleanupProbes.length > 0 &&
            typeof publicReturnedAt === "number" && cleanupProbes.every((probe) =>
              probe.settledAt !== null && probe.outcome === "fulfilled" &&
              probe.settledAt <= publicReturnedAt),
          verifierObserved: verifier !== undefined && verifierQueries.length > 0,
          verifierCoversPriorPids: priorPids.length > 0 && priorPids.every((pid) =>
            verifierQueries.some((query) => query.params.some((value) => value === pid))) &&
            verifierQueries.some((query) => /pg_stat_activity/u.test(query.sql)) &&
            verifierQueries.some((query) => /pg_locks/u.test(query.sql)),
          verifierDoesNotPollItself: verifierIdentity !== undefined && verifierQueries.length > 0 &&
            verifierQueries.every((query) =>
              !query.params.some((value) =>
                typeof value === "number" && value === verifierIdentity.pid) &&
              !query.params.some((value) => value === verifierIdentity.applicationName)),
          verifierEndedExternallyGone: typeof publicReturnedAt === "number" && verifier !== undefined &&
            verifier.observedIdentities.length === 1 &&
            exactBoundedDedicatedEndBefore(verifier, publicReturnedAt),
          allDedicatedDisposedBeforeReturn: dedicatedOwners.length > 1 &&
            dedicatedOwners.every((receipt) =>
              exactBoundedDedicatedEndBefore(receipt, publicReturnedAt)),
          distinctTags: dedicatedOwners.length > 1 &&
            dedicatedOwners.every(({ applicationName }) =>
              typeof applicationName === "string" && applicationName.length > 0 &&
              applicationName !== `${harness.token}_owner`) &&
            new Set(dedicatedOwners.map(({ applicationName }) => applicationName)).size ===
              dedicatedOwners.length,
          sharedCleanupQueries: harness.state.ownerQueryReceipts.slice(sharedQueryOffset)
            .filter(({ source }) => source === "shared-owner-db").length,
          sharedCleanupTransactions: harness.state.transactionReceipts.slice(sharedTransactionOffset)
            .filter(({ source }) => source === "shared-owner-db").length,
          sharedRawOperations: harness.state.sharedOwnerRawOperations.filter((receipt) =>
            receipt.invocationId === harness.state.openInvocations[0]?.id).length,
          sharedPrivateReads: harness.state.sharedOwnerPrivateReads.filter((receipt) =>
            receipt.invocationId === harness.state.openInvocations[0]?.id).length,
          servingCloses: harness.state.closeSettled.map(({ role }) => role).sort(),
          servingClosedBeforeReturn: typeof publicReturnedAt === "number" &&
            harness.state.closeSettled.every(({ at }) => at <= publicReturnedAt),
          settlement,
        }).toEqual({
          publicKind: "fulfilled",
          returned: true,
          reservationsHeld: true,
          semanticCleanupProbeObserved: true,
          cleanupProbesSettledBeforeReturn: true,
          verifierObserved: true,
          verifierCoversPriorPids: true,
          verifierDoesNotPollItself: true,
          verifierEndedExternallyGone: true,
          allDedicatedDisposedBeforeReturn: true,
          distinctTags: true,
          sharedCleanupQueries: 0,
          sharedCleanupTransactions: 0,
          sharedRawOperations: 0,
          sharedPrivateReads: 0,
          servingCloses: ["aoa_app", "aoa_operator"],
          servingClosedBeforeReturn: true,
          settlement: {
            participant_pids: 0,
            dedicated_owner_pids: 0,
            legacy_owner_pids: 4,
            legacy_owner_invalid: 0,
            advisory_locks: 0,
          },
        });
      } finally {
        let drained: Awaited<ReturnType<typeof withOuterWatchdog>> | undefined;
        try {
          await reservations.release();
          drained = await withOuterWatchdog(closeOperation.then(() => true, () => true), 12_000);
        } finally {
          await harness.cleanup();
        }
        expect(drained).toMatchObject({ kind: "fulfilled", value: true });
      }
    }, 40_000);

    it("preserves the startup failure while bounding later owner cleanup acquisition", async () => {
      // Both serving closes pause only after the injected positive-phase failure has unwound and
      // participant cancellation/allSettled has finished. Owner reservation therefore targets
      // cleanup acquisition, never the earlier startup transaction.
      guard();
      const harness = await createAdvisoryStartupHarness("cleanup-failure-acquisition-pending");
      const cleanupProbeOffset = harness.state.cleanupProbeReceipts.length;
      const dedicatedOwnerOffset = harness.state.dedicatedOwnerReceipts.length;
      const operation = harness.open(harness.input);
      void operation.catch(() => {});
      let reservations: OwnerReservationGroup | null = null;
      try {
        const reachedLaterClose = await harness.waitForCloseAttempts(2, 12_000);
        expect(reachedLaterClose).toBe(true);
        expect(harness.state.injectionTriggered).toBe(true);
        expect(typeof harness.state.injectionTriggeredAt).toBe("number");
        expect(harness.state.closeAttempts.map(({ role }) => role).sort()).toEqual([
          "aoa_app", "aoa_operator",
        ]);
        expect(harness.state.closeSettled).toEqual([]);
        for (const attempt of harness.state.closeAttempts) {
          expect(attempt.at).toBeGreaterThanOrEqual(
            harness.state.injectionTriggeredAt ?? Number.POSITIVE_INFINITY,
          );
        }

        reservations = await harness.reserveOwnerSlots(4);
        const sharedQueryOffset = harness.state.ownerQueryReceipts.length;
        const sharedTransactionOffset = harness.state.transactionReceipts.length;
        expect(reservations.receipts).toHaveLength(4);
        for (const reservation of reservations.receipts) {
          expect(reservation.reservedAt).toBeGreaterThanOrEqual(
            harness.state.injectionTriggeredAt ?? Number.POSITIVE_INFINITY,
          );
        }
        harness.releaseCleanupFailureCloseGate();
        const outcome = await withOuterWatchdog(operation, EARLY_ABORT_PUBLIC_WATCHDOG_MS);
        const [invocation] = harness.state.openInvocations;
        const publicReturnedAt = invocation?.returnedAt;
        const cleanupProbes = harness.state.cleanupProbeReceipts.slice(cleanupProbeOffset);
        const dedicatedOwners = harness.state.dedicatedOwnerReceipts.slice(dedicatedOwnerOffset);
        const verifier = dedicatedOwners.find((receipt) =>
          receipt.queryReceipts.some(({ semantic }) => semantic === "cleanup"));
        const verifierQueries = verifier?.queryReceipts.filter(({ semantic }) => semantic === "cleanup") ?? [];
        const verifierIdentity = verifier?.observedIdentities[0];
        const priorPids = [
          ...harness.state.backendPids.aoa_app,
          ...harness.state.backendPids.aoa_operator,
          ...dedicatedOwners.filter((receipt) => receipt.id !== verifier?.id)
            .flatMap((receipt) => receipt.observedIdentities.map(({ pid }) => pid)),
        ];
        const settlement = await observeAdvisoryStartupSettlement(harness.token, dedicatedOwners);
        expect({
          publicKind: outcome.kind,
          errorCode: outcome.kind === "rejected"
            ? (outcome.error as { message?: unknown }).message
            : null,
          returned: typeof publicReturnedAt === "number",
          reservationsHeld: reservations.receipts.every(({ releasedAt }) => releasedAt === null),
          semanticCleanupProbeObserved: cleanupProbes.some((probe) =>
            probe.source === "dedicated-owner" && probe.participantPidsGone === true),
          cleanupProbesSettledBeforeReturn: cleanupProbes.length > 0 &&
            typeof publicReturnedAt === "number" && cleanupProbes.every((probe) =>
              probe.settledAt !== null && probe.outcome === "fulfilled" &&
              probe.settledAt <= publicReturnedAt),
          verifierObserved: verifier !== undefined && verifierQueries.length > 0,
          verifierCoversPriorPids: priorPids.length > 0 && priorPids.every((pid) =>
            verifierQueries.some((query) => query.params.some((value) => value === pid))),
          verifierDoesNotPollItself: verifierIdentity !== undefined && verifierQueries.length > 0 &&
            verifierQueries.every((query) =>
              !query.params.some((value) =>
                typeof value === "number" && value === verifierIdentity.pid) &&
              !query.params.some((value) => value === verifierIdentity.applicationName)),
          allDedicatedDisposedBeforeReturn: dedicatedOwners.length > 1 &&
            dedicatedOwners.every((receipt) =>
              exactBoundedDedicatedEndBefore(receipt, publicReturnedAt)),
          distinctTags: dedicatedOwners.length > 1 &&
            dedicatedOwners.every(({ applicationName }) =>
              typeof applicationName === "string" && applicationName.length > 0 &&
              applicationName !== `${harness.token}_owner`) &&
            new Set(dedicatedOwners.map(({ applicationName }) => applicationName)).size ===
              dedicatedOwners.length,
          sharedCleanupQueries: harness.state.ownerQueryReceipts.slice(sharedQueryOffset)
            .filter(({ source }) => source === "shared-owner-db").length,
          sharedCleanupTransactions: harness.state.transactionReceipts.slice(sharedTransactionOffset)
            .filter(({ source }) => source === "shared-owner-db").length,
          sharedRawOperations: harness.state.sharedOwnerRawOperations.filter((receipt) =>
            receipt.invocationId === invocation?.id).length,
          sharedPrivateReads: harness.state.sharedOwnerPrivateReads.filter((receipt) =>
            receipt.invocationId === invocation?.id).length,
          servingCloses: harness.state.closeSettled.map(({ role }) => role).sort(),
          servingClosedBeforeReturn: typeof publicReturnedAt === "number" &&
            harness.state.closeSettled.every(({ at }) => at <= publicReturnedAt),
          settlement,
        }).toEqual({
          publicKind: "rejected",
          errorCode: "distributed_execution_advisory_domain",
          returned: true,
          reservationsHeld: true,
          semanticCleanupProbeObserved: true,
          cleanupProbesSettledBeforeReturn: true,
          verifierObserved: true,
          verifierCoversPriorPids: true,
          verifierDoesNotPollItself: true,
          allDedicatedDisposedBeforeReturn: true,
          distinctTags: true,
          sharedCleanupQueries: 0,
          sharedCleanupTransactions: 0,
          sharedRawOperations: 0,
          sharedPrivateReads: 0,
          servingCloses: ["aoa_app", "aoa_operator"],
          servingClosedBeforeReturn: true,
          settlement: {
            participant_pids: 0,
            dedicated_owner_pids: 0,
            legacy_owner_pids: 4,
            legacy_owner_invalid: 0,
            advisory_locks: 0,
          },
        });
      } finally {
        harness.releaseCleanupFailureCloseGate();
        let drained: Awaited<ReturnType<typeof withOuterWatchdog>> | undefined;
        try {
          await reservations?.release();
          drained = await withOuterWatchdog(operation.then(() => true, () => true), 12_000);
        } finally {
          await harness.cleanup();
        }
        expect(drained).toMatchObject({ kind: "fulfilled", value: true });
      }
    }, 45_000);

    it("does not cancel unrelated legacy-owner work after a completed dedicated-owner transaction", async () => {
      guard();
      const harness = await createAdvisoryStartupHarness("stale-owner-lifecycle");
      const operation = harness.open(harness.input);
      void operation.catch(() => {});
      let reservations: OwnerReservationGroup | null = null;
      let outsiderQuery: ReturnType<ReservedOwnerSql["unsafe"]> | null = null;
      let outsiderObserved: Promise<void> | null = null;
      let outsiderOutcome: "pending" | "fulfilled" | "rejected" = "pending";
      let outsiderSettledAt: number | null = null;
      let outsiderObserver: Sql | null = null;
      const outsiderApplicationName = `${harness.token}_legacy_outsider`;
      try {
        const appPending = await harness.waitForActivePendingQuery("app-authority", 3_500);
        const [invocation] = harness.state.openInvocations;
        expect(invocation?.controllers).toHaveLength(1);

        const [appIdentity] = await admin!.unsafe<Array<{
          pid: number;
          backend_start: string;
          session_role: string;
          database_name: string;
          application_name: string;
        }>>(`
          SELECT activity.pid,
            activity.backend_start::text AS backend_start,
            activity.usename AS session_role,
            activity.datname AS database_name,
            activity.application_name
          FROM pg_stat_activity activity
          WHERE activity.pid = $1
            AND activity.state = 'active'
            AND activity.query ILIKE '%pg_sleep%'
        `, [appPending.backendPid]);
        expect(appIdentity).toMatchObject({
          pid: appPending.backendPid,
          backend_start: expect.any(String),
          session_role: "aoa_app",
          database_name: expect.any(String),
          application_name: `${harness.token}_app`,
        });

        reservations = await harness.reserveOwnerSlots(1);
        const [reservation] = reservations.receipts;
        expect(reservation).toMatchObject({
          applicationName: `${harness.token}_owner`,
          releasedAt: null,
        });

        await reservation!.connection.unsafe(
          "SELECT set_config('application_name', $1, false)",
          [outsiderApplicationName],
        );
        outsiderQuery = reservation!.connection.unsafe("SELECT pg_sleep(60)");
        outsiderObserved = outsiderQuery.then(
          () => {
            outsiderOutcome = "fulfilled";
            outsiderSettledAt = performance.now();
          },
          () => {
            outsiderOutcome = "rejected";
            outsiderSettledAt = performance.now();
          },
        );
        const outsiderDeadline = performance.now() + 3_500;
        let outsiderActivity: {
          backend_start: string;
          xact_start: string;
          session_role: string;
          database_name: string;
          application_name: string;
          active: boolean;
        } | undefined;
        do {
          [outsiderActivity] = await admin!.unsafe<Array<{
            backend_start: string;
            xact_start: string;
            session_role: string;
            database_name: string;
            application_name: string;
            active: boolean;
          }>>(`
            SELECT activity.backend_start::text AS backend_start,
              activity.xact_start::text AS xact_start,
              activity.usename AS session_role,
              activity.datname AS database_name,
              activity.application_name,
              activity.state = 'active' AND activity.query ILIKE '%pg_sleep%' AS active
            FROM pg_stat_activity activity
            WHERE activity.pid = $1
          `, [reservation!.pid]);
          if (outsiderActivity?.active) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (performance.now() < outsiderDeadline);
        expect(outsiderActivity).toMatchObject({
          backend_start: reservation?.backendStart,
          session_role: "test",
          database_name: appIdentity?.database_name,
          application_name: outsiderApplicationName,
          active: true,
        });
        expect(outsiderOutcome).toBe("pending");

        const controller = invocation!.controllers[0]!;
        controller.abort();
        const exactAbortAt = invocation?.deadlineReceipt?.at;
        const appTransactions = harness.state.transactionReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id && receipt.phase === "app-authority" &&
          receipt.outcome === "pending");
        const targetSettlement = await waitForReceiptSettlement(
          [appPending, ...appTransactions],
          (exactAbortAt ?? performance.now()) + EARLY_ABORT_SETTLEMENT_WATCHDOG_MS,
        );

        const outcome = await withOuterWatchdog(operation, EARLY_ABORT_PUBLIC_WATCHDOG_MS);
        const publicReturnedAt = invocation?.returnedAt;
        const dedicatedOwners = harness.state.dedicatedOwnerReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id);
        const participant = dedicatedOwners.find((receipt) => receipt.queryReceipts.some(({ semantic }) =>
          semantic === "migration-identity"));
        const participantIdentity = participant?.observedIdentities[0];
        const completedMigrationTransaction = harness.state.transactionReceipts.find((receipt) =>
          receipt.invocationId === invocation?.id && receipt.source === "dedicated-owner" &&
          receipt.dedicatedOwnerId === participant?.id);
        const controls = dedicatedOwners.filter((receipt) => receipt.id !== participant?.id &&
          receipt.queryReceipts.some(({ semantic }) =>
            semantic === "cancellation-discovery" || semantic === "cancellation"));
        const cancellationQueries = controls.flatMap((control) => control.queryReceipts.filter(({ semantic }) =>
          semantic === "cancellation-discovery" || semantic === "cancellation"));
        const cancellationDryRuns = cancellationQueries
          .filter(({ semantic }) => semantic === "cancellation")
          .map(({ dryRun }) => dryRun)
          .filter((dryRun): dryRun is CancellationDryRunReceipt => dryRun !== null);
        const targetIdentity: DedicatedOwnerIdentity | undefined = appIdentity && {
          pid: appIdentity.pid,
          backendStart: appIdentity.backend_start,
          sessionRole: appIdentity.session_role,
          databaseName: appIdentity.database_name,
          applicationName: appIdentity.application_name,
        };
        const forbiddenPids = [
          participantIdentity?.pid,
          reservation?.pid,
        ].filter((pid): pid is number => typeof pid === "number");
        const targetTupleBound = targetIdentity !== undefined && cancellationDryRuns.some((dryRun) =>
          dryRunProvesExactCancellation(dryRun, targetIdentity, forbiddenPids) &&
          typeof publicReturnedAt === "number" && dryRun.settledAt !== null &&
          dryRun.settledAt <= publicReturnedAt);
        const controlsSelfExcludeFullIdentity = targetTupleBound;
        const historicalParticipantNotTargeted = participantIdentity !== undefined &&
          cancellationDryRuns.length > 0 && cancellationDryRuns.every((dryRun) =>
            !dryRun.originalCandidatePids.includes(participantIdentity.pid) &&
            dryRun.targetIdentities.every((identity) =>
              identity.pid !== participantIdentity.pid ||
              identity.applicationName !== participantIdentity.applicationName));
        const outsiderNotTargeted = reservation !== undefined && cancellationDryRuns.length > 0 &&
          cancellationDryRuns.every((dryRun) =>
            !dryRun.originalCandidatePids.includes(reservation.pid) &&
            dryRun.candidateIdentities.every((identity) =>
              identity.pid !== reservation.pid &&
              identity.applicationName !== outsiderApplicationName));
        outsiderObserver = postgres(adminUrl, { max: 1 });
        const [stillActive] = await outsiderObserver.unsafe<Array<{ active: boolean }>>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE pid = $1 AND backend_start::text = $2
              AND state = 'active' AND query ILIKE '%pg_sleep%'
          ) AS active
        `, [reservation!.pid, reservation!.backendStart]);
        const settlement = await observeAdvisoryStartupSettlement(harness.token, dedicatedOwners);
        expect({
          publicKind: outcome.kind,
          errorCode: outcome.kind === "rejected"
            ? (outcome.error as { message?: unknown }).message
            : null,
          returned: typeof publicReturnedAt === "number",
          targetSettlementKind: targetSettlement.kind,
          targetSettledBeforeReturn: typeof publicReturnedAt === "number" &&
            [appPending, ...appTransactions].every((receipt) =>
              receipt.settledAt !== null && receipt.settledAt <= publicReturnedAt),
          dedicatedParticipantObserved: participant !== undefined &&
            participantIdentity !== undefined,
          migrationTransactionInactiveBeforeApp: completedMigrationTransaction?.outcome === "fulfilled" &&
            completedMigrationTransaction.settledAt !== null &&
            completedMigrationTransaction.settledAt <= appPending.startedAt,
          cancellationControlObserved: controls.length > 0 && cancellationQueries.length > 0,
          cancellationDryRunObserved: cancellationDryRuns.length > 0,
          cancellationDryRunCompleted: cancellationDryRuns.length > 0 &&
            cancellationDryRuns.every((dryRun) => dryRun.outcome === "fulfilled" &&
              dryRun.settledAt !== null),
          cancellationDryRunSettled: cancellationDryRuns.length > 0 &&
            cancellationDryRuns.every((dryRun) => dryRun.outcome === "fulfilled" &&
              dryRun.settledAt !== null && typeof publicReturnedAt === "number" &&
              dryRun.settledAt <= publicReturnedAt),
          targetTupleBound,
          controlsSelfExcludeFullIdentity,
          historicalParticipantNotTargeted,
          outsiderNotTargeted,
          distinctTags: dedicatedOwners.length > 1 && dedicatedOwners.every(({ applicationName }) =>
            typeof applicationName === "string" && applicationName.length > 0 &&
            applicationName !== `${harness.token}_owner`) &&
            new Set(dedicatedOwners.map(({ applicationName }) => applicationName)).size ===
              dedicatedOwners.length,
          allDedicatedEndedBeforeReturn: typeof publicReturnedAt === "number" &&
            dedicatedOwners.length > 1 && dedicatedOwners.every((receipt) =>
              exactBoundedDedicatedEndBefore(receipt, publicReturnedAt)),
          sharedOwnerQueries: harness.state.ownerQueryReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          sharedOwnerTransactions: harness.state.transactionReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          sharedOwnerRawOperations: harness.state.sharedOwnerRawOperations.filter((receipt) =>
            receipt.invocationId === invocation?.id).length,
          sharedOwnerPrivateReads: harness.state.sharedOwnerPrivateReads.filter((receipt) =>
            receipt.invocationId === invocation?.id).length,
          outsiderOutcome,
          outsiderSettledAt,
          outsiderStillActive: stillActive?.active === true,
          reservationHeld: reservation?.releasedAt === null,
          settlement,
        }).toEqual({
          publicKind: "rejected",
          errorCode: "distributed_execution_timeout",
          returned: true,
          targetSettlementKind: "settled",
          targetSettledBeforeReturn: true,
          dedicatedParticipantObserved: true,
          migrationTransactionInactiveBeforeApp: true,
          cancellationControlObserved: true,
          cancellationDryRunObserved: true,
          cancellationDryRunCompleted: true,
          cancellationDryRunSettled: true,
          targetTupleBound: true,
          controlsSelfExcludeFullIdentity: true,
          historicalParticipantNotTargeted: true,
          outsiderNotTargeted: true,
          distinctTags: true,
          allDedicatedEndedBeforeReturn: true,
          sharedOwnerQueries: 0,
          sharedOwnerTransactions: 0,
          sharedOwnerRawOperations: 0,
          sharedOwnerPrivateReads: 0,
          outsiderOutcome: "pending",
          outsiderSettledAt: null,
          outsiderStillActive: true,
          reservationHeld: true,
          settlement: {
            participant_pids: 0,
            dedicated_owner_pids: 0,
            legacy_owner_pids: 0,
            legacy_owner_invalid: 0,
            advisory_locks: 0,
          },
        });
      } finally {
        let outsiderDrained: Awaited<ReturnType<typeof withOuterWatchdog>> | undefined;
        let publicDrained: Awaited<ReturnType<typeof withOuterWatchdog>> | undefined;
        try {
          if (outsiderQuery && reservations?.receipts[0]) {
            outsiderObserver ??= postgres(adminUrl, { max: 1 });
            await outsiderObserver.unsafe(`
              SELECT pg_cancel_backend(activity.pid)
              FROM pg_stat_activity activity
              WHERE activity.pid = $1
                AND activity.backend_start::text = $2
                AND activity.usename = 'test'
                AND activity.datname = current_database()
                AND activity.application_name = $3
                AND activity.state = 'active'
                AND activity.query ILIKE '%pg_sleep%'
            `, [
              reservations.receipts[0].pid,
              reservations.receipts[0].backendStart,
              outsiderApplicationName,
            ]);
          }
          outsiderDrained = outsiderObserved
            ? await withOuterWatchdog(outsiderObserved, 5_000)
            : undefined;
          await outsiderObserver?.end({ timeout: 5 });
          outsiderObserver = null;
          if (reservations?.receipts[0]) {
            await reservations.receipts[0].connection.unsafe(
              "SELECT set_config('application_name', $1, false)",
              [`${harness.token}_owner`],
            ).catch(() => {});
          }
          await reservations?.release();
          publicDrained = await withOuterWatchdog(operation.then(() => true, () => true), 12_000);
        } finally {
          await outsiderObserver?.end({ timeout: 5 }).catch(() => {});
          await harness.cleanup();
        }
        expect(outsiderDrained).toMatchObject({ kind: "fulfilled" });
        expect(publicDrained).toMatchObject({ kind: "fulfilled", value: true });
      }
    }, 45_000);

    it("bounds and awaits a pending owner cleanup query on normal returned close", async () => {
      guard();
      const harness = await createAdvisoryStartupHarness("cleanup-pending");
      const dedicatedOwnerOffset = harness.state.dedicatedOwnerReceipts.length;
      const accepted = await harness.open(harness.input);
      expect(accepted).not.toBeNull();
      const sharedQueryOffset = harness.state.ownerQueryReceipts.length;
      const sharedTransactionOffset = harness.state.transactionReceipts.length;
      const closeOperation = accepted!.close();
      void closeOperation.catch(() => {});
      try {
        const outcome = await withOuterWatchdog(closeOperation);
        const returnedAt = outcome.kind === "watchdog" ? null : performance.now();
        const pending = harness.state.pendingQueries.filter((receipt) =>
          receipt.phase === "cleanup" && receipt.source === "dedicated-owner");
        const cleanupTransactions = harness.state.transactionReceipts.filter((receipt) =>
          receipt.phase === "cleanup" && receipt.source === "dedicated-owner");
        const cleanupControl = harness.state.dedicatedOwnerReceipts.find((receipt) =>
          receipt.id === pending[0]?.dedicatedOwnerId);
        const dedicatedOwners = harness.state.dedicatedOwnerReceipts.slice(dedicatedOwnerOffset);
        const tags = dedicatedOwners.map(({ applicationName }) => applicationName);
        const effectiveTimeoutMs = statementTimeoutMs(pending[0]?.effectiveStatementTimeout ?? null);
        const settlement = await observeAdvisoryStartupSettlement(
          harness.token,
          dedicatedOwners,
        );
        expect({
          publicKind: outcome.kind,
          errorCode: outcome.kind === "rejected"
            ? (outcome.error as { message?: unknown }).message
            : null,
          pendingCount: pending.length,
          pendingIdentity: pending[0] && {
            source: pending[0].source,
            dedicatedOwnerId: pending[0].dedicatedOwnerId,
            backendPid: typeof pending[0].backendPid,
            timeoutBounded: effectiveTimeoutMs !== null && effectiveTimeoutMs >= 0 &&
              effectiveTimeoutMs <= 5_000,
          },
          elapsedBounded: typeof returnedAt === "number" && pending.length === 1 &&
            returnedAt - pending[0]!.startedAt >= 4_500 &&
            returnedAt - pending[0]!.startedAt <= 6_500,
          pendingSettledBeforeReturn: typeof returnedAt === "number" && pending.length === 1 &&
            pending.every((receipt) => receipt.settledAt !== null && receipt.settledAt <= returnedAt),
          transactionCount: cleanupTransactions.length,
          transactionSettledBeforeReturn: typeof returnedAt === "number" &&
            cleanupTransactions.length === 1 && cleanupTransactions.every((receipt) =>
              receipt.dedicatedOwnerId === cleanupControl?.id && receipt.outcome === "rejected" &&
              receipt.settledAt !== null && receipt.settledAt <= returnedAt),
          semanticQueryObserved: cleanupControl?.lifecycle === "close" &&
            cleanupControl.queryReceipts.some((receipt) =>
              receipt.semantic === "cleanup" && receipt.source === "dedicated-owner" &&
              receipt.outcome === "rejected" && receipt.settledAt !== null),
          sharedCleanupQueries: harness.state.ownerQueryReceipts.slice(sharedQueryOffset)
            .filter(({ source }) => source === "shared-owner-db").length,
          sharedCleanupTransactions: harness.state.transactionReceipts.slice(sharedTransactionOffset)
            .filter(({ source }) => source === "shared-owner-db").length,
          servingCloses: harness.state.closeSettled.map(({ role }) => role).sort(),
          servingClosedBeforeReturn: typeof returnedAt === "number" &&
            harness.state.closeSettled.every(({ at }) => at <= returnedAt),
          distinctTags: dedicatedOwners.length > 1 && tags.every((tag) =>
            typeof tag === "string" && tag.length > 0 && tag !== `${harness.token}_owner`) &&
            new Set(tags).size === tags.length,
          allDedicatedEnded: typeof returnedAt === "number" && dedicatedOwners.length > 1 &&
            dedicatedOwners.every((receipt) => receipt.id === cleanupControl?.id
              ? boundedEmergencyEndBefore(receipt, returnedAt)
              : exactBoundedDedicatedEndBefore(receipt, returnedAt)),
          settlement,
          logs: harness.state.logs,
        }).toEqual({
          publicKind: "rejected",
          errorCode: "distributed_execution_close",
          pendingCount: 1,
          pendingIdentity: {
            source: "dedicated-owner",
            dedicatedOwnerId: expect.any(Number),
            backendPid: "number",
            timeoutBounded: true,
          },
          elapsedBounded: true,
          pendingSettledBeforeReturn: true,
          transactionCount: 1,
          transactionSettledBeforeReturn: true,
          semanticQueryObserved: true,
          sharedCleanupQueries: 0,
          sharedCleanupTransactions: 0,
          servingCloses: ["aoa_app", "aoa_operator"],
          servingClosedBeforeReturn: true,
          distinctTags: true,
          allDedicatedEnded: true,
          settlement: {
            participant_pids: 0,
            dedicated_owner_pids: 0,
            legacy_owner_pids: expect.any(Number),
            legacy_owner_invalid: 0,
            advisory_locks: 0,
          },
          logs: [],
        });
      } finally {
        await harness.cleanup();
        const drained = await withOuterWatchdog(closeOperation.then(() => true, () => true), 5_000);
        expect(drained).toMatchObject({ kind: "fulfilled", value: true });
      }
    }, 30_000);

    it("bounds and awaits a pending owner cleanup query after startup failure", async () => {
      guard();
      const harness = await createAdvisoryStartupHarness("cleanup-failure-pending");
      const dedicatedOwnerOffset = harness.state.dedicatedOwnerReceipts.length;
      const operation = harness.open(harness.input);
      void operation.catch(() => {});
      try {
        const outcome = await withOuterWatchdog(operation, 18_000);
        const [invocation] = harness.state.openInvocations;
        const returnedAt = invocation?.returnedAt;
        const pending = harness.state.pendingQueries.filter((receipt) =>
          receipt.invocationId === invocation?.id && receipt.phase === "cleanup" &&
          receipt.source === "dedicated-owner");
        const cleanupTransactions = harness.state.transactionReceipts.filter((receipt) =>
          receipt.invocationId === invocation?.id && receipt.phase === "cleanup" &&
          receipt.source === "dedicated-owner");
        const cleanupControl = harness.state.dedicatedOwnerReceipts.find((receipt) =>
          receipt.id === pending[0]?.dedicatedOwnerId);
        const dedicatedOwners = harness.state.dedicatedOwnerReceipts.slice(dedicatedOwnerOffset);
        const tags = dedicatedOwners.map(({ applicationName }) => applicationName);
        const effectiveTimeoutMs = statementTimeoutMs(pending[0]?.effectiveStatementTimeout ?? null);
        const settlement = await observeAdvisoryStartupSettlement(
          harness.token,
          dedicatedOwners,
        );
        expect({
          publicKind: outcome.kind,
          errorCode: outcome.kind === "rejected"
            ? (outcome.error as { message?: unknown }).message
            : null,
          laterFailureReached: harness.state.injectionTriggered,
          pendingCount: pending.length,
          pendingIdentity: pending[0] && {
            source: pending[0].source,
            dedicatedOwnerId: pending[0].dedicatedOwnerId,
            backendPid: typeof pending[0].backendPid,
            timeoutBounded: effectiveTimeoutMs !== null && effectiveTimeoutMs >= 0 &&
              effectiveTimeoutMs <= 5_000,
          },
          elapsedBounded: typeof returnedAt === "number" && pending.length === 1 &&
            returnedAt - pending[0]!.startedAt >= 4_500 &&
            returnedAt - pending[0]!.startedAt <= 6_500,
          pendingSettledBeforeReturn: typeof returnedAt === "number" && pending.length === 1 &&
            pending.every((receipt) => receipt.settledAt !== null && receipt.settledAt <= returnedAt),
          transactionCount: cleanupTransactions.length,
          transactionSettledBeforeReturn: typeof returnedAt === "number" &&
            cleanupTransactions.length === 1 && cleanupTransactions.every((receipt) =>
              receipt.dedicatedOwnerId === cleanupControl?.id && receipt.outcome === "rejected" &&
              receipt.settledAt !== null && receipt.settledAt <= returnedAt),
          semanticQueryObserved: cleanupControl?.lifecycle === "open" &&
            cleanupControl.queryReceipts.some((receipt) =>
              receipt.semantic === "cleanup" && receipt.source === "dedicated-owner" &&
              receipt.outcome === "rejected" && receipt.settledAt !== null),
          sharedOwnerQueries: harness.state.ownerQueryReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          sharedOwnerTransactions: harness.state.transactionReceipts.filter((receipt) =>
            receipt.invocationId === invocation?.id && receipt.source === "shared-owner-db").length,
          servingCloses: harness.state.closeSettled.map(({ role }) => role).sort(),
          servingClosedBeforeReturn: typeof returnedAt === "number" &&
            harness.state.closeSettled.every(({ at }) => at <= returnedAt),
          distinctTags: dedicatedOwners.length > 1 && tags.every((tag) =>
            typeof tag === "string" && tag.length > 0 && tag !== `${harness.token}_owner`) &&
            new Set(tags).size === tags.length,
          allDedicatedEnded: typeof returnedAt === "number" && dedicatedOwners.length > 1 &&
            dedicatedOwners.every((receipt) => receipt.id === cleanupControl?.id
              ? boundedEmergencyEndBefore(receipt, returnedAt)
              : exactBoundedDedicatedEndBefore(receipt, returnedAt)),
          settlement,
        }).toEqual({
          publicKind: "rejected",
          errorCode: "distributed_execution_close",
          laterFailureReached: true,
          pendingCount: 1,
          pendingIdentity: {
            source: "dedicated-owner",
            dedicatedOwnerId: expect.any(Number),
            backendPid: "number",
            timeoutBounded: true,
          },
          elapsedBounded: true,
          pendingSettledBeforeReturn: true,
          transactionCount: 1,
          transactionSettledBeforeReturn: true,
          semanticQueryObserved: true,
          sharedOwnerQueries: 0,
          sharedOwnerTransactions: 0,
          servingCloses: ["aoa_app", "aoa_operator"],
          servingClosedBeforeReturn: true,
          distinctTags: true,
          allDedicatedEnded: true,
          settlement: {
            participant_pids: 0,
            dedicated_owner_pids: 0,
            legacy_owner_pids: expect.any(Number),
            legacy_owner_invalid: 0,
            advisory_locks: 0,
          },
        });
        assertClosedStartupLogs(harness.state.logs);
        expectCaseInsensitiveRedaction(JSON.stringify(harness.state.logs), [
          harness.appNamedUrl,
          harness.operatorNamedUrl,
          adminUrl,
          "aoa_app",
          "aoa_operator",
          "pg_sleep",
          "test:test",
          "postgres://",
          DRIVER_CAUSE_SENTINEL,
          SQL_SENTINEL,
          ...checkedInMigrationIdentity().orderedHashes,
          ...harness.state.advisoryKeyBindings.map(String),
        ]);
      } finally {
        await harness.cleanup();
        const drained = await withOuterWatchdog(operation.then(() => true, () => true), 5_000);
        expect(drained).toMatchObject({ kind: "fulfilled", value: true });
      }
    }, 30_000);

    it("settles and tears down every advisory participant for each failure/timeout/forced-end phase without payload-bearing diagnostics", async () => {
      // Mutations caught: per-peer aborts, naked Promise.race closes, or logging URLs/keys can
      // strand a backend or disclose the random advisory domain after an injected phase fault.
      guard();
      const injections: StartupFailureInjection[] = [
        "owner-exclusive", "app-negative", "operator-negative", "app-positive", "operator-positive",
        "statement-timeout", "lock-timeout", "idle-timeout", "forced-end",
      ];
      const receipts: Array<{ injection: StartupFailureInjection; errorCode: string; closed: string[] }> = [];
      for (const injection of injections) {
        const harness = await createAdvisoryStartupHarness(injection);
        let accepted: Awaited<ReturnType<typeof openDistributedExecutionDatabases>> = null;
        let failure: unknown;
        let returnedAt = Number.POSITIVE_INFINITY;
        let settlement: Awaited<ReturnType<typeof observeAdvisoryStartupSettlement>> | undefined;
        try {
          accepted = await harness.open(harness.input);
        } catch (error) {
          failure = error;
          returnedAt = performance.now();
        } finally {
          await accepted?.close().catch(() => {});
          settlement = await observeAdvisoryStartupSettlement(
            harness.token,
            harness.state.dedicatedOwnerReceipts,
          );
          await harness.cleanup();
        }
        const errorCode = (failure as { message?: string } | undefined)?.message ?? "startup_returned_pool";
        receipts.push({
          injection,
          errorCode,
          closed: harness.state.closes.map((entry) => entry.role),
        });
        expect(accepted === null, `${injection}: startup must not return either pool`).toBe(true);
        expect(failure, injection).toMatchObject({
          name: "DistributedExecutionStartupError",
          message: expect.stringMatching(/^distributed_execution_/u),
        });
        expect(STARTUP_ERROR_CODES.has(String((failure as { message?: unknown }).message)), injection)
          .toBe(true);
        expect(Object.prototype.hasOwnProperty.call(failure, "cause"), injection).toBe(false);
        expect(harness.state.closes.map((entry) => entry.role).sort(), injection)
          .toEqual(["aoa_app", "aoa_operator"]);
        expect(harness.state.closes.map(({ input }) => input), injection)
          .toEqual([{ timeoutSeconds: 5 }, { timeoutSeconds: 5 }]);
        expect(harness.state.closeSettled.map(({ role }) => role).sort(), injection)
          .toEqual(["aoa_app", "aoa_operator"]);
        expect(harness.state.closeSettled.every(({ at }) => at <= returnedAt), injection).toBe(true);
        expect(harness.state.abortControllers, injection).toHaveLength(1);
        expect(harness.state.abortCalls, injection).toBe(1);
        expect(settlement, injection).toEqual({
          participant_pids: 0,
          dedicated_owner_pids: 0,
          legacy_owner_pids: expect.any(Number),
          legacy_owner_invalid: 0,
          advisory_locks: 0,
        });
        assertClosedStartupLogs(harness.state.logs);
        const serializedLogs = JSON.stringify(harness.state.logs);
        expectCaseInsensitiveRedaction(serializedLogs, [
          harness.appNamedUrl, harness.operatorNamedUrl, adminUrl, "aoa_app", "aoa_operator",
          "postgres://", "test:test", "pg_advisory", "903003",
          "startup-app-password", "startup-operator-password",
          DRIVER_CAUSE_SENTINEL, SQL_SENTINEL,
          ...checkedInMigrationIdentity().orderedHashes,
          ...harness.state.advisoryKeyBindings.map(String),
        ]);
      }
      expect(receipts.map((receipt) => receipt.injection)).toEqual(injections);
      expect(receipts.every((receipt) => receipt.errorCode !== "startup_returned_pool")).toBe(true);
    }, 120_000);

    it("uses exact migration hashes so a missing row fails and a repaired out-of-order serial ID succeeds", async () => {
      guard();
      const [removed] = await admin!.unsafe<Array<{ hash: string; created_at: string | number | null }>>(
        `DELETE FROM drizzle.__drizzle_migrations
         WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)
         RETURNING hash, created_at`,
      );
      expect(removed?.hash).toMatch(/^[0-9a-f]{64}$/);
      if (!removed) return;
      try {
        let failure: unknown;
        try {
          const unexpected = await openFinalStartup(finalStartupInput({
            appDatabaseUrl: appUrl,
            operatorDatabaseUrl: operatorUrl,
          }));
          await unexpected?.close();
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ message: "distributed_execution_migration_identity" });
      } finally {
        await admin!.unsafe(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [removed.hash, removed.created_at],
        );
      }

      const repaired = await openFinalStartup(finalStartupInput({
        appDatabaseUrl: appUrl,
        operatorDatabaseUrl: operatorUrl,
      }));
      expect(repaired).not.toBeNull();
      await repaired?.close();
    }, 60_000);

    it.each([
      ["an extra unmapped hash", async () => "e".repeat(64)],
      ["a duplicate hash", async () => {
        const [row] = await admin!<{ hash: string }[]>`
          SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 1`;
        return row!.hash;
      }],
      ["an unreadable hash", async () => "not-a-sha256"],
    ] as const)("fails migration identity for %s", async (_caseName, buildHash) => {
      guard();
      const hash = await buildHash();
      const [inserted] = await admin!.unsafe<Array<{ id: number }>>(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2) RETURNING id",
        [hash, Date.now()],
      );
      try {
        let accepted: Awaited<ReturnType<typeof openDistributedExecutionDatabases>> = null;
        let failure: unknown;
        try {
          accepted = await openFinalStartup(finalStartupInput({
            appDatabaseUrl: appUrl,
            operatorDatabaseUrl: operatorUrl,
          }));
        } catch (error) {
          failure = error;
        } finally {
          await accepted?.close().catch(() => {});
        }
        expect(failure).toMatchObject({ message: "distributed_execution_migration_identity" });
      } finally {
        await admin!.unsafe("DELETE FROM drizzle.__drizzle_migrations WHERE id = $1", [inserted!.id]);
      }
    }, 60_000);

    it("fails the exact RLS certificate when FORCE is disabled even though effective DML is unchanged", async () => {
      guard();
      await admin!.unsafe(`ALTER TABLE worker_lease_rejections NO FORCE ROW LEVEL SECURITY`);
      try {
        let failure: unknown;
        try {
          const unexpected = await openFinalStartup(finalStartupInput({
            appDatabaseUrl: appUrl,
            operatorDatabaseUrl: operatorUrl,
          }));
          await unexpected?.close();
        } catch (error) { failure = error; }
        expect(failure).toMatchObject({ message: "distributed_execution_app_authority" });
      } finally {
        await admin!.unsafe(`ALTER TABLE worker_lease_rejections FORCE ROW LEVEL SECURITY`);
      }
    }, 60_000);

    it("fails the exact RLS certificate when RLS itself is disabled", async () => {
      guard();
      await admin!.unsafe(`ALTER TABLE worker_lease_rejections DISABLE ROW LEVEL SECURITY`);
      try {
        expect(await captureFinalStartupFailure()).toMatchObject({
          message: "distributed_execution_app_authority",
        });
      } finally {
        await admin!.unsafe(`ALTER TABLE worker_lease_rejections ENABLE ROW LEVEL SECURITY`);
      }
    }, 60_000);

    it.each([
      ["removed", null],
      ["renamed", LEASE_REJECTION_POLICY_SQL.replaceAll(
        "worker_lease_rejections_tenant_isolation",
        "job003_renamed_policy",
      )],
      ["restrictive", LEASE_REJECTION_POLICY_SQL.replace("AS PERMISSIVE", "AS RESTRICTIVE")],
      ["SELECT-only command", `CREATE POLICY worker_lease_rejections_tenant_isolation
        ON worker_lease_rejections AS PERMISSIVE FOR SELECT TO aoa_app
        USING (organization_id = current_setting('aoa.organization_id', true)::uuid)`],
      ["PUBLIC role", LEASE_REJECTION_POLICY_SQL.replace("TO aoa_app", "TO PUBLIC")],
      ["false qual", LEASE_REJECTION_POLICY_SQL.replace(
        "USING (organization_id = current_setting('aoa.organization_id', true)::uuid)",
        "USING (false)",
      )],
      ["false check", LEASE_REJECTION_POLICY_SQL.replace(
        "WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid)",
        "WITH CHECK (false)",
      )],
    ] as const)("fails the exact policy certificate when its row is %s", async (_mutation, replacementSql) => {
      guard();
      await admin!.unsafe(`DROP POLICY worker_lease_rejections_tenant_isolation
        ON worker_lease_rejections`);
      if (replacementSql) await admin!.unsafe(replacementSql);
      try {
        expect(await captureFinalStartupFailure()).toMatchObject({
          message: "distributed_execution_app_authority",
        });
      } finally {
        await admin!.unsafe(`DROP POLICY IF EXISTS job003_renamed_policy
          ON worker_lease_rejections`);
        await restoreLeaseRejectionPolicy();
      }
    }, 60_000);

    it("fails the exact policy certificate on a harmless-looking 23rd permissive row", async () => {
      guard();
      await admin!.unsafe(`CREATE POLICY job003_extra_policy ON worker_lease_rejections
        AS PERMISSIVE FOR SELECT TO aoa_app USING (false)`);
      try {
        let failure: unknown;
        try {
          const unexpected = await openFinalStartup(finalStartupInput({
            appDatabaseUrl: appUrl,
            operatorDatabaseUrl: operatorUrl,
          }));
          await unexpected?.close();
        } catch (error) { failure = error; }
        expect(failure).toMatchObject({ message: "distributed_execution_app_authority" });
      } finally {
        await admin!.unsafe(`DROP POLICY IF EXISTS job003_extra_policy ON worker_lease_rejections`);
      }
    }, 60_000);

    it("rejects every real catalog relkind substitution, including a column-only serving relation", async () => {
      // mcp_api_keys is intentionally derived only from APP_MCP_API_KEY_COLUMN_GRANTS. A
      // hand-maintained table-grant list or broad effective-privilege scan misses every case
      // below once the original relation's column ACL is removed.
      guard();
      const relation = "mcp_api_keys";
      const backup = `job003_mcp_api_keys_backup_${process.pid}`;
      const columns = "id, company_id, user_id, revoked_at";
      const expectRelationFailure = async (shape: string) => {
        expect.soft(await captureFinalStartupFailure(), shape).toMatchObject({
          message: "distributed_execution_app_authority",
        });
      };
      const replace = async (
        shape: string,
        createSql: string,
        dropSql: string,
        grantColumns = true,
      ) => {
        await admin!.unsafe(`ALTER TABLE ${relation} RENAME TO ${backup}`);
        await admin!.unsafe(`REVOKE SELECT (${columns}) ON ${backup} FROM aoa_app`);
        try {
          if (createSql) await admin!.unsafe(createSql);
          if (grantColumns) {
            await admin!.unsafe(`GRANT SELECT (${columns}) ON ${relation} TO aoa_app`);
          }
          await expectRelationFailure(shape);
        } finally {
          if (dropSql) await admin!.unsafe(dropSql).catch(() => {});
          await admin!.unsafe(`GRANT SELECT (${columns}) ON ${backup} TO aoa_app`);
          await admin!.unsafe(`ALTER TABLE ${backup} RENAME TO ${relation}`);
        }
      };

      await replace("missing", "", "", false);
      await replace(
        "view",
        `CREATE VIEW ${relation} AS TABLE ${backup}`,
        `DROP VIEW IF EXISTS ${relation}`,
      );
      await replace(
        "materialized-view",
        `CREATE MATERIALIZED VIEW ${relation} AS TABLE ${backup} WITH NO DATA`,
        `DROP MATERIALIZED VIEW IF EXISTS ${relation}`,
      );
      await replace(
        "partitioned-table",
        `CREATE TABLE ${relation} (LIKE ${backup} INCLUDING DEFAULTS) PARTITION BY HASH (id)`,
        `DROP TABLE IF EXISTS ${relation}`,
      );
      await replace(
        "sequence",
        `CREATE SEQUENCE ${relation}`,
        `DROP SEQUENCE IF EXISTS ${relation}`,
        false,
      );

      const serverName = `job003_relation_shape_${process.pid}`;
      await admin!.unsafe("CREATE EXTENSION IF NOT EXISTS postgres_fdw");
      await admin!.unsafe(`CREATE SERVER ${serverName} FOREIGN DATA WRAPPER postgres_fdw
        OPTIONS (host '127.0.0.1', dbname 'postgres')`);
      try {
        await replace(
          "foreign-table",
          `CREATE FOREIGN TABLE ${relation} (
            id uuid, company_id uuid, user_id text, name text, key_hash text,
            last_used_at timestamptz, revoked_at timestamptz, created_at timestamptz
          ) SERVER ${serverName} OPTIONS (table_name '${backup}')`,
          `DROP FOREIGN TABLE IF EXISTS ${relation}`,
        );
      } finally {
        await admin!.unsafe(`DROP SERVER IF EXISTS ${serverName} CASCADE`).catch(() => {});
      }

    }, 120_000);

    it("checks grant-option ACL tuples independently on every derived relation and non-dropped user column", async () => {
      // The mutations preserve effective SELECT wherever it already exists. Only inspection of
      // relacl/attacl nullness and aclexplode(...).is_grantable can reject those cases.
      guard();
      const appTables = {
        ...legacyGrants.JOB_CONTROL_LEGACY_GRANTS,
        ...legacyGrants.JOB_CONTROL_NEW_PATH_GRANTS,
        ...legacyGrants.JOB_SUBMISSION_LEGACY_GRANTS,
        ...legacyGrants.JOB_SUBMISSION_NEW_PATH_GRANTS,
        ...legacyGrants.WORKER_ENROLLMENT_APP_GRANTS,
        ...legacyGrants.JOB_LEASING_NEW_PATH_GRANTS,
        // REL-004 Lane C. `instance_settings` was swept while its grant lived in
        // JOB_CONTROL_LEGACY_GRANTS; moving it to its own constant silently dropped it out of
        // this list, and NOTHING went red — the assertion is `acceptedMutations` is empty, and a
        // relation that is never probed contributes nothing. That is the "a check that nothing
        // runs" class, caused by a fix for a different instance of the same class.
        //
        // NOTE FOR THE NEXT ADDITION: this spread is HAND-MAINTAINED and already omits ten other
        // app serving relations (folder_grants, worker_admission_rate_limits, live_event_log,
        // live_event_sequences, legacy_resource_reconciliation, job_events,
        // job_projection_receipts, job_control_commands, distributed_cutover_markers,
        // execution_target_revocations). Deriving it from `APP_SERVING_RELATIONS` would make it
        // self-maintaining; it is not done here only because each relation costs a full server
        // boot plus one per column, and this test already carries a 180s budget. Measured and
        // recorded in REL-004-lane-C-result.md rather than absorbed.
        ...legacyGrants.KILL_SWITCH_POLICY_APP_GRANTS,
      } as Readonly<Record<string, readonly string[]>>;
      const operatorTables = legacyGrants.WORKER_ENROLLMENT_OPERATOR_GRANTS as
        Readonly<Record<string, readonly string[]>>;
      const relations = [...new Set([
        ...Object.keys(appTables),
        ...Object.keys(operatorTables),
        ...Object.keys(legacyGrants.OPERATOR_METADATA_COLUMN_GRANTS),
        "mcp_api_keys",
        "execution_targets",
      ])].sort();
      const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
      const acceptedMutations: string[] = [];

      for (const relation of relations) {
        const [access] = await admin!<{ app: boolean; operator: boolean }[]>`
          SELECT
            has_table_privilege('aoa_app', ${`public.${relation}`}, 'SELECT') AS app,
            has_table_privilege('aoa_operator', ${`public.${relation}`}, 'SELECT') AS operator`;
        const role = access?.app ? "aoa_app" : access?.operator ? "aoa_operator" : null;
        if (role) {
          await admin!.unsafe(`GRANT SELECT ON TABLE ${quote(relation)} TO ${role} WITH GRANT OPTION`);
          try {
            if (await captureFinalStartupFailure() === undefined) acceptedMutations.push(`${relation}:relacl`);
          } finally {
            await admin!.unsafe(
              `REVOKE GRANT OPTION FOR SELECT ON TABLE ${quote(relation)} FROM ${role}`,
            );
          }
        }

        const columns = await admin!<{ column_name: string; app: boolean; operator: boolean }[]>`
          SELECT attribute.attname AS column_name,
            has_column_privilege('aoa_app', relation.oid, attribute.attnum, 'SELECT') AS app,
            has_column_privilege('aoa_operator', relation.oid, attribute.attnum, 'SELECT') AS operator
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
          WHERE namespace.nspname = 'public' AND relation.relname = ${relation}
            AND relation.relkind = 'r' AND attribute.attnum > 0 AND NOT attribute.attisdropped
          ORDER BY attribute.attnum`;
        for (const column of columns) {
          const role = column.app ? "aoa_app" : column.operator ? "aoa_operator" : "aoa_app";
          const [prior] = await admin!<{ explicit_select: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_class relation
              JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
              JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
              CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
              LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
              WHERE namespace.nspname = 'public' AND relation.relname = ${relation}
                AND attribute.attname = ${column.column_name}
                AND grantee.rolname = ${role} AND acl.privilege_type = 'SELECT'
            ) AS explicit_select`;
          await admin!.unsafe(
            `GRANT SELECT (${quote(column.column_name)}) ON ${quote(relation)} TO ${role} WITH GRANT OPTION`,
          );
          try {
            if (await captureFinalStartupFailure() === undefined) {
              acceptedMutations.push(`${relation}.${column.column_name}:attacl`);
            }
          } finally {
            await admin!.unsafe(
              `REVOKE SELECT (${quote(column.column_name)}) ON ${quote(relation)} FROM ${role}`,
            );
            if (prior?.explicit_select) {
              await admin!.unsafe(
                `GRANT SELECT (${quote(column.column_name)}) ON ${quote(relation)} TO ${role}`,
              );
            }
          }
        }
      }
      expect(acceptedMutations).toEqual([]);
      // 180s -> 300s. Every relation in the list costs a full server-boot attempt, and every
      // non-dropped column costs another; restoring `instance_settings` (7 columns) added eight.
      // On Linux CI the whole file fits comfortably — the PR run at 4d5bcbead reported exactly
      // two failures, both in a DIFFERENT file, so this test passed there WITH the relation
      // covered. On a Windows local run it measured 192s against the old 180s budget. The extra
      // headroom keeps the local run usable and changes nothing about what is asserted.
    }, 300_000);

    it("fails exact attacl tuples when an expected column gains a grant option", async () => {
      guard();
      await admin!.unsafe(`GRANT SELECT (id) ON execution_targets TO aoa_app WITH GRANT OPTION`);
      try {
        let failure: unknown;
        try {
          const unexpected = await openFinalStartup(finalStartupInput({
            appDatabaseUrl: appUrl,
            operatorDatabaseUrl: operatorUrl,
          }));
          await unexpected?.close();
        } catch (error) { failure = error; }
        expect(failure).toMatchObject({ message: "distributed_execution_app_authority" });
      } finally {
        await admin!.unsafe(`REVOKE GRANT OPTION FOR SELECT (id) ON execution_targets FROM aoa_app`);
      }
    }, 60_000);

    it.each([
      [
        "a relation grant option",
        "GRANT SELECT ON job_outbox TO aoa_app WITH GRANT OPTION",
        "REVOKE GRANT OPTION FOR SELECT ON job_outbox FROM aoa_app",
      ],
      [
        "an unlisted-column grant option",
        "GRANT SELECT (label) ON workers TO aoa_app WITH GRANT OPTION",
        "REVOKE SELECT (label) ON workers FROM aoa_app",
      ],
      [
        "a PUBLIC relation ACL",
        "GRANT SELECT ON worker_lease_rejections TO PUBLIC",
        "REVOKE SELECT ON worker_lease_rejections FROM PUBLIC",
      ],
    ] as const)("fails exact ACL tuples for %s", async (_mutation, installSql, restoreSql) => {
      guard();
      await admin!.unsafe(installSql);
      try {
        expect(await captureFinalStartupFailure()).toMatchObject({
          message: "distributed_execution_app_authority",
        });
      } finally {
        await admin!.unsafe(restoreSql);
      }
    }, 60_000);

    it.each([
      ["aoa_app", "distributed_execution_app_authority"],
      ["aoa_operator", "distributed_execution_operator_authority"],
    ] as const)("keeps %s outside the drizzle migration schema", async (role, errorCode) => {
      guard();
      await admin!.unsafe(`GRANT USAGE ON SCHEMA drizzle TO ${role}`);
      await admin!.unsafe(`GRANT SELECT ON drizzle.__drizzle_migrations TO ${role}`);
      try {
        expect(await captureFinalStartupFailure()).toMatchObject({
          message: errorCode,
        });
      } finally {
        await admin!.unsafe(`REVOKE ALL ON drizzle.__drizzle_migrations FROM ${role}`);
        await admin!.unsafe(`REVOKE USAGE ON SCHEMA drizzle FROM ${role}`);
      }
    }, 60_000);

    it("loads none of the flag-on job-control graph while disabled", async () => {
      guard();
      const flagOff = await observeServer({
        databaseUrl: legacyOwnerUrl,
        distributedEnabled: false,
        sentinelMode: "deny",
      });
      expect(flagOff.exited, flagOff.output).toBe(false);
      for (const moduleName of [
        "worker-control", "job-leasing", "job-control-metrics", "job-ready-scheduler", "job-outbox-worker",
      ]) {
        expect(flagOff.output).not.toContain(`JOB_CONTROL_MODULE_LOAD:${moduleName}`);
      }
    }, 60_000);

    it("proves the module-load sentinel reaches every guarded module while enabled", async () => {
      guard();
      const flagOn = await observeServer({
        databaseUrl: adminUrl,
        distributedEnabled: true,
        appDatabaseUrl: appUrl,
        operatorDatabaseUrl: operatorUrl,
        sentinelMode: "record",
      });
      expect(flagOn.exited, flagOn.output).toBe(false);
      for (const moduleName of [
        "worker-control", "job-leasing", "job-control-metrics", "job-ready-scheduler", "job-outbox-worker",
      ]) {
        expect(flagOn.output).toContain(`JOB_CONTROL_MODULE_LOAD:${moduleName}`);
      }
    }, 60_000);

    it("threads the identical metrics instance through the real flag-on startup and app composition", async () => {
      guard();
      const flagOn = await observeServer({
        databaseUrl: adminUrl,
        distributedEnabled: true,
        appDatabaseUrl: appUrl,
        operatorDatabaseUrl: operatorUrl,
        sentinelMode: "identity",
      });
      expect(flagOn.exited, flagOn.output).toBe(false);
      expect(flagOn.output).toContain("JOB_CONTROL_METRICS_IDENTITY:metrics");
      for (const consumer of ["job-ready-scheduler", "job-outbox-worker", "worker-control", "job-leasing"]) {
        expect(flagOn.output, consumer).toContain(`JOB_CONTROL_METRICS_IDENTITY:${consumer}:same`);
        expect(flagOn.output, consumer).not.toContain(`JOB_CONTROL_METRICS_IDENTITY:${consumer}:different`);
      }
    }, 60_000);
  },
);
