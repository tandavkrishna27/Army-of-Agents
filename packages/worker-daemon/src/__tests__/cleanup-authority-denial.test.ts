import { describe, expect, it } from "vitest";

import { CleanupAuthority, CleanupAuthorityDeniedError } from "../supervisor/cleanup-authority.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

const fence = { jobId: "job-1", attempt: 1, leaseId: "lease-1", fenceToken: "f".repeat(40), deviceGeneration: 1, observedSeq: 0 };

async function ownedCleanup() {
  const labels = sampleLabels();
  const fake = createFakeSandboxProvider();
  const id = (
    await fake.create({ resourceLabels: labels, command: "codex", args: [], env: {}, workloadType: "batch" }, makeCtx())
  ).sandboxId;
  const cleanup = new CleanupAuthority({
    provider: fake,
    resourceLabels: labels,
    targetGeneration: labels.deviceGeneration,
    fence,
    deadline: Date.now() + 10_000,
    epoch: 0,
  });
  return { fake, cleanup, id };
}

describe("cleanup-authority-denial — every effectful op is DENIED under cleanup authority", () => {
  it("create/execute/resume/checkpoint/health/openEgress all throw CleanupAuthorityDeniedError", async () => {
    const { cleanup } = await ownedCleanup();
    expect(() => cleanup.create()).toThrow(CleanupAuthorityDeniedError);
    expect(() => cleanup.execute()).toThrow(CleanupAuthorityDeniedError);
    expect(() => cleanup.resume()).toThrow(CleanupAuthorityDeniedError);
    expect(() => cleanup.checkpoint()).toThrow(CleanupAuthorityDeniedError);
    expect(() => cleanup.health()).toThrow(CleanupAuthorityDeniedError);
    expect(() => cleanup.openEgress()).toThrow(CleanupAuthorityDeniedError);
    // The denial names the attempted op (never guesses/performs it).
    try {
      cleanup.execute();
    } catch (err) {
      expect((err as CleanupAuthorityDeniedError).attemptedOperation).toBe("execute");
    }
  });

  it("the ALLOWED teardown/read ops (list/inspect/cancel/kill/destroy/reconcile) still work", async () => {
    const { cleanup, id } = await ownedCleanup();
    expect((await cleanup.list(makeCtx())).map((r) => r.sandboxId)).toContain(id);
    expect((await cleanup.inspect(id, makeCtx())).sandboxId).toBe(id);
    expect((await cleanup.cancel(id, makeCtx())).outcome).toBe("stopped");
    expect((await cleanup.kill(id, makeCtx())).outcome).toBe("stopped");
    expect((await cleanup.destroy(id, makeCtx())).cleanupStatus).toBe("success");
    expect((await cleanup.reconcileCleanup(id, makeCtx())).cleanupStatus).toBe("success");
  });
});
