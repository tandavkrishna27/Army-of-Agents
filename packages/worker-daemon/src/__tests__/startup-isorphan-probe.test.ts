/**
 * WRK-007 Slice 1 — the control-plane-derived `isOrphan` predicate.
 *
 * `reconcile.ts` trusts the LOCAL `hasLiveLease` boolean. WRK-007 replaces that with
 * authority INFERRED from `lease_renew`: a sandbox whose local `hasLiveLease=true`
 * but whose lease probes `stale_fence`/`target_revoked` is an ORPHAN. `probeLeaseAuthority`
 * builds a per-lease liveness map (reusing `renewLeaseOnce`); `buildControlPlaneIsOrphan`
 * turns it into the synchronous predicate `reconcile()`'s existing seam accepts.
 *
 * Fail-first: the module + its two functions do not exist yet.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { reconcile } from "../supervisor/reconcile.js";
import { buildControlPlaneIsOrphan, probeLeaseAuthority } from "../supervisor/startup-reconcile.js";

import type { FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import { FakeScheduler, RENEWAL_CODE, makeRenewalHandoff, startRenewalPlane } from "./support/renewal-fixtures.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

const SELECTOR = { organizationId: "org-1", targetId: "target-1", workerId: "worker-1" };
const DEAD_LEASE = "00000000-0000-4000-8000-0000000000e1";
const LIVE_LEASE = "00000000-0000-4000-8000-0000000000e2";

let scheduler: FakeScheduler;
let fake: FakeControlPlane;

beforeEach(async () => {
  scheduler = new FakeScheduler();
  fake = await startRenewalPlane(scheduler);
});
afterEach(async () => {
  await fake.close();
});

describe("startup-isorphan-probe — a control-plane-derived predicate classifies a locally-live but revoked lease as orphan", () => {
  it("probes lease_renew and orphans the sandbox whose local hasLiveLease=true but whose fence is stale", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    fake.seedLeaseAuthority(DEAD_LEASE, { live: false, deadReason: "target_revoked" });
    fake.seedLeaseAuthority(LIVE_LEASE, { live: true });

    // The stale sandbox reports hasLiveLease=true LOCALLY — the default reconcile
    // predicate would KEEP it (the exact leak WRK-007 closes). The live one is real.
    const fakeProvider = createFakeSandboxProvider({
      seededResources: [
        { sandboxId: "sbx-stale", labels: sampleLabels({ jobId: "j-stale", leaseId: DEAD_LEASE }), hasLiveLease: true },
        { sandboxId: "sbx-live", labels: sampleLabels({ jobId: "j-live", leaseId: LIVE_LEASE }), hasLiveLease: true },
      ],
    });

    const offers = [
      makeRenewalHandoff({ leaseId: DEAD_LEASE }).offer,
      makeRenewalHandoff({ leaseId: LIVE_LEASE }).offer,
    ];
    const authorityMap = await probeLeaseAuthority({
      client,
      session: { get: async () => session, recover: async () => session },
      key,
      candidates: offers,
      now: () => scheduler.now(),
    });

    expect(authorityMap.get(DEAD_LEASE)?.state).toBe("dead");
    expect(authorityMap.get(LIVE_LEASE)?.state).toBe("live");

    const isOrphan = buildControlPlaneIsOrphan(authorityMap);

    // Sanity: the DEFAULT predicate keeps the stale sandbox (the pre-WRK-007 leak).
    const beforeStale = fakeProvider.peek("sbx-stale");
    expect(beforeStale?.hasLiveLease).toBe(true);

    const result = await reconcile({
      provider: fakeProvider,
      ownershipSelector: SELECTOR,
      makeCtx: () => makeCtx(),
      isOrphan,
    });

    // The stale (revoked-fence) sandbox is destroyed; the live one is untouched.
    expect(result.orphansDestroyed).toBe(1);
    expect(result.outcomes.map((o) => o.sandboxId)).toEqual(["sbx-stale"]);
    expect(fakeProvider.peek("sbx-stale")?.state).toBe("destroyed");
    expect(fakeProvider.peek("sbx-live")?.state).toBe("running");
  });

  it("an unreachable probe (transport failure) is neither live nor dead — the predicate keeps the sandbox", async () => {
    const { session, key } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    // A client that always fails the transport → renewLeaseOnce returns a transient
    // outcome → liveness `unreachable` (fail closed to the server reaper, never kill).
    const failingClient = {
      leaseRenewPath: (leaseId: string) => `/api/worker-control/leases/${leaseId}/renew`,
      leaseRenew: async () => {
        throw new (await import("../transport/client.js")).ControlPlaneTransportError("timeout", "probe timed out");
      },
    } as never;

    const authorityMap = await probeLeaseAuthority({
      client: failingClient,
      session: { get: async () => session, recover: async () => session },
      key,
      candidates: [makeRenewalHandoff({ leaseId: DEAD_LEASE }).offer],
      now: () => scheduler.now(),
    });
    expect(authorityMap.get(DEAD_LEASE)?.state).toBe("unreachable");

    const isOrphan = buildControlPlaneIsOrphan(authorityMap);
    const summary = {
      sandboxId: "sbx",
      resourceLabels: sampleLabels({ leaseId: DEAD_LEASE }),
      generation: 1,
      state: "running" as const,
      hasLiveLease: true,
    };
    expect(isOrphan(summary)).toBe(false);
  });
});
