// -----------------------------------------------------------------------------
// The reserved fault/canary directive contract (CLI-001, no-key core only).
//
// The two conformance suites inject every hostile lever through the opaque
// `params` bag of the provider-neutral invoke port. worker-daemon's PER-OP
// `SandboxProvider` has no such black-box channel, so `perOpToInvokeDriver`
// (the E6-F008 adapter) marshals those levers into the ONLY structured carriers
// the rich per-op types offer — the create-spec `env`/`command` and the execute
// `env` — under these reserved keys. The REAL driver logic never interprets them;
// it round-trips `env`/metadata verbatim. The DETERMINISTIC MOCK TRANSPORT decodes
// them to simulate what a real E2B sandbox would do under fault (an ignored signal,
// a transient teardown, a blocked egress, a timeout/crash). A REAL transport
// ignores them entirely — real faults come from real infrastructure, which is why
// the keyed real-E2B lane authors its own cases rather than reusing these markers.
//
// This module is the ONE place the reserved key names live, shared by the adapter
// (encode) and the mock transport (decode) so they can never silently drift.
// -----------------------------------------------------------------------------

export const DIRECTIVE_KEYS = {
  ignoreCancel: "__aoa_fault_ignore_cancel",
  ignoreKill: "__aoa_fault_ignore_kill",
  destroyFailures: "__aoa_fault_destroy_failures",
  egressClass: "__aoa_egress_class",
  lifecycleFault: "__aoa_lifecycle_fault",
  // CLI-002/D1 — the deterministic fake-CLI file-mutation directive (mock transport
  // ONLY). Its value is a JSON array of `{ path, content }` the mock applies to its
  // in-memory fs during runCommand, modeling a real CLI writing a KNOWN file inside
  // the sandbox. A REAL transport ignores it — the keyed lane runs a real shell
  // command against real E2B instead.
  fsWrite: "__aoa_fs_write",
  // CLI-003/D1 — the deterministic stdout/stderr streaming directive (mock transport
  // ONLY). Its value is a JSON array of `{ stream: "stdout"|"stderr", data: string }`
  // the mock replays to the `onStdout`/`onStderr` streaming callbacks during
  // runCommand, modeling a real CLI emitting output as it runs so log capture is
  // no-key-testable. A REAL transport ignores it — the keyed lane binds the `e2b`
  // SDK command stream instead.
  streamChunks: "__aoa_stream_chunks",
  // SVC-008a (mock transport ONLY) — the four directives that let the DOUBLE reproduce
  // what PRODUCTION can actually do. Before them, no double in this tree could produce an
  // indeterminate observation at all, which is precisely why E7-F034 survived every
  // ladder test: the mock was strictly MORE CAPABLE than the shipping transport in the
  // one dimension under test, so a suite that passed against it proved nothing.
  /** Every `getInfo`/`list` read of this sandbox THROWS — the branch that used to return
   * an affirmative `{delivered: true}` from `signal`'s own catch. */
  readFails: "__aoa_fault_read_fails",
  /** This sandbox's record carries an UNRECOGNIZED state (`E2bRecordState "unknown"`) —
   * the mock's stand-in for an SDK payload `mapState` cannot classify. */
  stateUnknown: "__aoa_fault_state_unknown",
  /** `startProcess` cannot be acknowledged (no handle). */
  refuseLaunch: "__aoa_fault_refuse_launch",
  /** Every `processStatus` read THROWS — an indeterminate PROCESS observation. */
  processReadFails: "__aoa_fault_process_read_fails",
} as const;

/** Metadata keys the provider round-trips through the transport to reconstruct a
 * management record (labels/command/env/workload). Opaque to the transport. */
export const METADATA_KEYS = {
  labels: "__aoa_labels",
  command: "__aoa_command",
  env: "__aoa_env",
  workload: "__aoa_workload",
} as const;

export interface CreateFaultDirectives {
  readonly ignoreCancel: boolean;
  readonly ignoreKill: boolean;
  readonly destroyFailures: number;
  /** SVC-008a — see {@link DIRECTIVE_KEYS.readFails}. */
  readonly readFails: boolean;
  /** SVC-008a — see {@link DIRECTIVE_KEYS.stateUnknown}. */
  readonly stateUnknown: boolean;
  /** SVC-008a — see {@link DIRECTIVE_KEYS.refuseLaunch}. */
  readonly refuseLaunch: boolean;
  /** SVC-008a — see {@link DIRECTIVE_KEYS.processReadFails}. */
  readonly processReadFails: boolean;
}

/** Decode the create-time fault directives from a stored env/metadata bag (mock
 * transport only). Absent/garbage → the benign default (no fault). */
export function decodeCreateFaults(env: Readonly<Record<string, string>>): CreateFaultDirectives {
  const rawDestroy = env[DIRECTIVE_KEYS.destroyFailures];
  const parsed = rawDestroy !== undefined ? Number.parseInt(rawDestroy, 10) : 0;
  return {
    ignoreCancel: env[DIRECTIVE_KEYS.ignoreCancel] === "1",
    ignoreKill: env[DIRECTIVE_KEYS.ignoreKill] === "1",
    destroyFailures: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
    readFails: env[DIRECTIVE_KEYS.readFails] === "1",
    stateUnknown: env[DIRECTIVE_KEYS.stateUnknown] === "1",
    refuseLaunch: env[DIRECTIVE_KEYS.refuseLaunch] === "1",
    processReadFails: env[DIRECTIVE_KEYS.processReadFails] === "1",
  };
}

export interface FsWriteDirective {
  readonly path: string;
  readonly content: string;
}

/** CLI-003/D1 — a single deterministic output chunk a fake CLI emits during a run
 * (mock transport only). `stream` selects the `onStdout`/`onStderr` callback. */
export interface StreamChunkDirective {
  readonly stream: "stdout" | "stderr";
  readonly data: string;
}

export interface ExecuteFaultDirectives {
  readonly egressClass: string | null;
  readonly lifecycleFault: "crash" | "ttl" | null;
  /** CLI-002/D1 — files a fake CLI mutates during this run (mock transport only). */
  readonly fsWrites: readonly FsWriteDirective[];
  /** CLI-003/D1 — stdout/stderr chunks a fake CLI streams during this run (mock only). */
  readonly streamChunks: readonly StreamChunkDirective[];
}

/** Decode the execute-time fault directives from the command env bag (mock
 * transport only). */
export function decodeExecuteFaults(env: Readonly<Record<string, string>>): ExecuteFaultDirectives {
  const egress = env[DIRECTIVE_KEYS.egressClass];
  const life = env[DIRECTIVE_KEYS.lifecycleFault];
  return {
    egressClass: typeof egress === "string" && egress.length > 0 ? egress : null,
    lifecycleFault: life === "crash" || life === "ttl" ? life : null,
    fsWrites: decodeFsWrites(env[DIRECTIVE_KEYS.fsWrite]),
    streamChunks: decodeStreamChunks(env[DIRECTIVE_KEYS.streamChunks]),
  };
}

/** Decode the reserved stream-chunk directive (mock transport only). Absent/garbage →
 * no chunks (benign default); a non-`stdout`/`stderr` stream or non-string `data`
 * entry is dropped so a malformed directive can never crash the run. */
export function decodeStreamChunks(raw: string | undefined): readonly StreamChunkDirective[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: StreamChunkDirective[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const stream = (entry as Record<string, unknown>).stream;
        const data = (entry as Record<string, unknown>).data;
        if ((stream === "stdout" || stream === "stderr") && typeof data === "string") {
          out.push({ stream, data });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Decode the reserved fs-write directive (mock transport only). Absent/garbage →
 * no writes (benign default). */
export function decodeFsWrites(raw: string | undefined): readonly FsWriteDirective[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: FsWriteDirective[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const p = (entry as Record<string, unknown>).path;
        const c = (entry as Record<string, unknown>).content;
        if (typeof p === "string" && p.length > 0 && typeof c === "string") {
          out.push({ path: p, content: c });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
