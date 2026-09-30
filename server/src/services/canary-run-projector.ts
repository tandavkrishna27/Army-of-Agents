// server/src/services/canary-run-projector.ts
//
// CLI-006 (D5) — the run-experience projector.
//
// A canary-owned run executes on the DISTRIBUTED side, so its evidence is produced
// there: CLI-003's `log`/`progress`/`usage`/terminal producers → the worker's durable
// sink → JOB-005 idempotent ingest, with MIG-003 supplying reconnect-safe catch-up.
// None of that is visible in the surface a founder actually looks at. This module
// projects it onto the EXISTING run experience — `heartbeat_run_events`, the run's
// terminal status, and the shared run-summary comment writer — so a canary run reads
// exactly like a legacy one.
//
// **Invariant 8 — a projection is not an authority.** The projector never invents run
// state. It maps the attempt's durable terminal onto the run through the SAME
// `setRunStatus` every other path uses, so that function's terminal latch still
// governs: a run a cancel already finished is not resurrected here. There is
// deliberately no second write path for run status.
//
// Best-effort per substep, mirroring the crew loopback (`postCrewRunSuccess`): a
// failing event projection must not cost the terminal, a failing terminal must not
// cost the summary, and the projector must NEVER throw into its caller.

export type CanaryAttemptOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

export interface CanaryAttemptEvent {
  /** JOB-005 ingest identity — the dedupe key for redelivered fan-out. */
  readonly eventId: string;
  readonly seq: number;
  readonly type: string;
  readonly stream?: "stdout" | "stderr";
  readonly message?: string;
  readonly payload?: Record<string, unknown>;
}

export interface CanaryAttemptEvidence {
  readonly jobId: string;
  readonly attemptId: string;
  readonly events: readonly CanaryAttemptEvent[];
  readonly terminal: {
    readonly outcome: CanaryAttemptOutcome;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
  };
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly costUsd: number | null;
    readonly durationMs: number;
  };
  /**
   * When the attempt finished, stamped onto the run's `finished_at` (E7-F036). A run
   * is DURABLY terminal only when it carries BOTH a terminal status and a finish time
   * (evidence-verifier A clause 3); `setRunStatus` never derives it, so — like every
   * legacy terminal caller — the projector must supply it.
   */
  readonly finishedAt: Date;
  readonly detectedFiles: ReadonlyArray<{ path: string; type?: string }>;
}

export interface CanaryProjectionTarget {
  readonly runId: string;
  readonly companyId: string;
  readonly issueId: string | null;
  readonly agentName: string;
  readonly runtimeConfig: Record<string, unknown> | null | undefined;
}

export interface CanaryRunProjectorDeps {
  appendRunEvent(event: {
    runId: string;
    companyId: string;
    seq: number;
    eventType: string;
    stream?: "stdout" | "stderr";
    message?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  /**
   * Write the run's terminal. Resolves `true` when this write WON the terminal
   * latch, `false` when it lost (the row was gone, already terminal, or fell to
   * the metadata-only fallback — `setRunStatus` returns null in all three).
   * Losing means someone else already finalized this run.
   */
  setRunStatus(
    runId: string,
    status: string,
    patch: Record<string, unknown>,
  ): Promise<boolean>;
  /**
   * Discharge the rest of what the legacy completion path does: release the issue
   * execution lock (so the next wake can run), reset the agent's status, and
   * terminalize the wakeup request. A suppressed run skips all of that, so the
   * projector must drive it — otherwise the agent stays pinned at `running`, and
   * because `finalizeAgentStatus` recomputes from the count of running rows, the
   * pinned row also keeps every OTHER run of that agent at `running` (R7).
   *
   * Optional so a deployment that has not wired the canary path composes exactly
   * the pre-CLI-006 projector.
   */
  finalizeRun?(input: {
    runId: string;
    companyId: string;
    outcome: CanaryAttemptOutcome;
    errorMessage: string | null;
  }): Promise<void>;
  postRunSummary(input: {
    companyId: string;
    issueId: string | null;
    agentName: string;
    runtimeConfig: Record<string, unknown> | null | undefined;
    outcome: CanaryAttemptOutcome;
    runId: string;
    durationMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    errorMessage: string | null;
    detectedFiles: Array<{ path: string; type?: string }>;
  }): Promise<{ posted: boolean }>;
}

export interface CanaryRunProjector {
  projectTerminal(input: {
    target: CanaryProjectionTarget;
    evidence: CanaryAttemptEvidence;
  }): Promise<void>;
}

/**
 * The attempt's terminal vocabulary is the frozen worker-protocol one; the run's is
 * the legacy heartbeat one. `timed_out` has no distinct run status, and a timeout IS
 * a failure from the founder's point of view, so it maps to `failed` while the
 * distinguishing detail survives in `errorCode` on the run patch and the summary.
 */
function runStatusForOutcome(outcome: CanaryAttemptOutcome): string {
  switch (outcome) {
    case "succeeded":
      // "succeeded", NOT "completed". The run-status vocabulary is
      // `TERMINAL_RUN_STATUSES` (heartbeat.ts:292) = succeeded|failed|cancelled|
      // timed_out. "completed" belongs to the WAKEUP status vocabulary
      // (heartbeat.ts:5452) and is not a terminal run status — writing it would
      // leave a successfully projected run permanently un-latched: never terminal,
      // no terminal hub emit, skipped by the work-question continuation gate, and
      // invisible to reapOrphanedRuns (which selects queued|running).
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "timed_out":
      return "failed";
  }
}

export function createCanaryRunProjector(deps: CanaryRunProjectorDeps): CanaryRunProjector {
  return {
    async projectTerminal({ target, evidence }) {
      // (1) Events, in durable sequence order, deduped by ingest identity. The
      // source may redeliver (at-least-once fan-out) and may arrive out of order
      // after a reconnect catch-up; the run experience must show neither.
      try {
        const seen = new Set<string>();
        const ordered = [...evidence.events]
          .filter((event) => {
            if (seen.has(event.eventId)) return false;
            seen.add(event.eventId);
            return true;
          })
          .sort((a, b) => a.seq - b.seq);
        for (const event of ordered) {
          await deps.appendRunEvent({
            runId: target.runId,
            companyId: target.companyId,
            seq: event.seq,
            eventType: event.type,
            stream: event.stream,
            message: event.message,
            payload: event.payload,
          });
        }
      } catch {
        // A failed projection costs visibility, never the terminal below.
      }

      // (2) The terminal — through the one shared writer, latch and all.
      //
      // `lostLatch` and a THROW are different failures and must behave differently.
      // Losing the latch means someone else already finalized this run — a
      // concurrent cancel, or a redelivered terminal — so re-finalizing would
      // release an issue lock and reset an agent out from under whoever won, and
      // re-posting the summary would duplicate a comment on the task. A throw is an
      // infrastructure fault where the run is still ours to finish, so the
      // remaining substeps proceed (best-effort, as before).
      let lostLatch = false;
      try {
        const won = await deps.setRunStatus(target.runId, runStatusForOutcome(evidence.terminal.outcome), {
          // DURABLY terminal: a terminal status alone leaves finished_at null (setRunStatus
          // never derives it), which the verifier reads as not-yet-finished — E7-F036.
          finishedAt: evidence.finishedAt,
          error: evidence.terminal.errorMessage,
          usageJson: {
            inputTokens: evidence.usage.inputTokens,
            outputTokens: evidence.usage.outputTokens,
            costUsd: evidence.usage.costUsd,
            durationMs: evidence.usage.durationMs,
            distributedJobId: evidence.jobId,
            distributedAttemptId: evidence.attemptId,
            terminalErrorCode: evidence.terminal.errorCode,
          },
        });
        lostLatch = won === false;
      } catch {
        // An infrastructure fault, not a race — the run is still ours to finish.
      }

      // (3) Finalize the rest of what the legacy completion path does: release the
      // issue execution lock, reset the agent's status, terminalize the wakeup.
      // Skipped when the latch was lost — whoever won already did this, and
      // repeating it would release a lock and reset an agent out from under them.
      if (!lostLatch && deps.finalizeRun) {
        try {
          await deps.finalizeRun({
            runId: target.runId,
            companyId: target.companyId,
            outcome: evidence.terminal.outcome,
            errorMessage: evidence.terminal.errorMessage,
          });
        } catch {
          // Best-effort; the summary below is still worth posting.
        }
      }

      // (4) The run-summary comment, via the SAME writer heartbeat and crew use, so
      // the format and the `autoRunSummary` opt-out live in one place. Skipped with
      // no issue — there is nothing to comment on — while the run terminal above is
      // deliberately NOT issue-gated.
      if (lostLatch || !target.issueId) return;
      try {
        await deps.postRunSummary({
          companyId: target.companyId,
          issueId: target.issueId,
          agentName: target.agentName,
          runtimeConfig: target.runtimeConfig,
          outcome: evidence.terminal.outcome,
          runId: target.runId,
          durationMs: evidence.usage.durationMs,
          inputTokens: evidence.usage.inputTokens,
          outputTokens: evidence.usage.outputTokens,
          costUsd: evidence.usage.costUsd,
          errorMessage: evidence.terminal.errorMessage,
          detectedFiles: [...evidence.detectedFiles],
        });
      } catch {
        // The shared writer is already best-effort; this guards the delegation.
      }
    },
  };
}
