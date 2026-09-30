import type { AdapterInvocationMeta } from "../../../adapters/index.js";
import type { RunLogHandle } from "../../run-log-store.js";

/**
 * T1 — crew run transcripts. Before this, `runAoaAgent` passed literal no-op
 * callbacks (`onLog: async () => {}, onMeta: async () => {}`) to
 * `adapter.execute`, so every crew run discarded its entire transcript and a
 * crew failure was undiagnosable. This module is the sink that turns those
 * callbacks into NDJSON events on the shared run-log store.
 *
 * Divergence from the org (heartbeat) path, deliberate: heartbeat splits the
 * two callbacks across two stores — `onLog` → the run-log file, `onMeta` →
 * `heartbeat_run_events` (eventType "adapter.invoke"). Crew has no equivalent
 * events table, so crew meta rides the SAME NDJSON as one `system`-stream
 * chunk. That is the only reason the two paths differ here.
 */

/**
 * The redacted shape actually persisted for an `adapter.invoke` event.
 * `prompt` / `env` / `context` from AdapterInvocationMeta are never written —
 * they carry the assembled prompt, resolved secrets, and the raw trigger
 * payload. They are replaced by non-reversible summaries (`promptChars`,
 * `contextKeys`) that keep the event diagnostically useful.
 *
 * This is an ALLOWLIST, not a denylist: `redactMeta` builds a fresh object from
 * named fields, so a field added to AdapterInvocationMeta later is dropped by
 * default and must be opted in here. Do not rewrite it as `delete`/spread —
 * that inverts the guarantee and silently persists every future field.
 *
 * Not a blanket secret guarantee: `commandArgs` is kept VERBATIM. It carries
 * `agent.adapterConfig.args` unfiltered, so operator-supplied extraArgs (e.g. a
 * founder pasting `--api-key sk-…`) would land on disk. That is trusted operator
 * input written to a local operator-readable file, and filtering it is a
 * separate concern from this module. The prompt itself does not leak this way —
 * claude receives it on stdin and codex masks the trailing arg.
 *
 * (The org path persists prompt/env/context unredacted today. That is a
 * pre-existing issue on the heartbeat side and is out of scope here.)
 */
export interface RedactedAdapterInvocationMeta {
  adapterType: string;
  command: string;
  cwd?: string;
  commandArgs?: string[];
  commandNotes?: string[];
  promptMetrics?: Record<string, number>;
  /** Length of the dropped prompt — enough to spot an empty/truncated prompt. */
  promptChars?: number;
  /** Key NAMES of the dropped context object. Never the values. */
  contextKeys?: string[];
  // Declared so a caller reading `.prompt`/`.env`/`.context` off the redacted
  // value type-errors instead of silently reading `undefined` forever.
  prompt?: undefined;
  env?: undefined;
  context?: undefined;
}

/**
 * Keep the operational fields (what was spawned, where, with which args);
 * drop the three sensitive ones and substitute size/shape summaries.
 * Pure — never throws.
 */
export function redactMeta(meta: AdapterInvocationMeta): RedactedAdapterInvocationMeta {
  const out: RedactedAdapterInvocationMeta = {
    adapterType: meta.adapterType,
    command: meta.command,
  };
  if (meta.cwd !== undefined) out.cwd = meta.cwd;
  if (meta.commandArgs !== undefined) out.commandArgs = meta.commandArgs;
  if (meta.commandNotes !== undefined) out.commandNotes = meta.commandNotes;
  if (meta.promptMetrics !== undefined) out.promptMetrics = meta.promptMetrics;
  if (typeof meta.prompt === "string") out.promptChars = meta.prompt.length;
  if (meta.context && typeof meta.context === "object") {
    out.contextKeys = Object.keys(meta.context);
  }
  return out;
}

/** Minimal slice of RunLogStore this sink needs — keeps the seam injectable/testable. */
export interface CrewRunLogAppender {
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<void>;
}

export interface CrewRunLogSink {
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta: (meta: AdapterInvocationMeta) => Promise<void>;
}

/**
 * Minimal logger slice. REQUIRED, and deliberately not defaulted to the module
 * logger: `middleware/logger.ts` does `fs.mkdirSync` at import and builds pino
 * transports on worker threads, so defaulting would drag all of that into this
 * otherwise type-only leaf module (and into every suite that imports it). The
 * single production caller already injects its own `logger.child(...)`.
 */
export interface CrewRunLogLogger {
  warn(fields: Record<string, unknown>, msg: string): void;
}

/**
 * Build the `{ onLog, onMeta }` pair handed to `adapter.execute`. Both
 * callbacks are BEST-EFFORT: a store failure (disk full, path gone) is
 * swallowed, because losing a transcript must never change a run's outcome.
 *
 * Swallowing SILENTLY, however, would reproduce the exact failure mode T1
 * exists to kill: an empty transcript that gives no reason for being empty is
 * indistinguishable from an agent that produced no output. So the FIRST append
 * failure per sink is warned (with the run's identity, so the line is traceable
 * back to the run row) and every later one is suppressed — a broken store fails
 * on every chunk, and the goal is one honest line per run, not thousands.
 */
export function createCrewRunLogSink(args: {
  store: CrewRunLogAppender;
  handle: RunLogHandle;
  /** Run identity for the append-failure warning. Optional so the seam stays test-friendly. */
  run?: { companyId?: string; agentId?: string; runId?: string };
  logger: CrewRunLogLogger;
}): CrewRunLogSink {
  const { store, handle, run } = args;
  const log = args.logger;
  // Per-sink (= per-run) latch. Closure state, so two concurrent runs never
  // suppress each other's first warning.
  let appendFailureWarned = false;

  function noteAppendFailure(err: unknown, stream: "stdout" | "stderr" | "system") {
    if (appendFailureWarned) return;
    appendFailureWarned = true;
    try {
      log.warn(
        {
          err,
          stream,
          companyId: run?.companyId,
          agentId: run?.agentId,
          runId: run?.runId,
          logRef: handle.logRef,
        },
        "crew run transcript append failed — this run's transcript will be incomplete (further append failures for this run are suppressed)",
      );
    } catch {
      /* an injected logger that throws must not defeat the swallow contract */
    }
  }

  return {
    async onLog(stream, chunk) {
      try {
        await store.append(handle, { stream, chunk, ts: new Date().toISOString() });
      } catch (err) {
        // best-effort: a transcript write must never fail the run
        noteAppendFailure(err, stream);
      }
    },

    async onMeta(meta) {
      try {
        const chunk = JSON.stringify({ event: "adapter.invoke", meta: redactMeta(meta) });
        await store.append(handle, { stream: "system", chunk, ts: new Date().toISOString() });
      } catch (err) {
        // best-effort: a transcript write must never fail the run
        noteAppendFailure(err, "system");
      }
    },
  };
}
