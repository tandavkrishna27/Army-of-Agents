export {
  createDb,
  createTenantAppDb,
  createTenantAppDbConnection,
  createOperatorDbConnection,
  assertNonOwnerConnection,
  assertPrimaryDbBypassesRls,
  rlsBypassRefusal,
  type NonOwnerDbConnection,
  type NonOwnerDbConnectionOptions,
  loadRequiredMigrationIdentity,
  type RequiredMigrationIdentity,
  loadAppliedMigrationIdentity,
  type AppliedMigrationIdentity,
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
  runDatabaseRestore,
  formatDatabaseBackupResult,
  pruneOldBackups,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-lib.js";
export * from "./schema/index.js";
// TEN-003: the tenant repository factory is the only sanctioned reader/writer of
// the new-path tables; re-exported from the package barrel so the server's
// `runInTenant` (server/src/db/tenant-context.ts) imports it as a bare specifier
// alongside `createTenantAppDb`/`Db`. The factory's OWN module surface is still the
// single `tenantRepositories` export (tenant-repository-surface.test.ts) — this
// re-export does not add a raw unscoped reader.
export { tenantRepositories, type TenantRepositories } from "./repositories/tenant/index.js";
export type {
  LeaseWorkerAuthority,
  PlacementCandidateSnapshot,
  TerminalCompletionStatus,
  ServiceHealthStatus,
  GuardedFenceResult,
  AcceptEventInput,
  AcceptEventBatchInput,
  EventIngestOutcome,
  ProjectionInput,
  ProjectionTransition,
  // SVC-003 — the decided service-instance projection and its per-event outcome.
  ServiceInstanceProjectionInput,
  ServiceProjectionOutcome,
  // SVC-003b — the liveness sweep's row shape and its result.
  ServiceInstanceLivenessRow,
  ServiceInstanceLivenessSweepResult,
  JobControlCommandKind,
  GovernedProjectionKind,
  GovernedProjectionInput,
  GovernedControlCommandInput,
  GovernedProjectionRecordResult,
  GovernedControlQueueResult,
  ControlCommandAckStatus,
  QueuedControlCommand,
  ControlCommandAckInput,
  ControlCommandAckOutcome,
  RequestCancellationInput,
  CancellationStatus,
  CancellationOutcome,
  RetryAllocationInput,
  RetryAllocationStatus,
  RetryAllocationResult,
  ReapExpiredLeasesInput,
  ReapExpiredLeasesResult,
  PatchApplyStateResult,
  AuthorizedSecretResolution,
} from "./repositories/tenant/job-control.js";
export { computeRetryBackoffMs } from "./repositories/tenant/job-control.js";
// SVC-005a — WHO drove a service instance terminal. Exported from the barrel because the
// generation rollout fence in `server/src/services/service-generation-rollout.ts` classifies
// against these, and because the set-EQUALITY reconciliation against migration 0279's CHECK
// is asserted server-side (the same pattern SVC-001 used for the status CHECK).
export {
  SERVICE_INSTANCE_TERMINAL_AUTHORS,
  WITNESSED_SERVICE_INSTANCE_TERMINAL_AUTHORS,
  type ServiceInstanceTerminalAuthor,
} from "./repositories/tenant/job-control.js";
// DEP-011 reaper Slice B (B1) — the read-only lease-truth classification surface.
export { classifyLeaseTruthRow, type LeaseTruthVerdict, type LeaseTruthRow } from "./repositories/tenant/lease-truth.js";
// JOB-004: the ONE common active-fence predicate + the CLOSED governed-mutator
// surface. Re-exported from the barrel so `server/src/services/job-fencing.ts`
// shares the exact same seam the tenant repository's guarded mutators gate on.
export {
  isActiveFence,
  classifyFence,
  JobFenceError,
  ArtifactCommitRejection,
  PatchApplyRejection,
  OrphanQuarantineRejection,
  SecretResolveRejection,
  authorizeSecretResolve,
  SECRET_REF_KINDS,
  MEMBERSHIP_CAPABLE_OWNER_KINDS,
  SECRET_RESOLVE_REJECTION_REASONS,
  GUARDED_JOB_MUTATORS,
  TERMINAL_ATTEMPT_STATUSES,
  type ActiveFenceRequest,
  type ActiveFenceSnapshot,
  type GuardedJobMutator,
  type JobFenceErrorCode,
  type ArtifactCommitRejectionReason,
  type PatchApplyRejectionReason,
  type OrphanQuarantineRejectionReason,
  type SecretResolveRejectionReason,
  type SecretResolveDecision,
  type SecretResolveAuthzInput,
  type SecretResolveHandleFacts,
  type SecretResolveJobOwner,
  type SecretRefKind,
} from "./repositories/tenant/job-fence.js";
export { operatorWorkerEnrollmentRepository } from "./repositories/operator/worker-enrollment.js";
export { listPlatformPlacementCandidateSnapshots } from "./repositories/operator/job-placement.js";
export {
  configurePlatformTargetAuthorityLockTimeout,
  acquirePlatformTargetAuthorityShared,
  acquirePlatformTargetAuthorityExclusive,
} from "./platform-target-authority-lock.js";
export {
  operatorJobLeasingRepository,
  type PlatformPhysicalLeaseAuthority,
} from "./repositories/operator/job-leasing.js";
