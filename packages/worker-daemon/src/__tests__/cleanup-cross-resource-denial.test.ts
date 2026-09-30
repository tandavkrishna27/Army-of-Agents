import { describe, expect, it } from "vitest";

import { CleanupAuthority, ResourceNotAvailableError } from "../supervisor/cleanup-authority.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

const fence = { jobId: "job-1", attempt: 1, leaseId: "lease-1", fenceToken: "f".repeat(40), deviceGeneration: 1, observedSeq: 0 };

describe("cleanup-cross-resource-denial — mismatched labels/generation denied with NO existence oracle", () => {
  it("a cross-resource (other-org) sandbox and a truly-absent id throw the IDENTICAL error", async () => {
    const boundLabels = sampleLabels();
    const otherLabels = sampleLabels({ organizationId: "org-2", jobId: "job-2", leaseId: "lease-2" });
    const fake = createFakeSandboxProvider();
    // Bound resource + a foreign resource that genuinely EXISTS.
    await fake.create({ resourceLabels: boundLabels, command: "x", args: [], env: {}, workloadType: "batch" }, makeCtx());
    const foreign = (
      await fake.create({ resourceLabels: otherLabels, command: "x", args: [], env: {}, workloadType: "batch" }, makeCtx())
    ).sandboxId;

    const cleanup = new CleanupAuthority({
      provider: fake,
      resourceLabels: boundLabels,
      targetGeneration: boundLabels.deviceGeneration,
      fence,
      deadline: Date.now() + 10_000,
      epoch: 0,
    });

    let existsButNotMine: unknown;
    try {
      await cleanup.inspect(foreign, makeCtx());
    } catch (err) {
      existsButNotMine = err;
    }
    let trulyAbsent: unknown;
    try {
      await cleanup.inspect("does-not-exist", makeCtx());
    } catch (err) {
      trulyAbsent = err;
    }

    expect(existsButNotMine).toBeInstanceOf(ResourceNotAvailableError);
    expect(trulyAbsent).toBeInstanceOf(ResourceNotAvailableError);
    // No oracle: the two cases are INDISTINGUISHABLE (same type + message).
    expect((existsButNotMine as Error).name).toBe((trulyAbsent as Error).name);
    expect((existsButNotMine as Error).message).toBe((trulyAbsent as Error).message);
  });

  it("a wrong-target-generation resource is denied identically", async () => {
    const boundLabels = sampleLabels({ deviceGeneration: 1 });
    const staleGenLabels = sampleLabels({ deviceGeneration: 2 });
    const fake = createFakeSandboxProvider();
    const staleId = (
      await fake.create({ resourceLabels: staleGenLabels, command: "x", args: [], env: {}, workloadType: "batch" }, makeCtx())
    ).sandboxId;

    const cleanup = new CleanupAuthority({
      provider: fake,
      resourceLabels: boundLabels,
      targetGeneration: 1,
      fence,
      deadline: Date.now() + 10_000,
      epoch: 0,
    });

    await expect(cleanup.inspect(staleId, makeCtx())).rejects.toBeInstanceOf(ResourceNotAvailableError);
    // Mutating ops are equally gated — a mismatched generation cannot be destroyed.
    await expect(cleanup.destroy(staleId, makeCtx())).rejects.toBeInstanceOf(ResourceNotAvailableError);
    await expect(cleanup.cancel(staleId, makeCtx())).rejects.toBeInstanceOf(ResourceNotAvailableError);
  });

  it("cleanup.list reveals ONLY the authority's own matched resources", async () => {
    const boundLabels = sampleLabels();
    // Same coarse ownership (org/target/worker) but a DIFFERENT job/lease, so it
    // passes the provider's coarse selector yet fails cleanup's exact-label filter.
    const otherLabels = sampleLabels({ jobId: "job-9", leaseId: "lease-9" });
    const fake = createFakeSandboxProvider();
    await fake.create({ resourceLabels: boundLabels, command: "x", args: [], env: {}, workloadType: "batch" }, makeCtx());
    await fake.create({ resourceLabels: otherLabels, command: "x", args: [], env: {}, workloadType: "batch" }, makeCtx());
    const cleanup = new CleanupAuthority({
      provider: fake,
      resourceLabels: boundLabels,
      targetGeneration: boundLabels.deviceGeneration,
      fence,
      deadline: Date.now() + 10_000,
      epoch: 0,
    });
    const listed = await cleanup.list(makeCtx());
    // Only the bound resource — the foreign org's resource is never revealed.
    expect(listed).toHaveLength(1);
    expect(listed[0]?.resourceLabelsHash).toBe(cleanup.resourceLabelsHash);
  });
});
