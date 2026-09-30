// -----------------------------------------------------------------------------
// DEP-011 Slice 2a — the NULL-OBJECT SandboxProvider.
//
// The supervisor's per-run authorities are built at `buildRun` (before the lease's
// capability exists) and REBUILT over the real per-run networked driver AFTER
// redemption (§2a.3). "Unset" authorities NPE — every abnormal exit
// (`accept`-finally `withdraw`, `escalateCleanup`'s `withdraw`/`list`) dereferences
// them UNCONDITIONALLY, and a concurrent cancel during the `await
// materializeRunSecrets` window reaches `escalateCleanup` with no try/catch.
//
// So the networked branch builds its authorities over THIS no-op provider at
// `buildRun`: `list` → empty (so `escalateCleanup` finds nothing → stays retryable,
// never converges), and every EFFECTFUL op THROWS (they must never be reached on the
// null-object — the real driver replaces it before `create`; a throw makes a wrong
// reach loud rather than a silent no-op). The full port is implemented ("mandatory
// means no absent path", review F5).
// -----------------------------------------------------------------------------

import {
  type ArtifactDigestResult,
  type ArtifactExportMode,
  type ArtifactExportResult,
  type FileStagingMode,
  type StageFilesResult,
  type CheckpointMode,
  type CheckpointResult,
  type CleanupResult,
  type CreateResult,
  type CreateSandboxSpec,
  type ExecuteInput,
  type ExecuteResult,
  type HealthMode,
  type HealthResult,
  type InspectResult,
  type ListInput,
  type ListResult,
  type ProcessHandle,
  type ProcessSignalResult,
  type ProcessStartResult,
  type ProcessStatusResult,
  type ProcessSupervisionMode,
  type ProviderOpContext,
  type ProviderOperation,
  type RestoreResult,
  type SandboxProvider,
  type StopResult,
} from "./provider.js";

/** Raised if an effectful op is EVER reached on the null-object provider — a
 * supervisor bug (the real per-run driver must replace it before any effectful op). */
export class NoopProviderReachedError extends Error {
  constructor(operation: string) {
    super(`null-object provider reached for ${operation} — the per-run driver was not bound`);
    this.name = "NoopProviderReachedError";
  }
}

const CORE_OPS: readonly ProviderOperation[] = [
  "create",
  "execute",
  "cancel",
  "kill",
  "destroy",
  "list",
  "inspect",
  "reconcile_cleanup",
];

/**
 * A SandboxProvider that owns NOTHING: `list` is empty (the only op the null-object
 * authorities legitimately reach — `escalateCleanup`'s discovery `list`), and every
 * other op THROWS `NoopProviderReachedError`. It never touches a network or a sandbox.
 */
export function createNoopProvider(): SandboxProvider {
  const checkpointMode: CheckpointMode = "none";
  const healthMode: HealthMode = "none";
  const artifactExportMode: ArtifactExportMode = "none";
  const fileStagingMode: FileStagingMode = "none";
  // SVC-008a — the null object supervises nothing, and says so. The trio below THROWS
  // rather than returning an `unknown` observation: an unsupported capability must never
  // be called again, while a returned `unknown` means "escalate and retry" — one value
  // cannot carry both handlings, and a caller that wired up a `"none"` provider by mistake
  // would emit an escalation storm instead of failing at the first call.
  const processSupervisionMode: ProcessSupervisionMode = "none";
  return {
    advertisedOperations: new Set<ProviderOperation>(CORE_OPS),
    checkpointMode,
    healthMode,
    artifactExportMode,
    fileStagingMode,
    processSupervisionMode,
    create(_spec: CreateSandboxSpec, _ctx: ProviderOpContext): Promise<CreateResult> {
      throw new NoopProviderReachedError("create");
    },
    execute(_input: ExecuteInput, _ctx: ProviderOpContext): Promise<ExecuteResult> {
      throw new NoopProviderReachedError("execute");
    },
    cancel(_sandboxId: string, _ctx: ProviderOpContext): Promise<StopResult> {
      throw new NoopProviderReachedError("cancel");
    },
    kill(_sandboxId: string, _ctx: ProviderOpContext): Promise<StopResult> {
      throw new NoopProviderReachedError("kill");
    },
    destroy(_sandboxId: string, _ctx: ProviderOpContext): Promise<CleanupResult> {
      throw new NoopProviderReachedError("destroy");
    },
    // The ONE op the null-object authorities legitimately reach: `escalateCleanup`'s
    // discovery `list` when no sandbox exists yet. Empty ⇒ nothing to reclaim ⇒ the run
    // stays retryable, never converges over the null-object.
    list(_input: ListInput, _ctx: ProviderOpContext): Promise<ListResult> {
      return Promise.resolve({ providerOpId: "noop-list", resources: [], nextPageToken: null });
    },
    inspect(_sandboxId: string, _ctx: ProviderOpContext): Promise<InspectResult> {
      throw new NoopProviderReachedError("inspect");
    },
    reconcileCleanup(_sandboxId: string, _ctx: ProviderOpContext): Promise<CleanupResult> {
      throw new NoopProviderReachedError("reconcile_cleanup");
    },
    checkpoint(_sandboxId: string, _ctx: ProviderOpContext): Promise<CheckpointResult> {
      throw new NoopProviderReachedError("checkpoint");
    },
    restore(_sandboxId: string, _ctx: ProviderOpContext): Promise<RestoreResult> {
      throw new NoopProviderReachedError("restore");
    },
    health(_sandboxId: string, _ctx: ProviderOpContext): Promise<HealthResult> {
      throw new NoopProviderReachedError("health");
    },
    digestArtifact(_sandboxId: string, _path: string, _ctx: ProviderOpContext): Promise<ArtifactDigestResult> {
      throw new NoopProviderReachedError("digest_artifact");
    },
    exportArtifact(): Promise<ArtifactExportResult> {
      throw new NoopProviderReachedError("export_artifact");
    },
    stageFiles(): Promise<StageFilesResult> {
      throw new NoopProviderReachedError("stage_files");
    },
    startProcess(_input: ExecuteInput, _ctx: ProviderOpContext): Promise<ProcessStartResult> {
      throw new NoopProviderReachedError("start_process");
    },
    processStatus(_sandboxId: string, _handle: ProcessHandle, _ctx: ProviderOpContext): Promise<ProcessStatusResult> {
      throw new NoopProviderReachedError("process_status");
    },
    signalProcess(
      _sandboxId: string,
      _handle: ProcessHandle,
      _kind: "cancel" | "kill",
      _ctx: ProviderOpContext,
    ): Promise<ProcessSignalResult> {
      throw new NoopProviderReachedError("signal_process");
    },
  };
}
