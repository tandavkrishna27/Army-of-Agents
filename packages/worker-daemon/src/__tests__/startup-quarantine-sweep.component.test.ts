/**
 * WRK-007 Slice 4a — the unknown-artifact quarantine sweep (D5).
 *
 * A staged output artifact whose observed fence is DEAD is orphaned. The startup
 * reconciler routes it through WRK-005's device-session `runOrphanQuarantine` with
 * reason `unknown_artifact`: it lands under the DISTINCT `quarantine/` prefix,
 * survives lease loss (device-session auth, not a live lease), is non-promotable,
 * and is idempotent on re-run. A TERMINAL session DROPS it (never the disabled
 * ordinary-commit path). An artifact under a still-LIVE lease is skipped.
 *
 * Fail-first: the reconciler ignores `quarantineCandidates` today.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createStartupReconciler, type StartupQuarantineCandidate } from "../supervisor/startup-reconcile.js";
import { SessionTerminalError } from "../poll/poll-loop.js";
import type { WorkerSession } from "../enrollment/enroll.js";

import type { FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import {
  FakeScheduler,
  RENEWAL_CODE,
  RENEWAL_IDENTITY,
  makeRenewalHandoff,
  quarantineArtifact,
  quarantineIdentity,
  startRenewalPlane,
} from "./support/renewal-fixtures.js";
import { makeCtx } from "./support/supervisor-fixtures.js";

const SELECTOR = { organizationId: "org-1", targetId: "target-1", workerId: "worker-1" };
const DEAD_LEASE = "00000000-0000-4000-8000-00000000c101";

let scheduler: FakeScheduler;
let fake: FakeControlPlane;

beforeEach(async () => {
  scheduler = new FakeScheduler();
  fake = await startRenewalPlane(scheduler);
});
afterEach(async () => {
  await fake.close();
});

function candidateUnderDeadFence(): StartupQuarantineCandidate {
  return {
    identity: { ...quarantineIdentity(), observedLeaseId: DEAD_LEASE },
    artifact: quarantineArtifact(),
  };
}

function reconcilerWith(
  sessionProvider: { get: () => Promise<WorkerSession>; recover: () => Promise<WorkerSession> },
  client: Awaited<ReturnType<typeof enrollFixtureWorker>>["client"],
  key: Awaited<ReturnType<typeof enrollFixtureWorker>>["key"],
) {
  return createStartupReconciler({
    provider: createFakeSandboxProvider(),
    ownershipSelector: SELECTOR,
    makeCtx: () => makeCtx(),
    client,
    session: sessionProvider,
    key,
    identity: RENEWAL_IDENTITY,
    leaseCandidates: [makeRenewalHandoff({ leaseId: DEAD_LEASE }).offer],
    quarantineCandidates: [candidateUnderDeadFence()],
    now: () => scheduler.now(),
  });
}

describe("startup-quarantine-sweep — staged output under a dead fence is quarantined (unknown_artifact)", () => {
  it("quarantines the orphan artifact under the distinct quarantine/ prefix; idempotent on re-run", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    fake.seedLeaseAuthority(DEAD_LEASE, { live: false, deadReason: "target_revoked" });
    const provider = { get: async () => session, recover: async () => session };

    const result = await reconcilerWith(provider, client, key).run();

    expect(result.artifactsQuarantined).toBe(1);
    expect(result.quarantineOutcomes[0]?.status).toBe("quarantined");

    // A grant + a finalize round-trip under the DISTINCT quarantine/ prefix.
    const records = fake.quarantineRecords();
    expect(records.map((r) => r.kind).sort()).toEqual(["finalize", "grant"]);
    for (const r of records) expect(r.quarantineObjectKey.startsWith("quarantine/")).toBe(true);

    // Re-run converges to the same disposition (idempotent — distinct prefix).
    const second = await reconcilerWith(provider, client, key).run();
    expect(second.quarantineOutcomes[0]?.status).toBe("quarantined");
  });

  it("a terminal session DROPS the orphan output (never the disabled ordinary-commit path)", async () => {
    const { key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    fake.seedLeaseAuthority(DEAD_LEASE, { live: false });
    const terminal = {
      get: async (): Promise<WorkerSession> => {
        throw new SessionTerminalError();
      },
      recover: async (): Promise<WorkerSession> => {
        throw new SessionTerminalError();
      },
    };

    const result = await reconcilerWith(terminal, client, key).run();

    expect(result.artifactsQuarantined).toBe(0);
    expect(result.artifactsDropped).toBe(1);
    expect(result.quarantineOutcomes[0]?.status).toBe("dropped");
    // No grant/finalize ever posted (dropped BEFORE the device-session round-trip).
    expect(fake.quarantineGrantCount()).toBe(0);
  });

  it("an artifact under a still-live lease is skipped (not quarantined)", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    fake.seedLeaseAuthority(DEAD_LEASE, { live: true }); // the observed lease is actually live
    const provider = { get: async () => session, recover: async () => session };

    const result = await reconcilerWith(provider, client, key).run();

    expect(result.artifactsQuarantined).toBe(0);
    expect(result.quarantineOutcomes[0]?.status).toBe("skipped_live");
    expect(fake.quarantineGrantCount()).toBe(0);
  });
});
