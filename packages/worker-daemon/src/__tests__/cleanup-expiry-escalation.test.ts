import { describe, expect, it } from "vitest";

import { CleanupAuthority } from "../supervisor/cleanup-authority.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { sampleLabels } from "./support/supervisor-fixtures.js";

const fence = { jobId: "job-1", attempt: 1, leaseId: "lease-1", fenceToken: "f".repeat(40), deviceGeneration: 1, observedSeq: 0 };

function authority(deadline: number, now: () => number) {
  return new CleanupAuthority({
    provider: createFakeSandboxProvider(),
    resourceLabels: sampleLabels(),
    targetGeneration: 1,
    fence,
    deadline,
    epoch: 5, // a monotonic base epoch
    now,
  });
}

describe("cleanup-expiry-escalation — past the deadline the authority escalates monotonically, never regressing", () => {
  it("reports expiry once now >= deadline", () => {
    let clock = 1_000;
    const cleanup = authority(2_000, () => clock);
    expect(cleanup.isExpired()).toBe(false);
    clock = 2_000;
    expect(cleanup.isExpired()).toBe(true);
    clock = 5_000;
    expect(cleanup.isExpired()).toBe(true);
  });

  it("escalate() advances none→cancel→kill→destroy, bumps the epoch, and converges at destroy", () => {
    const cleanup = authority(0, () => 1_000); // already expired
    expect(cleanup.escalationStage()).toBe("none");
    const baseEpoch = cleanup.cleanupEpoch();

    const stages: string[] = [];
    const epochs: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      stages.push(cleanup.escalate());
      epochs.push(cleanup.cleanupEpoch());
    }

    // Monotonic ladder that converges at destroy and never regresses.
    expect(stages).toEqual(["cancel", "kill", "destroy", "destroy", "destroy"]);
    // Epoch strictly increases on each genuine advance, then holds (converged).
    expect(epochs).toEqual([baseEpoch + 1, baseEpoch + 2, baseEpoch + 3, baseEpoch + 3, baseEpoch + 3]);
    // The base epoch is never lost.
    expect(baseEpoch).toBe(5);
  });

  it("there is no path to regress the stage below its current rung", () => {
    const cleanup = authority(0, () => 1_000);
    cleanup.escalate(); // cancel
    cleanup.escalate(); // kill
    expect(cleanup.escalationStage()).toBe("kill");
    // The only mutator is escalate(), which advances — the stage can only move
    // forward to destroy and then stay.
    cleanup.escalate();
    expect(cleanup.escalationStage()).toBe("destroy");
    cleanup.escalate();
    expect(cleanup.escalationStage()).toBe("destroy");
  });
});
