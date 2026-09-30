// -----------------------------------------------------------------------------
// E2bSandboxProvider — the REAL E2B driver logic, implementing worker-daemon's
// authoritative per-op `SandboxProvider` over an INJECTED transport (CLI-001/D1).
//
// The driver logic here is real and identical whether the injected transport is
// the deterministic key-less mock (`mock-transport.ts`, the no-key core proof) or
// the `e2b` SDK binding (`real-transport.ts`, the keyed lane). It:
//   * enforces create idempotency (lost-response replay returns the recorded id);
//   * enforces an explicit TTL on every sandbox (`setTimeout` at create; a
//     zero-deadline op is a deterministic timeout, never a hang);
//   * holds the FULL sensitive detail (command/env/logs/secrets) and returns it
//     ONLY from `inspect` (`InspectResult`) — so the cleanup authority's redaction
//     is a real, non-vacuous projection (management `list` never carries it);
//   * translates transport-level facts into the domain outcomes/denials the
//     conformance suites assert (ignored signal → `StopOutcome.ignored`; transient
//     teardown → a REPORTED `CleanupResult{failed}`, never a throw; a blocked
//     egress → the domain `SandboxEgressDeniedError`; an unknown id → the domain
//     `SandboxNotFoundError`).
//
// It advertises the eight core ops plus the optional ops the transport supports
// AND this provider is configured to expose; unadvertised optional ops throw the
// exact worker-daemon `UnsupportedProviderOperation`. No tenant/E2B field is
// invented into a management projection (CAV-002); the redaction to the neutral
// invoke-port projection is the E6-F008 adapter's job.
// -----------------------------------------------------------------------------

import {
  CORE_PROVIDER_OPERATIONS,
  type ProviderOperation,
  type ArtifactUploadGrantV1,
  type ArtifactDownloadGrantV1,
} from "@armyofagents/worker-protocol";
import { createHash } from "node:crypto";
import type {
  ArtifactDigestResult,
  ArtifactExportMode,
  ArtifactExportResult,
  FileStagingMode,
  StageFilesResult,
  StagedFileRequest,
  CheckpointMode,
  CheckpointResult,
  CleanupResult,
  CreateResult,
  CreateSandboxSpec,
  ExecuteInput,
  ExecuteResult,
  HealthMode,
  HealthResult,
  InspectResult,
  ListInput,
  ListResult,
  ProcessHandle,
  ProcessObservation,
  ProcessSignalResult,
  ProcessStartResult,
  ProcessStatusResult,
  ProcessSupervisionMode,
  ProviderOpContext,
  ResourceLabels,
  ResourceSummary,
  RestoreResult,
  SandboxProvider,
  SandboxState,
  StopOutcome,
  StopResult,
} from "@armyofagents/worker-daemon";

import { METADATA_KEYS } from "./directives.js";
import {
  ProcessLaunchNotAcknowledged,
  SandboxEgressDeniedError,
  SandboxNotFoundError,
  SandboxRecordIndeterminateError,
  UnsupportedProviderOperation,
} from "./errors.js";
import {
  E2bProcessLaunchNotAcknowledgedError,
  E2bTransportEgressBlockedError,
  E2bTransportNotFoundError,
  E2bTransportTransientError,
  type E2bProcessObservation,
  type E2bRecordState,
  type E2bSandboxRecord,
  type E2bStagedFile,
  type E2bTransport,
} from "./transport.js";

const DEFAULT_TTL_MS = 60_000;

/** Which optional ops this provider exposes by default: `health` (an E2B running
 * probe) is supported; `checkpoint`/`restore` are recorded unsupported-with-
 * fallback (see the capability matrix) so the no-key contract suite naturally
 * exercises BOTH negotiation branches. Override for tests. */
export const DEFAULT_ADVERTISED_OPTIONAL_OPS: readonly ProviderOperation[] = ["health"];

export interface E2bSandboxProviderOptions {
  readonly transport: E2bTransport;
  /** The pinned E2B template alias every sandbox is created from. */
  readonly templateId?: string;
  /** The optional ops (`checkpoint`/`restore`/`health`) this provider advertises.
   * Defaults to {@link DEFAULT_ADVERTISED_OPTIONAL_OPS}. A checkpoint/restore
   * advertisement additionally requires the transport to expose `pause`/`resume`. */
  readonly advertisedOptionalOps?: readonly ProviderOperation[];
  /** Default per-op deadline when a caller passes none. */
  readonly defaultTtlMs?: number;
  /**
   * CLI-008 Unit B — how the provider turns a download grant into bytes. Injected so the
   * no-key mock lane can stage without a network, exactly as `transport` is injected.
   * Defaults to the global `fetch` against the grant's presigned URL.
   *
   * ★ The implementation MUST NOT log or re-throw the url or headers: the grant is a bearer
   * capability, and the port already classifies this class of value as sensitive.
   */
  readonly redeemDownloadGrant?: (grant: ArtifactDownloadGrantV1) => Promise<Uint8Array>;
  /**
   * DAT-009 — how the provider turns an upload grant plus bytes into a stored object.
   * Injected for the same reason `redeemDownloadGrant` is: the no-key lane must be able to
   * prove the read -> verify -> reference path with no network, and the keyed lane must be
   * able to prove the SANDBOX half against real E2B without standing up an object store.
   *
   * ★ The implementation MUST NOT log or re-throw the url or headers: the grant is a bearer
   * capability that writes an attempt-scoped object key until it expires.
   */
  readonly performUploadGrant?: (grant: ArtifactUploadGrantV1, bytes: Uint8Array) => Promise<void>;
}

/** The default redemption: a plain GET against the presigned url with the grant's headers. */
async function fetchGrantBytes(grant: ArtifactDownloadGrantV1): Promise<Uint8Array> {
  const response = await fetch(grant.url, { method: "GET", headers: { ...grant.headers } });
  if (!response.ok) {
    // The status, never the url — the url IS the capability.
    throw new Error(`staged-input download failed with status ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The default upload: a plain PUT of the bytes against the presigned url with the grant's
 * headers, plus the checksum header the fenced commit's re-verification needs.
 *
 * ★★ `x-amz-checksum-sha256` IS NOT OPTIONAL, and this is the one non-obvious line in the
 * export path. DAT-002's live MinIO run measured that the control plane binds
 * `ChecksumAlgorithm: SHA256` when it signs but returns `headers: {}`, so the PUT itself must
 * carry the checksum; `artifact-commit.ts` then fails CLOSED when the store cannot supply one
 * to its `headObject` re-verification. An exporter that omits this header uploads
 * successfully and is rejected at commit, far away from the cause.
 *
 * The value is the BASE64 of the raw digest (S3's encoding), while the grant's
 * `expectedSha256` is hex (`sha256DigestSchema`) — two encodings of the same bytes, and
 * mixing them up produces a store-side rejection that looks like a checksum mismatch.
 */
async function putGrantBytes(grant: ArtifactUploadGrantV1, bytes: Uint8Array): Promise<void> {
  const response = await fetch(grant.url, {
    method: "PUT",
    headers: {
      // Defaults FIRST so `grant.headers` wins. The grant is the authority on what the
      // signature covers, and today it is empty (`s3-provider.ts` `presign` returns
      // `headers: {}`) — but `presign` signs `ContentType` whenever its caller supplies one,
      // and a signed content-type that disagreed with a hard-coded default here would fail
      // the signature at the store. Letting the grant override is the only ordering that
      // survives that change.
      "content-type": "application/octet-stream",
      "x-amz-checksum-sha256": createHash("sha256").update(bytes).digest("base64"),
      ...grant.headers,
    },
    // A Uint8Array is a valid BodyInit at runtime; the cast is only for the lib's
    // ArrayBufferLike variance.
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) {
    // The status, never the url — the url IS the capability.
    throw new Error(`artifact export upload failed with status ${response.status}`);
  }
}

/**
 * Project a CLASSIFIED record state onto the port's lifecycle vocabulary.
 *
 * ★ SVC-008a §4.2 A-iii — `"unknown"` is deliberately NOT accepted here. Widening
 * `E2bRecordState` with `"unknown"` reds this exhaustive switch, and that red is the
 * MECHANISM, not a cost: it forces every consumer of a record state to decide what an
 * indeterminate one means, and the two consumers are ruled differently because they fail
 * in opposite directions (`inspect` throws; `list` takes the non-destructive interim rule
 * of §9.4). Clearing the red by mapping `"unknown"` onto some lifecycle value HERE would
 * launder it into both call sites at once.
 */
function mapClassifiedState(state: Exclude<E2bRecordState, "unknown">): SandboxState {
  switch (state) {
    case "running":
      return "running";
    case "paused":
      return "stopped";
    case "stopped":
      return "stopped";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * Project the transport's observation onto the port's, adding only the timestamp of the
 * READ that produced it.
 *
 * ★ `observedAt` timestamps the read, never the state, and it is STRUCTURALLY ABSENT from
 * the `unknown` arm — the arm with no successful read to timestamp. There is no default
 * branch: a new transport-level inhabitant reds the build here rather than being
 * laundered into whichever arm happens to be last.
 */
function toPortObservation(observation: E2bProcessObservation): ProcessObservation {
  switch (observation.state) {
    case "running":
      return { state: "running", observedAt: Date.now() };
    case "exited":
      return {
        state: "exited",
        exitCode: observation.exitCode,
        signal: observation.signal,
        observedAt: Date.now(),
      };
    case "gone":
      return { state: "gone", observedAt: Date.now() };
    case "unknown":
      return { state: "unknown", reason: observation.reason };
    default: {
      const exhaustive: never = observation;
      return exhaustive;
    }
  }
}

/** Deterministic parse of the round-tripped management record. */
function parseRecord(record: E2bSandboxRecord): {
  labels: ResourceLabels;
  command: string;
  env: Record<string, string>;
  workloadType: string;
} {
  const rawLabels = record.metadata[METADATA_KEYS.labels];
  const rawEnv = record.metadata[METADATA_KEYS.env];
  let labels: ResourceLabels;
  try {
    labels = JSON.parse(rawLabels ?? "{}") as ResourceLabels;
  } catch {
    labels = {} as ResourceLabels;
  }
  let env: Record<string, string> = {};
  try {
    env = JSON.parse(rawEnv ?? "{}") as Record<string, string>;
  } catch {
    env = {};
  }
  return {
    labels,
    command: record.metadata[METADATA_KEYS.command] ?? "",
    env,
    workloadType: record.metadata[METADATA_KEYS.workload] ?? "",
  };
}

export class E2bSandboxProvider implements SandboxProvider {
  readonly #transport: E2bTransport;
  readonly #templateId: string;
  readonly #defaultTtlMs: number;
  readonly #redeemDownloadGrant: (grant: ArtifactDownloadGrantV1) => Promise<Uint8Array>;
  readonly #performUploadGrant: (grant: ArtifactUploadGrantV1, bytes: Uint8Array) => Promise<void>;
  readonly advertisedOperations: ReadonlySet<ProviderOperation>;
  readonly checkpointMode: CheckpointMode;
  readonly healthMode: HealthMode;
  /**
   * DAT-009 — declared `"grant_upload"`, and this one is REAL.
   *
   * Slice 1 declared `"none"` deliberately and named the reason: the transport already has
   * `readFile`, so a real implementation is "a small, provider-specific piece", explicitly out
   * of scope for that slice (`DAT-009-slice-1-design.md` §7). This is that piece. The mode now
   * says `"grant_upload"` because the two methods below actually read the sandbox, verify what
   * they read against the grant, and move it to object storage — the same standard
   * `fileStagingMode` is held to. A provider that CLAIMED support and then fabricated a
   * reference would be the WRK-009 defect all over again, where a fabricated success is
   * byte-identical to a real one on every gate; the refusal tests below are what keep this
   * declaration honest.
   *
   * ★★ NOTHING IN PRODUCTION READS THIS FIELD — measured by search, not assumed: outside the
   * two declarations (`provider-wire/src/driver.ts`, `supervisor/noop-provider.ts`), the port's
   * own type, and tests, the only reads are the two decline guards in this file. No supervisor,
   * placement or hello builder branches on it. So flipping it from `"none"` changes NO runtime
   * behaviour anywhere today; it becomes consultable when link 3 exists to consult it.
   *
   * ★ WHAT THIS DOES NOT DO. Declaring the mode does not put an artifact on any run.
   * Nothing in production calls `exportArtifact` — the worker-side sequencer
   * (digest → mint grant → export → commit) is DAT-009 slice 3 and is unbuilt — and the
   * kind an exported object is committed under is the COMMITTER's decision, not this
   * provider's. `countProducedOutputs` arm 1 filters `kind = 'workspace_patch'` (in
   * `server/src/services/e7-distributed-run-verifier-store.ts` — symbol, not a line pin; the
   * old `:201-211` citation was moved ~280 lines by W21B/W21C and now points into
   * `listJobEvents`), so this file moves no capability counter. See
   * `CLI-008-unit-f-design.md` §1.6 link 2.
   */
  readonly artifactExportMode: ArtifactExportMode = "grant_upload";

  /**
   * CLI-008 Unit B — declared `"grant_download"`, and this one is REAL.
   *
   * Unlike `artifactExportMode` above (honestly `"none"` because slice 1 left the
   * implementation out of scope), staging is implemented here over the transport's existing
   * `writeFiles`, which both drivers already have. Declaring support this provider did not
   * have would be the WRK-009 defect; declaring `"none"` for one it does have would leave the
   * capability unreachable. It has it, so it says so.
   */
  readonly fileStagingMode: FileStagingMode = "grant_download";

  /** Idempotency ledger: a stable create key → the recorded resource. A replayed
   * key returns the SAME sandbox and never provisions a second one. */
  readonly #idempotency = new Map<string, { sandboxId: string; resourceLabels: ResourceLabels }>();
  /**
   * SVC-008a — the SAME mechanism as `#idempotency` above, for the launch.
   *
   * ★ A SECOND MAP, NOT A SECOND SCHEME. `ProviderOpContext` states one contract for every
   * op ("a repeated key returns the recorded result and does not double-apply"), and this
   * follows the ledger `create` already uses rather than inventing a parallel one — two
   * idempotency schemes in one provider would be worse than the gap. It is a separate MAP
   * only because the recorded values have different shapes and a shared key space would let
   * a create replay hand back a launch, or the reverse.
   */
  readonly #processIdempotency = new Map<string, ProcessStartResult>();
  #opCounter = 0;
  /** SVC-008a §9.4 — how many records this provider could not classify. The observable
   * that keeps the interim `hasLiveLease` rule from being silent; the provider has no
   * metrics sink injected, so it is exposed for inspection instead. */
  #indeterminateRecords = 0;

  /**
   * SVC-008a — declared from the TRANSPORT's own answer, never asserted.
   *
   * ★ WHAT THIS DOES AND DOES NOT CLAIM. `RealE2bTransport` declares `"handle"` on the
   * strength of a reading of the `e2b@2.30.5` TYPE DECLARATIONS — `commands.run(cmd,
   * {background: true})` resolves a `CommandHandle` with a `pid`, `commands.list()`
   * resolves `ProcessInfo[]`, `commands.kill(pid)` resolves `true`/`false` — and that
   * reading has NOT been run against a real E2B account. So this field says "the binding
   * beneath me implements the trio against the SDK's documented surface", never "this has
   * been measured working". The keyed lane is what measures it, and the conformance
   * suite's keyed arm must report SKIPPED rather than passed when no key is present.
   *
   * A transport that declares `"none"` makes this `"none"`, and all three methods throw.
   */
  readonly processSupervisionMode: ProcessSupervisionMode;

  constructor(options: E2bSandboxProviderOptions) {
    this.#transport = options.transport;
    this.#templateId = options.templateId ?? "base";
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#redeemDownloadGrant = options.redeemDownloadGrant ?? fetchGrantBytes;
    this.#performUploadGrant = options.performUploadGrant ?? putGrantBytes;

    const requested = new Set<string>((options.advertisedOptionalOps ?? DEFAULT_ADVERTISED_OPTIONAL_OPS).map(String));
    const advertised = new Set<ProviderOperation>(CORE_PROVIDER_OPERATIONS);
    // checkpoint/restore require BOTH advertisement AND transport pause/resume.
    const canCheckpoint = requested.has("checkpoint") && typeof this.#transport.pause === "function";
    const canRestore = requested.has("restore") && typeof this.#transport.resume === "function";
    if (canCheckpoint) advertised.add("checkpoint");
    if (canRestore) advertised.add("restore");
    if (requested.has("health")) advertised.add("health");
    this.advertisedOperations = advertised;
    this.checkpointMode = canCheckpoint ? "snapshot" : "none";
    this.healthMode = requested.has("health") ? "poll" : "none";
    // Delegated, never asserted: the provider claims exactly what the injected transport
    // claims (the same shape `checkpointMode` uses, which gates on `transport.pause`).
    this.processSupervisionMode = this.#transport.processSupervisionMode;
  }

  /** SVC-008a §9.4 — records whose lifecycle state could not be classified. */
  indeterminateRecordCount(): number {
    return this.#indeterminateRecords;
  }

  #nextOpId(op: ProviderOperation): string {
    this.#opCounter += 1;
    return `e2b-${op}-${this.#opCounter}`;
  }

  #ttl(ctx: ProviderOpContext): number {
    return ctx.deadlineMs > 0 ? ctx.deadlineMs : this.#defaultTtlMs;
  }

  async create(spec: CreateSandboxSpec, ctx: ProviderOpContext): Promise<CreateResult> {
    const key = ctx.idempotencyKey;
    if (key) {
      const existing = this.#idempotency.get(key);
      if (existing) {
        return { sandboxId: existing.sandboxId, providerOpId: this.#nextOpId("create"), resourceLabels: existing.resourceLabels };
      }
    }
    // The management record the transport round-trips (labels/command/workload only).
    //
    // ★ [Cred-1] (DEP-012 Slice 4+5) — the tenant `env` is DELIBERATELY NOT written into
    // durable E2B metadata. A real transport persists `metadata` in E2B cloud (returned by
    // Sandbox.list()/getInfo()), so a `[METADATA_KEYS.env]: JSON.stringify(spec.env)` copy
    // would leave the tenant model-provider key AT REST in a shared-account durable store —
    // forbidden by Decision #104 (the credential must not hit a durable store). The copy was
    // REDUNDANT: `env` still reaches the running sandbox via the necessary `envVars` channel
    // below; its only reader was `inspect`, whose gated wire ALWAYS redacts env, and `list`
    // dropped it. The deterministic MOCK now decodes its create-fault directives from
    // `req.envVars` (which carries the same env), not from this metadata.
    const metadata: Record<string, string> = {
      [METADATA_KEYS.labels]: JSON.stringify(spec.resourceLabels),
      [METADATA_KEYS.command]: spec.command,
      [METADATA_KEYS.workload]: spec.workloadType,
    };
    const { sandboxId } = await this.#transport.create({
      templateId: this.#templateId,
      timeoutMs: this.#ttl(ctx),
      metadata,
      // The necessary channel: E2B needs the env to run the sandbox. NOT durable metadata.
      envVars: spec.env,
    });
    // Every sandbox gets an enforced TTL (idempotent belt-and-suspenders).
    await this.#transport.setTimeout(sandboxId, this.#ttl(ctx));
    if (key) this.#idempotency.set(key, { sandboxId, resourceLabels: spec.resourceLabels });
    return { sandboxId, providerOpId: this.#nextOpId("create"), resourceLabels: spec.resourceLabels };
  }

  async execute(input: ExecuteInput, ctx: ProviderOpContext): Promise<ExecuteResult> {
    // Driver-owned command budget. A non-positive deadline is an exhausted budget →
    // a DETERMINISTIC timedOut terminal, enforced HERE rather than delegated to the
    // transport: E2B treats `timeoutMs = 0` as "disable/default" (never an instant
    // kill, returning timedOut:false), so trusting the transport's verdict on a zero
    // budget would invert the "never hangs, always bounded" guarantee against real
    // E2B. The driver owns the zero-budget verdict; a POSITIVE budget is enforced by
    // the transport's own command timeout (real E2B honours a positive timeoutMs, and
    // the keyed lane asserts a long command is killed at its budget).
    if (ctx.deadlineMs <= 0) {
      return {
        providerOpId: this.#nextOpId("execute"),
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        stdoutRef: `ref:stdout:${input.sandboxId}`,
        stderrRef: `ref:stderr:${input.sandboxId}`,
      };
    }
    try {
      const result = await this.#transport.runCommand({
        sandboxId: input.sandboxId,
        command: input.command,
        args: input.args,
        envVars: input.env,
        // Positive command budget: forwarded as the transport command timeout.
        timeoutMs: ctx.deadlineMs,
      });
      return {
        providerOpId: this.#nextOpId("execute"),
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        // No customer bytes cross this boundary — opaque references only (E5).
        stdoutRef: `ref:stdout:${input.sandboxId}`,
        stderrRef: `ref:stderr:${input.sandboxId}`,
      };
    } catch (err) {
      if (err instanceof E2bTransportEgressBlockedError) {
        throw new SandboxEgressDeniedError(err.destinationClass);
      }
      if (err instanceof E2bTransportNotFoundError) throw new SandboxNotFoundError();
      throw err;
    }
  }

  /**
   * ★★★ SVC-008a §4.2 Half A — THE STOP VERDICT, DERIVED FROM WHAT WAS OBSERVED.
   *
   * `StopOutcome` is NOT widened, and it does not need to be: `"ignored"`'s existing
   * contract is already *"the sandbox did not comply and the supervisor must escalate"*,
   * which is the correct handling for BOTH `still_running` and `unknown`. Mapping an
   * indeterminate read onto the ESCALATING value is fail-safe; mapping it onto the
   * TERMINATING value is the E7-F034 defect.
   *
   * What this changes on the shipping lane: `cancel` now returns `"ignored"` against real
   * E2B, so `CleanupAuthority`'s `kill` rung EXECUTES for the first time in production,
   * `kill` also returns `"ignored"`, and the stage reaches `destroy`. The unconditional
   * forced `destroy` after the ladder is unchanged, so `cleanup_escalation{escalation_stage}`
   * starts reporting `"destroy"` where it reported `"cancel"` — the metric becoming TRUE:
   * this provider has no graceful stop, and every cancellation is a hard teardown.
   *
   * ★★★ FOR A CLASSIFIABLE RECORD, AND ONLY FOR ONE. This docstring used to say "no resource
   * behaviour changes at all", and that was FALSE for the class {@link inspect} introduces
   * below. An UNCLASSIFIABLE record previously mapped to `"stopped"` (the old `mapState`
   * default) -> a terminal `SandboxState` -> the ordinary ladder -> a forced `destroy`. It
   * now throws `SandboxRecordIndeterminateError` out of `inspect`, `CleanupAuthority`'s
   * ownership gate refuses, `#convergeOne` reports `"failed"`, and NO destroy is issued: the
   * resource is deliberately left to the next pass and, failing that, to the reaper. That is
   * the intended non-destructive disposition — no teardown against a record whose ownership
   * could not be established — but it IS a resource-behaviour change, and stating otherwise
   * would hide the one case an operator most needs to know about. `indeterminateRecordCount()`
   * is how often it fires.
   */
  #stopVerdict(observed: "stopped" | "still_running" | "unknown"): StopOutcome {
    return observed === "stopped" ? "stopped" : "ignored";
  }

  async cancel(sandboxId: string, _ctx: ProviderOpContext): Promise<StopResult> {
    const result = await this.#transport.signal(sandboxId, "cancel");
    return { providerOpId: this.#nextOpId("cancel"), outcome: this.#stopVerdict(result.observed) };
  }

  async kill(sandboxId: string, _ctx: ProviderOpContext): Promise<StopResult> {
    const result = await this.#transport.signal(sandboxId, "kill");
    return { providerOpId: this.#nextOpId("kill"), outcome: this.#stopVerdict(result.observed) };
  }

  async destroy(sandboxId: string, _ctx: ProviderOpContext): Promise<CleanupResult> {
    return this.#reclaim("destroy", sandboxId);
  }

  async reconcileCleanup(sandboxId: string, _ctx: ProviderOpContext): Promise<CleanupResult> {
    return this.#reclaim("reconcile_cleanup", sandboxId);
  }

  /** Terminate + reclaim. A transient transport failure is REPORTED as failed —
   * never thrown — so the cleanup convergence can retry it idempotently. An
   * already-gone sandbox is a converged success (idempotent). */
  async #reclaim(op: ProviderOperation, sandboxId: string): Promise<CleanupResult> {
    try {
      await this.#transport.terminate(sandboxId);
      return { providerOpId: this.#nextOpId(op), cleanupStatus: "success" };
    } catch (err) {
      if (err instanceof E2bTransportNotFoundError) {
        return { providerOpId: this.#nextOpId(op), cleanupStatus: "success" };
      }
      if (err instanceof E2bTransportTransientError) {
        return { providerOpId: this.#nextOpId(op), cleanupStatus: "failed" };
      }
      throw err;
    }
  }

  async list(input: ListInput, _ctx: ProviderOpContext): Promise<ListResult> {
    const providerOpId = this.#nextOpId("list");
    const page = await this.#transport.list({ pageSize: input.pageSize, pageToken: input.pageToken ?? null });
    const resources: ResourceSummary[] = page.items
      .map((record) => {
        const parsed = parseRecord(record);
        const indeterminate = record.state === "unknown";
        if (indeterminate) this.#indeterminateRecords += 1;
        return {
          sandboxId: record.sandboxId,
          resourceLabels: parsed.labels,
          generation: parsed.labels.deviceGeneration ?? 0,
          // ★ SVC-008a §9.4 — `SandboxState` has no indeterminate inhabitant, and adding
          // one is a cross-package widening (`startup-reconcile`, `reconcile`,
          // `provider-wire/projection`, the contract harness) that this ticket does NOT
          // own. `"cancelling"` is a PLACEHOLDER CHOSEN FOR ITS ROUTE, not a claim: it is
          // the member of `ALIVE_STATES` (`startup-reconcile.ts`) that asserts the least
          // about a settled lifecycle, and it keeps an unreadable record on the
          // ESCALATING cleanup-authority route rather than the direct-teardown one.
          state: indeterminate ? "cancelling" : mapClassifiedState(record.state),
          // ★★★ SVC-008a §9.4 — THE MANDATORY INTERIM RULE, and it is a deferral with a
          // rule rather than a hole. `hasLiveLease` is a BOOLEAN and both values are
          // affirmative claims made from nothing: `false` sends a live sandbox whose state
          // field was unreadable to `defaultIsOrphan` (`reconcile.ts`) and then to
          // TEARDOWN; `true` leaks a genuinely dead one past every converge. The
          // non-destructive direction is taken, matching the `indeterminate -> leave it to
          // the reaper` precedent at `startup-reconcile.ts` (`state === "unreachable"` ->
          // `disposition: "indeterminate"`). An indeterminate record must NEVER silently
          // become an orphan verdict, which is what shipped before this line. Whoever
          // answers §9.4 replaces the boolean; until then this loses orphans to the reaper
          // rather than tearing down live work — and `indeterminateRecordCount()` below is
          // how an operator sees how often it fires.
          hasLiveLease: record.state === "running" || indeterminate,
        };
      })
      // DRIVER-OWNED deterministic ordering: real E2B does not promise a stable total
      // order across two list walks, so the driver sorts each page by the opaque
      // resource id. This makes the contract §8 pagination-determinism guarantee a
      // property of the driver's projection, not an artifact of a transport double.
      .sort((a, b) => (a.sandboxId < b.sandboxId ? -1 : a.sandboxId > b.sandboxId ? 1 : 0));
    return { providerOpId, resources, nextPageToken: page.nextPageToken };
  }

  async inspect(sandboxId: string, _ctx: ProviderOpContext): Promise<InspectResult> {
    let record: E2bSandboxRecord;
    try {
      record = await this.#transport.getInfo(sandboxId);
    } catch (err) {
      if (err instanceof E2bTransportNotFoundError) throw new SandboxNotFoundError();
      throw err;
    }
    if (record.state === "unknown") {
      // ★ SVC-008a §4.2 A-iii. An indeterminate record is a PARTIAL READ — not a
      // lifecycle fact and not an absence — so it propagates rather than being collapsed
      // onto a state. Specifically NOT `SandboxNotFoundError`: the cleanup authority maps
      // that to a converged "already gone" success, so laundering an unreadable record
      // into it would end the converge on nothing witnessed.
      this.#indeterminateRecords += 1;
      throw new SandboxRecordIndeterminateError(sandboxId);
    }
    const parsed = parseRecord(record);
    // The FULL, sensitive detail — held here so the cleanup authority's redaction
    // is non-vacuous. `list` deliberately never carries any of this.
    return {
      providerOpId: this.#nextOpId("inspect"),
      sandboxId: record.sandboxId,
      resourceLabels: parsed.labels,
      generation: parsed.labels.deviceGeneration ?? 0,
      state: mapClassifiedState(record.state),
      command: parsed.command,
      env: parsed.env,
      logs: [],
      workspaceBytes: 0,
      objectGrants: [],
      secrets: {},
    };
  }

  /**
   * Read an in-sandbox file's bytes, mapping the transport's not-found onto the domain one.
   *
   * ★ BOTH drivers throw `E2bTransportNotFoundError` for a missing SANDBOX and for a missing
   * PATH alike (`real-transport.ts` `readFile`, `mock-transport.ts` `readFile`), and the
   * distinction does not matter here: either way there is nothing to describe, and the answer
   * must stay a THROW. A fabricated digest would mint a grant for bytes that do not exist and
   * push the refusal all the way out to the fenced commit, far from its cause.
   */
  async #readArtifactBytes(sandboxId: string, path: string): Promise<Uint8Array> {
    try {
      return await this.#transport.readFile(sandboxId, path);
    } catch (err) {
      if (err instanceof E2bTransportNotFoundError) throw new SandboxNotFoundError();
      throw err;
    }
  }

  /**
   * DAT-009 — describe an in-sandbox file. METADATA ONLY; never content.
   *
   * The digest and the size are what let the worker mint a grant at all:
   * `artifactTransferGrantRequestV1Schema` requires BOTH `expectedSha256` and `maxBytes`, and
   * only the provider can see inside the sandbox. That is the whole reason this is a separate
   * operation from the export rather than one call.
   */
  async digestArtifact(sandboxId: string, path: string, _ctx: ProviderOpContext): Promise<ArtifactDigestResult> {
    // ★ HONEST LABEL: this guard is UNREACHABLE BY CONSTRUCTION here, because the mode above is a
    // hard-coded literal. It is kept for exact symmetry with `stageFiles`'s identical shipped
    // guard, and because the port's contract is "the methods are present on every implementer and
    // only SUPPORT is optional" — so the decline path must exist even when this implementer never
    // takes it. It is a contract stub, NOT a live check, and no mutation can kill it; saying so is
    // the difference between a documented stub and a false claim of enforcement.
    if (this.artifactExportMode === "none") throw new UnsupportedProviderOperation("digest_artifact");
    const bytes = await this.#readArtifactBytes(sandboxId, path);
    return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
  }

  /**
   * DAT-009 — move an in-sandbox file to object storage under `grant`, returning a REFERENCE.
   *
   * Grant in, reference out: the bytes go sandbox -> provider -> store and never cross this
   * port. That is the exact inversion of `stageFiles`, and it is what the byte-egress decision
   * (Option D) requires — the daemon is dependency-pinned precisely so it never handles them.
   *
   * ★★ VERIFY BEFORE UPLOADING, and this is not the same check the store does. The grant was
   * minted from a PRIOR `digestArtifact` call, so between the two the file can have grown or
   * changed — a long-running agent still writing, a retry against a mutated sandbox. Re-hashing
   * here refuses AT THE CAUSE. Without it the PUT succeeds, and the fenced commit's `headObject`
   * re-verification rejects a checksum that no longer matches the manifest, in a different
   * process, with nothing left to point at. The size check is separate and comes first: a file
   * that outgrew its grant must not be uploaded at all.
   *
   * Errors carry the path and the digests, never the grant, the url or the headers.
   */
  async exportArtifact(
    sandboxId: string,
    path: string,
    grant: ArtifactUploadGrantV1,
    _ctx: ProviderOpContext,
  ): Promise<ArtifactExportResult> {
    // Unreachable by construction, exactly as in `digestArtifact` above — see the note there.
    if (this.artifactExportMode === "none") throw new UnsupportedProviderOperation("export_artifact");
    const bytes = await this.#readArtifactBytes(sandboxId, path);
    if (bytes.byteLength > grant.maxBytes) {
      throw new Error(`artifact at ${path} is ${bytes.byteLength} bytes, over the granted ${grant.maxBytes}`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== grant.expectedSha256) {
      // The digests, never the url.
      throw new Error(`artifact at ${path} hashed ${digest}, expected ${grant.expectedSha256}`);
    }
    await this.#performUploadGrant(grant, bytes);
    return { objectKey: grant.objectKey };
  }

  /**
   * CLI-008 Unit B — redeem each grant and write the bytes into the sandbox.
   *
   * ★ VERIFY BEFORE WRITING. The digest and the size are checked against the grant's own
   * `expectedSha256`/`maxBytes` before a single byte reaches `writeFiles`. Without that, a
   * store that served the wrong object — or a truncated response — produces a sandbox whose
   * agent works from the wrong instructions and whose run terminalizes cleanly, which is
   * indistinguishable from success on every gate downstream.
   *
   * ALL-OR-NOTHING: every file is fetched and verified first, and the single `writeFiles`
   * call happens only if all of them passed. A partial stage is worse than no stage, because
   * the agent cannot tell which files it is missing.
   *
   * Errors never carry the grant, the url or the headers.
   */
  async stageFiles(
    sandboxId: string,
    files: readonly StagedFileRequest[],
    _ctx: ProviderOpContext,
  ): Promise<StageFilesResult> {
    if (this.fileStagingMode === "none") throw new UnsupportedProviderOperation("stage_files");
    if (files.length === 0) return { stagedPaths: [] };
    const staged: E2bStagedFile[] = [];
    for (const file of files) {
      const bytes = await this.#redeemDownloadGrant(file.grant);
      if (bytes.byteLength > file.grant.maxBytes) {
        throw new Error(
          `staged-input for ${file.path} is ${bytes.byteLength} bytes, over the granted ${file.grant.maxBytes}`,
        );
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== file.grant.expectedSha256) {
        // The digests, never the url.
        throw new Error(
          `staged-input for ${file.path} hashed ${digest}, expected ${file.grant.expectedSha256}`,
        );
      }
      staged.push({ path: file.path, bytes });
    }
    await this.#transport.writeFiles(sandboxId, staged);
    return { stagedPaths: staged.map((file) => file.path) };
  }

  // --- SVC-008a process supervision -------------------------------------------
  //
  // A thin, honest projection of the transport's observations onto the port's. Every
  // arm is either a value the transport WITNESSED or an explicit `unknown` with a reason;
  // there is no default branch anywhere below, which is the property `mapState` lacked.

  #requireProcessSupervision(op: "start_process" | "process_status" | "signal_process"): void {
    // A `"none"` provider THROWS and never returns an observation: an unsupported
    // capability must never be called again, while a returned `unknown` means "escalate
    // and retry". One value cannot carry both handlings, and a caller that wired up a
    // `"none"` provider by mistake would emit an escalation storm instead of failing at
    // the first call. Same mechanism, same failure behaviour, as `stageFiles`.
    if (this.processSupervisionMode === "none") throw new UnsupportedProviderOperation(op);
  }

  async startProcess(input: ExecuteInput, ctx: ProviderOpContext): Promise<ProcessStartResult> {
    this.#requireProcessSupervision("start_process");
    // ★★★ REPLAY BEFORE LAUNCH — the `ProviderOpContext` contract, on the operation where
    // breaking it is most expensive.
    //
    // Without this, `startProcess` twice under one key invoked the transport twice and
    // returned two handles. The realistic producer is a retry after a LOST RESPONSE: the
    // launch succeeded, the answer never arrived, the caller retries with the stable key —
    // and now TWO service instances run in one sandbox while the caller never learned the
    // first handle, so the second is invisible to the very supervisor that would stop it.
    // That is duplicate placement one layer below the epic designed to prevent it.
    //
    // The recorded result is returned VERBATIM (same `providerOpId`, same handle, same
    // `acknowledgedAt`): a freshly minted op id would mean a second op happened, which is
    // the thing being ruled out. An empty key opts out, exactly as it does for `create` —
    // that is the create-gate's deliberate STRIP (`adapter-manager/create-gate.ts`), where a
    // durable ledger above this one is the sole idempotency layer.
    const key = ctx.idempotencyKey;
    if (key) {
      const recorded = this.#processIdempotency.get(key);
      if (recorded) return recorded;
    }
    try {
      const { handle } = await this.#transport.startProcess({
        sandboxId: input.sandboxId,
        command: input.command,
        args: input.args,
        envVars: input.env,
        timeoutMs: this.#ttl(ctx),
      });
      // Belt-and-suspenders on the port's non-empty contract: a transport that regressed
      // to the `String(x ?? "")` idiom must not be able to hand a caller `handle: ""`,
      // which IS present and would read as a started process.
      if (typeof handle !== "string" || handle.length === 0) {
        throw new ProcessLaunchNotAcknowledged(input.sandboxId, "transport returned no usable handle");
      }
      const result: ProcessStartResult = {
        providerOpId: this.#nextOpId("execute"),
        handle,
        acknowledgedAt: Date.now(),
      };
      // ★ RECORDED ONLY ON A WITNESSED LAUNCH. A refusal or an unreadable handle threw
      // above and records nothing, so a retry under the same key is a genuine retry of a
      // launch that never happened — never a replay of a failure.
      if (key) this.#processIdempotency.set(key, result);
      return result;
    } catch (err) {
      if (err instanceof E2bProcessLaunchNotAcknowledgedError) {
        throw new ProcessLaunchNotAcknowledged(input.sandboxId, err.message);
      }
      if (err instanceof E2bTransportNotFoundError) throw new SandboxNotFoundError();
      throw err;
    }
  }

  async processStatus(
    sandboxId: string,
    handle: ProcessHandle,
    _ctx: ProviderOpContext,
  ): Promise<ProcessStatusResult> {
    this.#requireProcessSupervision("process_status");
    return {
      providerOpId: this.#nextOpId("inspect"),
      observation: toPortObservation(await this.#transport.processStatus(sandboxId, handle)),
    };
  }

  async signalProcess(
    sandboxId: string,
    handle: ProcessHandle,
    kind: "cancel" | "kill",
    _ctx: ProviderOpContext,
  ): Promise<ProcessSignalResult> {
    this.#requireProcessSupervision("signal_process");
    const result = await this.#transport.signalProcess(sandboxId, handle, kind);
    return {
      providerOpId: this.#nextOpId(kind === "cancel" ? "cancel" : "kill"),
      accepted: result.accepted,
      observation: toPortObservation(result.observation),
    };
  }

  async checkpoint(sandboxId: string, _ctx: ProviderOpContext): Promise<CheckpointResult> {
    if (!this.advertisedOperations.has("checkpoint") || typeof this.#transport.pause !== "function") {
      throw new UnsupportedProviderOperation("checkpoint");
    }
    const { snapshotId } = await this.#transport.pause(sandboxId);
    return { providerOpId: this.#nextOpId("checkpoint"), mode: this.checkpointMode, checkpointRef: snapshotId };
  }

  async restore(sandboxId: string, _ctx: ProviderOpContext): Promise<RestoreResult> {
    if (!this.advertisedOperations.has("restore") || typeof this.#transport.resume !== "function") {
      throw new UnsupportedProviderOperation("restore");
    }
    await this.#transport.resume(sandboxId);
    return { providerOpId: this.#nextOpId("restore"), restored: true };
  }

  async health(sandboxId: string, _ctx: ProviderOpContext): Promise<HealthResult> {
    if (!this.advertisedOperations.has("health")) {
      throw new UnsupportedProviderOperation("health");
    }
    const running = await this.#transport.isRunning(sandboxId);
    return { providerOpId: this.#nextOpId("health"), mode: "poll", status: running ? "healthy" : "unhealthy" };
  }
}
