import { describe, expect, it } from "vitest";
import {
  DISTRIBUTED_EXECUTION_ROLLOUT_ENV,
  assertDistributedExecutionRolloutSourceValid,
  createDistributedExecutionRolloutSource,
  parseDistributedExecutionRolloutMap,
} from "../config/distributed-execution-rollout-source.js";
import { DISTRIBUTED_EXECUTION_ENABLED_ENV } from "../config/distributed-execution.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

function rolloutEnv(map: unknown, deploymentEnabled = true): Record<string, string | undefined> {
  return {
    [DISTRIBUTED_EXECUTION_ENABLED_ENV]: deploymentEnabled ? "true" : "false",
    [DISTRIBUTED_EXECUTION_ROLLOUT_ENV]: JSON.stringify(map),
  };
}

describe("CLI-005 distributed execution rollout source (config-driven, default-off)", () => {
  it("defaults every run to off when the rollout env is unset (byte-identical legacy)", () => {
    const source = createDistributedExecutionRolloutSource({
      [DISTRIBUTED_EXECUTION_ENABLED_ENV]: "true",
    });
    expect(
      source.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: ORG,
        workloadType: "batch",
      }),
    ).toBe("off");
    expect(source.resolveOrganizationPolicy({ organizationId: ORG })).toEqual({
      enabled: false,
      mode: "shadow",
    });
    expect(source.resolveWorkloadPolicy({ organizationId: ORG, workloadType: "batch" })).toBe(false);
  });

  it("resolves an opted-in org+workload to its configured mode (shadow)", () => {
    const source = createDistributedExecutionRolloutSource(
      rolloutEnv({ organizations: { [ORG]: { mode: "shadow", workloads: ["batch"] } } }),
    );
    expect(
      source.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: ORG,
        workloadType: "batch",
      }),
    ).toBe("shadow");
  });

  it("resolves an opted-in org+workload to active mode", () => {
    const source = createDistributedExecutionRolloutSource(
      rolloutEnv({ organizations: { [ORG]: { mode: "active", workloads: ["*"] } } }),
    );
    expect(
      source.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: ORG,
        workloadType: "batch",
      }),
    ).toBe("active");
  });

  it("keeps a non-listed org and a non-listed workload off", () => {
    const source = createDistributedExecutionRolloutSource(
      rolloutEnv({ organizations: { [ORG]: { mode: "active", workloads: ["batch"] } } }),
    );
    expect(
      source.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: OTHER_ORG,
        workloadType: "batch",
      }),
    ).toBe("off");
    expect(
      source.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: ORG,
        workloadType: "browser_session",
      }),
    ).toBe("off");
  });

  it("the deployment flag gate wins: flag-off forces off even with an active org", () => {
    const source = createDistributedExecutionRolloutSource(
      rolloutEnv({ organizations: { [ORG]: { mode: "active", workloads: ["*"] } } }, false),
    );
    expect(
      source.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: ORG,
        workloadType: "batch",
      }),
    ).toBe("off");
  });

  it("parses an empty/absent map to zero organizations", () => {
    expect(parseDistributedExecutionRolloutMap({}).size).toBe(0);
    expect(
      parseDistributedExecutionRolloutMap({ [DISTRIBUTED_EXECUTION_ROLLOUT_ENV]: "{}" }).size,
    ).toBe(0);
  });

  it("fails loudly on malformed JSON and shape (startup validation)", () => {
    expect(() =>
      assertDistributedExecutionRolloutSourceValid({
        [DISTRIBUTED_EXECUTION_ROLLOUT_ENV]: "{not json",
      }),
    ).toThrow(DISTRIBUTED_EXECUTION_ROLLOUT_ENV);
    expect(() =>
      assertDistributedExecutionRolloutSourceValid({
        [DISTRIBUTED_EXECUTION_ROLLOUT_ENV]: JSON.stringify({
          organizations: { [ORG]: { mode: "bogus", workloads: [] } },
        }),
      }),
    ).toThrow(/mode/);
    expect(() =>
      assertDistributedExecutionRolloutSourceValid({
        [DISTRIBUTED_EXECUTION_ROLLOUT_ENV]: JSON.stringify({
          organizations: { [ORG]: { mode: "shadow", workloads: [42] } },
        }),
      }),
    ).toThrow(/workloads/);
  });
});
