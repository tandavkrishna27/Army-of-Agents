// CLI-006 (Task 2b) — the after-commit terminal projection handler.
//
// This is the piece that turns a distributed attempt's durable terminal into the
// run experience a founder actually looks at. It sits on the JOB-005 ingest hook
// (`onAttemptTerminal`, landed `ddaa29b78`) and feeds the D5 projector.
//
// Two things here are load-bearing and neither is guarded by the compiler:
//
//   2b-D2 — the terminal VOCABULARIES differ. The protocol's is
//   `succeeded|failed|cancelled|EXPIRED` (worker-protocol/src/events.ts:320); the
//   projector's is `succeeded|failed|cancelled|TIMED_OUT`
//   (canary-run-projector.ts:23). `runStatusForOutcome` is an exhaustive switch
//   with NO default, so a cast at this boundary compiles clean and then writes a
//   run status of `undefined`. That is the same shape as the `succeeded` vs
//   `"completed"` defect fixed in `089ee34ab`, so it gets a total mapping and a
//   test per member — plus an end-to-end assertion that every folded outcome
//   yields a DEFINED status through the real projector.
//
//   The ownership predicate — a terminal must project onto a run ONLY when that
//   run was actually handed off (`execution_owner = "distributed"`). A run that
//   fell back to legacy owns its own terminal; projecting onto it would make the
//   projector a second authority for run state, breaking Invariant 8.

import { describe, expect, it, vi } from "vitest";
import {
  attemptOutcomeFromTerminalStatus,
  createAttemptTerminalProjectionHandler,
  foldAttemptEvidence,
  projectionSeqBase,
  toProjectorTerminalWriter,
  type AttemptEventRow,
  type AttemptTerminalProjectionDeps,
  type CanaryRunRow,
} from "../services/canary-terminal-projection.js";
import { createCanaryRunProjector } from "../services/canary-run-projector.js";

const ORG = "66666666-6666-4666-8666-666666666666";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN = "77777777-7777-4777-8777-777777777777";
const AGENT = "99999999-9999-4999-8999-999999999999";
const ISSUE = "88888888-8888-4888-8888-888888888888";
const JOB = "10b10b10-10b1-4b10-8b10-10b10b10b10b";
const ATTEMPT = "a77e3907-a77e-4a77-8a77-a77ea77ea77e";

const START = new Date("2026-08-19T10:00:00.000Z");
const NOW = new Date("2026-08-19T10:00:42.000Z");

function evt(over: Partial<AttemptEventRow> & { eventType: string }): AttemptEventRow {
  return {
    eventId: "e-1",
    sequence: 1,
    event: {},
    occurredAt: START,
    ...over,
  } as AttemptEventRow;
}

const terminalRow = (over: Record<string, unknown> = {}): AttemptEventRow =>
  evt({
    eventType: "terminal",
    sequence: 9,
    eventId: "e-9",
    event: { payload: { status: "succeeded", exitCode: 0, errorCode: null, errorMessage: null, ...over } },
  });

type FoldInput = Parameters<typeof foldAttemptEvidence>[0];

function fold(over: Partial<FoldInput> = {}) {
  return foldAttemptEvidence({
    jobId: JOB,
    attemptId: ATTEMPT,
    terminalStatus: "succeeded",
    rows: [terminalRow()],
    runStartedAt: START,
    now: NOW,
    ...over,
  } as FoldInput);
}

// -- 2b-D2: the vocabulary crossing ------------------------------------------

describe("CLI-006/2b-D2 — protocol terminal vocabulary to projector outcome", () => {
  it("maps every protocol status, and expired becomes timed_out (not a cast)", () => {
    expect(attemptOutcomeFromTerminalStatus("succeeded")).toBe("succeeded");
    expect(attemptOutcomeFromTerminalStatus("failed")).toBe("failed");
    expect(attemptOutcomeFromTerminalStatus("cancelled")).toBe("cancelled");
    // The whole point: `expired` exists in the protocol and NOT in the projector.
    expect(attemptOutcomeFromTerminalStatus("expired")).toBe("timed_out");
  });

  it("every folded outcome yields a DEFINED run status through the real projector", async () => {
    for (const status of ["succeeded", "failed", "cancelled", "expired"] as const) {
      const setRunStatus = vi.fn(async () => true);
      const projector = createCanaryRunProjector({
        appendRunEvent: async () => {},
        setRunStatus,
        postRunSummary: async () => ({ posted: false }),
      });
      await projector.projectTerminal({
        target: { runId: RUN, companyId: COMPANY, issueId: null, agentName: "a", runtimeConfig: null },
        evidence: fold({ terminalStatus: status, rows: [terminalRow({ status })] }),
      });
      const written = setRunStatus.mock.calls[0]?.[1];
      // An `undefined` here is the silent corruption this test exists for.
      expect(typeof written, `status for protocol terminal "${status}"`).toBe("string");
      expect(["succeeded", "failed", "cancelled"]).toContain(written);
    }
  });
});

// -- the pure fold ------------------------------------------------------------

describe("CLI-006/2b — foldAttemptEvidence", () => {
  it("takes the outcome from the accepted SIGNAL, not from a disagreeing row", () => {
    // The signal is what the ingest actually accepted; the row only enriches.
    const evidence = fold({ terminalStatus: "cancelled", rows: [terminalRow({ status: "succeeded" })] });
    expect(evidence.terminal.outcome).toBe("cancelled");
  });

  it("enriches errorCode/errorMessage from the terminal row payload", () => {
    const evidence = fold({
      terminalStatus: "failed",
      rows: [terminalRow({ status: "failed", errorCode: "exec_timeout", errorMessage: "signal:SIGKILL" })],
    });
    expect(evidence.terminal.errorCode).toBe("exec_timeout");
    expect(evidence.terminal.errorMessage).toBe("signal:SIGKILL");
  });

  it("tolerates a missing terminal row — the signal still decides the outcome", () => {
    const evidence = fold({ terminalStatus: "failed", rows: [] });
    expect(evidence.terminal).toEqual({ outcome: "failed", errorCode: null, errorMessage: null });
  });

  // E7-F036 — the folded evidence carries `finished_at` so the projector can write a
  // DURABLY terminal run (verifier clause 3 = terminal status AND finished_at). It is
  // `now`, not the terminal row's occurredAt, on purpose: durationMs's wall-clock
  // fallback (:227) already measures against `now`, so finished_at − started_at stays
  // consistent with the reported duration. The after-commit hook fires within ms of the
  // terminal, so `now` IS that instant.
  it("stamps finished_at = now so the projected run is durably terminal", () => {
    expect(fold().finishedAt).toEqual(NOW);
    // present even when the terminal row read failed and rows are empty
    expect(fold({ rows: [] }).finishedAt).toEqual(NOW);
  });

  it("dedupes by eventId and orders by sequence", () => {
    const evidence = fold({
      rows: [
        evt({ eventType: "log", sequence: 3, eventId: "b" }),
        evt({ eventType: "log", sequence: 1, eventId: "a" }),
        evt({ eventType: "log", sequence: 3, eventId: "b" }), // redelivered
        terminalRow(),
      ],
    });
    expect(evidence.events.map((e) => e.eventId)).toEqual(["a", "b", "e-9"]);
    expect(evidence.events.map((e) => e.seq)).toEqual([1, 3, 9]);
  });

  it("carries log stream/message through so the run experience reads like a legacy one", () => {
    const evidence = fold({
      rows: [
        evt({
          eventType: "log",
          sequence: 1,
          eventId: "a",
          event: { payload: { stream: "stderr", level: "warn", message: "hello" } },
        }),
        terminalRow(),
      ],
    });
    expect(evidence.events[0]).toMatchObject({ type: "log", stream: "stderr", message: "hello" });
  });

  it("folds usage, and costUsd is ALWAYS null — the frozen payload has no price field", () => {
    const evidence = fold({
      rows: [
        evt({
          eventType: "usage",
          sequence: 2,
          eventId: "u",
          event: { payload: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10, runtimeMillis: 1234 } },
        }),
        terminalRow(),
      ],
    });
    expect(evidence.usage.inputTokens).toBe(100);
    expect(evidence.usage.outputTokens).toBe(50);
    expect(evidence.usage.costUsd).toBeNull();
    expect(evidence.usage.durationMs).toBe(1234);
  });

  it("takes the LAST usage event by sequence when several arrive", () => {
    const usage = (seq: number, runtimeMillis: number) =>
      evt({
        eventType: "usage",
        sequence: seq,
        eventId: `u${seq}`,
        event: { payload: { inputTokens: seq, outputTokens: 0, cachedInputTokens: 0, runtimeMillis } },
      });
    const evidence = fold({ rows: [usage(5, 500), usage(2, 200), terminalRow()] });
    expect(evidence.usage.durationMs).toBe(500);
    expect(evidence.usage.inputTokens).toBe(5);
  });

  it("falls back to run wall-clock when the attempt reported no usage", () => {
    // `observeRun` is default-off (E4-D12), so a real canary attempt may emit no
    // usage at all. A 0 would render as an instant run in the summary comment.
    const evidence = fold({ rows: [terminalRow()] });
    expect(evidence.usage.durationMs).toBe(42_000);
    expect(evidence.usage.inputTokens).toBeNull();
  });

  it("reports detectedFiles as [] — artifact_prepared carries an id and kind, never a path", () => {
    const evidence = fold({
      rows: [
        evt({
          eventType: "artifact_prepared",
          sequence: 4,
          eventId: "ap",
          event: { payload: { artifactId: "01J0000000000000000000000A", kind: "patch" } },
        }),
        terminalRow(),
      ],
    });
    expect(evidence.detectedFiles).toEqual([]);
  });
});

// -- the handler --------------------------------------------------------------

const SIGNAL = {
  organizationId: ORG,
  companyId: COMPANY,
  jobId: JOB,
  attemptId: ATTEMPT,
  terminalStatus: "succeeded",
} as const;

const distributedRun: CanaryRunRow = {
  id: RUN,
  companyId: COMPANY,
  agentId: AGENT,
  executionOwner: "distributed",
  startedAt: START,
};

function handlerDeps(over: Partial<AttemptTerminalProjectionDeps> = {}) {
  const projectTerminal = vi.fn(async () => {});
  const deps: AttemptTerminalProjectionDeps = {
    findRunForAttempt: async () => distributedRun,
    listAttemptEvents: async () => [terminalRow()],
    resolveTarget: async () => ({ issueId: ISSUE, agentName: "Nova", runtimeConfig: { autoRunSummary: true } }),
    projector: { projectTerminal },
    now: () => NOW,
    ...over,
  };
  return { deps, projectTerminal };
}

describe("CLI-006/2b — createAttemptTerminalProjectionHandler", () => {
  it("resolves the run by (distributed_job_id, distributed_attempt_id) and projects onto it", async () => {
    const findRunForAttempt = vi.fn(async () => distributedRun);
    const { deps, projectTerminal } = handlerDeps({ findRunForAttempt });
    await createAttemptTerminalProjectionHandler(deps)(SIGNAL);

    expect(findRunForAttempt).toHaveBeenCalledWith({ jobId: JOB, attemptId: ATTEMPT, companyId: COMPANY });
    expect(projectTerminal).toHaveBeenCalledTimes(1);
    const call = projectTerminal.mock.calls[0]![0] as any;
    expect(call.target).toEqual({
      runId: RUN,
      companyId: COMPANY,
      issueId: ISSUE,
      agentName: "Nova",
      runtimeConfig: { autoRunSummary: true },
    });
    expect(call.evidence.jobId).toBe(JOB);
    expect(call.evidence.attemptId).toBe(ATTEMPT);
  });

  it("does NOT project when no run carries the marker — a non-canary attempt", async () => {
    const { deps, projectTerminal } = handlerDeps({ findRunForAttempt: async () => null });
    await createAttemptTerminalProjectionHandler(deps)(SIGNAL);
    expect(projectTerminal).not.toHaveBeenCalled();
  });

  it("does NOT project onto a run that fell back to legacy (execution_owner is not distributed)", async () => {
    // The legacy path owns its own terminal. Projecting here would make the
    // projector a SECOND authority for run state — Invariant 8.
    const { deps, projectTerminal } = handlerDeps({
      findRunForAttempt: async () => ({ ...distributedRun, executionOwner: null }),
    });
    await createAttemptTerminalProjectionHandler(deps)(SIGNAL);
    expect(projectTerminal).not.toHaveBeenCalled();
  });

  it("still projects when the target cannot be resolved, with a null issue", async () => {
    // Losing the agent row must not cost the run its terminal — the terminal is
    // deliberately not issue-gated in the projector.
    const { deps, projectTerminal } = handlerDeps({ resolveTarget: async () => null });
    await createAttemptTerminalProjectionHandler(deps)(SIGNAL);
    expect(projectTerminal).toHaveBeenCalledTimes(1);
    expect((projectTerminal.mock.calls[0]![0] as any).target.issueId).toBeNull();
  });

  it("reads the attempt events scoped to the signal org AND company", async () => {
    const listAttemptEvents = vi.fn(async () => [terminalRow()]);
    const { deps } = handlerDeps({ listAttemptEvents });
    await createAttemptTerminalProjectionHandler(deps)(SIGNAL);
    expect(listAttemptEvents).toHaveBeenCalledWith({
      organizationId: ORG,
      companyId: COMPANY,
      jobId: JOB,
      attemptId: ATTEMPT,
    });
  });

  it("projects the terminal even when the event read fails", async () => {
    // Visibility is best-effort; the terminal is not. A failed event read must
    // still latch the run and release the agent (R7).
    const { deps, projectTerminal } = handlerDeps({
      listAttemptEvents: async () => {
        throw new Error("tenant read failed");
      },
    });
    await createAttemptTerminalProjectionHandler(deps)(SIGNAL);
    expect(projectTerminal).toHaveBeenCalledTimes(1);
    const call = projectTerminal.mock.calls[0]![0] as any;
    expect(call.evidence.events).toEqual([]);
    expect(call.evidence.terminal.outcome).toBe("succeeded");
  });
});

// -- the heartbeat-side adapters ---------------------------------------------
//
// `setRunStatus` is a heartbeat-private closure returning `row | null`; the
// projector's dep returns `won: boolean`. The polarity is invisible to the
// compiler and inverting it is catastrophic in a quiet way: every projection
// would believe it LOST the latch and skip finalization, pinning the agent at
// `running` and dragging every other run of that agent with it (R7). So the
// adapter is a named, tested function — the `toRunExecutionPlacement` precedent.

describe("CLI-006/2b — toProjectorTerminalWriter", () => {
  it("reports WON when setRunStatus returns a row", async () => {
    const write = toProjectorTerminalWriter(async () => ({ id: RUN }));
    await expect(write(RUN, "succeeded", {})).resolves.toBe(true);
  });

  it("reports LOST when setRunStatus returns null", async () => {
    // null covers all three guard-miss branches: row gone, no-op flip, and the
    // metadata-only fallback. All three mean someone else finalized this run.
    const write = toProjectorTerminalWriter(async () => null);
    await expect(write(RUN, "succeeded", {})).resolves.toBe(false);
  });

  it("passes the runId, status and patch through unchanged", async () => {
    const inner = vi.fn(async () => ({ id: RUN }));
    await toProjectorTerminalWriter(inner)(RUN, "failed", { error: "boom" });
    expect(inner).toHaveBeenCalledWith(RUN, "failed", { error: "boom" });
  });
});

describe("CLI-006/2b — projectionSeqBase", () => {
  it("offsets projected events above the run's existing events", () => {
    // The suppression seam (Task 3) writes its handoff lifecycle event at seq 1,
    // and the attempt's own sequence also starts at 1. `heartbeat_run_events` has
    // only a NON-unique (run_id, seq) index, so a collision does not error — it
    // silently interleaves the distributed log with the handoff notice. Offsetting
    // keeps the run's timeline in the order it actually happened.
    expect(projectionSeqBase(1)).toBe(1);
    expect(projectionSeqBase(0)).toBe(0);
    expect(projectionSeqBase(null)).toBe(0);
  });
});
