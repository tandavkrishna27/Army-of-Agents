export {
  createDb,
  ensurePostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  type ApplyPendingMigrationsOptions,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export {
  assertMigrationSnapshotGate,
  isUndefinedTableError,
  readCompanyCountForSnapshotGate,
  readRecordedSnapshotsForSnapshotGate,
  shouldBlockForMissingSnapshot,
  SnapshotGateError,
  type AssertMigrationSnapshotGateInput,
  type MigrationGateDeploymentMode,
  type SnapshotGateInput,
} from "./migration-snapshot-gate.js";
export {
  runDatabaseBackup,
  formatDatabaseBackupResult,
  pruneOldBackups,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
} from "./backup-lib.js";
export * from "./schema/index.js";
