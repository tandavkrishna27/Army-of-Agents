/**
 * `createFakeSandboxProvider(script)` — a deterministic, inspectable, ADVERSARIAL
 * in-memory `SandboxProvider` double (WRK-004).
 *
 * It mirrors the SHAPE of the server-side `createFakeSandboxRuntimeProvider`
 * (`server/src/services/sandbox-provider-runtime.ts`) but is a NEW, purpose-built
 * double for the worker daemon's supervisor: it must be able to model every
 * failure the supervisor's authority separation exists to contain. A fake that
 * cannot inject a hung create, an ignored cancel, an ignored kill, and a destroy
 * failure would be a DEFECT (it could not exercise the escalation / cleanup
 * paths).
 *
 * Determinism: sandbox ids and provider-op ids are derived from an injectable
 * `idPrefix` + a monotonic counter, so every record is reproducible and
 * inspectable. Idempotency: a repeated `idempotencyKey` returns the recorded
 * result and does NOT double-apply.
 *
 * CRITICAL — the tenant command runs INSIDE the sandbox: `execute` records the
 * command against the sandbox and NEVER touches `node:child_process`. The double
 * imports no process-spawning API at all, which is what makes the
 * `no-local-tenant-spawn` proof meaningful.
 *
 * Runtime imports: relative `provider.ts` only (which pulls the frozen protocol +
 * node:crypto). No `node:child_process`, no bare packages — the E4-D01 boundary.
 */

import { createHash } from "node:crypto";

import type { ArtifactUploadGrantV1 } from "@armyofagents/worker-protocol";

import {
  labelsMatchSelector,
  ProcessLaunchNotAcknowledged,
  SandboxNotFoundError,
  UnsupportedProviderOperation,
  type ArtifactExportMode,
  type ProcessHandle,
  type ProcessObservation,
  type ProcessSignalResult,
  type ProcessStartResult,
  type ProcessStatusResult,
  type ProcessSupervisionMode,
  type ProcessUnknownReason,
  type FileStagingMode,
  type StagedFileRequest,
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
  type ProviderOpContext,
  type ProviderOperation,
  type ResourceLabels,
  type ResourceSummary,
  type RestoreResult,
  type SandboxProvider,
  type SandboxState,
  type StopResult,
} from "../../supervisor/provider.js";

/** A resource the fake is pre-seeded with (reconcile / list-pagination tests). */
export interface SeededResource {
  readonly sandboxId: string;
  readonly labels: ResourceLabels;
  readonly hasLiveLease: boolean;
  readonly state?: SandboxState;
}

/**
 * Adversarial injections + optional-op advertisement. Every injection targets a
 * specific supervisor/cleanup path so the acceptance matrix can drive real
 * failures rather than mocks.
 */
export interface FakeProviderScript {
  /** Optional ops the fake ADVERTISES (core ops are always present). */
  readonly optionalOperations?: readonly ("checkpoint" | "restore" | "health")[];
  readonly checkpointMode?: CheckpointMode;
  readonly healthMode?: HealthMode;
  /** DAT-009 slice 1 — defaults to "none" so an unscripted double DECLINES rather than
   * fabricating an export. A fabricated reference is byte-identical to a real one on every
   * gate, which is the WRK-009 defect. */
  readonly artifactExportMode?: ArtifactExportMode;
  /** In-sandbox path -> the bytes the double pretends are there. */
  readonly artifactFiles?: Readonly<Record<string, string>>;
  /** CLI-008 Unit B — defaults to "none" so an unscripted double DECLINES rather than
   * reporting a phantom stage. Same reasoning as `artifactExportMode`. */
  readonly fileStagingMode?: FileStagingMode;
  /** CLI-008 Unit B — objectKey -> the bytes the double's "store" would serve. A grant for a
   * key that is not here FAILS, rather than staging fabricated content. */
  readonly stagedObjects?: Readonly<Record<string, string>>;
  /** `create` never resolves (its resource is still registered as `creating`) →
   * the supervisor's deadline fires and it must tear the labeled resource down. */
  readonly hangCreate?: boolean;
  /** CLI-008 Unit B — `stageFiles` never resolves → the supervisor's staging deadline must
   * fire. Without a race the supervisor's `accept()` never terminalizes and the sandbox is
   * retained for the life of the process, which is a hang, not a failure. */
  readonly hangStageFiles?: boolean;
  /** `cancel` is ignored: the process tree stays alive → escalate to `kill`. */
  readonly ignoreCancel?: boolean;
  /** `kill` is ignored: the process tree stays alive → escalate to `destroy`. */
  readonly ignoreKill?: boolean;
  /** `destroy` returns `failed` this many times before succeeding (Infinity =
   * always fail). Never throws. */
  readonly destroyFailures?: number;
  /** `reconcileCleanup` returns `failed` this many times before succeeding. */
  readonly reconcileFailures?: number;
  readonly healthStatus?: "healthy" | "unhealthy";
  readonly restoreResumed?: boolean;
  readonly exitCode?: number;
  /** CLI-003 — inject the execute result's `signal` (default null) so the terminal
   * enrichment (signal → errorCode/errorMessage) is exercisable no-key. */
  readonly execSignal?: string | null;
  /** CLI-003 — inject the execute result's `timedOut` (default false). */
  readonly execTimedOut?: boolean;
  readonly idPrefix?: string;
  readonly seededResources?: readonly SeededResource[];
  /** Test control: `execute` awaits this before resolving, so a run can be held
   * "in-flight at execute" while an external cancel/shutdown escalates. Default
   * (absent) ⇒ execute resolves immediately. */
  readonly executeGate?: Promise<void>;
  /**
   * Model the REAL E2B provider's DEFERRED REGISTRATION: `create` awaits this gate
   * and the sandbox is registered (listable / inspectable) ONLY when create
   * RESOLVES — never while it is in-flight. This is the honest model of
   * `server/src/services/sandbox-provider-runtime.ts`, whose `sandboxId` is only
   * yielded AFTER `await e2b.Sandbox.create(...)`.
   *
   * Contrast `hangCreate` (registers synchronously as `creating`, then never
   * resolves) and the default (synchronous registration). It is exactly this
   * "not discoverable until create resolves" shape that lets a cancel /
   * onLeaseLost / shutdown arriving DURING create leak a live tenant sandbox if
   * the supervisor consumes its cleanup latch on an empty (nothing-listed) pass.
   */
  readonly createGate?: Promise<void>;

  // --- SVC-008a process supervision ------------------------------------------------
  //
  // ★ DEFAULTS TO `"none"` so an unscripted double DECLINES rather than fabricating a
  // launch, for the same reason `artifactExportMode` and `fileStagingMode` do. And the
  // scripted arms below exist for a sharper reason: this double's header already says a
  // fake that could not inject "an ignored cancel, an ignored kill" would be a DEFECT —
  // and until now no double in this tree could inject the case that is real E2B's ONLY
  // case, an accepted signal that stopped nothing, or an observation that says "I could
  // not tell". A double that cannot represent production cannot test it.

  readonly processSupervisionMode?: ProcessSupervisionMode;
  /** `startProcess` cannot be acknowledged → `ProcessLaunchNotAcknowledged`. */
  readonly refuseLaunch?: boolean;
  /**
   * What `processStatus` reports for a live handle. Default `"running"`.
   * `"unknown"` is the arm real E2B reaches whenever its status read fails.
   */
  readonly processState?: "running" | "exited" | "gone" | "unknown";
  /** The exit status `processStatus` reports when `processState` is `"exited"`. */
  readonly processExitCode?: number | null;
  /** The reason `processStatus` reports when `processState` is `"unknown"`. */
  readonly processUnknownReason?: ProcessUnknownReason;
  /**
   * ★ What `signalProcess` reports for the CALL — scripted INDEPENDENTLY of the
   * observation, so a test can exercise "accepted, and nothing stopped": the case that is
   * real E2B's only case and the one a caller must never read as success. Default
   * `"unsupported"` for `"cancel"` (matching the real transport, which has no per-pid
   * SIGTERM) and `"accepted"` for `"kill"`.
   */
  readonly signalAccepted?: "accepted" | "refused" | "unsupported";
  /** When true, a `"kill"` that was accepted actually stops the process (so the follow-up
   * observation is `"gone"`). Default false — the double does not assume an effect it did
   * not model. */
  readonly signalStopsProcess?: boolean;
}

interface FakeSandbox {
  sandboxId: string;
  labels: ResourceLabels;
  generation: number;
  state: SandboxState;
  command: string;
  args: string[];
  env: Record<string, string>;
  logs: string[];
  workspaceBytes: number;
  objectGrants: string[];
  secrets: Record<string, string>;
  hasLiveLease: boolean;
  /** pids of the in-sandbox process tree; empty ⇒ the tree is stopped. */
  processTree: number[];
  executions: Array<{ command: string; args: string[]; insideSandbox: true }>;
}

/** A recorded provider call (for inspectable, non-vacuous assertions). */
export interface FakeProviderCall {
  readonly op: ProviderOperation;
  readonly sandboxId: string | null;
  readonly idempotencyKey: string;
  readonly replayed: boolean;
}

/** The fake plus its inspection surface (test-only accessors). */
export interface FakeSandboxProvider extends SandboxProvider {
  /** Raw (UN-redacted) view of a sandbox — proves the redaction test is real. */
  peek(sandboxId: string): FakeSandbox | null;
  /** All non-destroyed sandboxes. */
  all(): FakeSandbox[];
  /** Executions recorded against a sandbox (tenant command ran INSIDE it). */
  executionsOf(sandboxId: string): Array<{ command: string; args: string[]; insideSandbox: true }>;
  /** True iff the sandbox's in-process tree is still alive. */
  processTreeAlive(sandboxId: string): boolean;
  /** Ordered log of every op call. */
  calls(): readonly FakeProviderCall[];
  callCount(op: ProviderOperation): number;
  /** CLI-008 Unit B — in-sandbox path -> the bytes actually staged, so a test can assert the
   * file landed with the right content. */
  stagedFiles(): Readonly<Record<string, string>>;
  /** The object keys this double redeemed. NEVER the grants: they are bearer capabilities. */
  readonly redeemedObjectKeys: string[];
}

const CORE_STATE_ALIVE: ReadonlySet<SandboxState> = new Set<SandboxState>(["creating", "running", "cancelling"]);

export function createFakeSandboxProvider(script: FakeProviderScript = {}): FakeSandboxProvider {
  const prefix = script.idPrefix ?? "fake";
  const sandboxes = new Map<string, FakeSandbox>();
  const idempotency = new Map<string, unknown>();
  const callLog: FakeProviderCall[] = [];
  let opCounter = 0;
  let pidCounter = 1;
  let destroyFailuresLeft = script.destroyFailures ?? 0;
  let reconcileFailuresLeft = script.reconcileFailures ?? 0;

  const optional = new Set<ProviderOperation>(script.optionalOperations ?? []);
  const advertised = new Set<ProviderOperation>([
    "create",
    "execute",
    "cancel",
    "kill",
    "destroy",
    "list",
    "inspect",
    "reconcile_cleanup",
    ...optional,
  ]);
  const checkpointMode: CheckpointMode = script.checkpointMode ?? "none";
  const healthMode: HealthMode = script.healthMode ?? "none";
  const artifactExportMode: ArtifactExportMode = script.artifactExportMode ?? "none";
  const artifactFiles: Readonly<Record<string, string>> = script.artifactFiles ?? {};
  const fileStagingMode: FileStagingMode = script.fileStagingMode ?? "none";
  const processSupervisionMode: ProcessSupervisionMode = script.processSupervisionMode ?? "none";
  /** Live process handles per sandbox, and whether each has been stopped. */
  const processes = new Map<string, { sandboxId: string; stopped: boolean }>();
  let processCounter = 0;
  const stagedObjects: Readonly<Record<string, string>> = script.stagedObjects ?? {};
  /** What actually landed in the sandbox, by path. */
  const stagedFileContents: Record<string, string> = {};
  /** Object keys this double redeemed, so a test can assert a stage happened. */
  const redeemedObjectKeys: string[] = [];
  /** Object keys this double has "uploaded", so a test can assert an export happened. */
  const exportedObjectKeys: string[] = [];

  // Seed resources (list/reconcile fixtures).
  for (const seed of script.seededResources ?? []) {
    sandboxes.set(seed.sandboxId, {
      sandboxId: seed.sandboxId,
      labels: seed.labels,
      generation: seed.labels.deviceGeneration,
      state: seed.state ?? "running",
      command: `tenant-${seed.sandboxId}`,
      args: ["--seeded"],
      env: { SEED: "1" },
      logs: [`seeded ${seed.sandboxId}`],
      workspaceBytes: 4096,
      objectGrants: [`grant-${seed.sandboxId}`],
      secrets: { API_TOKEN: `secret-${seed.sandboxId}` },
      hasLiveLease: seed.hasLiveLease,
      processTree: [pidCounter++, pidCounter++],
      executions: [],
    });
  }

  const nextOpId = (): string => `${prefix}-op-${++opCounter}`;
  const sandboxIdFor = (labels: ResourceLabels): string =>
    `${prefix}-sbx-${labels.jobId}-${labels.attempt}-${labels.leaseId}`;

  function record(op: ProviderOperation, sandboxId: string | null, ctx: ProviderOpContext, replayed: boolean): void {
    callLog.push({ op, sandboxId, idempotencyKey: ctx.idempotencyKey, replayed });
  }

  /** Return a recorded idempotent result if this key was already applied. */
  function replay<T>(ctx: ProviderOpContext, op: ProviderOperation, sandboxId: string | null): T | null {
    if (idempotency.has(ctx.idempotencyKey)) {
      record(op, sandboxId, ctx, true);
      return idempotency.get(ctx.idempotencyKey) as T;
    }
    return null;
  }
  function remember<T>(ctx: ProviderOpContext, result: T): T {
    idempotency.set(ctx.idempotencyKey, result);
    return result;
  }

  function requireAdvertised(op: ProviderOperation): void {
    if (!advertised.has(op)) throw new UnsupportedProviderOperation(op);
  }

  /**
   * SVC-008a — what this double SAW of a process. Every arm is scripted or read from the
   * double's own store; there is no default branch that manufactures a lifecycle.
   */
  function observe(sandboxId: string, handle: ProcessHandle): ProcessObservation {
    const scripted = script.processState ?? "running";
    if (scripted === "unknown") {
      return { state: "unknown", reason: script.processUnknownReason ?? "read_failed" };
    }
    const proc = processes.get(handle);
    // The store ANSWERED and this handle is not in it (or belongs elsewhere) — a witnessed
    // absence, not a failure to look.
    if (proc === undefined || proc.sandboxId !== sandboxId) return { state: "gone", observedAt: 0 };
    if (proc.stopped || scripted === "gone") return { state: "gone", observedAt: 0 };
    if (scripted === "exited") {
      return { state: "exited", exitCode: script.processExitCode ?? 0, signal: null, observedAt: 0 };
    }
    return { state: "running", observedAt: 0 };
  }

  function requireSandbox(sandboxId: string): FakeSandbox {
    const sandbox = sandboxes.get(sandboxId);
    if (sandbox === undefined) throw new SandboxNotFoundError();
    return sandbox;
  }

  const provider: FakeSandboxProvider = {
    advertisedOperations: advertised,
    checkpointMode,
    artifactExportMode,
    exportedObjectKeys,
    fileStagingMode,
    redeemedObjectKeys,

    stagedFiles() {
      return { ...stagedFileContents };
    },

    async stageFiles(sandboxId: string, files: readonly StagedFileRequest[]) {
      if (fileStagingMode === "none") throw new UnsupportedProviderOperation("stage_files");
      requireSandbox(sandboxId);
      // Never resolves — and deliberately does NOT honour the ctx deadline, because the real
      // E2B provider does not either (its transport's writeFiles/fetch accept no signal). The
      // supervisor-side race is the only thing standing between a stalled write and a run that
      // never terminalizes; a double that self-cancelled would test a provider we do not have.
      if (script.hangStageFiles === true) await new Promise<never>(() => {});
      // Fetch + VERIFY every file BEFORE writing any of them. A partial stage is worse than
      // no stage: the agent cannot tell which files it is missing.
      const resolved: Array<{ path: string; body: string }> = [];
      for (const file of files) {
        const body = stagedObjects[file.grant.objectKey];
        // An unknown object FAILS. It must never fabricate content — a fabricated stage is
        // byte-identical to a real one on every gate downstream, which is the WRK-009 defect.
        if (body === undefined) throw new SandboxNotFoundError();
        const digest = createHash("sha256").update(body).digest("hex");
        if (digest !== file.grant.expectedSha256) {
          throw new Error(`staged-input for ${file.path} hashed ${digest}, expected ${file.grant.expectedSha256}`);
        }
        resolved.push({ path: file.path, body });
      }
      for (const entry of resolved) stagedFileContents[entry.path] = entry.body;
      // Records only the OBJECT KEY — the grant is a bearer capability and is deliberately
      // not retained anywhere a projection, log or assertion could surface it.
      for (const file of files) redeemedObjectKeys.push(file.grant.objectKey);
      return { stagedPaths: resolved.map((entry) => entry.path) };
    },

    async digestArtifact(_sandboxId: string, path: string) {
      if (artifactExportMode === "none") throw new UnsupportedProviderOperation("digest_artifact");
      const body = artifactFiles[path];
      // An unknown path FAILS. It must never fabricate a digest: the whole point of the digest
      // step is that the grant is minted against a real file's hash and size.
      if (body === undefined) throw new SandboxNotFoundError();
      return {
        sha256: createHash("sha256").update(body).digest("hex"),
        sizeBytes: Buffer.byteLength(body),
      };
    },

    async exportArtifact(_sandboxId: string, path: string, grant: ArtifactUploadGrantV1) {
      if (artifactExportMode === "none") throw new UnsupportedProviderOperation("export_artifact");
      if (artifactFiles[path] === undefined) throw new SandboxNotFoundError();
      // Records only the OBJECT KEY. The grant is a bearer capability and is deliberately not
      // retained anywhere a projection, log or assertion could surface it.
      exportedObjectKeys.push(grant.objectKey);
      return { objectKey: grant.objectKey };
    },
    healthMode,

    async create(spec: CreateSandboxSpec, ctx: ProviderOpContext): Promise<CreateResult> {
      const sandboxId = sandboxIdFor(spec.resourceLabels);
      const replayed = replay<CreateResult>(ctx, "create", sandboxId);
      if (replayed !== null) return replayed;

      const registerCreating = (): void => {
        if (!sandboxes.has(sandboxId)) {
          sandboxes.set(sandboxId, {
            sandboxId,
            labels: spec.resourceLabels,
            generation: spec.resourceLabels.deviceGeneration,
            state: "creating",
            command: spec.command,
            args: [...spec.args],
            env: { ...spec.env },
            logs: [],
            workspaceBytes: 0,
            objectGrants: [],
            secrets: {},
            hasLiveLease: true,
            processTree: [],
            executions: [],
          });
        }
      };

      // DEFAULT / `hangCreate` providers register the resource SYNCHRONOUSLY (state
      // `creating`) so an in-flight or hung create is still discoverable by
      // ownership label for teardown. A `createGate` provider instead models the
      // REAL E2B runtime: the sandbox is registered ONLY when create RESOLVES, so
      // while create is in-flight a label-scoped `list` cannot find it.
      const deferredRegistration = script.createGate !== undefined;
      if (!deferredRegistration) {
        registerCreating();
      }
      record("create", sandboxId, ctx, false);

      if (script.hangCreate === true) {
        // Never resolves — the supervisor's deadline must fire. The recorded
        // resource stays `creating` for label-scoped teardown.
        return new Promise<CreateResult>(() => {});
      }

      if (deferredRegistration) {
        // Hold create in-flight; the sandbox stays UNREGISTERED (a label-scoped
        // `list` returns nothing) until the gate resolves and create returns.
        await script.createGate;
        registerCreating();
      }

      const sandbox = requireSandbox(sandboxId);
      sandbox.state = "running";
      sandbox.processTree = [pidCounter++, pidCounter++, pidCounter++];
      const result: CreateResult = { sandboxId, providerOpId: nextOpId(), resourceLabels: spec.resourceLabels };
      return remember(ctx, result);
    },

    async execute(input: ExecuteInput, ctx: ProviderOpContext): Promise<ExecuteResult> {
      const replayed = replay<ExecuteResult>(ctx, "execute", input.sandboxId);
      if (replayed !== null) return replayed;
      const sandbox = requireSandbox(input.sandboxId);
      // The tenant command runs INSIDE this sandbox. No child process of the
      // worker is ever spawned — this is a pure in-memory record.
      sandbox.executions.push({ command: input.command, args: [...input.args], insideSandbox: true });
      sandbox.logs.push(`exec ${input.command}`);
      record("execute", input.sandboxId, ctx, false);
      if (script.executeGate !== undefined) {
        // Hold the run in-flight at execute (deterministic cancel/shutdown tests).
        await script.executeGate;
      }
      const result: ExecuteResult = {
        providerOpId: nextOpId(),
        exitCode: script.exitCode ?? 0,
        signal: script.execSignal ?? null,
        timedOut: script.execTimedOut ?? false,
        stdoutRef: `sandbox://${input.sandboxId}/stdout`,
        stderrRef: `sandbox://${input.sandboxId}/stderr`,
      };
      return remember(ctx, result);
    },

    async cancel(sandboxId: string, ctx: ProviderOpContext): Promise<StopResult> {
      const replayed = replay<StopResult>(ctx, "cancel", sandboxId);
      if (replayed !== null) return replayed;
      const sandbox = requireSandbox(sandboxId);
      record("cancel", sandboxId, ctx, false);
      if (sandbox.state === "destroyed" || sandbox.state === "stopped") {
        // Already terminal — a cancel is an idempotent no-op (tree already gone).
        return remember(ctx, { providerOpId: nextOpId(), outcome: "stopped" } satisfies StopResult);
      }
      if (script.ignoreCancel === true) {
        sandbox.state = "cancelling"; // acknowledged but the tree does NOT stop
        return remember(ctx, { providerOpId: nextOpId(), outcome: "ignored" } satisfies StopResult);
      }
      sandbox.processTree = [];
      sandbox.state = "stopped";
      return remember(ctx, { providerOpId: nextOpId(), outcome: "stopped" } satisfies StopResult);
    },

    async kill(sandboxId: string, ctx: ProviderOpContext): Promise<StopResult> {
      const replayed = replay<StopResult>(ctx, "kill", sandboxId);
      if (replayed !== null) return replayed;
      const sandbox = requireSandbox(sandboxId);
      record("kill", sandboxId, ctx, false);
      if (sandbox.state === "destroyed" || sandbox.state === "stopped") {
        return remember(ctx, { providerOpId: nextOpId(), outcome: "stopped" } satisfies StopResult);
      }
      if (script.ignoreKill === true) {
        sandbox.state = "cancelling";
        return remember(ctx, { providerOpId: nextOpId(), outcome: "ignored" } satisfies StopResult);
      }
      sandbox.processTree = [];
      sandbox.state = "stopped";
      return remember(ctx, { providerOpId: nextOpId(), outcome: "stopped" } satisfies StopResult);
    },

    async destroy(sandboxId: string, ctx: ProviderOpContext): Promise<CleanupResult> {
      const replayed = replay<CleanupResult>(ctx, "destroy", sandboxId);
      if (replayed !== null) return replayed;
      const sandbox = requireSandbox(sandboxId);
      record("destroy", sandboxId, ctx, false);
      if (sandbox.state === "destroyed") {
        // Idempotent: an already-destroyed resource is a converged success.
        return remember(ctx, { providerOpId: nextOpId(), cleanupStatus: "success" } satisfies CleanupResult);
      }
      if (destroyFailuresLeft > 0) {
        destroyFailuresLeft -= 1;
        // Durable-retryable: the resource REMAINS so a fresh attempt can retry.
        // The failed status is recorded per-key (a replay returns it) but a NEW
        // key retries against the still-present resource.
        return remember(ctx, { providerOpId: nextOpId(), cleanupStatus: "failed" } satisfies CleanupResult);
      }
      sandbox.processTree = [];
      sandbox.state = "destroyed";
      sandbox.hasLiveLease = false;
      return remember(ctx, { providerOpId: nextOpId(), cleanupStatus: "success" } satisfies CleanupResult);
    },

    async reconcileCleanup(sandboxId: string, ctx: ProviderOpContext): Promise<CleanupResult> {
      const replayed = replay<CleanupResult>(ctx, "reconcile_cleanup", sandboxId);
      if (replayed !== null) return replayed;
      record("reconcile_cleanup", sandboxId, ctx, false);
      const sandbox = sandboxes.get(sandboxId);
      // Idempotent: an already-gone resource is a success (nothing to clean).
      if (sandbox === undefined || sandbox.state === "destroyed") {
        return remember(ctx, { providerOpId: nextOpId(), cleanupStatus: "success" } satisfies CleanupResult);
      }
      if (reconcileFailuresLeft > 0) {
        reconcileFailuresLeft -= 1;
        return remember(ctx, { providerOpId: nextOpId(), cleanupStatus: "failed" } satisfies CleanupResult);
      }
      sandbox.processTree = [];
      sandbox.state = "destroyed";
      sandbox.hasLiveLease = false;
      return remember(ctx, { providerOpId: nextOpId(), cleanupStatus: "success" } satisfies CleanupResult);
    },

    async list(input: ListInput, ctx: ProviderOpContext): Promise<ListResult> {
      record("list", null, ctx, false);
      const matching = [...sandboxes.values()]
        .filter((s) => s.state !== "destroyed" && labelsMatchSelector(s.labels, input.ownershipSelector))
        .sort((a, b) => (a.sandboxId < b.sandboxId ? -1 : a.sandboxId > b.sandboxId ? 1 : 0));
      const pageSize = Math.max(1, Math.floor(input.pageSize));
      const startAfter = input.pageToken ?? null;
      const startIndex = startAfter === null ? 0 : matching.findIndex((s) => s.sandboxId === startAfter) + 1;
      const page = matching.slice(startIndex, startIndex + pageSize);
      const endIndex = startIndex + page.length;
      const nextPageToken = endIndex < matching.length ? page[page.length - 1]?.sandboxId ?? null : null;
      const resources: ResourceSummary[] = page.map((s) => ({
        sandboxId: s.sandboxId,
        resourceLabels: s.labels,
        generation: s.generation,
        state: s.state,
        hasLiveLease: s.hasLiveLease,
      }));
      return { providerOpId: nextOpId(), resources, nextPageToken };
    },

    async inspect(sandboxId: string, ctx: ProviderOpContext): Promise<InspectResult> {
      record("inspect", sandboxId, ctx, false);
      const sandbox = requireSandbox(sandboxId);
      return {
        providerOpId: nextOpId(),
        sandboxId: sandbox.sandboxId,
        resourceLabels: sandbox.labels,
        generation: sandbox.generation,
        state: sandbox.state,
        command: sandbox.command,
        env: { ...sandbox.env },
        logs: [...sandbox.logs],
        workspaceBytes: sandbox.workspaceBytes,
        objectGrants: [...sandbox.objectGrants],
        secrets: { ...sandbox.secrets },
      };
    },

    async checkpoint(sandboxId: string, ctx: ProviderOpContext): Promise<CheckpointResult> {
      requireAdvertised("checkpoint");
      record("checkpoint", sandboxId, ctx, false);
      requireSandbox(sandboxId);
      return { providerOpId: nextOpId(), mode: checkpointMode, checkpointRef: `sandbox://${sandboxId}/checkpoint` };
    },

    async restore(sandboxId: string, ctx: ProviderOpContext): Promise<RestoreResult> {
      requireAdvertised("restore");
      record("restore", sandboxId, ctx, false);
      requireSandbox(sandboxId);
      return { providerOpId: nextOpId(), restored: script.restoreResumed ?? true };
    },

    async health(sandboxId: string, ctx: ProviderOpContext): Promise<HealthResult> {
      requireAdvertised("health");
      record("health", sandboxId, ctx, false);
      requireSandbox(sandboxId);
      return { providerOpId: nextOpId(), mode: healthMode, status: script.healthStatus ?? "healthy" };
    },

    // --- SVC-008a process supervision -----------------------------------------
    processSupervisionMode,

    async startProcess(input: ExecuteInput, ctx: ProviderOpContext): Promise<ProcessStartResult> {
      // A `"none"` double THROWS rather than returning an observation — the same contract
      // every other `"none"` implementer has, so a `"none"` provider has exactly one
      // behaviour to satisfy.
      if (processSupervisionMode === "none") throw new UnsupportedProviderOperation("start_process");
      requireSandbox(input.sandboxId);
      // ★ THE SAME REPLAY THE REST OF THIS DOUBLE DOES. This file's header promises "a
      // repeated `idempotencyKey` returns the recorded result and does NOT double-apply",
      // and `startProcess` shipped ignoring its ctx entirely — so the one op where a
      // double-apply costs a second live service instance was the one op that did not
      // honour it, and a double that double-applies cannot red a provider that does.
      //
      // It uses the SHARED `idempotency` map rather than a private one: this double's keys
      // are per-op-unique by construction in every suite, and re-using the store keeps it
      // one mechanism. Recorded AFTER the refusal check, so a refused launch records
      // nothing and a retry is a real retry.
      const key = ctx.idempotencyKey;
      if (key && idempotency.has(key)) return idempotency.get(key) as ProcessStartResult;
      if (script.refuseLaunch === true) {
        // ★ NEVER `handle: ""`. An empty string is "present" and satisfies "presence is
        // the acknowledgement" while acknowledging a launch that never happened.
        throw new ProcessLaunchNotAcknowledged(input.sandboxId, "launch refused by script");
      }
      processCounter += 1;
      const handle = `${prefix}-proc-${processCounter}`;
      processes.set(handle, { sandboxId: input.sandboxId, stopped: false });
      const result: ProcessStartResult = { providerOpId: nextOpId(), handle, acknowledgedAt: 0 };
      if (key) idempotency.set(key, result);
      return result;
    },

    async processStatus(
      sandboxId: string,
      handle: ProcessHandle,
      _ctx: ProviderOpContext,
    ): Promise<ProcessStatusResult> {
      if (processSupervisionMode === "none") throw new UnsupportedProviderOperation("process_status");
      return { providerOpId: nextOpId(), observation: observe(sandboxId, handle) };
    },

    async signalProcess(
      sandboxId: string,
      handle: ProcessHandle,
      kind: "cancel" | "kill",
      _ctx: ProviderOpContext,
    ): Promise<ProcessSignalResult> {
      if (processSupervisionMode === "none") throw new UnsupportedProviderOperation("signal_process");
      const accepted =
        script.signalAccepted ?? (kind === "cancel" ? ("unsupported" as const) : ("accepted" as const));
      const proc = processes.get(handle);
      // ★ The EFFECT is scripted separately from the ACCEPTANCE, so "accepted and nothing
      // stopped" is expressible. That is real E2B's only case, and a double that could not
      // express it is exactly what let E7-F034 survive every ladder test.
      if (proc !== undefined && accepted === "accepted" && script.signalStopsProcess === true) {
        proc.stopped = true;
      }
      return { providerOpId: nextOpId(), accepted, observation: observe(sandboxId, handle) };
    },

    // --- inspection surface (test-only) ---
    peek(sandboxId: string): FakeSandbox | null {
      return sandboxes.get(sandboxId) ?? null;
    },
    all(): FakeSandbox[] {
      return [...sandboxes.values()].filter((s) => s.state !== "destroyed");
    },
    executionsOf(sandboxId: string) {
      return sandboxes.get(sandboxId)?.executions ?? [];
    },
    processTreeAlive(sandboxId: string): boolean {
      const sandbox = sandboxes.get(sandboxId);
      return sandbox !== undefined && CORE_STATE_ALIVE.has(sandbox.state) && sandbox.processTree.length > 0;
    },
    calls(): readonly FakeProviderCall[] {
      return callLog;
    },
    callCount(op: ProviderOperation): number {
      return callLog.filter((c) => c.op === op && !c.replayed).length;
    },
  };

  return provider;
}
