// packages/shared/src/job-control-source.ts
//
// Two total functions over the `SubmitJobSource` union that were previously
// PRIVATE to `server/src/services/job-submission.ts`. They moved here so the
// submission path and the shadow comparator share ONE definition rather than
// two switches that drift — the comparator needs a loggable source identity,
// and the shadow evidence needs the workload key a real submission would use.
//
// `packages/worker-protocol` is FROZEN; this is the consumer-side shared layer
// and carries no schema.

import type { SubmitJobSource } from "./types/job-control.js";

/**
 * The discriminant identity of an execution source: the one id that names the
 * thing being executed. Total over the union — a new source kind is a compile
 * error here, which is the point.
 */
export function submitJobSourceIdentity(source: SubmitJobSource): string {
  switch (source.kind) {
    case "task_run":
      return source.runId;
    case "commander_turn":
      return source.internalAgentRunId;
    case "crew_run":
      return source.crewRunId;
    case "one_shot":
      return source.operationId;
    case "browser_request":
      return source.browserRequestId;
    case "service_reconcile":
      return source.reconciliationId;
  }
}

/**
 * The distributed workload class a source submits as, and therefore the second
 * half of the rollout key `(organizationId, workloadType)`.
 *
 * NOTE, and it is load-bearing for the cutover: the FOUR sinks this programme
 * cuts over — org heartbeat (`task_run`), Commander (`commander_turn`), crew
 * (`crew_run`) and one-shot (`one_shot`) — ALL map to `"batch"`. One rollout
 * switch therefore arms every one of them together. That is harmless for
 * effect-free shadow, but it means the Wave-4 ordering "MIG-005 then MIG-006
 * then MIG-007, lowest blast radius first" is NOT expressible against this key.
 * A per-sink axis belongs to JOB-007 / MIG-002. Do not fake one by passing a
 * finer string here: placement resolves the same policy using the job's real
 * frozen `workloadType`, so a shadow gated on a key active cannot use would
 * prove nothing about active.
 */
export function submitJobSourceWorkloadType(source: SubmitJobSource): string {
  if (source.kind === "browser_request") return "browser_session";
  if (source.kind === "service_reconcile") return "service";
  return "batch";
}
