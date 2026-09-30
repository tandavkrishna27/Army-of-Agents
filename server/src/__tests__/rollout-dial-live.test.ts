/**
 * MIG-002 (Wave 4 item 1) — the routing dial, made live and per-sink.
 *
 * §5 of the Wave-3/4 handoff justifies cutting sinks over one at a time because "the kill switch
 * and the per-org dial exist precisely so a bad cutover is reversible in seconds". The gate
 * clause-3 review proved the dial half false: the source captured its map and its flag at
 * construction, so rollback needed a restart. And all four cutover sinks resolve to
 * workloadType "batch", so one switch armed them together and the MIG-005 → 006 → 007 ordering
 * was not expressible.
 *
 * This suite pins the replacement.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createDistributedExecutionRolloutSource,
  parseDistributedExecutionRolloutMap,
} from "../config/distributed-execution-rollout-source.js";

const ORG = "11111111-1111-4111-8111-111111111111";

function rollout(entry: Record<string, unknown> | null): string {
  return JSON.stringify(entry === null ? { organizations: {} } : { organizations: { [ORG]: entry } });
}

function envBag(entry: Record<string, unknown> | null, enabled = "1"): Record<string, string | undefined> {
  return {
    AOA_DISTRIBUTED_EXECUTION_ENABLED: enabled,
    AOA_DISTRIBUTED_EXECUTION_ROLLOUT: rollout(entry),
  };
}

function state(
  source: ReturnType<typeof createDistributedExecutionRolloutSource>,
  sourceKind?: string,
): string {
  return source.resolveRunRolloutState({
    deploymentMode: "cloud_auth",
    organizationId: ORG,
    workloadType: "batch",
    ...(sourceKind ? { sourceKind } : {}),
  } as never);
}

// ─── M1 / M2 ─────────────────────────────────────────────────────────────────
describe("M1/M2 — the dial is live: rollback no longer needs a restart", () => {
  it("observes an Organization being REMOVED, with no reconstruction", () => {
    const env = envBag({ mode: "canary", workloads: ["batch"] });
    const source = createDistributedExecutionRolloutSource(env);
    expect(state(source)).toBe("canary");

    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = rollout(null);

    expect(state(source)).toBe("off");
  });

  it("observes a mode DOWNGRADE", () => {
    const env = envBag({ mode: "canary", workloads: ["batch"] });
    const source = createDistributedExecutionRolloutSource(env);
    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = rollout({ mode: "shadow", workloads: ["batch"] });
    expect(state(source)).toBe("shadow");
  });

  it("observes a RE-ENABLE, so the dial turns both ways", () => {
    const env = envBag(null);
    const source = createDistributedExecutionRolloutSource(env);
    expect(state(source)).toBe("off");
    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = rollout({ mode: "active", workloads: ["batch"] });
    expect(state(source)).toBe("active");
  });

  it("observes the deployment flag being unset — the flag is live IN THE SOURCE, not only at the hook", () => {
    const env = envBag({ mode: "canary", workloads: ["batch"] });
    const source = createDistributedExecutionRolloutSource(env);
    env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "0";
    expect(state(source)).toBe("off");
  });

  it("keeps the two values moving together — neither is captured", () => {
    // A half-migration (live map, captured flag) is the divergence the design forbids.
    const env = envBag({ mode: "canary", workloads: ["batch"] });
    const source = createDistributedExecutionRolloutSource(env);
    env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "0";
    expect(state(source)).toBe("off");
    env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "1";
    expect(state(source)).toBe("canary");
  });
});

// ─── M3 / M4 ─────────────────────────────────────────────────────────────────
describe("M3/M4 — the per-sink axis, opt-in and silent on absence", () => {
  it("an ABSENT `sources` key means ALL sinks — byte-identical to today", () => {
    // CLI-006's canary was validated live against this behaviour. Changing it would be a
    // behaviour change disguised as a feature.
    const source = createDistributedExecutionRolloutSource(envBag({ mode: "canary", workloads: ["batch"] }));
    for (const kind of ["task_run", "commander_turn", "crew_run", "one_shot"]) {
      expect(state(source, kind)).toBe("canary");
    }
  });

  it("a `sources` list enables ONLY the named sinks", () => {
    const source = createDistributedExecutionRolloutSource(
      envBag({ mode: "canary", workloads: ["batch"], sources: ["commander_turn"] }),
    );
    expect(state(source, "commander_turn")).toBe("canary");
    expect(state(source, "crew_run")).toBe("off");
    expect(state(source, "one_shot")).toBe("off");
    expect(state(source, "task_run")).toBe("off");
  });

  it("`*` in `sources` means all, like `workloads`", () => {
    const source = createDistributedExecutionRolloutSource(
      envBag({ mode: "active", workloads: ["batch"], sources: ["*"] }),
    );
    expect(state(source, "crew_run")).toBe("active");
  });

  it("is what makes the Wave-4 MIG-005 → 006 → 007 ordering expressible", () => {
    // The whole point: Commander first, at lowest blast radius, without arming crew or one-shot.
    const env = envBag({ mode: "canary", workloads: ["batch"], sources: ["commander_turn"] });
    const source = createDistributedExecutionRolloutSource(env);
    expect(state(source, "commander_turn")).toBe("canary");
    expect(state(source, "crew_run")).toBe("off");

    // …then crew joins, live, with no restart.
    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = rollout({
      mode: "canary",
      workloads: ["batch"],
      sources: ["commander_turn", "crew_run"],
    });
    expect(state(source, "crew_run")).toBe("canary");
    expect(state(source, "one_shot")).toBe("off");
  });

  it("a caller that supplies NO sourceKind is unaffected by a `sources` list", () => {
    // Existing callers (resolveRunRolloutState without the optional field) must keep working.
    const source = createDistributedExecutionRolloutSource(
      envBag({ mode: "canary", workloads: ["batch"], sources: ["commander_turn"] }),
    );
    expect(state(source)).toBe("canary");
  });

  it("rejects an unknown source kind at parse time, like an unknown mode", () => {
    expect(() =>
      parseDistributedExecutionRolloutMap(
        envBag({ mode: "canary", workloads: ["batch"], sources: ["not_a_sink"] }),
      ),
    ).toThrow(/sources/i);
  });
});

// ─── M5 ──────────────────────────────────────────────────────────────────────
describe("M5 — a bad edit lands on a RUNNING process, so it must fail closed and quietly", () => {
  it("resolves to off and does not throw", () => {
    const env = envBag({ mode: "canary", workloads: ["batch"] });
    const source = createDistributedExecutionRolloutSource(env);
    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = "{not json";
    // Legacy is the safe executor: degrade to it rather than throwing into a live run.
    expect(() => state(source)).not.toThrow();
    expect(state(source)).toBe("off");
  });

  it("reports the failure ONCE per distinct bad value, not once per call", () => {
    const onParseError = vi.fn();
    const env = envBag({ mode: "canary", workloads: ["batch"] });
    const source = createDistributedExecutionRolloutSource(env, { onParseError });
    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = "{not json";
    state(source);
    state(source);
    state(source);
    expect(onParseError).toHaveBeenCalledTimes(1);

    // A DIFFERENT bad value is a new fact and reports again.
    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = "{also not json";
    state(source);
    expect(onParseError).toHaveBeenCalledTimes(2);
  });

  it("recovers when the operator fixes the value, with no restart", () => {
    const env = envBag({ mode: "canary", workloads: ["batch"] });
    const source = createDistributedExecutionRolloutSource(env);
    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = "{not json";
    expect(state(source)).toBe("off");
    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = rollout({ mode: "active", workloads: ["batch"] });
    expect(state(source)).toBe("active");
  });
});

// ─── M6 ──────────────────────────────────────────────────────────────────────
describe("M6 — memoized on the raw string", () => {
  it("does not re-parse while the value is unchanged", () => {
    const env = envBag({ mode: "canary", workloads: ["batch"] });
    const source = createDistributedExecutionRolloutSource(env);
    // Identity stability of the parsed policy object proves the parse did not re-run;
    // a fresh parse would yield a new object each call.
    const a = source.resolveOrganizationPolicy({ organizationId: ORG });
    const b = source.resolveOrganizationPolicy({ organizationId: ORG });
    expect(a).toEqual(b);
    expect(source.__parseCountForTests?.()).toBe(1);

    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = rollout({ mode: "shadow", workloads: ["batch"] });
    source.resolveOrganizationPolicy({ organizationId: ORG });
    expect(source.__parseCountForTests?.()).toBe(2);
  });
});

// ─── M8 ──────────────────────────────────────────────────────────────────────
describe("M8 — every live-flip interleaving lands on legacy, never two executors", () => {
  it("enabled → disabled between the seam and placement: placement says no", () => {
    const env = envBag({ mode: "canary", workloads: ["batch"] });
    const source = createDistributedExecutionRolloutSource(env);

    // The seam decides first…
    expect(state(source, "task_run")).toBe("canary");
    // …the operator rolls back…
    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = rollout(null);
    // …and placement, reading the SAME source, refuses. The legacy adapter is therefore
    // never suppressed, so the run has exactly one executor.
    expect(source.resolveOrganizationPolicy({ organizationId: ORG }).enabled).toBe(false);
    expect(
      source.resolveWorkloadPolicy({
        organizationId: ORG,
        companyId: "c-1",
        sourceKind: "task_run",
        workloadType: "batch",
      } as never),
    ).toBe(false);
  });

  it("disabled → enabled between the seam and placement: the seam never converted", () => {
    const env = envBag(null);
    const source = createDistributedExecutionRolloutSource(env);
    expect(state(source, "task_run")).toBe("off");
    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = rollout({ mode: "canary", workloads: ["batch"] });
    // Placement is simply never consulted for this run — the seam already chose legacy.
    // Recorded so the asymmetry is deliberate rather than incidental.
    expect(state(source, "task_run")).toBe("canary");
  });

  it("a per-sink flip degrades the same way", () => {
    const env = envBag({ mode: "canary", workloads: ["batch"], sources: ["commander_turn", "crew_run"] });
    const source = createDistributedExecutionRolloutSource(env);
    expect(state(source, "crew_run")).toBe("canary");
    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = rollout({
      mode: "canary",
      workloads: ["batch"],
      sources: ["commander_turn"],
    });
    expect(state(source, "crew_run")).toBe("off");
    expect(
      source.resolveWorkloadPolicy({
        organizationId: ORG,
        companyId: "c-1",
        sourceKind: "crew_run",
        workloadType: "batch",
      } as never),
    ).toBe(false);
  });
});
