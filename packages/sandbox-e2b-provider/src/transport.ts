// -----------------------------------------------------------------------------
// The injectable E2B transport SEAM (CLI-001/D1).
//
// `E2bTransport` abstracts the small set of `e2b` SDK primitives the real driver
// logic (`E2bSandboxProvider`) needs: create / run-command / signal / terminate /
// get-info / list / set-timeout / pause / resume / is-running. The provider is
// programmed AGAINST this interface, never the concrete SDK, so a test can inject
// a deterministic, key-less, pure-TS double (`mock-transport.ts`) and exercise the
// REAL driver logic; the real binding (`real-transport.ts`) wraps the `e2b` SDK.
//
// The seam is deliberately provider-shaped-but-neutral: it carries an opaque
// `metadata` bag (a `Record<string,string>` the provider round-trips) and returns
// primitive lifecycle facts. Transport-level faults surface as the two transport
// error classes below (a transient teardown failure and a blocked-egress refusal),
// which the provider translates into the domain outcomes/denials the conformance
// suites assert. The transport itself makes NO authority decision.
// -----------------------------------------------------------------------------

/**
 * The lifecycle state a transport reports for a sandbox record.
 *
 * ★ SVC-008a §4.2 A-i — `"unknown"` means the transport got an answer it CANNOT
 * CLASSIFY, or no answer at all, for THIS field. It is not a lifecycle state; it is the
 * ABSENCE of one, and it exists so no parser is ever cornered into inventing a lifecycle.
 *
 * Before this inhabitant existed, `mapState` (`real-transport.ts`) fell through to
 * `"stopped"` for an absent, renamed or non-string state field — so an SDK field rename,
 * a partial/error-shaped response body, or a future `"hibernated"` was laundered into an
 * affirmative stop. That is E7-F034's exact class, one layer below where the finding
 * looked. `E2bRecordState` is LOCAL to this package: it is not `SANDBOX_STATES`, not
 * `StopOutcome`, and nothing under `packages/worker-protocol/`, so widening it touches no
 * frozen surface.
 */
export type E2bRecordState = "running" | "paused" | "stopped" | "unknown";

/** An opaque provider-owned record. `metadata` is round-tripped verbatim — the
 * provider stores its (management) labels + any test fault directives there; the
 * transport treats it as an opaque blob and never interprets it as authority. */
export interface E2bSandboxRecord {
  readonly sandboxId: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly state: E2bRecordState;
}

/** The primitive result of running a command inside a sandbox. `exitCode` is the
 * process exit status (`null` when it was signalled); `timedOut` marks a deadline
 * hit; `crashed` marks an abnormal (non-timeout) failure the provider maps to a
 * `failed` terminal. Egress refusals are raised, not returned (see below). */
export interface E2bCommandResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly crashed: boolean;
}

/**
 * What the transport OBSERVED after a cancel/kill signal attempt — never what it
 * assumed, and never what it merely requested.
 *
 * ★ SVC-008a §4.2 A-ii. This replaces `delivered: boolean`, which had no inhabitant for
 * "I witnessed nothing" and so forced `RealE2bTransport.signal` to return an affirmative
 * `{delivered: true}` from its own `catch` (E7-F034). The provider maps `"stopped"` to
 * `StopOutcome.stopped` and BOTH other values to `"ignored"` — mapping an indeterminate
 * read onto the ESCALATING value is fail-safe; mapping it onto the terminating value is
 * the defect.
 */
export interface E2bSignalResult {
  readonly observed: "stopped" | "still_running" | "unknown";
}

/** A page of records from `list`. */
export interface E2bListPage {
  readonly items: readonly E2bSandboxRecord[];
  readonly nextPageToken: string | null;
}

// --- Transport-level errors (never authority) --------------------------------

/** The transport could not confirm a sandbox exists. The provider maps this to
 * the domain `SandboxNotFoundError` (which the cleanup authority further collapses
 * into the uniform, oracle-free `ResourceNotAvailableError`). */
export class E2bTransportNotFoundError extends Error {
  constructor(sandboxId: string) {
    super(`e2b transport: sandbox not found: ${sandboxId}`);
    this.name = "E2bTransportNotFoundError";
  }
}

/** A transient teardown failure (the E2B control API rejected a terminate). The
 * provider maps this to a REPORTED `CleanupResult{cleanupStatus:"failed"}` — never
 * a throw — so the monotonic cleanup convergence can retry it idempotently. */
export class E2bTransportTransientError extends Error {
  constructor(message = "e2b transport: transient teardown failure") {
    super(message);
    this.name = "E2bTransportTransientError";
  }
}

/** The sandbox network fence refused an egress attempt carrying its frozen
 * destination class. The provider re-raises this as the domain
 * `SandboxEgressDeniedError` carrying the same class. */
export class E2bTransportEgressBlockedError extends Error {
  readonly destinationClass: string;
  constructor(destinationClass: string) {
    super(`e2b transport: egress blocked: ${destinationClass}`);
    this.name = "E2bTransportEgressBlockedError";
    this.destinationClass = destinationClass;
  }
}

// --- The seam ----------------------------------------------------------------

export interface E2bCreateRequest {
  readonly templateId: string;
  readonly timeoutMs: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly envVars: Readonly<Record<string, string>>;
}

export interface E2bRunCommandRequest {
  readonly sandboxId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly envVars: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/**
 * CLI-003/D1 — optional streaming callbacks for a `runCommand`. A coding run's
 * stdout/stderr is delivered chunk-by-chunk as it is produced so the caller can turn
 * it into durable `log` events. Callbacks are BEST-EFFORT observation only: they
 * carry NO authority and never change the `E2bCommandResult` (whose shape is
 * unchanged). Absent handlers = the pre-CLI-003 behaviour (no streaming). The real
 * binding wires the `e2b` SDK command stream; the mock replays deterministic chunks
 * from the reserved `__aoa_stream_chunks` directive.
 */
export interface E2bStreamHandlers {
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface E2bListRequest {
  readonly pageSize: number;
  readonly pageToken?: string | null;
}

/** A file to stage into a sandbox: an absolute in-sandbox path + its raw bytes.
 * CLI-002/D1 — the ONLY primitive that puts host-assembled bytes (the declared
 * snapshot, the actor-gated `## Context` block, approved runtime inputs) into a
 * sandbox. Provider-neutral: no tenant/E2B field, just path + bytes. */
export interface E2bStagedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

// --- SVC-008a: process supervision at the transport scope --------------------
//
// `runCommand` is a COMPLETION oracle — it resolves only once the command has exited
// (this file's own `real-transport.ts` comment records, from real E2B run 33789547290,
// that `sandbox.commands.run()` is `start()` then `CommandHandle.wait()`). A supervisor
// built on it records a hung launch as a started instance. `getInfo`/`isRunning` answer
// about the SANDBOX, which is up from the moment `create` resolves. The trio below is the
// missing scope: a launch you can witness, a status you can read, and a stop that cannot
// lie about what it saw.

/** Whether this transport can launch a process it can later observe and signal. */
export type E2bProcessSupervisionMode = "none" | "handle";

/** An opaque, TRANSPORT-MINTED process handle. Never empty — see {@link E2bProcessStartResult}. */
export type E2bProcessHandle = string;

/**
 * WHAT THE TRANSPORT SAW. `"unknown"` is not a lifecycle state; it is the absence of one,
 * and its `reason` names a read that was ATTEMPTED and did not answer.
 */
export type E2bProcessObservation =
  | { readonly state: "running" }
  | { readonly state: "exited"; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly state: "gone" }
  | {
      readonly state: "unknown";
      readonly reason: "read_failed" | "sandbox_unreachable" | "handle_unrecognized" | "state_unrecognized";
    };

export interface E2bProcessStartResult {
  /** ★ NON-EMPTY BY CONTRACT — presence is the acknowledgement, so "present" must not be
   * satisfiable by a value that means nothing. A launch response from which no non-empty
   * handle can be read is an {@link E2bProcessLaunchNotAcknowledgedError}, never `""`. */
  readonly handle: E2bProcessHandle;
}

export interface E2bProcessSignalResult {
  /** About the CALL only. There is deliberately no member naming a process outcome. */
  readonly accepted: "accepted" | "refused" | "unsupported";
  /** About the PROCESS, obtained by RE-READING after the attempt. */
  readonly observation: E2bProcessObservation;
}

export interface E2bStartProcessRequest {
  readonly sandboxId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly envVars: Readonly<Record<string, string>>;
  /** The sandbox-side command budget, forwarded to the provider. */
  readonly timeoutMs: number;
}

/** The transport could not ACKNOWLEDGE a launch: the provider refused, or its response
 * carried no handle this binding can read. The provider maps it to the domain
 * `ProcessLaunchNotAcknowledged`. */
export class E2bProcessLaunchNotAcknowledgedError extends Error {
  readonly sandboxId: string;
  constructor(sandboxId: string, detail?: string) {
    super(`e2b transport: process launch not acknowledged for ${sandboxId}${detail ? `: ${detail}` : ""}`);
    this.name = "E2bProcessLaunchNotAcknowledgedError";
    this.sandboxId = sandboxId;
  }
}

/**
 * The injectable E2B transport. Optional capabilities (`pause`/`resume`) may be
 * absent — the provider gates the optional `checkpoint`/`restore` ops on their
 * presence AND on its own advertisement.
 */
export interface E2bTransport {
  create(req: E2bCreateRequest): Promise<{ readonly sandboxId: string }>;
  /** Run a command inside the sandbox. `handlers` (CLI-003/D1) optionally receive
   * stdout/stderr chunks as they are produced — best-effort observation that never
   * alters the returned {@link E2bCommandResult}. */
  runCommand(req: E2bRunCommandRequest, handlers?: E2bStreamHandlers): Promise<E2bCommandResult>;
  /**
   * CLI-002/D1 — stage `files` (declared snapshot + `## Context` bundle + approved
   * inputs) into a live sandbox before execution. The real binding uses the `e2b`
   * SDK filesystem API; the mock models an in-memory fs so staging + a fake CLI's
   * file mutation are no-key-testable. An unknown sandbox throws
   * {@link E2bTransportNotFoundError}. It carries NO tenant field (CAV-002).
   */
  writeFiles(sandboxId: string, files: readonly E2bStagedFile[]): Promise<void>;
  /** CLI-002/D1 — read a staged/mutated file's bytes back (assertions + result
   * collection). Missing sandbox OR path throws {@link E2bTransportNotFoundError}. */
  readFile(sandboxId: string, path: string): Promise<Uint8Array>;
  /** CLI-002/D1 — enumerate the absolute paths of files under a directory prefix
   * (assertions). Missing sandbox throws {@link E2bTransportNotFoundError}. */
  listDir(sandboxId: string, path: string): Promise<readonly string[]>;
  /** Deliver a graceful-cancel or forced-kill signal to a live sandbox. */
  signal(sandboxId: string, kind: "cancel" | "kill"): Promise<E2bSignalResult>;
  /** Terminate + reclaim a sandbox. May throw {@link E2bTransportTransientError}. */
  terminate(sandboxId: string): Promise<void>;
  getInfo(sandboxId: string): Promise<E2bSandboxRecord>;
  list(req: E2bListRequest): Promise<E2bListPage>;
  setTimeout(sandboxId: string, timeoutMs: number): Promise<void>;
  isRunning(sandboxId: string): Promise<boolean>;

  // --- SVC-008a process supervision (MANDATORY methods, optional SUPPORT) ------
  //
  // "Mandatory means no absent path": every transport implements all three, and only
  // `processSupervisionMode` says whether they do anything. A `"none"` transport THROWS
  // `UnsupportedProviderOperation` (via the provider) rather than returning an `unknown`
  // observation — an unsupported capability must never be called again, while an
  // `unknown` means "escalate and retry", and one value cannot carry both handlings.

  /** Whether the three methods below are supported. */
  readonly processSupervisionMode: E2bProcessSupervisionMode;
  /** Launch a DETACHED process and return as soon as the provider acknowledges a handle.
   * Never waits for the process to exit. Throws
   * {@link E2bProcessLaunchNotAcknowledgedError} when no non-empty handle can be read. */
  startProcess(req: E2bStartProcessRequest): Promise<E2bProcessStartResult>;
  /** Read what the transport can SEE of the process behind `handle`. A read that THREW is
   * `{state: "unknown"}`; an ANSWER that the process is absent is `{state: "gone"}`. */
  processStatus(sandboxId: string, handle: E2bProcessHandle): Promise<E2bProcessObservation>;
  /** Signal the process behind `handle`, then RE-READ its status. */
  signalProcess(
    sandboxId: string,
    handle: E2bProcessHandle,
    kind: "cancel" | "kill",
  ): Promise<E2bProcessSignalResult>;

  pause?(sandboxId: string): Promise<{ readonly snapshotId: string }>;
  resume?(sandboxId: string): Promise<void>;
}
