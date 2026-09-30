import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubmitJobSource } from "@armyofagents/shared";
import {
  SHADOW_PROBE_DEADLINE_MS,
  createDistributedShadowRecorder,
  recordDistributedShadow,
  setDistributedShadowPort,
} from "../services/distributed-shadow-port.js";
import type { ShadowComparisonResult } from "../services/job-shadow-comparator.js";

const SOURCE: SubmitJobSource = {
  kind: "commander_turn",
  internalAgentRunId: "run-1",
  conversationId: "conv-1",
};

const INPUT = {
  companyId: "c-1",
  source: SOURCE,
  principal: { kind: "user", id: "u-1", role: "founder" },
  routing: { executionTargetType: "e2b" },
  policy: { model: "claude-sonnet", budgetPolicyId: null, effectiveCompletionPolicy: "review_required" },
  workloadCharacterization: {
    command: "claude",
    args: [],
    maxRuntimeSeconds: 600,
    stdinArtifactId: null,
  },
};

afterEach(() => {
  setDistributedShadowPort(null);
  vi.useRealTimers();
});

describe("the port is inert until something registers it", () => {
  it("is a no-op when unregistered — a deployment that never composes it is unchanged", async () => {
    await expect(recordDistributedShadow(INPUT)).resolves.toBeUndefined();
  });

  it("delivers to a registered port", async () => {
    const record = vi.fn(async () => {});
    setDistributedShadowPort({ record });
    await recordDistributedShadow(INPUT);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ companyId: "c-1" });
  });

  it("a throwing port never propagates into the live operation", async () => {
    setDistributedShadowPort({
      record: async () => {
        throw new Error("shadow exploded");
      },
    });
    await expect(recordDistributedShadow(INPUT)).resolves.toBeUndefined();
  });
});

describe("the recorder does nothing unless the rollout says shadow", () => {
  function harness(state: string) {
    const compare = vi.fn(() => ({}) as ShadowComparisonResult);
    const probe = vi.fn(async () => ({
      admissible: true as boolean | null,
      reason: "admissible" as const,
      authoritiesChecked: ["admission" as const],
    }));
    const recorder = createDistributedShadowRecorder({
      resolveRolloutState: async () => ({ state, organizationId: "org-1" }),
      probe,
      comparator: { compare },
    });
    return { recorder, compare, probe };
  }

  it.each(["off", "active", "canary"])("does not probe or compare when the rollout is %s", async (state) => {
    const { recorder, compare, probe } = harness(state);
    await recorder.record(INPUT);
    expect(probe).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it("probes and compares exactly once in shadow", async () => {
    const { recorder, compare, probe } = harness("shadow");
    await recorder.record(INPUT);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledTimes(1);
    const [snapshot, options] = compare.mock.calls[0] as unknown as [
      { source: SubmitJobSource; organizationId: string; workloadType: string },
      { admissible: boolean | null },
    ];
    expect(snapshot.source).toEqual(SOURCE);
    expect(snapshot.organizationId).toBe("org-1");
    // The workload key a REAL submission would use, not one the seam invented.
    expect(snapshot.workloadType).toBe("batch");
    expect(options.admissible).toBe(true);
  });

  it("labels the workload with the key a real submission computes, not a constant", async () => {
    // Every MIG sink is "batch", so a hardcoded "batch" is indistinguishable here unless
    // a non-batch source is driven through. Without this, the shared helper could be
    // replaced by a literal and nothing would notice — and the whole point of sharing it
    // is that the shadow gate uses the same key `active` will use.
    const { recorder, compare } = harness("shadow");
    await recorder.record({
      ...INPUT,
      source: { kind: "browser_request", browserRequestId: "br-1", parentJobId: null },
    });
    const [snapshot] = compare.mock.calls[0] as unknown as [{ workloadType: string }];
    expect(snapshot.workloadType).toBe("browser_session");
  });

  it("does not resolve an Organization it was not given", async () => {
    const compare = vi.fn(() => ({}) as ShadowComparisonResult);
    const recorder = createDistributedShadowRecorder({
      resolveRolloutState: async () => ({ state: "shadow", organizationId: null }),
      probe: vi.fn(async () => ({
        admissible: true as boolean | null,
        reason: "admissible" as const,
        authoritiesChecked: ["admission" as const],
      })),
      comparator: { compare },
    });
    await recorder.record(INPUT);
    // No Organization means no tenant context, so nothing may be probed or claimed.
    expect(compare).not.toHaveBeenCalled();
  });
});

describe("the probe is bounded on a live path (D5b)", () => {
  it("records probe_timeout rather than waiting on a hung probe", async () => {
    vi.useFakeTimers();
    const compare = vi.fn(() => ({}) as ShadowComparisonResult);
    const recorder = createDistributedShadowRecorder({
      resolveRolloutState: async () => ({ state: "shadow", organizationId: "org-1" }),
      // Never settles: the deadline is the only thing that can end this.
      probe: () => new Promise(() => {}),
      comparator: { compare },
    });
    const done = recorder.record(INPUT);
    await vi.advanceTimersByTimeAsync(SHADOW_PROBE_DEADLINE_MS + 10);
    await done;

    expect(compare).toHaveBeenCalledTimes(1);
    const [, options] = compare.mock.calls[0] as unknown as [unknown, { admissible: boolean | null }];
    // A timeout is DATA. Recording it as `true`, or as agreement, would be the
    // "bound that degrades to looks-fine" this ticket exists to remove.
    expect(options.admissible).toBeNull();
  });

  it("a probe that throws is recorded as undetermined, never as admissible", async () => {
    const compare = vi.fn(() => ({}) as ShadowComparisonResult);
    const recorder = createDistributedShadowRecorder({
      resolveRolloutState: async () => ({ state: "shadow", organizationId: "org-1" }),
      probe: async () => {
        throw new Error("probe blew up");
      },
      comparator: { compare },
    });
    await recorder.record(INPUT);
    const [, options] = compare.mock.calls[0] as unknown as [unknown, { admissible: boolean | null }];
    expect(options.admissible).toBeNull();
  });

  it("a rollout resolver that throws leaves the operation untouched", async () => {
    const compare = vi.fn(() => ({}) as ShadowComparisonResult);
    const recorder = createDistributedShadowRecorder({
      resolveRolloutState: async () => {
        throw new Error("rollout resolution failed");
      },
      probe: vi.fn(),
      comparator: { compare },
    });
    await expect(recorder.record(INPUT)).resolves.toBeUndefined();
    expect(compare).not.toHaveBeenCalled();
  });
});
