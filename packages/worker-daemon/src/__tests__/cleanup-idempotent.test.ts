import { describe, expect, it } from "vitest";

import { CleanupAuthority, CleanupAuthorityDeniedError } from "../supervisor/cleanup-authority.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

const fence = { jobId: "job-1", attempt: 1, leaseId: "lease-1", fenceToken: "f".repeat(40), deviceGeneration: 1, observedSeq: 0 };

describe("cleanup-idempotent — repeated cleanup converges and never resurrects effect authority", () => {
  it("a transiently-failing destroy converges to success and re-running is idempotent", async () => {
    const labels = sampleLabels();
    // Fail the first destroy, then succeed — proving durable retry converges.
    const fake = createFakeSandboxProvider({ destroyFailures: 1 });
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

    const first = await cleanup.converge([id], () => makeCtx());
    expect(first).toBe("success");
    expect(fake.peek(id)?.state).toBe("destroyed");
    const epochAfterFirst = cleanup.cleanupEpoch();

    // Idempotent re-run: still success, and the epoch NEVER regresses.
    const second = await cleanup.converge([id], () => makeCtx());
    expect(second).toBe("success");
    expect(cleanup.cleanupEpoch()).toBeGreaterThanOrEqual(epochAfterFirst);

    // Never resurrects effect authority — cleanup can STILL never create/execute.
    expect(() => cleanup.create()).toThrow(CleanupAuthorityDeniedError);
    expect(() => cleanup.execute()).toThrow(CleanupAuthorityDeniedError);
  });
});
