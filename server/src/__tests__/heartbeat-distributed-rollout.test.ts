import { describe, expect, it, vi } from "vitest";
import type { SubmitJobSource } from "@armyofagents/shared";
import {
  HEARTBEAT_TASK_RUN_WORKLOAD_TYPE,
  createHeartbeatDistributedRolloutHook,
  isDistributedExecutionFlagEnabled,
} from "../services/heartbeat-distributed-rollout.js";
import { DISTRIBUTED_EXECUTION_ENABLED_ENV } from "../config/distributed-execution.js";
import type { DistributedExecutionRolloutSource } from "../config/distributed-execution-rollout-source.js";
import type { JobConvertOrchestrator } from "../services/job-convert-orchestrator.js";
import type { JobShadowComparator, LegacyRunExecutionSnapshot } from "../services/job-shadow-comparator.js";

const COMPANY = "22222222-2222-4222-8222-222222222222";
const ORG = "11111111-1111-4111-8111-111111111111";

const SNAPSHOT: LegacyRunExecutionSnapshot = {
  organizationId: ORG,
  companyId: COMPANY,
  runId: "33333333-3333-4333-8333-333333333333",
  issueId: "44444444-4444-4444-8444-444444444444",
  assigneeAgentId: "55555555-5555-4555-8555-555555555555",
  workloadType: HEARTBEAT_TASK_RUN_WORKLOAD_TYPE,
  routing: { executionTargetType: "local" },
  provenance: { executionPrincipalKind: "agent", credentialKind: null },
  policy: { model: null, budgetPolicyId: null, effectiveCompletionPolicy: "review_required" },
  workloadCharacterization: { command: "claude", args: [], maxRuntimeSeconds: 600, stdinArtifactId: null },
};

function fakeRolloutSource(state: "off" | "shadow" | "active"): DistributedExecutionRolloutSource {
  return {
    resolveOrganizationPolicy: () => ({ enabled: state !== "off", mode: state === "active" ? "active" : "shadow" }),
    resolveWorkloadPolicy: () => state !== "off",
    resolveRunRolloutState: () => state,
  };
}

describe("CLI-005 heartbeat distributed-rollout hook (flag-first, dormant by default)", () => {
  it("isDistributedExecutionFlagEnabled defaults off", () => {
    expect(isDistributedExecutionFlagEnabled({})).toBe(false);
    expect(isDistributedExecutionFlagEnabled({ [DISTRIBUTED_EXECUTION_ENABLED_ENV]: "true" })).toBe(true);
  });

  it("resolves off WITHOUT touching org resolution when the flag is off (no DB effect)", async () => {
    const resolveOrganizationId = vi.fn(async () => ORG);
    const hook = createHeartbeatDistributedRolloutHook({
      env: { [DISTRIBUTED_EXECUTION_ENABLED_ENV]: "false" },
      deploymentMode: "cloud_auth",
      rolloutSource: fakeRolloutSource("active"),
      resolveOrganizationId,
      convertOrchestrator: { convertRunToJob: vi.fn() } as unknown as JobConvertOrchestrator,
      comparator: { compare: vi.fn() } as unknown as JobShadowComparator,
    });

    const resolution = await hook.resolveRunRolloutState({ companyId: COMPANY });
    expect(resolution).toEqual({ state: "off", organizationId: null });
    expect(resolveOrganizationId).not.toHaveBeenCalled();
  });

  it("resolves shadow / active from the rollout source when the flag is on", async () => {
    for (const mode of ["shadow", "active"] as const) {
      const hook = createHeartbeatDistributedRolloutHook({
        env: { [DISTRIBUTED_EXECUTION_ENABLED_ENV]: "true" },
        deploymentMode: "cloud_auth",
        rolloutSource: fakeRolloutSource(mode),
        resolveOrganizationId: vi.fn(async () => ORG),
        convertOrchestrator: { convertRunToJob: vi.fn() } as unknown as JobConvertOrchestrator,
        comparator: { compare: vi.fn() } as unknown as JobShadowComparator,
      });
      expect(await hook.resolveRunRolloutState({ companyId: COMPANY })).toEqual({
        state: mode,
        organizationId: ORG,
      });
    }
  });

  it("resolves off (best-effort) when org resolution fails — never throws into the run", async () => {
    const hook = createHeartbeatDistributedRolloutHook({
      env: { [DISTRIBUTED_EXECUTION_ENABLED_ENV]: "true" },
      deploymentMode: "cloud_auth",
      rolloutSource: fakeRolloutSource("active"),
      resolveOrganizationId: vi.fn(async () => {
        throw new Error("org lookup failed");
      }),
      convertOrchestrator: { convertRunToJob: vi.fn() } as unknown as JobConvertOrchestrator,
      comparator: { compare: vi.fn() } as unknown as JobShadowComparator,
    });
    expect(await hook.resolveRunRolloutState({ companyId: COMPANY })).toEqual({
      state: "off",
      organizationId: null,
    });
  });

  it("delegates active convert to the orchestrator", async () => {
    const convertRunToJob = vi.fn(async () => ({ converted: true as const, reason: "submitted" as const }));
    const hook = createHeartbeatDistributedRolloutHook({
      env: { [DISTRIBUTED_EXECUTION_ENABLED_ENV]: "true" },
      deploymentMode: "cloud_auth",
      rolloutSource: fakeRolloutSource("active"),
      resolveOrganizationId: vi.fn(async () => ORG),
      convertOrchestrator: { convertRunToJob } as unknown as JobConvertOrchestrator,
      comparator: { compare: vi.fn() } as unknown as JobShadowComparator,
    });
    const source: SubmitJobSource = {
      kind: "task_run",
      runId: SNAPSHOT.runId,
      issueId: SNAPSHOT.issueId,
      assigneeAgentId: SNAPSHOT.assigneeAgentId,
    };
    const result = await hook.convertActiveRun({
      source,
      actor: { kind: "agent", id: SNAPSHOT.assigneeAgentId, companyId: COMPANY },
      idempotencyKey: "run-333",
    });
    expect(convertRunToJob).toHaveBeenCalledTimes(1);
    expect(result.converted).toBe(true);
  });

  it("runs shadow comparison via the comparator and never throws", () => {
    const compare = vi.fn(() => {
      throw new Error("comparator blew up");
    });
    const hook = createHeartbeatDistributedRolloutHook({
      env: { [DISTRIBUTED_EXECUTION_ENABLED_ENV]: "true" },
      deploymentMode: "cloud_auth",
      rolloutSource: fakeRolloutSource("shadow"),
      resolveOrganizationId: vi.fn(async () => ORG),
      convertOrchestrator: { convertRunToJob: vi.fn() } as unknown as JobConvertOrchestrator,
      comparator: { compare } as unknown as JobShadowComparator,
    });
    expect(() => hook.runShadowComparison(SNAPSHOT)).not.toThrow();
    expect(compare).toHaveBeenCalledTimes(1);
  });
});
