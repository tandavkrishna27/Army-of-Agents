// crew-distributed-gate.test.ts — MIG-006 slice 2a.
//
// The crew distributed-execution gate: the SEPARATE off-by-default crew flag, and the pure
// decision (crew flag → canary state → workload ok) that the runAoaAgent seam consumes. These
// arms pin the fail-safe order — chiefly that the crew flag is the INDEPENDENT first gate, so a
// task_run-canary org does not auto-arm tool-less crew.
import { describe, expect, it } from "vitest";
import {
  resolveCrewDistributedGate,
  type CrewDistributedGateInput,
} from "../services/internal-agent/aoa-agents/crew-distributed-gate.js";
import {
  readDistributedCrewRolloutFlag,
  DISTRIBUTED_CREW_ROLLOUT_ENABLED_ENV,
} from "../config/distributed-execution.js";
import type { BuildTaskRunBatchWorkloadResult } from "../services/task-run-batch-workload.js";

const okWorkload: BuildTaskRunBatchWorkloadResult = {
  ok: true,
  workload: { command: "claude", args: ["--print"], stdinArtifactId: null, maxRuntimeSeconds: 240 },
  stagedFiles: [],
};
const refusedWorkload: BuildTaskRunBatchWorkloadResult = { ok: false, reason: "adapter_not_v1_scope" };

const gate = (over: Partial<CrewDistributedGateInput> = {}) =>
  resolveCrewDistributedGate({ rolloutState: "canary", crewRolloutEnabled: true, workload: okWorkload, ...over });

describe("readDistributedCrewRolloutFlag — MIG-006 crew gate", () => {
  it("defaults OFF (the separate crew gate is opt-in)", () => {
    expect(readDistributedCrewRolloutFlag({})).toBe(false);
  });
  it("is ON only when the env is explicitly set truthy", () => {
    expect(readDistributedCrewRolloutFlag({ [DISTRIBUTED_CREW_ROLLOUT_ENABLED_ENV]: "true" })).toBe(true);
  });
});

describe("resolveCrewDistributedGate — MIG-006 crew gate", () => {
  it("stays legacy (crew_rollout_disabled) when the crew flag is off — EVEN for a canary org (independent gate)", () => {
    expect(gate({ crewRolloutEnabled: false })).toEqual({ attempt: false, reason: "crew_rollout_disabled" });
  });

  it("stays legacy (not_canary) for a non-canary org (active/shadow/off) with the crew flag on", () => {
    for (const rolloutState of ["off", "shadow", "active"] as const) {
      const g = gate({ rolloutState });
      expect(g.attempt).toBe(false);
      if (!g.attempt) expect(g.reason).toBe("not_canary");
    }
  });

  it("stays legacy (workload_unavailable) when the crew workload could not be built", () => {
    const g = gate({ workload: refusedWorkload });
    expect(g.attempt).toBe(false);
    if (!g.attempt) expect(g.reason).toBe("workload_unavailable");
  });

  it("attempts distributed (carrying the workload + staged files) when flag on + canary + workload ok", () => {
    const g = gate();
    expect(g.attempt).toBe(true);
    if (g.attempt) {
      expect(g.workload.command).toBe("claude");
      expect(g.stagedFiles).toEqual([]);
    }
  });
});
