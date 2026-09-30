/**
 * WRK-007 Slice 2 — sandbox three-way classification + CleanupAuthority teardown.
 *
 * The startup reconciler classifies every selector-matched sandbox against inferred
 * lease authority into three buckets (D3/D4):
 *   - keep       — probe renewed + matching deviceGeneration + local live lease (never
 *                  re-attached — D2; just left for a fresh JOB-006 attempt);
 *   - kill_stale — probe dead / generation mismatch / no local lease → torn down via
 *                  the distinct monotonic CleanupAuthority.converge (escalation
 *                  survives an ignored cancel + ignored kill to a forced destroy);
 *   - unknown_sandbox — matches the coarse selector but its lease can't resolve to a
 *                  probed authority → RECORDED, never killed (conservative; left to
 *                  the server reaper — no existence-oracle probing).
 *
 * Fail-first: `createStartupReconciler` does not exist yet.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createStartupReconciler } from "../supervisor/startup-reconcile.js";
import { createMetrics } from "../metrics/metrics.js";

import type { FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import { FakeScheduler, RENEWAL_CODE, RENEWAL_IDENTITY, makeRenewalHandoff, startRenewalPlane } from "./support/renewal-fixtures.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

const SELECTOR = { organizationId: "org-1", targetId: "target-1", workerId: "worker-1" };
const DEAD_LEASE = "00000000-0000-4000-8000-0000000000f1";
const LIVE_LEASE = "00000000-0000-4000-8000-0000000000f2";
const UNKNOWN_LEASE = "00000000-0000-4000-8000-0000000000f3";

let scheduler: FakeScheduler;
let fake: FakeControlPlane;

beforeEach(async () => {
  scheduler = new FakeScheduler();
  fake = await startRenewalPlane(scheduler);
});
afterEach(async () => {
  await fake.close();
});

function mixedProvider() {
  return createFakeSandboxProvider({
    ignoreCancel: true, // the stale sandbox's cancel is ignored → escalate to kill
    ignoreKill: true, //   its kill is ignored too → escalate to a forced destroy
    seededResources: [
      { sandboxId: "sbx-stale", labels: sampleLabels({ jobId: "j-stale", leaseId: DEAD_LEASE }), hasLiveLease: true, state: "running" },
      { sandboxId: "sbx-live", labels: sampleLabels({ jobId: "j-live", leaseId: LIVE_LEASE }), hasLiveLease: true, state: "running" },
      { sandboxId: "sbx-unknown", labels: sampleLabels({ jobId: "j-unk", leaseId: UNKNOWN_LEASE }), hasLiveLease: true, state: "running" },
    ],
  });
}

describe("startup-sandbox-classification — keep / kill-stale (escalated) / unknown_sandbox", () => {
  it("kills the revoked-fence sandbox (converge escalates to a forced destroy), keeps the live one, records the unknown", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    fake.seedLeaseAuthority(DEAD_LEASE, { live: false, deadReason: "target_revoked" });
    fake.seedLeaseAuthority(LIVE_LEASE, { live: true });
    // UNKNOWN_LEASE is deliberately NOT a probe candidate → unknown_sandbox.

    const provider = mixedProvider();
    const metrics = createMetrics();
    const reconciler = createStartupReconciler({
      provider,
      ownershipSelector: SELECTOR,
      makeCtx: () => makeCtx(),
      client,
      session: { get: async () => session, recover: async () => session },
      key,
      identity: RENEWAL_IDENTITY,
      leaseCandidates: [makeRenewalHandoff({ leaseId: DEAD_LEASE }).offer, makeRenewalHandoff({ leaseId: LIVE_LEASE }).offer],
      metrics,
      now: () => scheduler.now(),
    });

    const result = await reconciler.run();

    expect(result.sandboxesScanned).toBe(3);
    expect(result.sandboxesKilled).toBe(1);
    expect(result.sandboxesKept).toBe(1);
    expect(result.unknownSandboxes).toBe(1);
    expect(result.sandboxesFailed).toBe(0);

    // The stale sandbox was destroyed and its process tree is provably gone (leak oracle).
    expect(provider.peek("sbx-stale")?.state).toBe("destroyed");
    expect(provider.processTreeAlive("sbx-stale")).toBe(false);
    const stale = result.sandboxOutcomes.find((o) => o.sandboxId === "sbx-stale");
    expect(stale?.disposition).toBe("killed");
    expect(stale?.escalationStage).toBe("destroy"); // cancel(ignored)→kill(ignored)→destroy

    // The live-owned sandbox was NEVER touched (no cancel/kill/destroy on it).
    expect(provider.peek("sbx-live")?.state).toBe("running");
    expect(provider.processTreeAlive("sbx-live")).toBe(true);
    expect(result.sandboxOutcomes.find((o) => o.sandboxId === "sbx-live")?.disposition).toBe("keep");

    // The unknown sandbox is recorded but conservatively LEFT ALIVE (server reaper).
    expect(provider.peek("sbx-unknown")?.state).toBe("running");
    expect(provider.processTreeAlive("sbx-unknown")).toBe(true);
    expect(result.sandboxOutcomes.find((o) => o.sandboxId === "sbx-unknown")?.disposition).toBe("unknown_sandbox");

    // Observability: hashed labels only + the escalation/outcome metrics.
    expect(stale?.resourceLabelsHash).toMatch(/^[0-9a-f]{64}$/);
    const prom = metrics.renderPrometheus();
    expect(prom).toContain("reconcile_orphans_total 1");
    expect(prom).toContain('cleanup_escalation{escalation_stage="destroy"} 1');
    expect(prom).toContain('cleanup_outcome{outcome="success"} 1');
  });

  it("is idempotent: a second pass finds the stale sandbox already gone — no double-kill", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    fake.seedLeaseAuthority(DEAD_LEASE, { live: false });
    fake.seedLeaseAuthority(LIVE_LEASE, { live: true });
    const provider = mixedProvider();
    const deps = {
      provider,
      ownershipSelector: SELECTOR,
      makeCtx: () => makeCtx(),
      client,
      session: { get: async () => session, recover: async () => session },
      key,
      identity: RENEWAL_IDENTITY,
      leaseCandidates: [makeRenewalHandoff({ leaseId: DEAD_LEASE }).offer, makeRenewalHandoff({ leaseId: LIVE_LEASE }).offer],
      now: () => scheduler.now(),
    };

    const first = await createStartupReconciler(deps).run();
    expect(first.sandboxesKilled).toBe(1);

    const destroyCallsAfterFirst = provider.callCount("destroy");
    const second = await createStartupReconciler(deps).run();
    // The destroyed sandbox is no longer listed → nothing to kill on the re-run.
    expect(second.sandboxesKilled).toBe(0);
    expect(second.sandboxesScanned).toBe(2); // live + unknown remain
    // No additional destroy op ran (converged, not double-killed).
    expect(provider.callCount("destroy")).toBe(destroyCallsAfterFirst);
  });

  it("a failing destroy is durable-RETRYABLE: the sandbox records kill_failed and survives a re-run to convergence (crash-matrix CP6)", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    fake.seedLeaseAuthority(DEAD_LEASE, { live: false });

    // destroyFailures = 3 fails the first converge (maxDestroyAttempts) but the
    // resource REMAINS, so a fresh pass retries it to a clean success — never a throw.
    const provider = createFakeSandboxProvider({
      destroyFailures: 3,
      seededResources: [
        { sandboxId: "sbx-stale", labels: sampleLabels({ jobId: "j-stale", leaseId: DEAD_LEASE }), hasLiveLease: true, state: "running" },
      ],
    });
    const metrics = createMetrics();
    const deps = {
      provider,
      ownershipSelector: SELECTOR,
      makeCtx: () => makeCtx(),
      client,
      session: { get: async () => session, recover: async () => session },
      key,
      identity: RENEWAL_IDENTITY,
      leaseCandidates: [makeRenewalHandoff({ leaseId: DEAD_LEASE }).offer],
      metrics,
      now: () => scheduler.now(),
    };

    const first = await createStartupReconciler(deps).run();
    expect(first.sandboxesKilled).toBe(0);
    expect(first.sandboxesFailed).toBe(1);
    expect(first.sandboxOutcomes[0]?.disposition).toBe("kill_failed");
    // The resource survives for a durable retry (never a silent drop).
    expect(provider.peek("sbx-stale")?.state).not.toBe("destroyed");
    expect(metrics.renderPrometheus()).toContain('cleanup_outcome{outcome="failed"} 1');

    // A second pass (destroyFailures now exhausted) converges cleanly.
    const second = await createStartupReconciler(deps).run();
    expect(second.sandboxesKilled).toBe(1);
    expect(provider.peek("sbx-stale")?.state).toBe("destroyed");
    expect(provider.processTreeAlive("sbx-stale")).toBe(false);
  });

  it("a 401-unauthorized probe is UNREACHABLE (a recoverable auth blip), NOT dead — the live-owned sandbox is left for the reaper, never mass-killed", async () => {
    // Regression (HIGH): renewLeaseOnce returns kind 'terminal' for BOTH target_revoked
    // (dead) AND a 401 unauthorized (a recoverable session-credential failure). A boot
    // clock-skew / audience desync makes every renew 401; collapsing that to 'dead' would
    // mass-kill live-owned sandboxes + abandon their streams. It must be 'unreachable'.
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    fake.forceRenewUnauthorized(true); // every renew 401s (recoverable, not a liveness verdict)
    const provider = createFakeSandboxProvider({
      seededResources: [
        { sandboxId: "sbx-owned", labels: sampleLabels({ jobId: "j-owned", leaseId: LIVE_LEASE }), hasLiveLease: true, state: "running" },
      ],
    });
    const result = await createStartupReconciler({
      provider,
      ownershipSelector: SELECTOR,
      makeCtx: () => makeCtx(),
      client,
      session: { get: async () => session, recover: async () => session },
      key,
      identity: RENEWAL_IDENTITY,
      leaseCandidates: [makeRenewalHandoff({ leaseId: LIVE_LEASE }).offer],
      now: () => scheduler.now(),
    }).run();

    expect(result.leaseProbes.get(LIVE_LEASE)?.state).toBe("unreachable");
    expect(result.sandboxesKilled).toBe(0);
    expect(result.indeterminateSandboxes).toBe(1);
    expect(result.sandboxOutcomes[0]?.disposition).toBe("indeterminate");
    expect(provider.peek("sbx-owned")?.state).toBe("running"); // NEVER touched
    expect(provider.processTreeAlive("sbx-owned")).toBe(true);
  });

  it("teardown does not interleave with pagination: each sandbox is classified exactly once (no re-processed survivor / inflated counts)", async () => {
    // Regression (MEDIUM): the provider page cursor is a sandboxId (findIndex(token)+1)
    // and `list` excludes destroyed rows. Inline teardown during pagination shifts the
    // cursor back and RE-PROCESSES the kept survivor. A KEPT sandbox precedes the KILLED
    // one so the buggy path re-classifies it; the fix snapshots the inventory first.
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    fake.seedLeaseAuthority(LIVE_LEASE, { live: true });
    fake.seedLeaseAuthority(DEAD_LEASE, { live: false, deadReason: "target_revoked" });
    const provider = createFakeSandboxProvider({
      seededResources: [
        { sandboxId: "sbx-a-live", labels: sampleLabels({ jobId: "j-a", leaseId: LIVE_LEASE }), hasLiveLease: true, state: "running" },
        { sandboxId: "sbx-b-dead", labels: sampleLabels({ jobId: "j-b", leaseId: DEAD_LEASE }), hasLiveLease: true, state: "running" },
        { sandboxId: "sbx-c-live", labels: sampleLabels({ jobId: "j-c", leaseId: LIVE_LEASE }), hasLiveLease: true, state: "running" },
      ],
    });
    const result = await createStartupReconciler({
      provider,
      ownershipSelector: SELECTOR,
      makeCtx: () => makeCtx(),
      client,
      session: { get: async () => session, recover: async () => session },
      key,
      identity: RENEWAL_IDENTITY,
      leaseCandidates: [makeRenewalHandoff({ leaseId: LIVE_LEASE }).offer, makeRenewalHandoff({ leaseId: DEAD_LEASE }).offer],
      pageSize: 2, // force multi-page pagination so a mid-scan destroy would shift the cursor
      now: () => scheduler.now(),
    }).run();

    expect(result.sandboxesScanned).toBe(3);
    expect(result.sandboxesKilled).toBe(1);
    expect(result.sandboxesKept).toBe(2);
    expect(result.sandboxOutcomes).toHaveLength(3);
    // Each sandboxId appears EXACTLY once (no survivor re-processed).
    expect(result.sandboxOutcomes.map((o) => o.sandboxId).sort()).toEqual(["sbx-a-live", "sbx-b-dead", "sbx-c-live"]);
  });
});
