// server/src/services/internal-agent/aoa-agents/crew-distributed-gate.ts
//
// MIG-006 slice 2a — the crew distributed-execution GATE (a pure decision).
//
// The crew seam in `runAoaAgent` must make ONE explicit, auditable decision: does this crew run
// transfer to the distributed substrate, or execute on the legacy in-process adapter? This
// function is that decision, extracted so it is testable independent of the runAoaAgent
// integration — the same reason `shouldSuppressLegacyExecution` and `toRunExecutionPlacement`
// are named functions rather than inline conditions.
//
// THREE gates, in a deliberate order:
//   1. The SEPARATE crew flag (`readDistributedCrewRolloutFlag`), checked FIRST. It is
//      independent of the task_run rollout dial, so arming an org's task_run canary never
//      auto-arms crew — a distributed crew agent is tool-less (CLI-008 Unit C) and crew work
//      leans on its `aoa` MCP tools far more than a one-shot task run.
//   2. The org rollout STATE must be `canary` — real distributed execution. task_run reserves
//      `active` for the CLI-005 inert convert; `off`/`shadow`/`active` never transfer crew.
//   3. The workload the seam already built (`buildTaskRunBatchWorkload`, from `agent.adapterType`)
//      must be `ok`; a refusal
//      (non-v1 provider, empty prompt, …) stays legacy with an attributable reason.
//
// Fail-safe: every non-attempt is a LEGACY run with a machine-readable reason. This function
// never decides "distributed" on a missing signal.

import type { RunRolloutState } from "../../../config/distributed-execution-rollout-source.js";
import type { BatchWorkloadV1 } from "@armyofagents/worker-protocol";
import type {
  BuildTaskRunBatchWorkloadResult,
  TaskRunStagedFile,
} from "../../task-run-batch-workload.js";

export type CrewDistributedGate =
  | {
      readonly attempt: false;
      /** Machine-readable so the seam can log an attributable "stayed legacy" cause. */
      readonly reason: "crew_rollout_disabled" | "not_canary" | "workload_unavailable";
      readonly detail?: string;
    }
  | {
      readonly attempt: true;
      readonly workload: BatchWorkloadV1;
      readonly stagedFiles: readonly TaskRunStagedFile[];
    };

export interface CrewDistributedGateInput {
  /** The org's resolved rollout state (via the same hook the heartbeat seam uses). */
  readonly rolloutState: RunRolloutState;
  /** The SEPARATE crew gate (`readDistributedCrewRolloutFlag`), off by default. */
  readonly crewRolloutEnabled: boolean;
  /** The workload the seam built from `buildTaskRunBatchWorkload` (`agent.adapterType`). */
  readonly workload: BuildTaskRunBatchWorkloadResult;
}

export function resolveCrewDistributedGate(input: CrewDistributedGateInput): CrewDistributedGate {
  // 1. The independent crew gate, FIRST — a task_run-canary org must not auto-arm tool-less crew.
  if (!input.crewRolloutEnabled) return { attempt: false, reason: "crew_rollout_disabled" };
  // 2. Real distributed execution is CANARY only (task_run reserves `active` for the inert convert).
  if (input.rolloutState !== "canary") {
    return { attempt: false, reason: "not_canary", detail: `rollout state is ${input.rolloutState}` };
  }
  // 3. The seam-built workload must be usable; a refusal stays legacy with its own reason.
  if (!input.workload.ok) {
    return { attempt: false, reason: "workload_unavailable", detail: input.workload.reason };
  }
  return { attempt: true, workload: input.workload.workload, stagedFiles: input.workload.stagedFiles };
}
