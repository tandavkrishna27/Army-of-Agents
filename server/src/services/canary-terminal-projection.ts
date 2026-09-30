// server/src/services/canary-terminal-projection.ts
//
// CLI-006 (Task 2b) — the after-commit bridge from a distributed attempt's durable
// terminal to the D5 run-experience projector.
//
// JOB-005's ingest fires `onAttemptTerminal` once, AFTER the tenant transaction
// commits, when a batch it accepted carried the attempt's terminal event
// (`job-events.ts:323`). That signal names the attempt, not the run. This module
// answers "which heartbeat run, if any, handed its execution to this attempt?",
// gathers the attempt's durable evidence, and hands both to the projector.
//
// Three properties are deliberate:
//
//   1. **The ownership predicate lives here, in one place.** A terminal projects
//      onto a run ONLY when `execution_owner === "distributed"`. A run that fell
//      back to legacy owns its own terminal, and projecting onto it would make the
//      projector a second authority for run state (Invariant 8). The lookup is a
//      plain read; the decision is not smeared into SQL where no unit test sees it.
//
//   2. **Evidence gathering is best-effort; the terminal is not.** A failed event
//      read costs visibility. It must not cost the run its terminal — without that
//      the run never latches, the issue lock is never released, and the agent pins
//      at `running`, dragging every other run of that agent with it (R7).
//
//   3. **The vocabulary crossing is an explicit total function** (2b-D2). See
//      `attemptOutcomeFromTerminalStatus`.
//
// This handler may throw: the ingest hook already catches and logs with the signal
// attached (`job-events.ts:326`), which is better diagnostics than swallowing here.

import type { TerminalEventStatus } from "@armyofagents/worker-protocol";
import type { AttemptTerminalSignal } from "./job-events.js";
import type {
  CanaryAttemptEvent,
  CanaryAttemptEvidence,
  CanaryAttemptOutcome,
  CanaryRunProjector,
} from "./canary-run-projector.js";

/** One persisted `job_events` row, narrowed to what projection needs. */
export interface AttemptEventRow {
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType: string;
  /** The stored wire event; the variant payload sits under `.payload`. */
  readonly event: Record<string, unknown>;
  readonly occurredAt: Date;
}

/** The heartbeat run a terminal may project onto, narrowed to the marker columns. */
export interface CanaryRunRow {
  readonly id: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly executionOwner: string | null;
  readonly startedAt: Date | null;
}

// Every port below is declared with ARROW-PROPERTY syntax, not method shorthand.
// Method shorthand makes parameters BIVARIANT, so a dependency missing a required
// argument typechecks clean and fails only at runtime — the exact hole that let
// `placement: placementService` compile in Task 2a while passing `now: undefined`.
export interface AttemptTerminalProjectionDeps {
  /** Look a run up by the CLI-006 marker columns. Company-scoped: the ids are
   * uuids minted per attempt, but scoping keeps the read on the tenant index and
   * makes a cross-company match impossible rather than merely improbable. */
  findRunForAttempt: (input: {
    jobId: string;
    attemptId: string;
    companyId: string;
  }) => Promise<CanaryRunRow | null>;
  /** The attempt's durable events, tenant-scoped. May throw — see property 2. */
  listAttemptEvents: (input: {
    organizationId: string;
    companyId: string;
    jobId: string;
    attemptId: string;
  }) => Promise<readonly AttemptEventRow[]>;
  /** The founder-facing identity for the summary comment: the run's issue (via the
   * execution lock) and the agent's name/runtime config. Resolved BEFORE projection
   * because `finalizeRun` releases the execution lock the issue lookup reads. */
  resolveTarget: (input: { run: CanaryRunRow }) => Promise<{
    issueId: string | null;
    agentName: string;
    runtimeConfig: Record<string, unknown> | null | undefined;
  } | null>;
  projector: CanaryRunProjector;
  now?: () => Date;
}

/**
 * 2b-D2 — the protocol's terminal vocabulary is NOT the projector's.
 *
 *   protocol  (worker-protocol/src/events.ts:320): succeeded | failed | cancelled | EXPIRED
 *   projector (canary-run-projector.ts:23):        succeeded | failed | cancelled | TIMED_OUT
 *
 * `runStatusForOutcome` is an exhaustive switch with no `default`; it compiles only
 * because its parameter type excludes `expired`. So a cast at this boundary
 * typechecks clean and then writes a run status of `undefined` — the same silent
 * shape as the `succeeded` vs `"completed"` defect fixed in `089ee34ab`.
 *
 * A lease that ran out of time is `expired` on the wire and a timeout to the
 * founder, so it maps to `timed_out` (which the projector in turn renders as a
 * failed run, with the distinction preserved in `errorCode`).
 */
export function attemptOutcomeFromTerminalStatus(status: TerminalEventStatus): CanaryAttemptOutcome {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "timed_out";
  }
}

function payloadOf(row: AttemptEventRow): Record<string, unknown> {
  const payload = row.event?.payload;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

/**
 * BRW-003d-3 — the key the envelope's `extensions` ride under, INSIDE the payload.
 *
 * ★ INSIDE, deliberately. The frozen forbidden-key scan is KEYS-ONLY, so a
 * credential sitting in an extension VALUE under an innocuous key is legal on the
 * wire. The event egress redactor sweeps `event.payload`; extensions arriving as a
 * SIBLING field would bypass it, and closing that would mean remembering a second
 * redaction call at every egress. Folding them into the payload makes the coverage
 * a structural property instead of a promise.
 */
export const PROJECTED_WIRE_EXTENSIONS_KEY = "wireExtensions";

/**
 * The envelope's `extensions`, or null when there are none to carry.
 *
 * The stored event is whatever was persisted, so a surprising shape must not cost
 * the whole attempt's evidence — an unusable value is simply not carried. An EMPTY
 * array is also "nothing to carry": inventing an empty artefact on every event
 * makes every payload noisier for no information.
 */
function extensionsOf(row: AttemptEventRow): unknown[] | null {
  const raw = row.event?.extensions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Pure: the attempt's persisted rows → the evidence shape the projector consumes.
 *
 * `terminalStatus` comes from the ACCEPTED ingest signal and is the authority for
 * the outcome; a terminal row only enriches `errorCode`/`errorMessage`. Keeping one
 * authority means a row that disagrees (a redelivery, a partial read) cannot flip
 * the run's terminal.
 */
export function foldAttemptEvidence(input: {
  jobId: string;
  attemptId: string;
  terminalStatus: TerminalEventStatus;
  rows: readonly AttemptEventRow[];
  runStartedAt: Date | null;
  now: Date;
}): CanaryAttemptEvidence {
  // Dedupe by ingest identity (at-least-once fan-out redelivers) and order by the
  // durable sequence (a reconnect catch-up can arrive out of order). The projector
  // repeats both defensively; doing it here keeps the folded usage/terminal picks
  // reading the same ordered view the events do.
  const seen = new Set<string>();
  const ordered = input.rows
    .filter((row) => {
      if (seen.has(row.eventId)) return false;
      seen.add(row.eventId);
      return true;
    })
    .sort((a, b) => a.sequence - b.sequence);

  const events: CanaryAttemptEvent[] = ordered.map((row) => {
    const payload = payloadOf(row);
    const stream = payload.stream;
    const message = payload.message;
    const extensions = extensionsOf(row);
    // Only build a new object when there is something to add: spreading on every
    // event would copy every payload for no reason.
    //
    // A payload that already owns the key keeps its own value. The projection is
    // not the place to resolve a collision with a frozen payload field, and
    // clobbering would lose real data in order to carry metadata.
    const projected = extensions && !(PROJECTED_WIRE_EXTENSIONS_KEY in payload)
      ? { ...payload, [PROJECTED_WIRE_EXTENSIONS_KEY]: extensions }
      : payload;
    return {
      eventId: row.eventId,
      seq: row.sequence,
      type: row.eventType,
      ...(stream === "stdout" || stream === "stderr" ? { stream } : {}),
      ...(typeof message === "string" ? { message } : {}),
      payload: projected,
    };
  });

  // LAST usage event by sequence wins. The supervisor emits at most one, carrying
  // whole-attempt totals (`supervisor.ts:389`), so "last" is the same as "the one"
  // today and stays correct if a future producer emits cumulative snapshots.
  const usageRow = [...ordered].reverse().find((row) => row.eventType === "usage");
  const usage = usageRow ? payloadOf(usageRow) : null;

  const terminalRow = [...ordered].reverse().find((row) => row.eventType === "terminal");
  const terminal = terminalRow ? payloadOf(terminalRow) : null;

  // `runtimeMillis` is the attempt's own measurement and is preferred. But
  // `observeRun` is default-off (E4-D12), so a real canary attempt may emit no
  // usage at all — and a 0 would render the run as instantaneous in the summary
  // comment. Fall back to the run's wall clock, which is the quantity the legacy
  // path reports anyway (`heartbeat.ts:2567`).
  const reportedMs = usage ? intOrNull(usage.runtimeMillis) : null;
  const wallClockMs = input.runStartedAt
    ? Math.max(0, input.now.getTime() - input.runStartedAt.getTime())
    : 0;

  return {
    jobId: input.jobId,
    attemptId: input.attemptId,
    events,
    terminal: {
      outcome: attemptOutcomeFromTerminalStatus(input.terminalStatus),
      errorCode: terminal ? stringOrNull(terminal.errorCode) : null,
      errorMessage: terminal ? stringOrNull(terminal.errorMessage) : null,
    },
    usage: {
      inputTokens: usage ? intOrNull(usage.inputTokens) : null,
      outputTokens: usage ? intOrNull(usage.outputTokens) : null,
      // ALWAYS null. `usagePayloadV1Schema` is `.strict()` over token/runtime fields
      // and rejects every pricing field by construction — CLI-003 emits unpriced
      // evidence and JOB-012 prices it server-side. There is nothing to read here.
      costUsd: null,
      durationMs: reportedMs ?? wallClockMs,
    },
    // The run's `finished_at` (E7-F036). `now`, not the terminal row's occurredAt: the
    // wall-clock `durationMs` above already measures against `now`, so keeping the same
    // reference makes finished_at − started_at agree with the reported duration, and the
    // after-commit projection fires within ms of the terminal.
    finishedAt: input.now,
    // `artifact_prepared` carries an artifactId and a kind, never a path
    // (worker-protocol/src/events.ts:294), so there is no honest file list to
    // build — the same `[]` the W3a crew loopback ships until workspaces land.
    detectedFiles: [],
  };
}

/**
 * Adapt the heartbeat-private `setRunStatus` (which resolves the updated row, or
 * `null`) to the projector's `won: boolean` contract.
 *
 * The polarity is invisible to the compiler and inverting it fails quietly in the
 * worst direction: every projection would believe it LOST the latch, skip
 * finalization, and leave the agent pinned at `running` — which, because
 * `finalizeAgentStatus` recomputes from the count of running rows, also holds
 * every OTHER run of that agent at `running` (R7). Hence a named, tested function,
 * the same reasoning that produced `toRunExecutionPlacement`.
 *
 * `null` covers all three guard-miss branches — row gone, no-op flip, and the
 * metadata-only fallback — and all three mean someone else finalized this run.
 */
export function toProjectorTerminalWriter(
  setRunStatus: (runId: string, status: string, patch: Record<string, unknown>) => Promise<unknown>,
): (runId: string, status: string, patch: Record<string, unknown>) => Promise<boolean> {
  return async (runId, status, patch) => (await setRunStatus(runId, status, patch)) != null;
}

/**
 * The seq offset for projected events.
 *
 * The suppression seam (Task 3) writes its handoff lifecycle event at seq 1, and
 * the attempt's own durable sequence also starts at 1. `heartbeat_run_events`
 * carries only a NON-unique `(run_id, seq)` index, so a collision does not error —
 * it silently interleaves the distributed log with the handoff notice in the run
 * timeline. Offsetting every projected seq above what the run already has keeps
 * the timeline in the order it actually happened.
 */
export function projectionSeqBase(maxExistingSeq: number | null | undefined): number {
  return typeof maxExistingSeq === "number" && Number.isFinite(maxExistingSeq) && maxExistingSeq > 0
    ? maxExistingSeq
    : 0;
}

export function createAttemptTerminalProjectionHandler(
  deps: AttemptTerminalProjectionDeps,
): (signal: AttemptTerminalSignal) => Promise<void> {
  const now = deps.now ?? (() => new Date());

  return async function projectAttemptTerminal(signal) {
    const run = await deps.findRunForAttempt({
      jobId: signal.jobId,
      attemptId: signal.attemptId,
      companyId: signal.companyId,
    });
    // No run carries this attempt's marker: a job that was never a canary handoff.
    if (!run) return;
    // The run fell back to legacy after the convert. The legacy path is its terminal
    // authority; projecting here would be a second one (Invariant 8).
    if (run.executionOwner !== "distributed") return;

    let rows: readonly AttemptEventRow[] = [];
    try {
      rows = await deps.listAttemptEvents({
        organizationId: signal.organizationId,
        companyId: signal.companyId,
        jobId: signal.jobId,
        attemptId: signal.attemptId,
      });
    } catch {
      // Visibility only. The terminal below still has to happen — see property 2.
    }

    let target: Awaited<ReturnType<AttemptTerminalProjectionDeps["resolveTarget"]>> = null;
    try {
      target = await deps.resolveTarget({ run });
    } catch {
      // Same reasoning: a missing agent row must not cost the run its terminal.
      // The projector skips the summary when there is no issue, and writes the
      // terminal regardless — it is deliberately not issue-gated.
    }

    await deps.projector.projectTerminal({
      target: {
        runId: run.id,
        companyId: run.companyId,
        issueId: target?.issueId ?? null,
        agentName: target?.agentName ?? "Agent",
        runtimeConfig: target?.runtimeConfig ?? null,
      },
      evidence: foldAttemptEvidence({
        jobId: signal.jobId,
        attemptId: signal.attemptId,
        terminalStatus: signal.terminalStatus,
        rows,
        runStartedAt: run.startedAt,
        now: now(),
      }),
    });
  };
}
