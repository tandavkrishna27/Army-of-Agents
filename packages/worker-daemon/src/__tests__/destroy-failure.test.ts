import { describe, expect, it } from "vitest";

import { CleanupAuthority } from "../supervisor/cleanup-authority.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

const fence = { jobId: "job-1", attempt: 1, leaseId: "lease-1", fenceToken: "f".repeat(40), deviceGeneration: 1, observedSeq: 0 };

describe("destroy-failure — a destroy failure returns failed status (durable-retryable), never throws", () => {
  it("provider.destroy returns cleanupStatus:'failed' without throwing", async () => {
    const fake = createFakeSandboxProvider({ destroyFailures: Number.POSITIVE_INFINITY });
    const id = (
      await fake.create({ resourceLabels: sampleLabels(), command: "x", args: [], env: {}, workloadType: "batch" }, makeCtx())
    ).sandboxId;

    const first = await fake.destroy(id, makeCtx());
    expect(first.cleanupStatus).toBe("failed");
    // Durable-retryable: the resource REMAINS so a fresh attempt can retry.
    expect(fake.peek(id)?.state).not.toBe("destroyed");
    const second = await fake.destroy(id, makeCtx());
    expect(second.cleanupStatus).toBe("failed");
  });

  it("cleanup.destroy on an owned resource returns 'failed' (never throws)", async () => {
    const labels = sampleLabels();
    const fake = createFakeSandboxProvider({ destroyFailures: Number.POSITIVE_INFINITY });
    const id = (
      await fake.create({ resourceLabels: labels, command: "x", args: [], env: {}, workloadType: "batch" }, makeCtx())
    ).sandboxId;
    const cleanup = new CleanupAuthority({
      provider: fake,
      resourceLabels: labels,
      targetGeneration: labels.deviceGeneration,
      fence,
      deadline: Date.now(),
      epoch: 0,
    });
    const result = await cleanup.destroy(id, makeCtx());
    expect(result.cleanupStatus).toBe("failed");
  });

  it("a bounded converge over a permanently-failing destroy returns 'failed', not an infinite loop", async () => {
    const labels = sampleLabels();
    const fake = createFakeSandboxProvider({ destroyFailures: Number.POSITIVE_INFINITY });
    const id = (
      await fake.create({ resourceLabels: labels, command: "x", args: [], env: {}, workloadType: "batch" }, makeCtx())
    ).sandboxId;
    const cleanup = new CleanupAuthority({
      provider: fake,
      resourceLabels: labels,
      targetGeneration: labels.deviceGeneration,
      fence,
      deadline: Date.now(),
      epoch: 0,
    });
    const status = await cleanup.converge([id], () => makeCtx(), 3);
    expect(status).toBe("failed");
  });
});
