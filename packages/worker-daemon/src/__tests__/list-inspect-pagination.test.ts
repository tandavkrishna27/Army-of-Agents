import { describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { SandboxNotFoundError } from "../supervisor/provider.js";
import type { SeededResource } from "./support/fake-provider.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

function seed(n: number): SeededResource[] {
  return Array.from({ length: n }, (_, i) => ({
    sandboxId: `fake-sbx-${String(i).padStart(2, "0")}`,
    labels: sampleLabels({ jobId: `job-${i}`, leaseId: `lease-${i}` }),
    hasLiveLease: i % 2 === 0,
  }));
}

describe("list-inspect-pagination — deterministic paging + full inspect", () => {
  it("pages deterministically by sandboxId and terminates with a null token", async () => {
    const fake = createFakeSandboxProvider({ seededResources: seed(5) });
    const selector = { organizationId: "org-1", targetId: "target-1", workerId: "worker-1" };

    const collected: string[] = [];
    let pageToken: string | null = null;
    let pages = 0;
    do {
      const page = await fake.list({ ownershipSelector: selector, pageSize: 2, pageToken }, makeCtx());
      // Each page is sorted ascending and at most pageSize.
      expect(page.resources.length).toBeLessThanOrEqual(2);
      collected.push(...page.resources.map((r) => r.sandboxId));
      pageToken = page.nextPageToken;
      pages += 1;
      expect(pages).toBeLessThan(10); // no infinite loop
    } while (pageToken !== null);

    expect(collected).toEqual([
      "fake-sbx-00",
      "fake-sbx-01",
      "fake-sbx-02",
      "fake-sbx-03",
      "fake-sbx-04",
    ]);
    // A repeat of the same first page is byte-identical (deterministic).
    const first = await fake.list({ ownershipSelector: selector, pageSize: 2 }, makeCtx());
    const firstAgain = await fake.list({ ownershipSelector: selector, pageSize: 2 }, makeCtx());
    expect(firstAgain.resources).toEqual(first.resources);
    expect(firstAgain.nextPageToken).toEqual(first.nextPageToken);
  });

  it("inspect returns full provider detail for a known sandbox and throws for an unknown one", async () => {
    const fake = createFakeSandboxProvider({ seededResources: seed(2) });
    const detail = await fake.inspect("fake-sbx-00", makeCtx());
    expect(detail.sandboxId).toBe("fake-sbx-00");
    expect(detail.command).toContain("tenant-");
    await expect(fake.inspect("nope", makeCtx())).rejects.toBeInstanceOf(SandboxNotFoundError);
  });
});
