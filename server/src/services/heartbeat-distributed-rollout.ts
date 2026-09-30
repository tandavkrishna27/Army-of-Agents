// server/src/services/heartbeat-distributed-rollout.ts
//
// CLI-005 (D1/D2/D3) — the SINGLE, tightly flag-gated, dormant-by-default hook the org
// heartbeat seam calls. It composes the rollout-state resolver, the effect-free shadow
// comparator, and the active convert orchestrator behind ONE small surface so that
// `heartbeat.ts` adds only a handful of guarded call sites.
//
// DORMANCY / byte-identical flag-off: `resolveRunRolloutState` reads the deployment flag
// FIRST and returns "off" BEFORE any Organization resolution or rollout-source read, so a
// flag-off deployment performs no DB lookup and no effect — the legacy path is untouched.
// The hook itself is only INJECTED into `heartbeatService` by the composition root when
// distributed execution is enabled; when it is absent, the seam skips the hook entirely.
//
// Every method is best-effort: a failure in rollout resolution, shadow comparison, or
// active convert is swallowed (logged by the caller) and NEVER fails the legacy run.

import type { DeploymentMode, SubmitJobSource } from "@armyofagents/shared";
import { readDistributedExecutionDeploymentFlag } from "../config/distributed-execution.js";
import type {
  DistributedExecutionRolloutSource,
  RunRolloutState,
} from "../config/distributed-execution-rollout-source.js";
import type { BridgeActor } from "./job-admission-bridge.js";
import type { JobConvertOrchestrator, JobConvertResult } from "./job-convert-orchestrator.js";
import type { JobShadowComparator, LegacyRunExecutionSnapshot } from "./job-shadow-comparator.js";
import type { RunExecutionOwner, RunExecutionOwnerResolver } from "./run-execution-owner.js";

/** task_run maps to the distributed "batch" workload class (job-submission workloadType). */
export const HEARTBEAT_TASK_RUN_WORKLOAD_TYPE = "batch";

type Env = Record<string, string | undefined>;

/** Flag-first gate: a flag-off deployment never resolves an Organization or a rollout. */
export function isDistributedExecutionFlagEnabled(env: Env = process.env): boolean {
  return readDistributedExecutionDeploymentFlag(env);
}

export interface HeartbeatRolloutResolution {
  readonly state: RunRolloutState;
  /** The resolved Organization id (null when off / unresolved). */
  readonly organizationId: string | null;
}

export interface HeartbeatDistributedRolloutHook {
  /**
   * Resolve one heartbeat run to `off | shadow | active`. Returns `{ state:"off" }`
   * (without any Organization lookup) when the deployment flag is off, and `off`
   * best-effort if Organization/rollout resolution throws. The resolved `organizationId`
   * is returned so a shadow comparison can label its record without a second lookup.
   */
  resolveRunRolloutState(input: {
    companyId: string;
    /**
     * MIG-002 per-sink axis. Optional, and omitting it means "do not filter by sink" — so a
     * caller that does not pass it behaves exactly as before. Every real caller SHOULD pass it,
     * or an Organization opted in for one sink would enable them all.
     */
    sourceKind?: string;
  }): Promise<HeartbeatRolloutResolution>;
  /** Active convert (D3): delegate to the orchestrator. Best-effort; never throws. */
  convertActiveRun(input: {
    source: SubmitJobSource;
    actor: BridgeActor;
    idempotencyKey: string;
    input?: Record<string, unknown>;
  }): Promise<JobConvertResult>;
  /**
   * CLI-006 (D3) canary transfer: resolve WHO executes this run. Delegates to the
   * single ownership decision, which converts, places, and returns either
   * `{owner:"distributed"}` (the attempt is leasable — the legacy adapter MUST be
   * suppressed) or `{owner:"legacy", reason}`. Best-effort: never throws, and every
   * failure direction is legacy.
   *
   * `rolloutState` is passed through because the seam has already resolved it, so
   * the canary predicate is derived exactly once per run.
   */
  resolveExecutionOwner(input: {
    source: SubmitJobSource;
    actor: BridgeActor;
    organizationId: string;
    idempotencyKey: string;
    rolloutState: RunRolloutState;
    input?: Record<string, unknown>;
    /**
     * CLI-008 Unit D — the control-plane-authored files this run's argv READS (the prompt and,
     * when the agent has one, the instructions bundle entry file). Built by
     * `buildTaskRunBatchWorkload` alongside the workload, so the two cannot name different
     * paths, and forwarded verbatim to the ownership decision, which stages them between the
     * convert and the placement.
     *
     * ★ THE PASS-THROUGH IS THE WHOLE JOB HERE, AND IT IS EASY TO FORGET. This hook destructures
     * its input explicitly, so a field that is added to the type and not to BOTH the
     * destructure and the delegated call is silently dropped — the run is then placed with an
     * argv that reads files nobody staged. `heartbeat-distributed-rollout.test.ts` asserts the
     * forwarding rather than the type.
     */
    stagedFiles?: readonly { readonly path: string; readonly bytes: Uint8Array; readonly contentType?: string }[];
  }): Promise<RunExecutionOwner>;
  /** Shadow comparison (D2): delegate to the effect-free comparator. Never throws. */
  runShadowComparison(snapshot: LegacyRunExecutionSnapshot): void;
}

export function createHeartbeatDistributedRolloutHook(deps: {
  env?: Env;
  deploymentMode: DeploymentMode;
  rolloutSource: DistributedExecutionRolloutSource;
  /** Resolve the immutable Company→Organization edge (only called when the flag is on). */
  resolveOrganizationId(companyId: string): Promise<string | null>;
  convertOrchestrator: JobConvertOrchestrator;
  comparator: JobShadowComparator;
  /**
   * CLI-006: the single ownership decision. Optional so a deployment that has not
   * wired the canary path at all composes exactly the CLI-005 hook — absent
   * resolver ⇒ every run stays legacy, which is the safe default.
   */
  ownerResolver?: RunExecutionOwnerResolver;
}): HeartbeatDistributedRolloutHook {
  const env = deps.env ?? process.env;

  return {
    async resolveRunRolloutState({ companyId, sourceKind }) {
      // FLAG FIRST — no Organization resolution, no rollout-source read when off.
      if (!isDistributedExecutionFlagEnabled(env)) return { state: "off", organizationId: null };
      try {
        const organizationId = await deps.resolveOrganizationId(companyId);
        if (!organizationId) return { state: "off", organizationId: null };
        const state = deps.rolloutSource.resolveRunRolloutState({
          deploymentMode: deps.deploymentMode,
          organizationId,
          workloadType: HEARTBEAT_TASK_RUN_WORKLOAD_TYPE,
          sourceKind,
        });
        return { state, organizationId };
      } catch {
        // Never fail the legacy run over a rollout-resolution error — stay legacy.
        return { state: "off", organizationId: null };
      }
    },

    async convertActiveRun(input) {
      try {
        return await deps.convertOrchestrator.convertRunToJob(input);
      } catch (error) {
        // The orchestrator already swallows submit failures; this guards the delegation
        // boundary itself so the legacy run can never be failed by the convert path.
        return { converted: false, reason: "submit_failed", error };
      }
    },

    async resolveExecutionOwner({ source, actor, organizationId, idempotencyKey, rolloutState, input, stagedFiles }) {
      // An unwired resolver is a legacy deployment. Never guess.
      if (!deps.ownerResolver) {
        return { owner: "legacy", reason: "rollout_not_canary", detail: "owner resolver not composed" };
      }
      try {
        return await deps.ownerResolver.resolve({
          source,
          actor,
          organizationId,
          workloadType: HEARTBEAT_TASK_RUN_WORKLOAD_TYPE,
          idempotencyKey,
          jobInput: input,
          rolloutState,
          stagedFiles,
        });
      } catch (error) {
        // The resolver already fails safe internally; this guards the delegation
        // boundary itself so the legacy run can never be failed by the transfer path.
        return {
          owner: "legacy",
          reason: "transfer_error",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    runShadowComparison(snapshot) {
      try {
        deps.comparator.compare(snapshot);
      } catch {
        // The comparator is already effect-free + best-effort; this is a final guard.
      }
    },
  };
}
