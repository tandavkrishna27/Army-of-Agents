// server/src/services/internal-agent/aoa-agents/crew-terminal-projection.ts
//
// MIG-006 slice 2 — project a distributed CREW attempt's terminal back onto the crew run
// experience. The crew analogue of heartbeat's `projectDistributedAttemptTerminal`.
//
// A crew run whose execution was handed off to a worker attempt (slice 1's CREW-SUPPRESSION-RETURN)
// produced its terminal on the DISTRIBUTED side. This projects that terminal onto
// `internal_agent_runs` and the founder-facing task surfaces, reusing the generic,
// dependency-injected `createAttemptTerminalProjectionHandler` + `createCanaryRunProjector` (both
// already unit-tested) with crew-shaped deps. Two crew-specific facts shape the deps:
//
//   1. Crew runs live in `internal_agent_runs` (columns completed_at / error_message / token_usage
//      / cost_cents, status vocabulary completed|failed|cancelled), NOT `heartbeat_runs`
//      (finished_at / error / usage_json, succeeded|…). `setRunStatus` translates both.
//   2. A distributed crew run is TOOL-LESS (Unit C unbuilt), so it cannot advance its own task.
//      `finalizeRun` therefore does NOT replicate the runner's advance/stall completion logic
//      (`runner.ts:1320-1397`, which is for a tool-CAPABLE local run) — it releases the execution
//      lock (leaving the task in_progress and founder-actionable) and runs the W3a loopback the
//      suppression return skipped.
//
// Registered INERT alongside the heartbeat projection: the projector no-ops (findRunForAttempt
// returns null) for any attempt no crew run carries, so the two projections compose safely — the
// two run tables are disjoint per attempt.

import type { Db } from "@armyofagents/db";
import { agents, internalAgentRuns, issues } from "@armyofagents/db";
import { and, eq } from "drizzle-orm";

import { createAttemptTerminalProjectionHandler, type AttemptEventRow } from "../../canary-terminal-projection.js";
import { createCanaryRunProjector } from "../../canary-run-projector.js";
import type { AttemptTerminalSignal } from "../../job-events.js";
import { logger } from "../../../middleware/logger.js";
import { postCrewRunFailure, postCrewRunSuccess } from "./crew-run-outcome.js";

const log = logger.child({ svc: "crew-terminal-projection" });

/**
 * PURE: the projector emits the FROZEN worker-protocol run-status vocabulary via
 * `runStatusForOutcome` (`succeeded | failed | cancelled`); `internal_agent_runs` uses
 * `completed | failed | cancelled`. Only `succeeded → completed` differs.
 */
export function crewRunStatusForProjection(projectorStatus: string): string {
  return projectorStatus === "succeeded" ? "completed" : projectorStatus;
}

/**
 * PURE: translate the projector's heartbeat_runs-shaped terminal patch
 * (`{finishedAt, error, usageJson:{inputTokens, outputTokens, costUsd, durationMs, …}}`) onto the
 * `internal_agent_runs` columns. `costCents` is derived from `costUsd` the way the runner does
 * (`Math.round(costUsd * 100)`); any null/absent field maps to null.
 */
export function crewRunTerminalPatch(patch: Record<string, unknown>): {
  completedAt: Date | null;
  errorMessage: string | null;
  tokenUsage: { inputTokens: number | null; outputTokens: number | null } | null;
  costCents: number | null;
  durationMs: number | null;
} {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const usage =
    patch.usageJson && typeof patch.usageJson === "object"
      ? (patch.usageJson as Record<string, unknown>)
      : null;
  const costUsd = usage ? num(usage.costUsd) : null;
  return {
    completedAt: patch.finishedAt instanceof Date ? patch.finishedAt : null,
    errorMessage: typeof patch.error === "string" ? patch.error : null,
    tokenUsage: usage ? { inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens) } : null,
    costCents: costUsd !== null ? Math.round(costUsd * 100) : null,
    durationMs: usage ? num(usage.durationMs) : null,
  };
}

export function createCrewAttemptTerminalProjection(db: Db) {
  // CLI-006 finalizeRun analogue for crew: discharge, for a handed-off run whose terminal latch
  // this projection just won, the finalization the SUPPRESSION RETURN skipped. Best-effort per
  // substep; never throws (the projector runs it inside an after-commit hook).
  async function releaseIssueLockAndLoopback(input: {
    runId: string;
    companyId: string;
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
    errorMessage: string | null;
  }): Promise<void> {
    const run = await db
      .select({
        agentId: internalAgentRuns.agentId,
        relatedEntityType: internalAgentRuns.relatedEntityType,
        relatedEntityId: internalAgentRuns.relatedEntityId,
      })
      .from(internalAgentRuns)
      .where(eq(internalAgentRuns.id, input.runId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run) return;
    const issueId = run.relatedEntityType === "task" ? run.relatedEntityId : null;
    if (!issueId) return;

    // (1) Release the execution lock the suppression return skipped (runner.ts:1320-1377). Guarded
    //     on executionRunId=runId AND status='in_progress' so a concurrent re-claim is never
    //     clobbered. LEAVE the status in_progress: a tool-less distributed run could not advance the
    //     task, so it is founder-actionable, NOT a stall — do not release-to-todo/throw (that logic
    //     is for a tool-capable local run). Best-effort.
    try {
      await db
        .update(issues)
        .set({
          executionRunId: null,
          checkoutRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(issues.id, issueId), eq(issues.executionRunId, input.runId), eq(issues.status, "in_progress")));
    } catch (err) {
      log.warn({ err, issueId, runId: input.runId }, "[MIG-006] crew finalize: issue lock release failed");
    }

    // (2) The W3a loopback the suppression return skipped (relay/card + delivery). The token/cost
    //     evidence already landed on the run row via setRunStatus; the loopback's own summary shows
    //     duration only (the distributed lane surfaces no adapter usage to this seam).
    const agentId = run.agentId;
    if (!agentId) return; // agent row deleted mid-flight → nothing to loop back to (lock released).
    const agent = await db
      .select({ name: agents.name, runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!agent) return;
    const runtimeConfig = agent.runtimeConfig as Record<string, unknown> | null | undefined;
    const nowMs = Date.now();
    try {
      if (input.outcome === "succeeded") {
        await postCrewRunSuccess(db, {
          companyId: input.companyId,
          issueId,
          agentName: agent.name,
          runtimeConfig,
          startedAtMs: nowMs,
          nowMs,
          adapterUsage: undefined,
          costCents: null,
          runId: input.runId,
          agentId,
        });
      } else {
        await postCrewRunFailure(db, {
          companyId: input.companyId,
          issueId,
          agentId,
          agentName: agent.name,
          runtimeConfig,
          startedAtMs: nowMs,
          nowMs,
          errorMessage: input.errorMessage ?? "distributed crew run failed",
          runId: input.runId,
        });
      }
    } catch (err) {
      log.warn({ err, issueId, runId: input.runId }, "[MIG-006] crew finalize: W3a loopback failed");
    }
  }

  return {
    async projectCrewAttemptTerminal(input: {
      signal: AttemptTerminalSignal;
      listAttemptEvents: (i: {
        organizationId: string;
        companyId: string;
        jobId: string;
        attemptId: string;
      }) => Promise<readonly AttemptEventRow[]>;
    }): Promise<void> {
      const handler = createAttemptTerminalProjectionHandler({
        findRunForAttempt: ({ jobId, attemptId, companyId }) =>
          db
            .select({
              id: internalAgentRuns.id,
              companyId: internalAgentRuns.companyId,
              agentId: internalAgentRuns.agentId,
              executionOwner: internalAgentRuns.executionOwner,
              startedAt: internalAgentRuns.createdAt,
            })
            .from(internalAgentRuns)
            .where(
              and(
                eq(internalAgentRuns.companyId, companyId),
                eq(internalAgentRuns.distributedJobId, jobId),
                eq(internalAgentRuns.distributedAttemptId, attemptId),
              ),
            )
            .limit(1)
            // internal_agent_runs.agent_id is nullable (ON DELETE SET NULL); CanaryRunRow.agentId
            // is non-null. A run whose agent row was deleted mid-flight is not projectable — drop
            // it (return null) rather than widen the shared row shape.
            .then((rows) => {
              const r = rows[0];
              return r && r.agentId != null ? { ...r, agentId: r.agentId } : null;
            }),

        listAttemptEvents: input.listAttemptEvents,

        // Resolved BEFORE projection because finalizeRun releases the very execution lock this
        // issue lookup reads.
        resolveTarget: async ({ run }) => {
          const agent = await db
            .select({ name: agents.name, runtimeConfig: agents.runtimeConfig })
            .from(agents)
            .where(eq(agents.id, run.agentId))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!agent) return null;
          const issue = await db
            .select({ id: issues.id })
            .from(issues)
            .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          return {
            issueId: issue?.id ?? null,
            agentName: agent.name,
            runtimeConfig: agent.runtimeConfig as Record<string, unknown> | null | undefined,
          };
        },

        projector: createCanaryRunProjector({
          // internal_agent_runs has no per-event table; the crew transcript rides the run-log store,
          // not run-event rows. Nothing to project per event.
          appendRunEvent: async () => {},
          setRunStatus: async (runId, status, patch) => {
            const mapped = crewRunTerminalPatch(patch);
            const rows = await db
              .update(internalAgentRuns)
              .set({
                status: crewRunStatusForProjection(status),
                completedAt: mapped.completedAt ?? new Date(),
                errorMessage: mapped.errorMessage,
                // The jsonb column's setter is typed Record<string, unknown> | …; the mapped usage
                // is exactly that at runtime but its precise shape lacks an index signature.
                tokenUsage: mapped.tokenUsage as unknown as Record<string, unknown> | null,
                costCents: mapped.costCents,
                durationMs: mapped.durationMs,
              })
              // The latch: only a still-'running' run is ours to terminalize. A run a
              // continuation/failure already finished returns zero rows → lost (the projector then
              // skips finalize + summary, so it never releases a lock out from under the winner).
              .where(and(eq(internalAgentRuns.id, runId), eq(internalAgentRuns.status, "running")))
              .returning({ id: internalAgentRuns.id });
            return rows.length > 0;
          },
          finalizeRun: ({ runId, companyId, outcome, errorMessage }) =>
            releaseIssueLockAndLoopback({ runId, companyId, outcome, errorMessage }),
          // finalizeRun's W3a loopback posts the task run-summary; the projector's own summary step
          // is a no-op to avoid a duplicate comment on the task.
          postRunSummary: async () => ({ posted: false }),
        }),
      });

      try {
        await handler(input.signal);
      } catch (err) {
        log.warn({ err, signal: input.signal }, "[MIG-006] crew distributed attempt terminal projection failed");
      }
    },
  };
}
