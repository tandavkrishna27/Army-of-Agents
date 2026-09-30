/**
 * `SandboxProvider` driver port + result/label/authority types (WRK-004).
 *
 * This is the provider-neutral driver interface the supervisor programs against.
 * It is deliberately the SECURITY CORE of the worker: the tenant command runs
 * INSIDE a provider sandbox (`execute`), never as a child of the worker process,
 * and every op is mediated by an effect- or cleanup-authority (see
 * `effect-authority.ts` / `cleanup-authority.ts`).
 *
 * E4-F003 (choice): the port TYPES are EXPORTED from `@armyofagents/worker-daemon`
 * (via `index.ts`) so a future `@armyofagents/sandbox-fake-provider` (DEP-000)
 * can `implements SandboxProvider` without copying the shape. The port stays
 * authoritative HERE in worker-daemon (it is not relocated to a shared leaf) —
 * DEP-000 depends on worker-daemon for it. Mirror in E6-F004.
 *
 * E4-F002 (choice): the interface is TRANSPORT-AGNOSTIC. CORE binds ONLY the
 * in-process `createFakeSandboxProvider` double. A `SandboxProvider` is a plain
 * async method surface with no wire/serialization assumptions, so a networked
 * worker→provider driver can bind it later WITHOUT changing this port. That
 * networked driver + its wire is a NON-GOAL of WRK-004 CORE; it is the
 * containerized half of E6-F003, deferred by DEP-010 and owned by DEP-011.
 *
 * DEP-010 (Sprint 2, decision D1): this per-op `SandboxProvider` is THE
 * authoritative provider port of record — the port the security core speaks and
 * the only one the sole real implementation (`E2bSandboxProvider`) implements —
 * enforced in the findings register (E6-F008 resolved). The contract package's
 * `SandboxProviderDriver` is NOT authoritative and NOT retired: it is a
 * conformance-harness surface only (D2), reached FROM this port through the
 * shipped `perOpToInvokeDriver` adapter
 * (`packages/sandbox-e2b-provider/src/per-op-adapter.ts`), never the reverse.
 *
 * Runtime imports: `@armyofagents/worker-protocol` (the frozen op vocabulary) +
 * `node:crypto` (label hashing) only — the E4-D01 boundary.
 */

import { createHash } from "node:crypto";

import {
  CHECKPOINT_MODES,
  HEALTH_MODES,
  PROVIDER_OPERATIONS,
  type ProviderOperation,
  // DAT-009 slice 1 — the grant the provider redeems. From the FROZEN package, which E4-D01
  // permits worker-daemon to import; no new dependency is introduced.
  type ArtifactUploadGrantV1,
  // CLI-008 Unit B — the INBOUND counterpart. Same frozen package, same permission; the
  // download grant is a bearer capability exactly as the upload grant is.
  type ArtifactDownloadGrantV1,
} from "@armyofagents/worker-protocol";

export type { ProviderOperation };
export { PROVIDER_OPERATIONS };

/** Optional-op modes negotiated with the provider (frozen vocabulary). */
export type CheckpointMode = (typeof CHECKPOINT_MODES)[number];
export type HealthMode = (typeof HEALTH_MODES)[number];

/**
 * DAT-009 slice 1 — whether this provider can export an in-sandbox file to object storage
 * under a worker-minted grant.
 *
 * ★ DEFINED LOCALLY ON PURPOSE. `CHECKPOINT_MODES`/`HEALTH_MODES` come from the FROZEN
 * worker-protocol, and this mode deliberately does NOT join them: it must not enter the frozen
 * `registeredTargetProfileV1Schema`, because adding a value there would be an E4-D02 STOP that
 * the byte-egress decision established is unnecessary.
 *
 * It answers a purely LOCAL question — "can THIS provider export?". The separate, server-side
 * question — "should placement route this job here?" — is answered by the frozen
 * `artifact.direct_upload` capability in the target's `capabilityCeiling`. Two layers, two
 * mechanisms; do not collapse them.
 */
export type ArtifactExportMode = "none" | "grant_upload";

/** Metadata ONLY. There is deliberately no content field: the digest step DESCRIBES the file,
 * the export step MOVES it provider -> object storage, and neither hands bytes to the daemon.
 * That is what keeps this port's no-bytes property true. */
export interface ArtifactDigestResult {
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** A REFERENCE to what was exported — never the bytes. */
export interface ArtifactExportResult {
  readonly objectKey: string;
}

/**
 * CLI-008 Unit B — whether this provider can stage control-plane-authored files INTO a
 * sandbox by redeeming a worker-minted download grant.
 *
 * ★ DEFINED LOCALLY, for the same reason `ArtifactExportMode` is (see above): it must not
 * enter the FROZEN `PROVIDER_OPERATIONS` vocabulary, which `advertisedOperations` is typed
 * to. It answers the LOCAL question "can THIS provider stage?"; whether a job should be
 * routed somewhere that can is a separate, server-side question.
 *
 * Measured cost of doing it the other way instead: adding a `stage_files` operation to
 * `OPTIONAL_PROVIDER_OPERATIONS` reds 1 of 289 worker-protocol tests and to
 * `CORE_PROVIDER_OPERATIONS` reds 27 — but the cheap number is the misleading one, because
 * the conformance suite iterates the optional set exhaustively and the fake driver defaults
 * its advertised optional set to ALL of them, so a fourth optional op is auto-advertised by
 * a driver that cannot serve it.
 */
export type FileStagingMode = "none" | "grant_download";

/**
 * One file to stage: WHERE it goes inside the sandbox, and a GRANT that redeems to its bytes.
 *
 * ★ A GRANT, NOT BYTES. A bytes-shaped signature would route payloads through a daemon that
 * is dependency-pinned (E4-D01) precisely so it does not handle them — the exact inversion of
 * `exportArtifact`, which takes an upload grant and returns a reference. `sha256` and
 * `sizeBytes` ride on the grant itself (`expectedSha256`, `maxBytes`), so the provider can
 * verify what it fetched before it writes it.
 */
export interface StagedFileRequest {
  /** The ABSOLUTE in-sandbox path to write. */
  readonly path: string;
  /**
   * ★ THIS IS A BEARER CAPABILITY — anyone holding it can read that object key until it
   * expires. The same rule `exportArtifact`'s grant carries applies here: an implementation
   * must never let it reach a projection, a log line, or an error.
   */
  readonly grant: ArtifactDownloadGrantV1;
}

/** What was staged — paths only. No bytes, and never the grants. */
export interface StageFilesResult {
  readonly stagedPaths: readonly string[];
}

// -----------------------------------------------------------------------------
// SVC-008a — optional PROCESS SUPERVISION (gated on `processSupervisionMode`).
//
// NOT in `advertisedOperations`, for the same reason the export pair and `stageFiles`
// are not: that set is typed to the FROZEN `ProviderOperation` union and these are not
// frozen operations. Support is declared by the mode below. The METHODS are present on
// every implementer and only SUPPORT is optional — "mandatory means no absent path".
//
// ★★★ THE ONE RULE. A value returned by this trio may assert ONLY what the
// implementation actually WITNESSED. The way to enforce that in a type system is to
// make "I witnessed nothing" a representable value, so no implementation is ever
// cornered into an affirmative one. `StopOutcome` below has no such inhabitant, which
// is why `RealE2bTransport.signal` returned `{delivered:true}` from its own catch
// (E7-F034): the lie was not a slip, the type made it mandatory.
// -----------------------------------------------------------------------------

/**
 * Whether this provider can launch a process it can later observe and signal.
 *
 * ★ DEFINED LOCALLY ON PURPOSE, exactly like {@link ArtifactExportMode} and
 * {@link FileStagingMode} above: entering the frozen `ProviderOperation` vocabulary
 * would be an E4-D02 STOP, and this answers the purely LOCAL question "can THIS
 * provider supervise a process?".
 */
export type ProcessSupervisionMode = "none" | "handle";

/**
 * An opaque, PROVIDER-MINTED process handle. Never parsed by a caller, never logged
 * unredacted, and never empty — see {@link ProcessStartResult.handle}.
 */
export type ProcessHandle = string;

/**
 * WHAT THE PROVIDER SAW. Not what it did, not what it hoped.
 *
 * The `unknown` arm is the whole point of this type: an implementation that could not
 * observe anything returns it rather than picking an affirmative claim. It carries no
 * `observedAt` because there is no successful read to timestamp.
 */
export type ProcessObservation =
  | { readonly state: "running"; readonly observedAt: number }
  | {
      readonly state: "exited";
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly observedAt: number;
    }
  | { readonly state: "gone"; readonly observedAt: number }
  | { readonly state: "unknown"; readonly reason: ProcessUnknownReason };

/**
 * EVERY member names a read that was ATTEMPTED and did not answer. Nothing here names
 * a call that was never made — a provider that does not supervise processes THROWS
 * (see {@link SandboxProvider.startProcess}); it does not return an observation. A
 * failed read must be escalated and retried; an unsupported capability must never be
 * called again, and one value cannot carry two incompatible handlings.
 */
export type ProcessUnknownReason =
  /** The status read itself threw. */
  | "read_failed"
  /** The sandbox could not be described. */
  | "sandbox_unreachable"
  /** The provider does not recognize this handle. */
  | "handle_unrecognized"
  /** ★ The read ANSWERED, and its answer named no state this implementation recognizes. */
  | "state_unrecognized";

export interface ProcessStartResult {
  readonly providerOpId: string;
  /**
   * ★ PRESENCE IS THE ACKNOWLEDGEMENT, and it is NON-EMPTY BY CONTRACT.
   *
   * There is deliberately no `started: boolean` — a boolean lets an implementation
   * return `false` and a caller read it as "started, sort of". Absence of a handle is
   * a {@link ProcessLaunchNotAcknowledged} throw, never a returned value.
   *
   * The non-emptiness clause is not a nicety: this tree's idiom for minting an id from
   * an SDK response is `String(x ?? "")` (`real-transport.ts` `create`/`toRecord`), and
   * an empty string IS present. An implementation written in that idiom would
   * acknowledge a launch it did not witness. A response from which no non-empty handle
   * can be read is a THROW.
   */
  readonly handle: ProcessHandle;
  readonly acknowledgedAt: number;
}

export interface ProcessStatusResult {
  readonly providerOpId: string;
  readonly observation: ProcessObservation;
}

export interface ProcessSignalResult {
  readonly providerOpId: string;
  /**
   * About the CALL only. There is deliberately NO `outcome: "stopped"` here — the word
   * "stopped" is absent from this type, so `accepted` is structurally incapable of
   * being laundered into a claim about the process. The stop verdict is derived by the
   * caller from `observation`, and only from `observation`.
   *
   * ★ `"unsupported"` means THIS SIGNAL KIND is not deliverable on a provider that DOES
   * supervise processes. It does NOT mean `processSupervisionMode === "none"`; that case
   * throws and never returns.
   */
  readonly accepted: "accepted" | "refused" | "unsupported";
  /** About the PROCESS, and obtained by RE-READING — never by asserting. */
  readonly observation: ProcessObservation;
}

/** Lifecycle state of a provider sandbox resource. */
export const SANDBOX_STATES = [
  "creating",
  "running",
  "cancelling",
  "stopped",
  "destroyed",
  "failed",
] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

/** `destroy`/`reconcile_cleanup` terminal disposition. */
export type CleanupStatus = "success" | "failed";

/** `cancel`/`kill` disposition: `stopped` ends the process tree; `ignored`
 * means the sandbox did not comply and the supervisor must escalate. */
export type StopOutcome = "stopped" | "ignored";

// -----------------------------------------------------------------------------
// Ownership labels + selectors
// -----------------------------------------------------------------------------

/**
 * The ownership/identity labels stamped on every provider resource. The cleanup
 * authority binds to the FULL tuple + `deviceGeneration` (its `targetGeneration`);
 * reconcile scopes by the coarser `OwnershipSelector`. These are management
 * metadata (never customer data) — but they are HASHED before entering any log,
 * cleanup record, or metric (`hashResourceLabels`).
 */
export interface ResourceLabels {
  readonly organizationId: string;
  readonly targetId: string;
  readonly workerId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseId: string;
  readonly deviceGeneration: number;
}

/** The coarse (org, target, worker) scope reconcile lists resources under. */
export interface OwnershipSelector {
  readonly organizationId: string;
  readonly targetId: string;
  readonly workerId: string;
}

/** Structural, order-independent equality of two label tuples. */
export function labelsEqual(a: ResourceLabels, b: ResourceLabels): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.targetId === b.targetId &&
    a.workerId === b.workerId &&
    a.jobId === b.jobId &&
    a.attempt === b.attempt &&
    a.leaseId === b.leaseId &&
    a.deviceGeneration === b.deviceGeneration
  );
}

/** True iff `labels` fall under the coarse ownership `selector`. */
export function labelsMatchSelector(labels: ResourceLabels, selector: OwnershipSelector): boolean {
  return (
    labels.organizationId === selector.organizationId &&
    labels.targetId === selector.targetId &&
    labels.workerId === selector.workerId
  );
}

/**
 * A stable lowercase-hex SHA-256 over the canonical ordering of the ownership
 * labels — the ONLY form of the labels that may appear in a log line, cleanup
 * record, or (were it ever labeled) a metric. Raw label VALUES never leave the
 * supervisor.
 */
export function hashResourceLabels(labels: ResourceLabels): string {
  const canonical = [
    labels.organizationId,
    labels.targetId,
    labels.workerId,
    labels.jobId,
    String(labels.attempt),
    labels.leaseId,
    String(labels.deviceGeneration),
  ].join("\0");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// -----------------------------------------------------------------------------
// Per-op context + typed results
// -----------------------------------------------------------------------------

/**
 * Every provider op carries a wall-clock `deadlineMs` budget and a STABLE
 * `idempotencyKey`. A repeated key returns the recorded result and does not
 * double-apply (lost-response replay).
 */
export interface ProviderOpContext {
  readonly deadlineMs: number;
  readonly idempotencyKey: string;
}

export interface CreateSandboxSpec {
  readonly resourceLabels: ResourceLabels;
  /** The TENANT command — it runs INSIDE the sandbox, never in the worker. */
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly workloadType: string;
}

export interface CreateResult {
  readonly sandboxId: string;
  readonly providerOpId: string;
  readonly resourceLabels: ResourceLabels;
}

export interface ExecuteInput {
  readonly sandboxId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The result of running the tenant command INSIDE the sandbox. `stdoutRef`/
 * `stderrRef` are OPAQUE references — never inline customer bytes (object-byte
 * capture/upload is E5). No stdout/stderr content crosses this boundary.
 */
export interface ExecuteResult {
  readonly providerOpId: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdoutRef: string;
  readonly stderrRef: string;
}

export interface StopResult {
  readonly providerOpId: string;
  readonly outcome: StopOutcome;
}

export interface CleanupResult {
  readonly providerOpId: string;
  readonly cleanupStatus: CleanupStatus;
}

/** A management-safe list row (never customer bytes). `hasLiveLease` lets
 * reconcile spot orphans. */
export interface ResourceSummary {
  readonly sandboxId: string;
  readonly resourceLabels: ResourceLabels;
  readonly generation: number;
  readonly state: SandboxState;
  readonly hasLiveLease: boolean;
}

export interface ListInput {
  readonly ownershipSelector: OwnershipSelector;
  readonly pageSize: number;
  readonly pageToken?: string | null;
}

export interface ListResult {
  readonly providerOpId: string;
  readonly resources: readonly ResourceSummary[];
  readonly nextPageToken: string | null;
}

/**
 * The FULL provider-level inspection. It intentionally carries SENSITIVE fields
 * (`command`/`env`/`logs`/`workspaceBytes`/`objectGrants`/`secrets`) so the
 * cleanup authority's redaction is a real (non-vacuous) projection: cleanup
 * NEVER returns this object — only `RedactedResourceProjection`.
 */
export interface InspectResult {
  readonly providerOpId: string;
  readonly sandboxId: string;
  readonly resourceLabels: ResourceLabels;
  readonly generation: number;
  readonly state: SandboxState;
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logs: readonly string[];
  readonly workspaceBytes: number;
  readonly objectGrants: readonly string[];
  readonly secrets: Readonly<Record<string, string>>;
}

export interface CheckpointResult {
  readonly providerOpId: string;
  readonly mode: CheckpointMode;
  readonly checkpointRef: string;
}

export interface RestoreResult {
  readonly providerOpId: string;
  readonly restored: boolean;
}

export interface HealthResult {
  readonly providerOpId: string;
  readonly mode: HealthMode;
  readonly status: "healthy" | "unhealthy";
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Thrown when an OPTIONAL op (`checkpoint`/`restore`/`health`, or the DAT-009 artifact-export
 * pair) is invoked on a provider that did not advertise it. Failing EXPLICITLY (never guessing)
 * is the point: an unsupported capability is a hard, named error.
 *
 * ★ The parameter is WIDENED beyond the frozen `ProviderOperation` union. `digest_artifact` and
 * `export_artifact` are NOT frozen operations — deliberately, per the byte-egress decision — so
 * a decline for them could not otherwise be expressed. Widening here is additive and local:
 * every existing caller passes a `ProviderOperation`, which still typechecks.
 */
export type DeclinableOperation =
  | ProviderOperation
  | "digest_artifact"
  | "export_artifact"
  | "stage_files"
  // SVC-008a — the process-supervision trio. Not frozen operations, same as the three above.
  | "start_process"
  | "process_status"
  | "signal_process";

export class UnsupportedProviderOperation extends Error {
  readonly operation: DeclinableOperation;
  constructor(operation: DeclinableOperation) {
    super(`provider operation ${operation} is not advertised`);
    this.name = "UnsupportedProviderOperation";
    this.operation = operation;
  }
}

/**
 * Thrown by a provider when a sandbox id is unknown. Cleanup authority MAPS this
 * (and a label mismatch) to the SAME `ResourceNotAvailableError`, so a caller can
 * never use it as an existence oracle.
 */
export class SandboxNotFoundError extends Error {
  constructor() {
    super("sandbox not found");
    this.name = "SandboxNotFoundError";
  }
}

/**
 * SVC-008a §4.2 A-iii — the provider read a resource record whose LIFECYCLE STATE it
 * could not classify. A partial read: neither a lifecycle fact nor an absence.
 *
 * ★ IT IS DELIBERATELY NOT {@link SandboxNotFoundError}. Mapping an unreadable record
 * onto "this sandbox does not exist" would hand the cleanup authority an
 * affirmative-from-nothing, and that one is DESTRUCTIVE in the other direction: a
 * not-found is a CONVERGED SUCCESS that ends the converge on nothing witnessed.
 *
 * ★★★ IT LIVES ON THE PORT, NOT IN THE E2B PACKAGE, AND THAT IS A CORRECTION TO THE
 * DESIGN. SVC-008a §4.2 A-iii ruled that `inspect` must throw and §6 recorded that
 * `CleanupAuthority` needs "None." code change. Those two cannot both hold:
 * `#requireOwned` gates cancel/kill/destroy on `inspect`, and `#convergeOne` catches only
 * `ResourceNotAvailableError` — so an unclassifiable record would propagate out of
 * `converge()` and the UNCONDITIONAL forced `destroy` would never run. That turns a
 * lenient stop verdict into a DISARMED REAPER: strictly worse than E7-F034, which leaked
 * nothing. The authority must therefore be able to RECOGNIZE this condition, which means
 * the class is the port's.
 */
export class SandboxRecordIndeterminateError extends Error {
  readonly sandboxId: string;
  constructor(sandboxId: string) {
    super(`sandbox record state could not be classified for ${sandboxId}`);
    this.name = "SandboxRecordIndeterminateError";
    this.sandboxId = sandboxId;
  }
}

/**
 * SVC-008a — thrown when a launch could not be ACKNOWLEDGED: the provider refused, or
 * its response carried no handle this implementation can read.
 *
 * ★ It exists so {@link ProcessStartResult} needs no `started: boolean` and no
 * empty-string handle. There is no third state for a caller to misread: either a
 * non-empty handle came back, or nothing did and this threw.
 */
export class ProcessLaunchNotAcknowledged extends Error {
  readonly sandboxId: string;
  constructor(sandboxId: string, detail?: string) {
    super(`process launch was not acknowledged for sandbox ${sandboxId}${detail ? `: ${detail}` : ""}`);
    this.name = "ProcessLaunchNotAcknowledged";
    this.sandboxId = sandboxId;
  }
}

/**
 * SVC-008a — THE DERIVED STOP PREDICATE, stated once so no caller re-derives it wrong.
 *
 * ```
 * stopped      iff observation.state is "exited" or "gone"
 * still up     iff observation.state is "running"
 * undetermined iff observation.state is "unknown"   -> ESCALATE, never conclude
 * ```
 *
 * ★ Compare with what this replaces: `cancel` returns `outcome: "stopped"` — an
 * affirmative claim of EFFECT — from a function that read metadata and, on the real
 * transport, from the catch branch where even that read failed (E7-F034). Under this
 * predicate the same implementation yields `undetermined`, which no caller can read as
 * success. That is the entire fix, and it is a type fix, not a courtesy.
 */
export function deriveStopVerdict(observation: ProcessObservation): "stopped" | "still_up" | "undetermined" {
  switch (observation.state) {
    case "exited":
    case "gone":
      return "stopped";
    case "running":
      return "still_up";
    case "unknown":
      return "undetermined";
    default: {
      // A new inhabitant must be RULED ON here, never defaulted — a default branch is
      // exactly how `mapState` laundered an unreadable state into an affirmative stop.
      const exhaustive: never = observation;
      return exhaustive;
    }
  }
}

// -----------------------------------------------------------------------------
// The driver port
// -----------------------------------------------------------------------------

/**
 * The provider-neutral sandbox driver. Eight CORE ops + three OPTIONAL ops. The
 * optional ops throw {@link UnsupportedProviderOperation} unless advertised in
 * `advertisedOperations` (paired with a non-`none` `checkpointMode`/`healthMode`).
 *
 * Transport-agnostic (E4-F002): no method assumes a wire — a network binding can
 * implement this port later without changing it.
 */
export interface SandboxProvider {
  /** The advertised op set (always a superset of the 8 core ops). */
  readonly advertisedOperations: ReadonlySet<ProviderOperation>;
  readonly checkpointMode: CheckpointMode;
  readonly healthMode: HealthMode;

  // --- core ---
  create(spec: CreateSandboxSpec, ctx: ProviderOpContext): Promise<CreateResult>;
  execute(input: ExecuteInput, ctx: ProviderOpContext): Promise<ExecuteResult>;
  cancel(sandboxId: string, ctx: ProviderOpContext): Promise<StopResult>;
  kill(sandboxId: string, ctx: ProviderOpContext): Promise<StopResult>;
  destroy(sandboxId: string, ctx: ProviderOpContext): Promise<CleanupResult>;
  list(input: ListInput, ctx: ProviderOpContext): Promise<ListResult>;
  inspect(sandboxId: string, ctx: ProviderOpContext): Promise<InspectResult>;
  reconcileCleanup(sandboxId: string, ctx: ProviderOpContext): Promise<CleanupResult>;

  // --- optional (gated on advertisement) ---
  checkpoint(sandboxId: string, ctx: ProviderOpContext): Promise<CheckpointResult>;
  restore(sandboxId: string, ctx: ProviderOpContext): Promise<RestoreResult>;
  health(sandboxId: string, ctx: ProviderOpContext): Promise<HealthResult>;

  // --- optional artifact export (gated on `artifactExportMode`) -------------------------
  //
  // NOT in `advertisedOperations`: that set is typed to the FROZEN `ProviderOperation` union
  // and these are not frozen operations. Support is declared by the mode above instead. Like
  // the optional trio, the METHODS are present on every implementer and only SUPPORT is
  // optional — "mandatory means no absent path".

  /** Describe an in-sandbox file. Metadata only; never returns content. */
  digestArtifact(sandboxId: string, path: string, ctx: ProviderOpContext): Promise<ArtifactDigestResult>;

  /**
   * Upload an in-sandbox file directly to object storage under `grant`, returning a reference.
   *
   * ★ `grant` IS A BEARER CAPABILITY — anyone holding it can write that object key until it
   * expires. The port already classifies this class of value as sensitive: `InspectResult`
   * carries `objectGrants` among `command`/`env`/`logs`/`secrets`, and
   * `RedactedResourceProjection` — the only shape cleanup authority ever returns — excludes it.
   * An implementation must never let a grant reach a projection, a log line, or an error.
   */
  exportArtifact(
    sandboxId: string,
    path: string,
    grant: ArtifactUploadGrantV1,
    ctx: ProviderOpContext,
  ): Promise<ArtifactExportResult>;

  /** Whether this provider supports the two operations above. */
  readonly artifactExportMode: ArtifactExportMode;

  // --- optional file staging (gated on `fileStagingMode`) -------------------------------
  //
  // NOT in `advertisedOperations`, for the same reason the export pair is not: that set is
  // typed to the FROZEN `ProviderOperation` union and this is not a frozen operation. Support
  // is declared by the mode below. The METHOD is present on every implementer and only
  // SUPPORT is optional — "mandatory means no absent path".

  /**
   * Write `files` into a live sandbox before the tenant command runs, by redeeming each
   * file's download grant.
   *
   * Grant in, reference out: the bytes go store -> provider -> sandbox and never cross this
   * port. An implementation MUST verify what it fetched against the grant's `expectedSha256`
   * before writing — a provider that wrote unverified bytes would be the WRK-009 defect
   * again, where a fabricated success is byte-identical to a real one on every gate.
   *
   * Throws {@link UnsupportedProviderOperation} when `fileStagingMode` is `"none"`.
   */
  stageFiles(
    sandboxId: string,
    files: readonly StagedFileRequest[],
    ctx: ProviderOpContext,
  ): Promise<StageFilesResult>;

  /** Whether this provider supports the operation above. */
  readonly fileStagingMode: FileStagingMode;

  // --- optional process supervision (gated on `processSupervisionMode`) -----------------
  //
  // NOT in `advertisedOperations`, for the same reason the export pair and stageFiles are
  // not: that set is typed to the FROZEN `ProviderOperation` union. Support is declared by
  // the mode below. The METHODS are present on every implementer and only SUPPORT is
  // optional — "mandatory means no absent path".
  //
  // ★ WHY THIS EXISTS AT ALL. `execute` is a COMPLETION oracle: it resolves only once the
  // command has already exited, so a supervisor built on it records a hung launch as a
  // started instance. `inspect`/`health` answer about the SANDBOX, which is up from the
  // moment `create` resolves. Neither can witness a process.

  /**
   * Launch a process and return as soon as the provider ACKNOWLEDGES it — never waiting
   * for it to exit.
   *
   * ★ It takes {@link ExecuteInput} as the WHOLE request rather than a payload beside a
   * redundant `sandboxId`, so the launch target is single-sourced: a separate parameter
   * would let the validated sandbox and the launched sandbox disagree, and an authority
   * wrapper would then validate one and launch in another.
   *
   * Throws {@link UnsupportedProviderOperation} when `processSupervisionMode` is `"none"`,
   * and {@link ProcessLaunchNotAcknowledged} when no non-empty handle can be read.
   */
  startProcess(input: ExecuteInput, ctx: ProviderOpContext): Promise<ProcessStartResult>;

  /**
   * Read what the provider can SEE of the process behind `handle`. About the PROCESS —
   * never about the sandbox, and never a sandbox-scoped answer relabelled.
   *
   * ★ `gone` may NOT be sourced from a boolean whose `false` branch also swallows an
   * error (`RealE2bTransport.isRunning` is exactly that shape). A failure to look is
   * `{state: "unknown", reason: "read_failed"}`; an ANSWER that the process is absent is
   * `gone`. Collapsing the two reports an affirmative absence from a read that threw.
   *
   * Throws {@link UnsupportedProviderOperation} when `processSupervisionMode` is `"none"`.
   */
  processStatus(
    sandboxId: string,
    handle: ProcessHandle,
    ctx: ProviderOpContext,
  ): Promise<ProcessStatusResult>;

  /**
   * Deliver a graceful-stop or forced-kill signal to the process behind `handle`, then
   * RE-READ its status and report what that read saw.
   *
   * Throws {@link UnsupportedProviderOperation} when `processSupervisionMode` is `"none"`.
   */
  signalProcess(
    sandboxId: string,
    handle: ProcessHandle,
    kind: "cancel" | "kill",
    ctx: ProviderOpContext,
  ): Promise<ProcessSignalResult>;

  /** Whether this provider supports the three operations above. */
  readonly processSupervisionMode: ProcessSupervisionMode;
}

/** A management-only, REDACTED projection of a sandbox: identity + lifecycle
 * state + a HASH of the ownership labels. It carries NO command, env, logs,
 * secrets, workspace/customer bytes, or object grants — the only shape the
 * cleanup authority ever returns from `inspect`/`list`. */
export interface RedactedResourceProjection {
  readonly sandboxId: string;
  readonly resourceLabelsHash: string;
  readonly generation: number;
  readonly state: SandboxState;
  readonly providerOpId: string;
}
