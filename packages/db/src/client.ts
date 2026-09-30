import { createHash } from "node:crypto";
import type { DeploymentMode } from "@armyofagents/shared";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as schema from "./schema/index.js";
import { assertMigrationSnapshotGate } from "./migration-snapshot-gate.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_JOURNAL_JSON = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function quoteIdentifier(value: string): string {
  if (!isSafeIdentifier(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export type MigrationState =
  | { status: "upToDate"; tableCount: number; availableMigrations: string[]; appliedMigrations: string[] }
  | {
      status: "needsMigrations";
      tableCount: number;
      availableMigrations: string[];
      appliedMigrations: string[];
      pendingMigrations: string[];
      reason: "no-migration-journal-empty-db" | "no-migration-journal-non-empty-db" | "pending-migrations";
    };

export function createDb(url: string) {
  // Force UTF-8 client encoding. Helps when the postgres SERVER's default
  // encoding is UTF-8 but the connection got created without explicit
  // client_encoding. On Windows, the embedded-postgres CLUSTER itself is
  // initialized with the OS locale (WIN1252) at initdb time, so this option
  // alone doesn't rescue clusters that were already created with WIN1252
  // storage — those need to be re-initialized (see `initdbFlags` in
  // server/src/index.ts) or migrated. Defensive scaffolder code (avoid
  // `→`, em-dashes, emoji in stored markdown) is the cheapest workaround.
  const sql = postgres(url, { connection: { client_encoding: "UTF8" } });
  return drizzlePg(sql, { schema });
}

/**
 * TEN-002 (E2-D03 / finding E2-F007): the NON-OWNER serving-pool factory for the
 * new-path distributed-execution tables. Builds the pool exactly like `createDb`
 * (UTF-8 client encoding), but is intended to authenticate as `aoa_app`
 * (NOSUPERUSER, NOBYPASSRLS) so forced RLS filters it.
 *
 * FAIL-CLOSED: throws on a missing/blank URL and NEVER falls back to `createDb`
 * (the privileged/owner pool). A silent fallback would run new-path queries as a
 * superuser that BYPASSES RLS entirely — a total H-01 tenant-isolation fail-open.
 * `createDb` is kept unchanged for the privileged/migration path.
 *
 * TEN-003: `opts.max` is forwarded to `postgres()` (additive; default behavior
 * unchanged when omitted). The tenant-context pooled-reuse proof pins `max: 1` so
 * every query lands on the same physical connection and the transaction-local GUC
 * no-leak assertion is real rather than vacuous.
 */
export interface NonOwnerDbConnection {
  db: Db;
  close(input: { timeoutSeconds: number }): Promise<void>;
}

export interface NonOwnerDbConnectionOptions {
  max?: number;
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionSessionTimeoutMs?: number;
  idleTimeoutMs?: number;
}

function createRequiredNonOwnerDbConnection(
  url: string,
  role: "aoa_app" | "aoa_operator",
  opts?: NonOwnerDbConnectionOptions,
): NonOwnerDbConnection {
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error(
      `${role} requires its explicit non-owner database URL; it must NEVER fall back to ` +
        "the owner/superuser pool (that would bypass RLS - H-01 tenant-isolation fail-open).",
    );
  }
  const client = postgres(url, {
    connect_timeout: (opts?.connectTimeoutMs ?? 5_000) / 1_000,
    idle_timeout: (opts?.idleTimeoutMs ?? 30_000) / 1_000,
    connection: {
      client_encoding: "UTF8",
      statement_timeout: opts?.statementTimeoutMs ?? 5_000,
      lock_timeout: opts?.lockTimeoutMs ?? 750,
      idle_in_transaction_session_timeout: opts?.idleInTransactionSessionTimeoutMs ?? 5_000,
    },
    ...(opts?.max !== undefined ? { max: opts.max } : {}),
  });
  return {
    db: drizzlePg(client, { schema }),
    close: (input) => {
      if (input === undefined) {
        throw new Error("A non-owner database close timeout is required");
      }
      return input.timeoutSeconds === 5
        ? client.end({ timeout: 5 })
        : client.end({ timeout: input.timeoutSeconds });
    },
  };
}

export function createTenantAppDbConnection(
  url: string,
  opts?: NonOwnerDbConnectionOptions,
): NonOwnerDbConnection {
  return createRequiredNonOwnerDbConnection(url, "aoa_app", opts);
}

export function createOperatorDbConnection(
  url: string,
  opts?: NonOwnerDbConnectionOptions,
): NonOwnerDbConnection {
  return createRequiredNonOwnerDbConnection(url, "aoa_operator", opts);
}

export function createTenantAppDb(url: string, opts?: { max?: number }) {
  return createTenantAppDbConnection(url, opts).db;
}

export interface RequiredMigrationIdentity {
  readonly orderedHashes: readonly string[];
  readonly ledgerSha256: string;
}

/**
 * Produce the owner-side migration certificate from the checked-in Drizzle
 * journal and raw migration bytes. Database serial IDs are deliberately absent:
 * they are allocation details, not migration identity.
 */
export async function loadRequiredMigrationIdentity(): Promise<RequiredMigrationIdentity> {
  const rawJournal = await readFile(MIGRATIONS_JOURNAL_JSON, "utf8");
  const journal = JSON.parse(rawJournal) as MigrationJournalFile;
  if (!Array.isArray(journal.entries)) {
    throw new Error("The checked-in migration journal has no entries");
  }

  const orderedPaths = journal.entries
    .map((entry) => {
      if (typeof entry?.tag !== "string" || entry.tag.length === 0) {
        throw new Error("The checked-in migration journal contains an invalid tag");
      }
      if (!Number.isInteger(entry.idx)) {
        throw new Error("The checked-in migration journal contains an invalid index");
      }
      return `${entry.tag}.sql`;
    });

  if (new Set(orderedPaths).size !== orderedPaths.length) {
    throw new Error("The checked-in migration journal contains duplicate paths");
  }

  const orderedHashes = await Promise.all(orderedPaths.map(async (migrationPath) =>
    createHash("sha256")
      .update(await readFile(new URL(`./migrations/${migrationPath}`, import.meta.url)))
      .digest("hex")));
  if (new Set(orderedHashes).size !== orderedHashes.length) {
    throw new Error("The checked-in migration journal contains duplicate migration hashes");
  }

  const frozenHashes = Object.freeze(orderedHashes);
  return Object.freeze({
    orderedHashes: frozenHashes,
    ledgerSha256: createHash("sha256").update(JSON.stringify(frozenHashes)).digest("hex"),
  });
}

export interface AppliedMigrationIdentity {
  /** sha256 (file bytes) of each APPLIED migration file that resolves to this image, in apply order. */
  readonly orderedHashes: readonly string[];
  /** The raw `__drizzle_migrations` row count — catches a DB migrated PAST this image (rollback). */
  readonly rawAppliedCount: number;
}

/**
 * DEP-003 (E6 deployment harness): the DB-side applied-migration certificate for the
 * readiness schema-compatibility gate. `orderedHashes` mirror
 * `loadRequiredMigrationIdentity`'s per-file sha256 for the applied subset (in apply
 * order), and `rawAppliedCount` is the raw `__drizzle_migrations` row count. The raw
 * count is load-bearing: a DB migrated by a NEWER image has rows whose files this
 * image lacks (they cannot be hashed), so only the raw count reveals the "newer /
 * incompatible" rollback case. Reads only; never mutates the database.
 */
export async function loadAppliedMigrationIdentity(url: string): Promise<AppliedMigrationIdentity> {
  const state = await inspectMigrations(url);
  const appliedTags =
    state.status === "upToDate" ? state.appliedMigrations : state.appliedMigrations;

  const orderedHashes = await Promise.all(
    appliedTags.map(async (fileName) =>
      createHash("sha256")
        .update(await readFile(new URL(`./migrations/${fileName}`, import.meta.url)))
        .digest("hex")),
  );

  const sql = postgres(url, { max: 1 });
  try {
    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    let rawAppliedCount = 0;
    if (migrationTableSchema) {
      const quotedSchema = quoteIdentifier(migrationTableSchema);
      const qualifiedTable = `${quotedSchema}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;
      const rows = await sql.unsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM ${qualifiedTable}`,
      );
      rawAppliedCount = Number(rows[0]?.count ?? 0);
    }
    return { orderedHashes: Object.freeze(orderedHashes), rawAppliedCount };
  } finally {
    await sql.end();
  }
}

/**
 * TEN-002 (E2-D03): assert the connection's role has the exact hardened posture:
 * non-superuser, no RLS bypass/role inheritance/cluster
 * authority, no inherited roles, and no owned application objects). Used at boot
 * / in tests to prove the serving pool cannot widen its effective authority. A
 * superuser or BYPASSRLS role always bypasses RLS regardless of FORCE, so serving
 * tenant queries as one is a total H-01 fail-open.
 */
export async function assertNonOwnerConnection(
  db: Db,
  expectedRole?: "aoa_app" | "aoa_operator",
): Promise<void> {
  const result = await db.execute(sql`
    SELECT
      session_user AS session_role_name,
      current_user AS role_name,
      role.rolsuper,
      role.rolbypassrls,
      role.rolcreatedb,
      role.rolcreaterole,
      role.rolinherit,
      role.rolreplication,
      (
        SELECT count(*)::int
        FROM pg_auth_members membership
        WHERE membership.member = role.oid
      ) AS membership_count,
      (
        EXISTS (
          SELECT 1 FROM pg_database database
          WHERE database.datdba = role.oid AND database.datname = current_database()
        ) OR EXISTS (
          SELECT 1 FROM pg_namespace namespace
          WHERE namespace.nspowner = role.oid
            AND namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg_%'
        ) OR EXISTS (
          SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE relation.relowner = role.oid
            AND namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg_%'
        ) OR EXISTS (
          SELECT 1
          FROM pg_proc function
          JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
          WHERE function.proowner = role.oid
            AND namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg_%'
        ) OR EXISTS (
          SELECT 1
          FROM pg_type type
          JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
          WHERE type.typowner = role.oid
            AND namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg_%'
        )
      ) AS owns_application_objects
    FROM pg_roles role
    WHERE role.rolname = current_user
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
    role_name?: string;
    session_role_name?: string;
    rolsuper?: boolean;
    rolbypassrls?: boolean;
    rolcreatedb?: boolean;
    rolcreaterole?: boolean;
    rolinherit?: boolean;
    rolreplication?: boolean;
    membership_count?: number;
    owns_application_objects?: boolean;
  }>;
  const row = rows[0];
  if (!row) {
    throw new Error("assertNonOwnerConnection: could not resolve current_user role attributes");
  }
  if (
    row.session_role_name !== row.role_name ||
    (expectedRole && (row.session_role_name !== expectedRole || row.role_name !== expectedRole))
  ) {
    throw new Error(
      `Refusing ${expectedRole ?? "bounded"} serving pool credentials with authenticated session ` +
        `${row.session_role_name ?? "unknown"} and active role ${row.role_name ?? "unknown"}; ` +
        "session_user and current_user must both equal the expected bounded role, so owner-pool, " +
        "startup SET ROLE, and cross-role fallback are forbidden.",
    );
  }
  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `Refusing to serve tenant queries as a privileged role (rolsuper=${row.rolsuper}, ` +
        `rolbypassrls=${row.rolbypassrls}); the serving pool must be a non-owner NOSUPERUSER ` +
        "NOBYPASSRLS role so forced RLS can filter it.",
    );
  }
  if (
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolinherit ||
    row.rolreplication ||
    row.membership_count !== 0 ||
    row.owns_application_objects
  ) {
    throw new Error(
      `Refusing ${row.role_name ?? expectedRole ?? "unknown"} serving pool with drifted authority ` +
        `(rolcreatedb=${row.rolcreatedb}, rolcreaterole=${row.rolcreaterole}, ` +
        `rolinherit=${row.rolinherit}, rolreplication=${row.rolreplication}, ` +
        `memberships=${row.membership_count}, ownsApplicationObjects=${row.owns_application_objects}).`,
    );
  }
}

/**
 * DAT-007 item #1 — the RLS precondition for arming the distributed run-JWT currency gate.
 *
 * The `/mcp` currency resolver reads `leases`/`job_attempts` on the PRIMARY (owner) `db` pool.
 * Those tables are FORCE-RLS'd with tenant policies scoped `TO aoa_app` (rls-tenant.ts), so if the
 * primary `DATABASE_URL` role is ever a NON-superuser, NON-BYPASSRLS table owner, no policy matches
 * it and no tenant GUC is set — the resolver reads ZERO rows and would DENY EVERY distributed run
 * (fail-CLOSED: an availability outage, not a security bypass). This precondition refuses to arm the
 * gate on such a pool, turning a silent, oracle-less 403 storm into a loud boot failure. The proven
 * E7-1 canary already runs on a privileged primary db, so this holds today; the check exists so a
 * future deployment cannot regress it silently. A superuser/BYPASSRLS owner bypasses FORCE RLS.
 *
 * PURE half — decide from the resolved role attributes so it is unit-testable without a database.
 * Returns a refusal message, or null when the role bypasses RLS.
 */
export function rlsBypassRefusal(
  attrs: { rolsuper?: boolean | null; rolbypassrls?: boolean | null } | null,
): string | null {
  if (!attrs) {
    return "assertPrimaryDbBypassesRls: could not resolve current_user role attributes from pg_roles.";
  }
  if (!(attrs.rolsuper || attrs.rolbypassrls)) {
    return (
      "Refusing to arm AOA_DISTRIBUTED_EXECUTION_ENABLED: the primary db role " +
      `(rolsuper=${attrs.rolsuper ?? false}, rolbypassrls=${attrs.rolbypassrls ?? false}) does not ` +
      "bypass RLS. The DAT-007 currency resolver reads FORCE-RLS'd leases/job_attempts on this pool; " +
      "a non-bypassing owner would read zero rows and deny every distributed run. Grant BYPASSRLS to " +
      "the primary role (or thread a tenant-scoped read) before enabling distributed execution."
    );
  }
  return null;
}

/**
 * ASYNC half — resolve the primary pool's role attributes and throw on refusal. Call ONCE at the
 * distributed-on startup so a misconfigured pool fails boot rather than every `/mcp` call. Mirrors
 * `assertNonOwnerConnection`'s `pg_roles` read; the INVERSE assertion (must bypass, not must-not).
 */
export async function assertPrimaryDbBypassesRls(db: Db): Promise<void> {
  const result = await db.execute(sql`
    SELECT role.rolsuper, role.rolbypassrls
    FROM pg_roles role
    WHERE role.rolname = current_user
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
    rolsuper?: boolean;
    rolbypassrls?: boolean;
  }>;
  const refusal = rlsBypassRefusal(rows[0] ?? null);
  if (refusal) throw new Error(refusal);
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_FOLDER, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

type MigrationJournalFile = {
  entries?: Array<{ idx?: number; tag?: string; when?: number }>;
};

type JournalMigrationEntry = {
  fileName: string;
  folderMillis: number;
  order: number;
};

async function listJournalMigrationEntries(): Promise<JournalMigrationEntry[]> {
  try {
    const raw = await readFile(MIGRATIONS_JOURNAL_JSON, "utf8");
    const parsed = JSON.parse(raw) as MigrationJournalFile;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map((entry, entryIndex) => {
        if (typeof entry?.tag !== "string") return null;
        if (typeof entry?.when !== "number" || !Number.isFinite(entry.when)) return null;
        const order = Number.isInteger(entry.idx) ? Number(entry.idx) : entryIndex;
        return { fileName: `${entry.tag}.sql`, folderMillis: entry.when, order };
      })
      .filter((entry): entry is JournalMigrationEntry => entry !== null);
  } catch {
    return [];
  }
}

async function listJournalMigrationFiles(): Promise<string[]> {
  const entries = await listJournalMigrationEntries();
  return entries.map((entry) => entry.fileName);
}

async function readMigrationFileContent(migrationFile: string): Promise<string> {
  return readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
}

async function orderMigrationsByJournal(migrationFiles: string[]): Promise<string[]> {
  const journalEntries = await listJournalMigrationEntries();
  const orderByFileName = new Map(journalEntries.map((entry) => [entry.fileName, entry.order]));
  return [...migrationFiles].sort((left, right) => {
    const leftOrder = orderByFileName.get(left);
    const rightOrder = orderByFileName.get(right);
    if (leftOrder === undefined && rightOrder === undefined) return left.localeCompare(right);
    if (leftOrder === undefined) return 1;
    if (rightOrder === undefined) return -1;
    if (leftOrder === rightOrder) return left.localeCompare(right);
    return leftOrder - rightOrder;
  });
}

type SqlExecutor = Pick<ReturnType<typeof postgres>, "unsafe">;

async function runInTransaction(sql: SqlExecutor, action: () => Promise<void>): Promise<void> {
  await sql.unsafe("BEGIN");
  try {
    await action();
    await sql.unsafe("COMMIT");
  } catch (error) {
    try {
      await sql.unsafe("ROLLBACK");
    } catch {
      // Ignore rollback failures and surface the original error.
    }
    throw error;
  }
}

async function latestMigrationCreatedAt(
  sql: SqlExecutor,
  qualifiedTable: string,
): Promise<number | null> {
  const rows = await sql.unsafe<{ created_at: string | number | null }[]>(
    `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC NULLS LAST LIMIT 1`,
  );
  const value = Number(rows[0]?.created_at ?? Number.NaN);
  return Number.isFinite(value) ? value : null;
}

function normalizeFolderMillis(value: number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return Date.now();
}

async function ensureMigrationJournalTable(
  sql: ReturnType<typeof postgres>,
): Promise<{ migrationTableSchema: string; columnNames: Set<string> }> {
  let migrationTableSchema = await discoverMigrationTableSchema(sql);
  if (!migrationTableSchema) {
    const drizzleSchema = quoteIdentifier("drizzle");
    const migrationTable = quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE);
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${drizzleSchema}`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${drizzleSchema}.${migrationTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    migrationTableSchema = (await discoverMigrationTableSchema(sql)) ?? "drizzle";
  }

  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
  return { migrationTableSchema, columnNames };
}

async function migrationHistoryEntryExists(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
): Promise<boolean> {
  const predicates: string[] = [];
  if (columnNames.has("hash")) predicates.push(`hash = ${quoteLiteral(hash)}`);
  if (columnNames.has("name")) predicates.push(`name = ${quoteLiteral(migrationFile)}`);
  if (predicates.length === 0) return false;

  const rows = await sql.unsafe<{ one: number }[]>(
    `SELECT 1 AS one FROM ${qualifiedTable} WHERE ${predicates.join(" OR ")} LIMIT 1`,
  );
  return rows.length > 0;
}

async function recordMigrationHistoryEntry(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
  folderMillis: number,
): Promise<void> {
  const insertColumns: string[] = [];
  const insertValues: string[] = [];

  if (columnNames.has("hash")) {
    insertColumns.push(quoteIdentifier("hash"));
    insertValues.push(quoteLiteral(hash));
  }
  if (columnNames.has("name")) {
    insertColumns.push(quoteIdentifier("name"));
    insertValues.push(quoteLiteral(migrationFile));
  }
  if (columnNames.has("created_at")) {
    const latestCreatedAt = await latestMigrationCreatedAt(sql, qualifiedTable);
    const createdAt = latestCreatedAt === null
      ? normalizeFolderMillis(folderMillis)
      : Math.max(latestCreatedAt + 1, normalizeFolderMillis(folderMillis));
    insertColumns.push(quoteIdentifier("created_at"));
    insertValues.push(quoteLiteral(String(createdAt)));
  }

  if (insertColumns.length === 0) return;

  await sql.unsafe(
    `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
  );
}

async function applyPendingMigrationsManually(
  url: string,
  pendingMigrations: string[],
): Promise<void> {
  if (pendingMigrations.length === 0) return;

  const orderedPendingMigrations = await orderMigrationsByJournal(pendingMigrations);
  const journalEntries = await listJournalMigrationEntries();
  const folderMillisByFileName = new Map(
    journalEntries.map((entry) => [entry.fileName, normalizeFolderMillis(entry.folderMillis)]),
  );

  const sql = postgres(url, { max: 1 });
  try {
    const { migrationTableSchema, columnNames } = await ensureMigrationJournalTable(sql);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of orderedPendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const existingEntry = await migrationHistoryEntryExists(
        sql,
        qualifiedTable,
        columnNames,
        migrationFile,
        hash,
      );
      if (existingEntry) continue;

      await runInTransaction(sql, async () => {
        for (const statement of splitMigrationStatements(migrationContent)) {
          await sql.unsafe(statement);
        }

        await recordMigrationHistoryEntry(
          sql,
          qualifiedTable,
          columnNames,
          migrationFile,
          hash,
          folderMillisByFileName.get(migrationFile) ?? Date.now(),
        );
      });
    }
  } finally {
    await sql.end();
  }
}

async function mapHashesToMigrationFiles(migrationFiles: string[]): Promise<Map<string, string>> {
  const mapped = new Map<string, string>();

  await Promise.all(
    migrationFiles.map(async (migrationFile) => {
      const content = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(content).digest("hex");
      mapped.set(hash, migrationFile);
    }),
  );

  return mapped;
}

async function getMigrationTableColumnNames(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
): Promise<Set<string>> {
  const columns = await sql.unsafe<{ column_name: string }[]>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ${quoteLiteral(migrationTableSchema)}
        AND table_name = ${quoteLiteral(DRIZZLE_MIGRATIONS_TABLE)}
    `,
  );
  return new Set(columns.map((column) => column.column_name));
}

async function tableExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function columnExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
        AND column_name = ${columnName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function indexExists(
  sql: ReturnType<typeof postgres>,
  indexName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'i'
        AND c.relname = ${indexName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function constraintExists(
  sql: ReturnType<typeof postgres>,
  constraintName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
        AND c.conname = ${constraintName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function migrationStatementAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  statement: string,
): Promise<boolean> {
  const normalized = statement.replace(/\s+/g, " ").trim();

  const createTableMatch = normalized.match(/^CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createTableMatch) {
    return tableExists(sql, createTableMatch[1]);
  }

  const addColumnMatch = normalized.match(
    /^ALTER TABLE "([^"]+)" ADD COLUMN(?: IF NOT EXISTS)? "([^"]+)"/i,
  );
  if (addColumnMatch) {
    return columnExists(sql, addColumnMatch[1], addColumnMatch[2]);
  }

  const createIndexMatch = normalized.match(/^CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createIndexMatch) {
    return indexExists(sql, createIndexMatch[1]);
  }

  const addConstraintMatch = normalized.match(/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/i);
  if (addConstraintMatch) {
    return constraintExists(sql, addConstraintMatch[2]);
  }

  // If we cannot reason about a statement safely, require manual migration.
  return false;
}

async function migrationContentAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  migrationContent: string,
): Promise<boolean> {
  const statements = splitMigrationStatements(migrationContent);
  if (statements.length === 0) return false;

  for (const statement of statements) {
    const applied = await migrationStatementAlreadyApplied(sql, statement);
    if (!applied) return false;
  }

  return true;
}

async function loadAppliedMigrations(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
  availableMigrations: string[],
): Promise<string[]> {
  const quotedSchema = quoteIdentifier(migrationTableSchema);
  const qualifiedTable = `${quotedSchema}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;
  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);

  if (columnNames.has("name")) {
    const rows = await sql.unsafe<{ name: string }[]>(`SELECT name FROM ${qualifiedTable} ORDER BY id`);
    return rows.map((row) => row.name).filter((name): name is string => Boolean(name));
  }

  if (columnNames.has("hash")) {
    const rows = await sql.unsafe<{ hash: string }[]>(`SELECT hash FROM ${qualifiedTable} ORDER BY id`);
    const hashesToMigrationFiles = await mapHashesToMigrationFiles(availableMigrations);
    const appliedFromHashes = rows
      .map((row) => hashesToMigrationFiles.get(row.hash))
      .filter((name): name is string => Boolean(name));

    if (appliedFromHashes.length > 0) {
      // Best-effort: when all hashes resolve, this is authoritative.
      if (appliedFromHashes.length === rows.length) return appliedFromHashes;

      // Partial hash resolution can happen when files have changed; return what we can trust.
      return appliedFromHashes;
    }

    // Fallback only when hashes are unavailable/unresolved.
    if (columnNames.has("created_at")) {
      const journalEntries = await listJournalMigrationEntries();
      if (journalEntries.length > 0) {
        const lastDbRows = await sql.unsafe<{ created_at: string | number | null }[]>(
          `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC LIMIT 1`,
        );
        const lastCreatedAt = Number(lastDbRows[0]?.created_at ?? -1);
        if (Number.isFinite(lastCreatedAt) && lastCreatedAt >= 0) {
          return journalEntries
            .filter((entry) => availableMigrations.includes(entry.fileName))
            .filter((entry) => entry.folderMillis <= lastCreatedAt)
            .map((entry) => entry.fileName)
            .slice(0, rows.length);
        }
      }
    }
  }

  const rows = await sql.unsafe<{ id: number }[]>(`SELECT id FROM ${qualifiedTable} ORDER BY id`);
  const journalMigrationFiles = await listJournalMigrationFiles();
  const appliedFromIds = rows
    .map((row) => journalMigrationFiles[row.id - 1])
    .filter((name): name is string => Boolean(name));
  if (appliedFromIds.length > 0) return appliedFromIds;

  return availableMigrations.slice(0, Math.max(0, rows.length));
}

export type MigrationHistoryReconcileResult = {
  repairedMigrations: string[];
  remainingMigrations: string[];
};

export async function reconcilePendingMigrationHistory(
  url: string,
): Promise<MigrationHistoryReconcileResult> {
  const state = await inspectMigrations(url);
  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    return { repairedMigrations: [], remainingMigrations: [] };
  }

  const sql = postgres(url, { max: 1 });
  const repairedMigrations: string[] = [];

  try {
    const journalEntries = await listJournalMigrationEntries();
    const folderMillisByFile = new Map(journalEntries.map((entry) => [entry.fileName, entry.folderMillis]));
    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      return { repairedMigrations, remainingMigrations: state.pendingMigrations };
    }

    const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of state.pendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const alreadyApplied = await migrationContentAlreadyApplied(sql, migrationContent);
      if (!alreadyApplied) break;

      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const folderMillis = folderMillisByFile.get(migrationFile) ?? Date.now();
      const existingByHash = columnNames.has("hash")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE hash = ${quoteLiteral(hash)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      const existingByName = columnNames.has("name")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE name = ${quoteLiteral(migrationFile)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      if (existingByHash.length > 0 || existingByName.length > 0) {
        if (columnNames.has("created_at")) {
          const existingHashCreatedAt = Number(existingByHash[0]?.created_at ?? -1);
          if (existingByHash.length > 0 && Number.isFinite(existingHashCreatedAt) && existingHashCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE hash = ${quoteLiteral(hash)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }

          const existingNameCreatedAt = Number(existingByName[0]?.created_at ?? -1);
          if (existingByName.length > 0 && Number.isFinite(existingNameCreatedAt) && existingNameCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE name = ${quoteLiteral(migrationFile)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }
        }

        repairedMigrations.push(migrationFile);
        continue;
      }

      const insertColumns: string[] = [];
      const insertValues: string[] = [];

      if (columnNames.has("hash")) {
        insertColumns.push(quoteIdentifier("hash"));
        insertValues.push(quoteLiteral(hash));
      }
      if (columnNames.has("name")) {
        insertColumns.push(quoteIdentifier("name"));
        insertValues.push(quoteLiteral(migrationFile));
      }
      if (columnNames.has("created_at")) {
        insertColumns.push(quoteIdentifier("created_at"));
        insertValues.push(quoteLiteral(String(folderMillis)));
      }

      if (insertColumns.length === 0) break;

      await sql.unsafe(
        `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
      );
      repairedMigrations.push(migrationFile);
    }
  } finally {
    await sql.end();
  }

  const refreshed = await inspectMigrations(url);
  return {
    repairedMigrations,
    remainingMigrations:
      refreshed.status === "needsMigrations" ? refreshed.pendingMigrations : [],
  };
}

async function discoverMigrationTableSchema(sql: ReturnType<typeof postgres>): Promise<string | null> {
  const rows = await sql<{ schemaName: string }[]>`
    SELECT n.nspname AS "schemaName"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${DRIZZLE_MIGRATIONS_TABLE} AND c.relkind = 'r'
  `;

  if (rows.length === 0) return null;

  const drizzleSchema = rows.find(({ schemaName }) => schemaName === "drizzle");
  if (drizzleSchema) return drizzleSchema.schemaName;

  const publicSchema = rows.find(({ schemaName }) => schemaName === "public");
  if (publicSchema) return publicSchema.schemaName;

  return rows[0]?.schemaName ?? null;
}

export async function inspectMigrations(url: string): Promise<MigrationState> {
  const sql = postgres(url, { max: 1 });

  try {
    const availableMigrations = await listMigrationFiles();
    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;
    const tableCount = tableCountResult[0]?.count ?? 0;

    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      if (tableCount > 0) {
        return {
          status: "needsMigrations",
          tableCount,
          availableMigrations,
          appliedMigrations: [],
          pendingMigrations: availableMigrations,
          reason: "no-migration-journal-non-empty-db",
        };
      }

      return {
        status: "needsMigrations",
        tableCount,
        availableMigrations,
        appliedMigrations: [],
        pendingMigrations: availableMigrations,
        reason: "no-migration-journal-empty-db",
      };
    }

    const appliedMigrations = await loadAppliedMigrations(sql, migrationTableSchema, availableMigrations);
    const pendingMigrations = availableMigrations.filter((name) => !appliedMigrations.includes(name));
    if (pendingMigrations.length === 0) {
      return {
        status: "upToDate",
        tableCount,
        availableMigrations,
        appliedMigrations,
      };
    }

    return {
      status: "needsMigrations",
      tableCount,
      availableMigrations,
      appliedMigrations,
      pendingMigrations,
      reason: "pending-migrations",
    };
  } finally {
    await sql.end();
  }
}

export interface ApplyPendingMigrationsOptions {
  deploymentMode?: DeploymentMode;
}

export async function applyPendingMigrations(
  url: string,
  options: ApplyPendingMigrationsOptions = {},
): Promise<void> {
  const initialState = await inspectMigrations(url);
  if (initialState.status === "upToDate") return;

  // Finding #4: serialize concurrent-replica migrations. Cloud replicas
  // auto-apply on boot (non-TTY); hold a session-level advisory lock across
  // inspect+apply so two replicas don't both run non-idempotent DDL (e.g. 0188
  // ADD COLUMN / ADD CONSTRAINT). Precedent: first-user-bootstrap.ts (which uses
  // the *xact* variant); here we use the *session* variant because
  // applyPendingMigrations has no surrounding transaction — the migrator opens
  // its own per-file transactions. The lock is held on a dedicated max:1
  // connection for the whole inspect+apply. Deadlock-free: drizzle's migrator
  // takes no advisory lock, and this logical lock doesn't contend with the
  // inspect/migrate connections.
  const lockSql = postgres(url, { max: 1 });
  try {
    await lockSql`SELECT pg_advisory_lock(hashtext('aoa:migrations'))`;

    // Re-inspect under the lock — a peer replica may have migrated while we
    // waited on the lock.
    const stateUnderLock = await inspectMigrations(url);
    if (stateUnderLock.status === "upToDate") return;

    // The backup gate belongs at the shared apply boundary, under the same
    // advisory lock as the migration itself. This covers server auto-apply,
    // pnpm db:migrate, and direct library callers before either migration path
    // can execute 0188. Missing deployment context is deliberately fail-closed
    // for a populated database with 0188 pending.
    await assertMigrationSnapshotGate({
      deploymentMode: options.deploymentMode,
      pendingMigrationTags: stateUnderLock.pendingMigrations,
      queryCompanyCount: () =>
        lockSql.unsafe(`SELECT count(*)::int AS count FROM companies`),
      queryRecordedSnapshots: () =>
        lockSql.unsafe(
          `SELECT general FROM instance_settings WHERE singleton_key = 'default'`,
        ),
    });

    const sql = postgres(url, { max: 1 });
    try {
      const db = drizzlePg(sql);
      await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await sql.end();
    }

    let state = await inspectMigrations(url);
    if (state.status === "upToDate") return;

    const repair = await reconcilePendingMigrationHistory(url);
    if (repair.repairedMigrations.length > 0) {
      state = await inspectMigrations(url);
      if (state.status === "upToDate") return;
    }

    if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
      throw new Error("Migrations are still pending after attempted apply; run inspectMigrations for details.");
    }

    await applyPendingMigrationsManually(url, state.pendingMigrations);

    const finalState = await inspectMigrations(url);
    if (finalState.status !== "upToDate") {
      throw new Error(
        `Failed to apply pending migrations: ${finalState.pendingMigrations.join(", ")}`,
      );
    }
  } finally {
    // Every return after acquiring the lock is inside this try, so the finally
    // always runs. Session end releases the advisory lock anyway, so an unlock
    // failure is non-fatal.
    try {
      await lockSql`SELECT pg_advisory_unlock(hashtext('aoa:migrations'))`;
    } catch {
      /* lock is released on session end below */
    }
    await lockSql.end();
  }
}

export type MigrationBootstrapResult =
  | { migrated: true; reason: "migrated-empty-db"; tableCount: 0 }
  | { migrated: false; reason: "already-migrated"; tableCount: number }
  | { migrated: false; reason: "not-empty-no-migration-journal"; tableCount: number };

export async function migratePostgresIfEmpty(url: string): Promise<MigrationBootstrapResult> {
  const sql = postgres(url, { max: 1 });

  try {
    const migrationTableSchema = await discoverMigrationTableSchema(sql);

    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;

    const tableCount = tableCountResult[0]?.count ?? 0;

    if (migrationTableSchema) {
      return { migrated: false, reason: "already-migrated", tableCount };
    }

    if (tableCount > 0) {
      return { migrated: false, reason: "not-empty-no-migration-journal", tableCount };
    }

    const db = drizzlePg(sql);
    const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
    await migratePg(db, { migrationsFolder });

    return { migrated: true, reason: "migrated-empty-db", tableCount: 0 };
  } finally {
    await sql.end();
  }
}

export async function ensurePostgresDatabase(
  url: string,
  databaseName: string,
): Promise<"created" | "exists"> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe database name: ${databaseName}`);
  }

  const sql = postgres(url, { max: 1 });
  try {
    const existing = await sql<{ one: number }[]>`
      select 1 as one from pg_database where datname = ${databaseName} limit 1
    `;
    if (existing.length > 0) return "exists";

    await sql.unsafe(`create database "${databaseName}"`);
    return "created";
  } finally {
    await sql.end();
  }
}

export type Db = ReturnType<typeof createDb>;
