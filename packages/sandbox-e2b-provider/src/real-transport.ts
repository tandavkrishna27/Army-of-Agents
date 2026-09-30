// -----------------------------------------------------------------------------
// RealE2bTransport — the `e2b` SDK binding of the transport seam (CLI-001/D1/D4).
//
// This is the ONLY module that touches the `e2b` SDK and the ONLY module that
// reads the provider-control credential (`E2B_API_KEY`). It is exercised solely by
// the keyed real-E2B lane (`E2B_API_KEY` present); the no-key core never imports
// it (the tests inject `MockE2bTransport`). It is authored + parse-verified here;
// the operator supplies the key + template and dispatches the lane.
//
// The credential is confined here (DEP-006 reuse): it is read from the environment
// (rotatable/revocable without touching this code) and passed only to the SDK — it
// never crosses the provider-neutral invoke seam, never enters a projection, and
// never appears in the adapter/provider/mock. The static boundary checker asserts
// `E2B_API_KEY` appears in NO other runtime source file.
//
// The `e2b` surface is accessed through a deliberately loose local facade: the SDK
// types are broad and version-sensitive, and this binding is not run in the no-key
// build, so its SDK interactions are cast rather than statically pinned. Behavioral
// correctness is the keyed lane's job, not the typechecker's.
// -----------------------------------------------------------------------------

import { CommandExitError, Sandbox } from "e2b";

import {
  E2bProcessLaunchNotAcknowledgedError,
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
import { isE2bNotFound, shellJoin } from "./real-transport-helpers.js";

/** Loose facade over the version-sensitive `e2b` SDK surface (keyed lane only). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SandboxSdk = any;

export interface RealE2bTransportOptions {
  /** The provider-control API key. Defaults to `process.env.E2B_API_KEY`. Read
   * ONLY here (DEP-006 credential confinement). */
  readonly apiKey?: string;
  /** Advertise pause/resume (E2B beta) — off by default. */
  readonly enablePauseResume?: boolean;
  /**
   * ★ TEST-ONLY SDK INJECTION, and its limits are stated rather than implied.
   *
   * Defaults to the real `e2b` `Sandbox` class. A suite may substitute a stub so the
   * PRODUCTION parsing and verdict-derivation code in this file (`mapState`, `toRecord`,
   * `signal`, `processStatus`) can be driven keylessly against the response shapes a real
   * SDK can return. That proves this file's LOGIC; it proves NOTHING about what the live
   * `e2b` service actually returns, and it is never a substitute for the keyed arm —
   * which is why T8's keyed arm reports SKIPPED, never passed, when `E2B_API_KEY` is
   * absent. Injecting here does not make this a double: the code under test is the
   * shipping code, and only the SDK boundary moves.
   */
  readonly sdk?: unknown;
}

function requireApiKey(explicit?: string): string {
  const key = explicit ?? process.env.E2B_API_KEY;
  if (!key || key.length === 0) {
    throw new Error("RealE2bTransport requires E2B_API_KEY (provider-control credential) — set it in the keyed lane, never in the no-key build");
  }
  return key;
}

/**
 * ★★★ SVC-008a §4.2 A-i — RECOGNITION IS EXPLICIT AND THE FALLTHROUGH IS HONEST.
 *
 * This function used to be `if includes("run") … if includes("paus") … return "stopped"`,
 * fed `info?.state ?? info?.status` by {@link toRecord}. So an ABSENT, RENAMED or
 * NON-STRING state field — an SDK field rename anywhere in the pinned `^2.30.5` range, a
 * partial or error-shaped response body, a future `"hibernated"` — became
 * `state: "stopped"`: an affirmative stop derived from a read that witnessed nothing
 * about the state. That is E7-F034's class, one layer below where the finding measured
 * it, and it would have been rebuilt inside E7-F034's own repair.
 *
 * Now every recognized value is matched POSITIVELY and everything else is `"unknown"`.
 * `"unknown"` is the honest inhabitant, and the provider maps it to the ESCALATING stop
 * verdict, never the terminating one.
 */
export function mapState(raw: unknown): E2bRecordState {
  if (typeof raw !== "string") return "unknown"; // absent / renamed / non-string
  const s = raw.toLowerCase();
  if (s.includes("run")) return "running";
  if (s.includes("paus")) return "paused";
  if (s.includes("stop") || s.includes("kill") || s.includes("terminat")) return "stopped";
  return "unknown"; // ★ NOT "stopped"
}

/** Parse a transport-minted handle back to a pid. A handle this binding did not mint —
 * or one carrying no usable pid — is `null`, which becomes `handle_unrecognized`: an
 * honest "I cannot look this up", never a guess about the process. */
function parseHandle(handle: string): number | null {
  if (typeof handle !== "string" || handle.length === 0) return null;
  if (!/^[0-9]+$/.test(handle)) return null;
  const pid = Number.parseInt(handle, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function toRecord(info: SandboxSdk): E2bSandboxRecord {
  const metadata = (info?.metadata ?? {}) as Record<string, string>;
  return {
    sandboxId: String(info?.sandboxId ?? info?.sandbox_id ?? ""),
    metadata,
    state: mapState(info?.state ?? info?.status),
  };
}

export class RealE2bTransport implements E2bTransport {
  readonly #apiKey: string;
  readonly #sdk: SandboxSdk;
  pause?: (sandboxId: string) => Promise<{ readonly snapshotId: string }>;
  resume?: (sandboxId: string) => Promise<void>;

  constructor(options: RealE2bTransportOptions = {}) {
    this.#apiKey = requireApiKey(options.apiKey);
    this.#sdk = (options.sdk ?? Sandbox) as SandboxSdk;
    if (options.enablePauseResume) {
      this.pause = async (sandboxId: string) => {
        const snapshotId = await this.#sdk.betaPause(sandboxId, { apiKey: this.#apiKey });
        return { snapshotId: String(snapshotId ?? sandboxId) };
      };
      this.resume = async (sandboxId: string) => {
        await this.#sdk.connect(sandboxId, { apiKey: this.#apiKey });
      };
    }
  }

  async create(req: E2bCreateRequest): Promise<{ sandboxId: string }> {
    const sandbox = await this.#sdk.create(req.templateId, {
      apiKey: this.#apiKey,
      timeoutMs: req.timeoutMs,
      metadata: req.metadata,
      envs: req.envVars,
    });
    return { sandboxId: String(sandbox?.sandboxId ?? "") };
  }

  async runCommand(req: E2bRunCommandRequest, handlers?: E2bStreamHandlers): Promise<E2bCommandResult> {
    const sandbox = await this.#sdk.connect(req.sandboxId, { apiKey: this.#apiKey });
    // Quote every token so the argv survives the collapse into e2b's single
    // command-STRING API — a naive space-join silently breaks `sh -c "<script>"`.
    const full = shellJoin(req.command, req.args);
    try {
      // CLI-003/D1 — bind the `e2b` SDK command stream to the streaming callbacks.
      // The SDK invokes `onStdout`/`onStderr` with each output chunk as it is
      // produced; they are best-effort observation and never alter the result.
      const result = await sandbox.commands.run(full, {
        envs: req.envVars,
        timeoutMs: req.timeoutMs,
        onStdout: handlers?.onStdout ? (data: unknown) => handlers.onStdout?.(String(data)) : undefined,
        onStderr: handlers?.onStderr ? (data: unknown) => handlers.onStderr?.(String(data)) : undefined,
      });
      const exitCode = typeof result?.exitCode === "number" ? result.exitCode : 0;
      return { exitCode, signal: null, timedOut: false, crashed: exitCode !== 0 };
    } catch (err) {
      // ── (a) THE COMMAND RAN AND EXITED NON-ZERO. A normal outcome, NOT a fault.
      //
      // E7-F014, observed in a real E2B sandbox (run 33789547290, confirmed by the
      // mutant run 33790235730): `sandbox.commands.run()` is `start()` then
      // `CommandHandle.wait()`, and `wait()` THROWS for any non-zero exit —
      // `if (this.result.exitCode !== 0) throw new CommandExitError(this.result)`
      // (e2b@2.30.5, `src/sandbox/commands/commandHandle.ts:176`). Nothing on the way
      // out converted it back, so `result` above was never assigned, the throw
      // travelled through `E2bSandboxProvider.execute` untouched, and the supervisor's
      // execute-catch wrote the durable terminal as `exitCode: null` +
      // `errorCode: "execute_failed"`. Every failing distributed run lost its exit
      // code, and `crashed: exitCode !== 0` above was unreachable.
      //
      // `CommandExitError` is an exception carrying a COMPLETED `CommandResult`
      // (`implements CommandResult`, with an `exitCode: number` getter), so convert it
      // back into the ordinary result shape this seam already models — and which
      // `MockE2bTransport` has always returned for a crashed command
      // (`{ exitCode: 1, crashed: true }`). That restores attribution without any new
      // shape: the provider passes `exitCode` straight through, and the supervisor
      // reaches its ORDINARY terminal (`status` from the code, not the catch).
      //
      // ★ NARROW ON THE CLASS, AND READ THE STATUS OFF IT — never manufacture one.
      // The SDK draws precisely this line itself, in the same `wait()`: a command that
      // produced NO exit status throws `iterationError` or a bare
      // `SandboxError("Process exited without a result")` instead of a
      // `CommandExitError`. Those are case (b) — the sandbox or transport FAULTED —
      // and they must keep throwing, so the supervisor still tears down and reports
      // `execute_failed`. Reporting a fault as "exited N" would invent an exit status
      // that never existed, which is strictly worse than losing a real one. The
      // `instanceof` is the SDK's own idiom for this narrowing (`isAuthFailure`,
      // `isMissingUpstream` both gate on `err instanceof CommandExitError`), and it
      // fails CLOSED: anything that is not that class keeps its current path.
      if (err instanceof CommandExitError) {
        const exitCode = err.exitCode;
        // Defensive: the status is READ, never defaulted. A `CommandExitError` whose
        // `exitCode` is not a number carries no status to report, so it stays a throw
        // rather than becoming a fabricated "exited 1".
        if (typeof exitCode === "number") {
          return { exitCode, signal: null, timedOut: false, crashed: exitCode !== 0 };
        }
      }
      // ── (b) THE SANDBOX OR TRANSPORT FAULTED — no exit status exists.
      // A real timeout surfaces as an SDK timeout error; map it to a timed-out
      // terminal (the keyed lane refines egress/crash mapping against real infra).
      const name = err instanceof Error ? err.name : "";
      if (name.toLowerCase().includes("timeout")) {
        return { exitCode: null, signal: "SIGKILL", timedOut: true, crashed: false };
      }
      throw err;
    }
  }

  async signal(sandboxId: string, _kind: "cancel" | "kill"): Promise<E2bSignalResult> {
    // ★★★ THE E7-F034 REPAIR (SVC-008a §4.2 Half A). Read against the same single
    // `getInfo` this function already paid for — the honest answer was fetched and
    // DISCARDED, so this costs zero additional provider calls.
    //
    // What it used to do: `getInfo`, throw the record away, `return {delivered: true}` —
    // and `{delivered: true}` from the `catch` too, i.e. report a delivery when the only
    // read it performed had FAILED. `E2bSandboxProvider.cancel`/`.kill` mapped that to
    // `outcome: "stopped"` unconditionally, so `"ignored"` was not producible by the real
    // provider, `CleanupAuthority`'s `kill` rung was structurally unreachable in
    // production, and `cleanup_escalation{escalation_stage}` could only ever say "cancel".
    //
    // `_kind` is STILL not read, and that stays true rather than being papered over:
    // this is a SANDBOX-scoped signal, and E2B has no in-sandbox graceful-cancel
    // primitive distinct from teardown, so cancel and kill genuinely are the same
    // sandbox-level act. The graceful/forced distinction lives at the PROCESS scope
    // (`signalProcess` below), which is what a supervisor should use. What changes here
    // is only that the verdict is now WITNESSED.
    let record: E2bSandboxRecord;
    try {
      record = toRecord(await this.#sdk.getInfo(sandboxId, { apiKey: this.#apiKey }));
    } catch {
      // The read threw. Nothing was witnessed, and that is now SAYABLE.
      return { observed: "unknown" };
    }
    switch (record.state) {
      case "running":
      case "paused":
        // A paused sandbox's process was not stopped — reporting a stop here would be the
        // same lie in a quieter place.
        return { observed: "still_running" };
      case "stopped":
        return { observed: "stopped" };
      case "unknown":
        // ★ The payload ANSWERED and named no state this parser recognizes (see
        // `mapState`). That is not a stop; it is the absence of an answer about state.
        return { observed: "unknown" };
      default: {
        const exhaustive: never = record.state;
        return exhaustive;
      }
    }
  }

  // --- SVC-008a process supervision -------------------------------------------
  //
  // ★★★ THE HONESTY LABEL ON THIS WHOLE BLOCK, AND IT MUST NOT BE QUIETLY UPGRADED.
  // Everything below is written against the `e2b@2.30.5` TYPE DECLARATIONS
  // (`dist/index.d.ts`): `Commands.run(cmd, {background: true})` resolves a
  // `CommandHandle` carrying `readonly pid: number`; `Commands.list()` resolves
  // `ProcessInfo[]` each carrying a `pid`; `Commands.kill(pid)` resolves `true` when the
  // command was killed and `false` when it was NOT FOUND, and its own doc comment says it
  // "uses `SIGKILL`". That is a CODE READING of a package that is not installed in the
  // worktree this was authored in. NONE of it has been run against a real E2B account.
  // Behavioural correctness is the keyed lane's job, exactly as this file's header says.
  //
  // ★ ONE CAPABILITY IS ABSENT AND IS REPORTED AS ABSENT, NOT SIMULATED. There is no
  // per-pid SIGTERM in that surface — `Commands.kill` is SIGKILL only and takes no signal
  // selector — so `signalProcess(…, "cancel")` returns `accepted: "unsupported"`. It does
  // NOT quietly escalate to a kill, and it does NOT claim a graceful stop happened.
  //
  // ★ ONE OBSERVATION IS UNREACHABLE AND IS REPORTED AS SUCH. `processStatus` polls
  // `Commands.list()`, which carries no exit status, so this transport can witness
  // `running` and `gone` but can NEVER produce `exited` with a code. Reading a code would
  // need `Commands.connect(pid).wait()`, which BLOCKS until exit — the completion oracle
  // this whole primitive exists to escape. A `gone` process therefore has no code, and
  // inventing one is the E7-F014 failure this file already refused once.

  readonly processSupervisionMode: E2bProcessSupervisionMode = "handle";

  async startProcess(req: E2bStartProcessRequest): Promise<E2bProcessStartResult> {
    const sandbox = await this.#sdk.connect(req.sandboxId, { apiKey: this.#apiKey });
    const full = shellJoin(req.command, req.args);
    const handle = await sandbox.commands.run(full, {
      background: true,
      envs: req.envVars,
      timeoutMs: req.timeoutMs,
    });
    // ★ THE HANDLE IS READ, NEVER MINTED. This file's own id idiom is
    // `String(x ?? "")` (`create`, `toRecord`) — and an empty string IS present, so a
    // `startProcess` written that way would acknowledge a launch it did not witness while
    // satisfying "presence is the acknowledgement". A response with no readable pid is a
    // THROW.
    const pid: unknown = (handle as SandboxSdk)?.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      throw new E2bProcessLaunchNotAcknowledgedError(req.sandboxId, "launch response carried no usable pid");
    }
    return { handle: String(pid) };
  }

  async processStatus(sandboxId: string, handle: E2bProcessHandle): Promise<E2bProcessObservation> {
    const pid = parseHandle(handle);
    if (pid === null) return { state: "unknown", reason: "handle_unrecognized" };
    let sandbox: SandboxSdk;
    try {
      sandbox = await this.#sdk.connect(sandboxId, { apiKey: this.#apiKey });
    } catch {
      // ★ A FAILURE TO LOOK IS NOT AN ABSENCE. `isRunning` right below is
      // `catch { return false }`, and `e2b-provider.ts` already ships that `false` as
      // `status: "unhealthy"` — an affirmative claim from a read that threw. This method
      // must not be built on that shape.
      return { state: "unknown", reason: "sandbox_unreachable" };
    }
    let processes: unknown;
    try {
      processes = await sandbox.commands.list();
    } catch {
      return { state: "unknown", reason: "read_failed" };
    }
    if (!Array.isArray(processes)) {
      // The call answered with something this binding cannot classify. Not an absence.
      return { state: "unknown", reason: "state_unrecognized" };
    }
    // ★★★ AN ABSENCE CLAIM REQUIRES HAVING READ EVERY ENTRY.
    //
    // This loop used to be `if (typeof info?.pid === "number" && info.pid === pid) return
    // running` and then fall through to `return {state: "gone"}` — so a list whose entries
    // this binding could not read AT ALL produced the affirmative absence, and
    // `gone -> deriveStopVerdict -> "stopped"`, the TERMINATING verdict, from a payload
    // nothing was classified out of. Measured on the shipped code with `[{processId: 4242}]`
    // (an SDK field rename inside the pinned `^2.30.5` range — the realistic producer),
    // `[{}]`, `["4242"]`, `[{pid: "4242"}]` and `[null]`.
    //
    // ★ IT WAS SELF-INCONSISTENT WITH THE BRANCH DIRECTLY ABOVE, which is the tell: a
    // NON-array payload already answered `unknown/state_unrecognized`, and only the
    // unclassifiable-ENTRIES case failed open. This is E7-F034's own class, rebuilt one
    // method away from the repair for it — which is exactly how this class survives.
    //
    // The rule: an entry that carries no readable pid is an entry that MIGHT have been this
    // one, so no absence may be concluded from a list containing any. `gone` now requires
    // that every entry was classified and none of them matched. An EMPTY list still means
    // `gone` — nothing is running is an answer, not a failure to read.
    let unclassifiable = 0;
    for (const info of processes as SandboxSdk[]) {
      const entryPid: unknown = (info as SandboxSdk)?.pid;
      if (typeof entryPid !== "number" || !Number.isInteger(entryPid) || entryPid <= 0) {
        unclassifiable += 1;
        continue;
      }
      if (entryPid === pid) return { state: "running" };
    }
    if (unclassifiable > 0) return { state: "unknown", reason: "state_unrecognized" };
    // The list ANSWERED, every entry was read, and this pid is not among them. That is a
    // witnessed absence — and it carries no exit code, because this read has none to carry.
    return { state: "gone" };
  }

  async signalProcess(
    sandboxId: string,
    handle: E2bProcessHandle,
    kind: "cancel" | "kill",
  ): Promise<E2bProcessSignalResult> {
    const pid = parseHandle(handle);
    if (pid === null) {
      return { accepted: "refused", observation: { state: "unknown", reason: "handle_unrecognized" } };
    }
    if (kind === "cancel") {
      // ★ NOT deliverable, and said so rather than silently promoted to a kill. The
      // observation is still a real re-read: the process may have stopped for other
      // reasons, and the caller must be able to see that.
      return { accepted: "unsupported", observation: await this.processStatus(sandboxId, handle) };
    }
    let accepted: E2bProcessSignalResult["accepted"];
    try {
      const sandbox = await this.#sdk.connect(sandboxId, { apiKey: this.#apiKey });
      const killed: unknown = await sandbox.commands.kill(pid);
      // `true` = killed, `false` = not found. Both are ANSWERS about the CALL only; the
      // claim about the PROCESS comes from the re-read below and from nowhere else.
      accepted = killed === true ? "accepted" : "refused";
    } catch {
      // The call failed. `accepted` has no "unknown" inhabitant by design — it describes
      // only whether the request was taken, and nothing may be concluded about the
      // process from it either way (see the port's `accepted` docstring). Reporting a
      // thrown call as "not taken" launders nothing, because the whole process claim
      // rides on the observation below.
      accepted = "refused";
    }
    return { accepted, observation: await this.processStatus(sandboxId, handle) };
  }

  async terminate(sandboxId: string): Promise<void> {
    try {
      // `Sandbox.kill` resolves `true` when the sandbox was found and killed and
      // `false` when it was already gone — it does NOT throw for a missing sandbox.
      // Surface the gone case as the uniform not-found signal so repeated teardown is
      // idempotent (the second terminate of a reclaimed sandbox → not-found, no hang).
      const killed = await this.#sdk.kill(sandboxId, { apiKey: this.#apiKey });
      if (killed === false) throw new E2bTransportNotFoundError(sandboxId);
    } catch (err) {
      if (err instanceof E2bTransportNotFoundError) throw err;
      if (this.#isNotFound(err)) throw new E2bTransportNotFoundError(sandboxId);
      throw new E2bTransportTransientError(err instanceof Error ? err.message : undefined);
    }
  }

  async getInfo(sandboxId: string): Promise<E2bSandboxRecord> {
    try {
      const info = await this.#sdk.getInfo(sandboxId, { apiKey: this.#apiKey });
      return toRecord(info);
    } catch (err) {
      if (this.#isNotFound(err)) throw new E2bTransportNotFoundError(sandboxId);
      throw err;
    }
  }

  async list(req: E2bListRequest): Promise<E2bListPage> {
    const paginator = this.#sdk.list({ apiKey: this.#apiKey, limit: req.pageSize, nextToken: req.pageToken ?? undefined });
    const items: E2bSandboxRecord[] = [];
    const page = typeof paginator?.nextItems === "function" ? await paginator.nextItems() : await paginator;
    for (const info of (page ?? []) as SandboxSdk[]) items.push(toRecord(info));
    const nextPageToken = typeof paginator?.nextToken === "string" ? paginator.nextToken : null;
    return { items, nextPageToken };
  }

  async setTimeout(sandboxId: string, timeoutMs: number): Promise<void> {
    await this.#sdk.setTimeout(sandboxId, timeoutMs, { apiKey: this.#apiKey });
  }

  // --- CLI-002/D1 staging fs primitives (keyed lane only) --------------------

  async writeFiles(sandboxId: string, files: readonly E2bStagedFile[]): Promise<void> {
    const sandbox = await this.#sdk.connect(sandboxId, { apiKey: this.#apiKey });
    for (const file of files) {
      // `sandbox.files.write(path, data)` accepts bytes; a Buffer view keeps the
      // e2b SDK's Node upload path happy without copying the underlying data.
      await sandbox.files.write(file.path, Buffer.from(file.bytes));
    }
  }

  async readFile(sandboxId: string, path: string): Promise<Uint8Array> {
    try {
      const sandbox = await this.#sdk.connect(sandboxId, { apiKey: this.#apiKey });
      const data = await sandbox.files.read(path, { format: "bytes" });
      if (data instanceof Uint8Array) return data;
      if (typeof data === "string") return new TextEncoder().encode(data);
      return new Uint8Array(data as ArrayBufferLike);
    } catch (err) {
      if (this.#isNotFound(err)) throw new E2bTransportNotFoundError(`${sandboxId}:${path}`);
      throw err;
    }
  }

  async listDir(sandboxId: string, path: string): Promise<readonly string[]> {
    try {
      const sandbox = await this.#sdk.connect(sandboxId, { apiKey: this.#apiKey });
      const entries = await sandbox.files.list(path);
      const arr = Array.isArray(entries) ? entries : [];
      return arr.map((e: SandboxSdk) => String(e?.path ?? e?.name ?? ""));
    } catch (err) {
      if (this.#isNotFound(err)) throw new E2bTransportNotFoundError(`${sandboxId}:${path}`);
      throw err;
    }
  }

  async isRunning(sandboxId: string): Promise<boolean> {
    try {
      const sandbox = await this.#sdk.connect(sandboxId, { apiKey: this.#apiKey });
      return Boolean(await sandbox.isRunning());
    } catch {
      return false;
    }
  }

  #isNotFound(err: unknown): boolean {
    // Delegates to the SDK-free classifier (no-key-tested): named not-found/bad-target
    // classes + a base `SandboxError` carrying a 4xx status (an absent/foreign sandbox
    // lookup surfaces as an unmapped 4xx, not `NotFoundError`, against real E2B).
    return isE2bNotFound(err);
  }
}

export function createRealE2bTransport(options: RealE2bTransportOptions = {}): RealE2bTransport {
  return new RealE2bTransport(options);
}
