// -----------------------------------------------------------------------------
// MockE2bTransport — the deterministic, key-less, pure-TS E2B transport double
// (CLI-001/D3). It records the call shapes the real driver makes and replays a
// faithful E2B-shaped response, so the REAL `E2bSandboxProvider` logic is proven
// (op routing, idempotency, TTL, redaction-source, denial translation, idempotent
// cleanup) WITHOUT a key or a network. It is the ONLY substituted layer.
//
// It decodes the reserved fault directives (`directives.ts`) the E6-F008 adapter
// folds into create/execute env, and simulates exactly what a real E2B sandbox
// would do under fault: an ignored signal, a transient teardown that a retry
// clears, a blocked egress carrying its class, a deterministic timeout/crash. The
// directives are the ONLY non-happy-path input; with none it behaves as a clean
// sandbox host. It makes NO authority decision — the facet/authority gate is the
// adapter's, the domain translation is the provider's.
// -----------------------------------------------------------------------------

import { decodeCreateFaults, decodeExecuteFaults } from "./directives.js";
import {
  E2bProcessLaunchNotAcknowledgedError,
  E2bTransportEgressBlockedError,
  E2bTransportNotFoundError,
  E2bTransportTransientError,
  type E2bCommandResult,
  type E2bProcessHandle,
  type E2bProcessObservation,
  type E2bProcessSignalResult,
  type E2bProcessStartResult,
  type E2bProcessSupervisionMode,
  type E2bStartProcessRequest,
  type E2bCreateRequest,
  type E2bListPage,
  type E2bListRequest,
  type E2bRecordState,
  type E2bRunCommandRequest,
  type E2bSandboxRecord,
  type E2bSignalResult,
  type E2bStagedFile,
  type E2bStreamHandlers,
  type E2bTransport,
} from "./transport.js";

interface MockRecord {
  sandboxId: string;
  metadata: Record<string, string>;
  state: E2bRecordState;
  ignoreCancel: boolean;
  ignoreKill: boolean;
  /** Remaining teardown attempts that FAIL transiently before reclamation. */
  destroyFailuresRemaining: number;
  /** CLI-002/D1 — deterministic in-memory filesystem: absolute path → bytes. */
  fs: Map<string, Uint8Array>;
  /** SVC-008a — every `getInfo`/`list` read of this record THROWS. Models the branch that
   * used to be laundered into `{delivered: true}` from `signal`'s own catch (E7-F034). */
  readFails: boolean;
  /** SVC-008a — this record's `state` is `"unknown"`. The mock's records never pass
   * through `mapState`, so without this directive the unrecognized-payload case (§4.2
   * A-i) would be testable on the KEYED arm only — i.e. skipped in the CI that runs. */
  stateUnknown: boolean;
  /** SVC-008a — `startProcess` cannot be acknowledged. */
  refuseLaunch: boolean;
  /** SVC-008a — every `processStatus` read of this sandbox's processes THROWS. */
  processReadFails: boolean;
  /** SVC-008a — in-sandbox processes: handle → its observation-bearing record. */
  processes: Map<string, MockProcess>;
}

interface MockProcess {
  handle: string;
  state: "running" | "exited";
  exitCode: number | null;
  signal: string | null;
}

export interface MockE2bTransportOptions {
  /** Advertise pause/resume support (so a provider may advertise checkpoint/
   * restore). Default false — matches the no-key core's default disposition. */
  readonly supportsPauseResume?: boolean;
}

export class MockE2bTransport implements E2bTransport {
  readonly #records = new Map<string, MockRecord>();
  #counter = 0;

  // `pause`/`resume` are conditionally present so the provider's advertisement gate
  // is exercised on both branches. Assigned in the constructor when enabled.
  pause?: (sandboxId: string) => Promise<{ readonly snapshotId: string }>;
  resume?: (sandboxId: string) => Promise<void>;

  constructor(options: MockE2bTransportOptions = {}) {
    if (options.supportsPauseResume) {
      this.pause = async (sandboxId: string) => {
        this.#requireRecord(sandboxId).state = "paused";
        return { snapshotId: `snap-${sandboxId}` };
      };
      this.resume = async (sandboxId: string) => {
        this.#requireRecord(sandboxId).state = "running";
      };
    }
  }

  #requireRecord(sandboxId: string): MockRecord {
    const record = this.#records.get(sandboxId);
    if (!record) throw new E2bTransportNotFoundError(sandboxId);
    return record;
  }

  async create(req: E2bCreateRequest): Promise<{ sandboxId: string }> {
    this.#counter += 1;
    // Zero-padded so lexical sort === creation order (deterministic pagination).
    const sandboxId = `sbx-${String(this.#counter).padStart(6, "0")}`;
    // ★ [Cred-1] (DEP-012 Slice 4+5) — decode the create-fault directives from `envVars`,
    // NOT `metadata[__aoa_env]`: the real provider no longer copies the tenant env into
    // durable metadata (it would leave the model key AT REST). `envVars` carries the same
    // env, so the deterministic fault contract is unchanged (parity with runCommand, which
    // already reads `req.envVars`).
    const faults = decodeCreateFaults(req.envVars);
    this.#records.set(sandboxId, {
      sandboxId,
      // SVC-008a — a record whose state field the parser could not classify. The mock's
      // records are minted from its own store and never pass through `mapState`, so this
      // directive is the only no-key way to reach the `unknown` state arm.
      state: faults.stateUnknown ? "unknown" : "running",
      metadata: { ...req.metadata },
      ignoreCancel: faults.ignoreCancel,
      ignoreKill: faults.ignoreKill,
      destroyFailuresRemaining: faults.destroyFailures,
      fs: new Map<string, Uint8Array>(),
      readFails: faults.readFails,
      stateUnknown: faults.stateUnknown,
      refuseLaunch: faults.refuseLaunch,
      processReadFails: faults.processReadFails,
      processes: new Map<string, MockProcess>(),
    });
    return { sandboxId };
  }

  async runCommand(req: E2bRunCommandRequest, handlers?: E2bStreamHandlers): Promise<E2bCommandResult> {
    const record = this.#requireRecord(req.sandboxId);
    const faults = decodeExecuteFaults(req.envVars);
    if (faults.egressClass && faults.egressClass !== "allow") {
      throw new E2bTransportEgressBlockedError(faults.egressClass);
    }
    // CLI-002/D1 — the fake CLI's file mutations: apply the reserved fs-write
    // directive to the in-memory fs BEFORE reporting a terminal, modeling a real
    // CLI writing a KNOWN file inside the sandbox. Skipped on a crash/timeout run.
    // CLI-003/D1 — the fake CLI's streamed output: replay the reserved stream-chunk
    // directive to the onStdout/onStderr callbacks in order, modeling a real CLI
    // emitting output as it runs. Skipped on a crash/timeout run (no clean stream).
    if (faults.lifecycleFault === null) {
      for (const write of faults.fsWrites) {
        record.fs.set(write.path, new TextEncoder().encode(write.content));
      }
      if (handlers) {
        for (const chunk of faults.streamChunks) {
          if (chunk.stream === "stdout") handlers.onStdout?.(chunk.data);
          else handlers.onStderr?.(chunk.data);
        }
      }
    }
    // HONEST transport semantics: a zero/positive command budget does NOT itself
    // decide the timeout — the driver owns the zero-budget verdict (e2b-provider
    // short-circuits deadlineMs<=0 before ever reaching the transport), and real E2B
    // enforces a positive budget itself. The ONLY transport-authored timeout here is a
    // sandbox-TTL fire (lifecycleFault:"ttl"), a genuine provider-side mechanism.
    const timedOut = faults.lifecycleFault === "ttl";
    const crashed = faults.lifecycleFault === "crash";
    return {
      exitCode: crashed ? 1 : timedOut ? null : 0,
      signal: timedOut ? "SIGKILL" : null,
      timedOut,
      crashed,
    };
  }

  async signal(sandboxId: string, kind: "cancel" | "kill"): Promise<E2bSignalResult> {
    const record = this.#records.get(sandboxId);
    // Already gone: an ABSENCE this store genuinely answered, so it is a witness.
    if (!record) return { observed: "stopped" };
    // ★ SVC-008a — the two arms production has and no double could previously produce.
    if (record.readFails) return { observed: "unknown" };
    if (record.state === "unknown") return { observed: "unknown" };
    if (kind === "cancel" && record.ignoreCancel) return { observed: "still_running" };
    if (kind === "kill" && record.ignoreKill) return { observed: "still_running" };
    record.state = "stopped";
    return { observed: "stopped" };
  }

  // --- SVC-008a process supervision -------------------------------------------
  //
  // ★★★ THE DOUBLE MUST NOT BE MORE CAPABLE THAN PRODUCTION, and that is asserted by the
  // conformance suite rather than left to review. The one place it would have been is
  // `signalProcess("cancel")`: a mock that genuinely stopped a process gracefully, while
  // `RealE2bTransport` reports `unsupported` because `e2b@2.30.5` exposes no per-pid
  // SIGTERM, would rebuild E7-F034's exact shape one layer up. So this mock reports
  // `unsupported` for `"cancel"` too.

  readonly processSupervisionMode: E2bProcessSupervisionMode = "handle";

  async startProcess(req: E2bStartProcessRequest): Promise<E2bProcessStartResult> {
    const record = this.#requireRecord(req.sandboxId);
    if (record.refuseLaunch) {
      // No handle comes back at all — never `handle: ""`, which is "present" and would
      // read to a caller as a started process.
      throw new E2bProcessLaunchNotAcknowledgedError(req.sandboxId, "launch refused by directive");
    }
    this.#counter += 1;
    const handle = `proc-${String(this.#counter).padStart(6, "0")}`;
    record.processes.set(handle, { handle, state: "running", exitCode: null, signal: null });
    return { handle };
  }

  async processStatus(sandboxId: string, handle: E2bProcessHandle): Promise<E2bProcessObservation> {
    const record = this.#records.get(sandboxId);
    if (!record) return { state: "unknown", reason: "sandbox_unreachable" };
    // A read that THREW — distinct from an answer of absence, which is the distinction
    // `RealE2bTransport.isRunning`'s `catch { return false }` cannot make.
    if (record.processReadFails) return { state: "unknown", reason: "read_failed" };
    const proc = record.processes.get(handle);
    // The store ANSWERED and this handle is not in it.
    if (!proc) return { state: "gone" };
    if (proc.state === "exited") return { state: "exited", exitCode: proc.exitCode, signal: proc.signal };
    return { state: "running" };
  }

  async signalProcess(
    sandboxId: string,
    handle: E2bProcessHandle,
    kind: "cancel" | "kill",
  ): Promise<E2bProcessSignalResult> {
    const record = this.#records.get(sandboxId);
    if (!record) {
      return { accepted: "refused", observation: { state: "unknown", reason: "sandbox_unreachable" } };
    }
    if (kind === "cancel") {
      // Deliberately NOT more capable than `RealE2bTransport` — see the block comment.
      return { accepted: "unsupported", observation: await this.processStatus(sandboxId, handle) };
    }
    const proc = record.processes.get(handle);
    if (!proc) {
      return { accepted: "refused", observation: await this.processStatus(sandboxId, handle) };
    }
    if (!record.ignoreKill) {
      proc.state = "exited";
      proc.exitCode = null;
      proc.signal = "SIGKILL";
    }
    // ★ `accepted` describes the CALL and nothing else — under `ignoreKill` the request
    // was taken and the process is still running, which is real E2B's only interesting
    // case and the one a caller must not read as success.
    return { accepted: "accepted", observation: await this.processStatus(sandboxId, handle) };
  }

  async terminate(sandboxId: string): Promise<void> {
    const record = this.#records.get(sandboxId);
    if (!record) throw new E2bTransportNotFoundError(sandboxId);
    if (record.destroyFailuresRemaining > 0) {
      record.destroyFailuresRemaining -= 1;
      throw new E2bTransportTransientError();
    }
    this.#records.delete(sandboxId);
  }

  async getInfo(sandboxId: string): Promise<E2bSandboxRecord> {
    const record = this.#requireRecord(sandboxId);
    // SVC-008a — a read that THREW. Distinguishable from an answer, which is the whole
    // point: the pre-fix `signal` could not tell them apart and reported both as a stop.
    if (record.readFails) throw new E2bTransportTransientError("e2b transport: getInfo failed");
    return { sandboxId: record.sandboxId, metadata: { ...record.metadata }, state: record.state };
  }

  async list(req: E2bListRequest): Promise<E2bListPage> {
    const all = [...this.#records.values()]
      .sort((a, b) => (a.sandboxId < b.sandboxId ? -1 : a.sandboxId > b.sandboxId ? 1 : 0))
      .map((r): E2bSandboxRecord => ({ sandboxId: r.sandboxId, metadata: { ...r.metadata }, state: r.state }));
    const cursor = req.pageToken ?? null;
    let start = 0;
    if (cursor !== null) {
      const idx = all.findIndex((r) => r.sandboxId === cursor);
      start = idx >= 0 ? idx + 1 : all.length;
    }
    const slice = all.slice(start, start + req.pageSize);
    const end = start + slice.length;
    const nextPageToken = end < all.length && slice.length > 0 ? slice[slice.length - 1].sandboxId : null;
    return { items: slice, nextPageToken };
  }

  async setTimeout(sandboxId: string, _timeoutMs: number): Promise<void> {
    this.#requireRecord(sandboxId);
  }

  async isRunning(sandboxId: string): Promise<boolean> {
    const record = this.#records.get(sandboxId);
    return record !== undefined && record.state === "running";
  }

  // --- CLI-002/D1 staging fs primitives -------------------------------------

  async writeFiles(sandboxId: string, files: readonly E2bStagedFile[]): Promise<void> {
    const record = this.#requireRecord(sandboxId);
    for (const file of files) {
      // Copy the bytes so a later caller mutation of the source buffer can't
      // retroactively alter staged content (deterministic isolation).
      record.fs.set(file.path, Uint8Array.from(file.bytes));
    }
  }

  async readFile(sandboxId: string, path: string): Promise<Uint8Array> {
    const record = this.#requireRecord(sandboxId);
    const bytes = record.fs.get(path);
    if (bytes === undefined) throw new E2bTransportNotFoundError(`${sandboxId}:${path}`);
    return Uint8Array.from(bytes);
  }

  async listDir(sandboxId: string, path: string): Promise<readonly string[]> {
    const record = this.#requireRecord(sandboxId);
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return [...record.fs.keys()].filter((p) => p === path || p.startsWith(prefix)).sort();
  }

  /** Test-only: current live sandbox count (zero after a full converge). */
  liveCount(): number {
    return this.#records.size;
  }
}


export function createMockE2bTransport(options: MockE2bTransportOptions = {}): MockE2bTransport {
  return new MockE2bTransport(options);
}
