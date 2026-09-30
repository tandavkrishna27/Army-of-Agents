// -----------------------------------------------------------------------------
// NetworkedProviderDriver (DEP-012 Slice 1 · Unit A).
//
// Presents the AUTHORITATIVE per-op `SandboxProvider` port over a network hop: each
// implemented op POSTs `{args, ctx}` to the adapter-manager server and deserializes
// `{ok|err}`. It lives OUTSIDE worker-daemon (so the daemon imports nothing new); a
// container composition root (DEP-011) injects it via `deps.provider`, exactly as the
// desktop lane injects `E2bSandboxProvider`.
//
// UNIT A SCOPE. Only `create` + `execute` are wired. The other core ops + the optional
// trio + the artifact pair throw the AUTHORITATIVE `UnsupportedProviderOperation` (the
// worker-daemon class, re-exported via the e2b leaf's `errors.js`) until Unit B builds
// their routes + the server-side ownership gate. `execute`'s route here has NO ownership
// gate and is COMPONENT-TEST-ONLY / not deploy-safe (S1.4).
//
// ★ execute (ONLY) applies the driver-owned zero-deadline short-circuit BEFORE any RPC
// (`deadlineMs <= 0` -> the deterministic timedOut verdict). `create` has no such
// short-circuit — `CreateResult` has no `timedOut` field and the provider substitutes a
// default TTL for a non-positive deadline (e2b-provider.ts #ttl), so there is nothing to
// mirror. Uses Node's global `fetch`; a caller may inject one (tests spy on the hop).
// -----------------------------------------------------------------------------

import type {
  ArtifactDigestResult,
  ArtifactExportMode,
  FileStagingMode,
  StageFilesResult,
  StagedFileRequest,
  ArtifactExportResult,
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
  ProcessSignalResult,
  ProcessStartResult,
  ProcessStatusResult,
  ProcessSupervisionMode,
  ProviderOperation,
  ProviderOpContext,
  RedactedResourceProjection,
  ResourceLabels,
  ResourceSummary,
  RestoreResult,
  SandboxProvider,
  StopResult,
} from "@armyofagents/worker-daemon";
import type { ArtifactUploadGrantV1 } from "@armyofagents/worker-protocol";
import { CORE_PROVIDER_OPERATIONS } from "@armyofagents/worker-protocol";
import { ResourceNotAvailableError, UnsupportedProviderOperation } from "@armyofagents/sandbox-e2b-provider/errors.js";

import { decodeOpResponse, encodeOpRequest } from "./codec.js";
import type { OwnedLabelsCapability } from "./capability.js";
import type { RedactedListResult } from "./projection.js";

export interface NetworkedProviderDriverOptions {
  /** The adapter-manager base URL, e.g. `http://adapter-manager:PORT`. */
  readonly baseUrl: string;
  /** Injectable fetch (default: the global). Tests spy on the network hop through it. */
  readonly fetch?: typeof fetch;
  /**
   * The owned-labels capability the driver attaches to GATE-REQUIRED ops (DEP-012
   * Unit B1: `execute` + the teardown/read ops; Slice 3 · β1 adds `create`). Sourced
   * OUT-OF-BAND — the `SandboxProvider` port ops have NO capability slot, so it is
   * injected here (the container composition root / DEP-011 supplies the control-plane-
   * minted token), NOT threaded through the caller. On a KEYED server `create` now
   * carries it (the create-gate verifies + label-matches + namespaces the ledger); an
   * UNGATED server ignores it (create's Unit-A body is byte-identical when it is absent).
   */
  readonly capability?: OwnedLabelsCapability;
}

export class NetworkedProviderDriver implements SandboxProvider {
  // Shape-faithful to the port contract ("always a superset of the 8 core ops").
  // Unit A only IMPLEMENTS create + execute; the rest throw until Unit B — an honest
  // "not built yet", not a silent no-op.
  readonly advertisedOperations: ReadonlySet<ProviderOperation> = new Set(CORE_PROVIDER_OPERATIONS);
  readonly checkpointMode: CheckpointMode = "none";
  readonly healthMode: HealthMode = "none";
  readonly artifactExportMode: ArtifactExportMode = "none";
  /**
   * E7-F011 — `"grant_download"`: this driver RELAYS staging over the wire (the route CLI-008
   * Unit B's comment called "its own piece of work"). `stage_files` is still NOT a member of
   * the frozen `ProviderOperation` vocabulary (deliberately — see `FileStagingMode`); the
   * route is added by widening `#post`'s op type LOCALLY to `ProviderOperation | "stage_files"`
   * (never the frozen vocabulary), and `stageFiles` below POSTs `/op/stage_files`. Like
   * `create`/`execute`, the mode asserts only that the driver can RELAY the op — if the FAR
   * provider is `"none"`, its `stageFiles` throws `UnsupportedProviderOperation`, which the
   * codec carries back and re-throws client-side. Honest failure, not a silent drop.
   */
  readonly fileStagingMode: FileStagingMode = "grant_download";

  /**
   * SVC-008a — `"none"`, and honestly so, for exactly the reason `fileStagingMode` is.
   *
   * `start_process` / `process_status` / `signal_process` are NOT members of the frozen
   * `ProviderOperation` vocabulary (deliberately — see `ProcessSupervisionMode`), and
   * `#post` is typed to that vocabulary, so this driver has no wire route to reach a
   * remote provider's process supervision. Giving the adapter-manager wire an inbound
   * process route is its own piece of work; claiming support without one would silently
   * drop every signal and report a launch nobody made.
   *
   * ★ Consequence, stated rather than smuggled: the containerized/networked lane CANNOT
   * supervise a service until that route exists. That is the identical, accepted cost
   * CLI-008 Unit B paid for `stageFiles`, and this ticket does not take it on.
   */
  readonly processSupervisionMode: ProcessSupervisionMode = "none";

  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #capability?: OwnedLabelsCapability;

  constructor(options: NetworkedProviderDriverOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#capability = options.capability;
  }

  async create(spec: CreateSandboxSpec, ctx: ProviderOpContext): Promise<CreateResult> {
    // create is GATE-REQUIRED on a KEYED server (DEP-012 Slice 3 · β1) — attach the
    // owned-labels capability (undefined when the driver was constructed without one;
    // an ungated server ignores it and keeps create's Unit-A byte-identical body, while
    // a gated server refuses on absence with the uniform error). ONE-arg change: `#post`
    // already types `op: ProviderOperation` and threads an optional capability.
    return this.#post<CreateResult>("create", spec, ctx, this.#capability);
  }

  async execute(input: ExecuteInput, ctx: ProviderOpContext): Promise<ExecuteResult> {
    // Driver-owned zero-deadline verdict — the CLIENT short-circuits before the RPC, so
    // the server is never consulted for an exhausted budget (mirrors the provider's own
    // deadlineMs<=0 short-circuit, kept driver-side so the wire preserves it).
    if (ctx.deadlineMs <= 0) {
      return {
        providerOpId: `wire-execute-zero-deadline:${input.sandboxId}`,
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        stdoutRef: `ref:stdout:${input.sandboxId}`,
        stderrRef: `ref:stderr:${input.sandboxId}`,
      };
    }
    // execute is GATE-REQUIRED — attach the owned-labels capability (undefined when the
    // driver was constructed without one; the server then refuses with the uniform error).
    return this.#post<ExecuteResult>("execute", input, ctx, this.#capability);
  }

  // --- the gate-required teardown ops (DEP-012 Unit B2) -----------------------------
  // Each attaches the owned-labels capability and POSTs; the server verifies + owned-checks
  // + dispatches (or refuses with the uniform ResourceNotAvailableError). The results
  // (StopResult/CleanupResult) are NON-sensitive, so they cross byte-identically.

  async cancel(sandboxId: string, ctx: ProviderOpContext): Promise<StopResult> {
    return this.#post<StopResult>("cancel", sandboxId, ctx, this.#capability);
  }
  async kill(sandboxId: string, ctx: ProviderOpContext): Promise<StopResult> {
    return this.#post<StopResult>("kill", sandboxId, ctx, this.#capability);
  }
  async destroy(sandboxId: string, ctx: ProviderOpContext): Promise<CleanupResult> {
    return this.#post<CleanupResult>("destroy", sandboxId, ctx, this.#capability);
  }
  async reconcileCleanup(sandboxId: string, ctx: ProviderOpContext): Promise<CleanupResult> {
    return this.#post<CleanupResult>("reconcile_cleanup", sandboxId, ctx, this.#capability);
  }

  // --- the gate-required redacted reads (DEP-012 Unit B2) ----------------------------
  // The wire carries a REDACTED projection ONLY (hashed labels, no env/secrets/command).
  // The port demands the full InspectResult / ResourceSummary, so the driver SYNTHESIZES a
  // port-shaped result from the caller's OWN labels (cap.ownedLabels — provably equal to
  // the target on the allow path) + the server's projection: resourceLabels from the
  // capability (F2-clean — own labels only), state + generation FROM THE PROJECTION (never
  // invented), and EMPTY sensitive fields. The redacting wire can honor the port no other way.

  async inspect(sandboxId: string, ctx: ProviderOpContext): Promise<InspectResult> {
    const projection = await this.#post<RedactedResourceProjection>("inspect", sandboxId, ctx, this.#capability);
    return this.#synthesizeInspect(projection);
  }

  async list(input: ListInput, ctx: ProviderOpContext): Promise<ListResult> {
    const redacted = await this.#post<RedactedListResult>("list", input, ctx, this.#capability);
    return {
      providerOpId: redacted.providerOpId,
      resources: redacted.resources.map((p) => this.#synthesizeSummary(p)),
      nextPageToken: redacted.nextPageToken,
    };
  }

  async checkpoint(_sandboxId: string, _ctx: ProviderOpContext): Promise<CheckpointResult> {
    throw new UnsupportedProviderOperation("checkpoint");
  }
  async restore(_sandboxId: string, _ctx: ProviderOpContext): Promise<RestoreResult> {
    throw new UnsupportedProviderOperation("restore");
  }
  async health(_sandboxId: string, _ctx: ProviderOpContext): Promise<HealthResult> {
    throw new UnsupportedProviderOperation("health");
  }
  async digestArtifact(_sandboxId: string, _path: string, _ctx: ProviderOpContext): Promise<ArtifactDigestResult> {
    throw new UnsupportedProviderOperation("digest_artifact");
  }
  async exportArtifact(
    _sandboxId: string,
    _path: string,
    _grant: ArtifactUploadGrantV1,
    _ctx: ProviderOpContext,
  ): Promise<ArtifactExportResult> {
    throw new UnsupportedProviderOperation("export_artifact");
  }
  async stageFiles(
    sandboxId: string,
    files: readonly StagedFileRequest[],
    ctx: ProviderOpContext,
  ): Promise<StageFilesResult> {
    // E7-F011 — the networked lane's stage_files wire route. GATE-REQUIRED (staging writes
    // into a live OWNED sandbox), so it attaches the owned-labels capability exactly like
    // `execute`; a gated server owned-checks it, an ungated server 404s it. GRANT, NOT BYTES
    // (E4-D01): each `StagedFileRequest` carries an `ArtifactDownloadGrantV1` (a bearer
    // capability, `redaction:"secret"`) and NO payload — the far provider redeems + verifies
    // sha256/maxBytes + writes, so no bytes cross the daemon. Two port params packed into one
    // opaque `args`, as `execute` embeds `sandboxId` in `ExecuteInput`.
    return this.#post<StageFilesResult>("stage_files", { sandboxId, files }, ctx, this.#capability);
  }

  // SVC-008a — a `"none"` provider THROWS from all three; it never returns an
  // observation. A returned `unknown` is indistinguishable at the call site from a
  // transient read failure, whose prescribed response is "escalate and retry" — so a
  // caller that wired up this driver by mistake would retry forever instead of failing
  // at the first call. The throw is unmissable and names the operation.
  async startProcess(_input: ExecuteInput, _ctx: ProviderOpContext): Promise<ProcessStartResult> {
    throw new UnsupportedProviderOperation("start_process");
  }
  async processStatus(
    _sandboxId: string,
    _handle: ProcessHandle,
    _ctx: ProviderOpContext,
  ): Promise<ProcessStatusResult> {
    throw new UnsupportedProviderOperation("process_status");
  }
  async signalProcess(
    _sandboxId: string,
    _handle: ProcessHandle,
    _kind: "cancel" | "kill",
    _ctx: ProviderOpContext,
  ): Promise<ProcessSignalResult> {
    throw new UnsupportedProviderOperation("signal_process");
  }

  async #post<R>(
    // E7-F011 — locally widened beyond the FROZEN `ProviderOperation` vocabulary to carry the
    // non-frozen `stage_files` route (the vocabulary itself is untouched — E4-D02). Additive:
    // every existing caller still passes a `ProviderOperation`.
    op: ProviderOperation | "stage_files",
    args: unknown,
    ctx: ProviderOpContext,
    capability?: OwnedLabelsCapability,
  ): Promise<R> {
    const res = await this.#fetch(`${this.#baseUrl}/op/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodeOpRequest(args, ctx, capability),
    });
    // Body-driven: the codec decides ok vs err vs garbled regardless of HTTP status. A
    // non-JSON / non-envelope body (e.g. a bare 500) surfaces as a WireProtocolError,
    // never as a silent success.
    return decodeOpResponse<R>(await res.text());
  }

  /** The caller's OWN labels, or a fail-closed refusal. Only reached AFTER a successful
   * decode of a gated read — the server refuses (and #post throws) when no capability is
   * carried — so `#capability` is defined here; the guard is defense-in-depth. */
  #ownedLabels(): ResourceLabels {
    if (this.#capability === undefined) throw new ResourceNotAvailableError();
    return this.#capability.ownedLabels;
  }

  /** Reconstruct the port's InspectResult from own labels + the redacted projection.
   * F2-clean: own labels only; state/generation FROM the projection; sensitive fields EMPTY. */
  #synthesizeInspect(projection: RedactedResourceProjection): InspectResult {
    return {
      providerOpId: projection.providerOpId,
      sandboxId: projection.sandboxId,
      resourceLabels: this.#ownedLabels(),
      generation: projection.generation,
      state: projection.state,
      command: "",
      env: {},
      logs: [],
      workspaceBytes: 0,
      objectGrants: [],
      secrets: {},
    };
  }

  /** Reconstruct a port ResourceSummary from own labels + a redacted row. `hasLiveLease`
   * is SYNTHESIZED faithfully (`state === "running"`, matching e2b-provider.ts:308) — never
   * a hardcoded default; no B2 consumer reads it, but a DEP-011 reconcile consumer would.
   * `nextPageToken` (on the ListResult) is whatever the server sent — null for B2's narrow
   * list (the server exposes no cursor; skeptic F1) — passed through, never invented here. */
  #synthesizeSummary(projection: RedactedResourceProjection): ResourceSummary {
    return {
      sandboxId: projection.sandboxId,
      resourceLabels: this.#ownedLabels(),
      generation: projection.generation,
      state: projection.state,
      hasLiveLease: projection.state === "running",
    };
  }
}
