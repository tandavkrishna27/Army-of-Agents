import { describe, expect, it } from "vitest";

import { createMetrics } from "../metrics/metrics.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import type { SeededResource } from "./support/fake-provider.js";
import { reconcile } from "../supervisor/reconcile.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

const selector = { organizationId: "org-1", targetId: "target-1", workerId: "worker-1" };

function mixed(): SeededResource[] {
  return [
    { sandboxId: "sbx-live-1", labels: sampleLabels({ jobId: "j1", leaseId: "l1" }), hasLiveLease: true },
    { sandboxId: "sbx-orphan-1", labels: sampleLabels({ jobId: "j2", leaseId: "l2" }), hasLiveLease: false },
    { sandboxId: "sbx-live-2", labels: sampleLabels({ jobId: "j3", leaseId: "l3" }), hasLiveLease: true },
    { sandboxId: "sbx-orphan-2", labels: sampleLabels({ jobId: "j4", leaseId: "l4" }), hasLiveLease: false },
  ];
}

describe("reconcile-leaked — lists by ownership label and idempotently destroys orphans with no live lease", () => {
  it("destroys ONLY the orphans and leaves live-lease resources untouched", async () => {
    const fake = createFakeSandboxProvider({ seededResources: mixed() });
    const metrics = createMetrics();

    const result = await reconcile({ provider: fake, ownershipSelector: selector, makeCtx: () => makeCtx(), pageSize: 2, metrics });

    expect(result.scanned).toBe(4);
    expect(result.orphansDestroyed).toBe(2);
    expect(result.orphansFailed).toBe(0);
    expect(result.outcomes.map((o) => o.sandboxId).sort()).toEqual(["sbx-orphan-1", "sbx-orphan-2"]);

    // Live-lease resources are never touched.
    expect(fake.peek("sbx-live-1")?.state).toBe("running");
    expect(fake.peek("sbx-live-2")?.state).toBe("running");
    // Orphans are gone.
    expect(fake.peek("sbx-orphan-1")?.state).toBe("destroyed");
    expect(fake.peek("sbx-orphan-2")?.state).toBe("destroyed");

    expect(metrics.renderPrometheus()).toContain("reconcile_orphans_total 2");
  });

  it("is idempotent: a second pass finds no orphans to destroy", async () => {
    const fake = createFakeSandboxProvider({ seededResources: mixed() });
    await reconcile({ provider: fake, ownershipSelector: selector, makeCtx: () => makeCtx() });
    const second = await reconcile({ provider: fake, ownershipSelector: selector, makeCtx: () => makeCtx() });
    // Only the two live resources remain in the listing; no orphan cleanup runs.
    expect(second.scanned).toBe(2);
    expect(second.orphansDestroyed).toBe(0);
  });

  it("a failed orphan cleanup is counted (durable-retryable) without throwing", async () => {
    const fake = createFakeSandboxProvider({
      seededResources: [{ sandboxId: "sbx-orphan-x", labels: sampleLabels(), hasLiveLease: false }],
      reconcileFailures: Number.POSITIVE_INFINITY,
    });
    const result = await reconcile({ provider: fake, ownershipSelector: selector, makeCtx: () => makeCtx() });
    expect(result.orphansFailed).toBe(1);
    expect(result.orphansDestroyed).toBe(0);
  });
});
