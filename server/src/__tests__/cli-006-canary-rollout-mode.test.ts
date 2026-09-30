// CLI-006 (D1) — the `canary` rollout mode.
//
// `canary` is a strict superset of CLI-005's `active`: the run seam sees `canary`
// (and therefore places + suppresses the legacy executor), while the PLACEMENT
// boundary sees `active` so `job-placement.ts:663` yields `leaseEligible: true`
// without any edit to the E3-owned placement module or its `["active","shadow"]`
// input guard at `:589`.
//
// Invariant 9 (rollback is a config edit) and Invariant 4 (non-canary isolation)
// are both properties of THIS module, so they are proven here.

import { describe, expect, it } from "vitest";
import {
  DISTRIBUTED_EXECUTION_ROLLOUT_ENV,
  assertDistributedExecutionRolloutSourceValid,
  createDistributedExecutionRolloutSource,
  parseDistributedExecutionRolloutMap,
} from "../config/distributed-execution-rollout-source.js";
import { DISTRIBUTED_EXECUTION_ENABLED_ENV } from "../config/distributed-execution.js";

const CANARY_ORG = "33333333-3333-4333-8333-333333333333";
const LEGACY_ORG = "44444444-4444-4444-8444-444444444444";

function env(map: unknown, deploymentEnabled = true): Record<string, string | undefined> {
  return {
    [DISTRIBUTED_EXECUTION_ENABLED_ENV]: deploymentEnabled ? "true" : "false",
    [DISTRIBUTED_EXECUTION_ROLLOUT_ENV]: JSON.stringify(map),
  };
}

const canaryMap = {
  organizations: {
    [CANARY_ORG]: { mode: "canary", workloads: ["batch"] },
  },
};

describe("CLI-006 D1 — `canary` rollout mode", () => {
  it("parses `canary` as a valid mode", () => {
    const map = parseDistributedExecutionRolloutMap(env(canaryMap));
    expect(map.get(CANARY_ORG)?.mode).toBe("canary");
    expect(() => assertDistributedExecutionRolloutSourceValid(env(canaryMap))).not.toThrow();
  });

  it("resolves an opted-in org+workload to the `canary` run state", () => {
    const source = createDistributedExecutionRolloutSource(env(canaryMap));
    expect(
      source.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: CANARY_ORG,
        workloadType: "batch",
      }),
    ).toBe("canary");
  });

  // The load-bearing mapping: placement must see `active`, never `canary`, or the
  // `["active","shadow"].includes(mode)` guard at job-placement.ts:589 rejects the
  // placement as `invalid_placement_input` and the attempt is never leasable.
  it("presents `canary` to the PLACEMENT boundary as `active` (leaseEligible)", () => {
    const source = createDistributedExecutionRolloutSource(env(canaryMap));
    const policy = source.resolveOrganizationPolicy({ organizationId: CANARY_ORG });
    expect(policy).toEqual({ enabled: true, mode: "active" });
    // Structural: the value handed to placement is in placement's accepted vocabulary.
    expect(["active", "shadow"]).toContain(policy.mode);
  });

  it("keeps `shadow` and `active` unchanged at both boundaries (CLI-005 parity)", () => {
    for (const mode of ["shadow", "active"] as const) {
      const source = createDistributedExecutionRolloutSource(
        env({ organizations: { [CANARY_ORG]: { mode, workloads: ["*"] } } }),
      );
      expect(
        source.resolveRunRolloutState({
          deploymentMode: "cloud_auth",
          organizationId: CANARY_ORG,
          workloadType: "batch",
        }),
      ).toBe(mode);
      expect(source.resolveOrganizationPolicy({ organizationId: CANARY_ORG }).mode).toBe(mode);
    }
  });

  // Invariant 4 — non-canary isolation.
  it("leaves an org absent from the map fully off, even while a sibling org is canaried", () => {
    const source = createDistributedExecutionRolloutSource(env(canaryMap));
    expect(
      source.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: LEGACY_ORG,
        workloadType: "batch",
      }),
    ).toBe("off");
    expect(source.resolveOrganizationPolicy({ organizationId: LEGACY_ORG })).toEqual({
      enabled: false,
      mode: "shadow",
    });
  });

  it("keeps a canaried org off for a workload it did not opt in", () => {
    const source = createDistributedExecutionRolloutSource(env(canaryMap));
    expect(
      source.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: CANARY_ORG,
        workloadType: "browser_session",
      }),
    ).toBe("off");
  });

  // The deployment flag is checked FIRST — nothing in the map can defeat it.
  it("resolves `off` when the deployment flag is off, even for a canaried org", () => {
    const source = createDistributedExecutionRolloutSource(env(canaryMap, false));
    expect(
      source.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: CANARY_ORG,
        workloadType: "batch",
      }),
    ).toBe("off");
  });

  // Invariant 9 — rollback is a config edit, with no code change and no migration.
  it("returns the next run to legacy when the canary key is removed", () => {
    const rolledBack = createDistributedExecutionRolloutSource(env({ organizations: {} }));
    expect(
      rolledBack.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: CANARY_ORG,
        workloadType: "batch",
      }),
    ).toBe("off");
  });

  it("returns to CLI-005 inert convert when the canary key is downgraded to `active`", () => {
    const downgraded = createDistributedExecutionRolloutSource(
      env({ organizations: { [CANARY_ORG]: { mode: "active", workloads: ["batch"] } } }),
    );
    expect(
      downgraded.resolveRunRolloutState({
        deploymentMode: "cloud_auth",
        organizationId: CANARY_ORG,
        workloadType: "batch",
      }),
    ).toBe("active");
  });

  it("still rejects an unknown mode loudly at startup (fail-closed parser)", () => {
    expect(() =>
      parseDistributedExecutionRolloutMap(
        env({ organizations: { [CANARY_ORG]: { mode: "live", workloads: ["*"] } } }),
      ),
    ).toThrow(/mode must be/);
  });
});
