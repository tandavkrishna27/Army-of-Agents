/**
 * WRK-007 Slice 3 — outbox stream reconciliation on boot.
 *
 * Cross-referencing each active stream's `identity.leaseId` against the inferred
 * lease authority (D7):
 *   - owned/live lease → resume-drain (recover `uploading`→`pending` with NO attempts
 *     bump, resend from `acceptedThroughSeq + 1`; the server dedups by seq);
 *   - dead lease → eagerly `stopStream` (events under a dead fence can never be
 *     accepted) rather than waiting for the drain's lazy stale-fence self-stop.
 *   - Streams are reconciled BEFORE the sandbox kill pass (D8); a poison row must
 *     stop its own stream (corrupt_row, no silent zombie) WITHOUT blocking the
 *     sandbox pass.
 *
 * Fail-first: `createStartupReconciler` ignores the `outbox` seam today (no stream
 * classification, no recover/drain wiring).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEventOutboxDrain } from "../events/event-outbox-drain.js";
import { DurableWorkerEventSink } from "../events/durable-event-sink.js";
import { deriveStreamKey, openEventOutboxStore, type DurableEventStore } from "../events/event-outbox-store.js";
import { uploadEventBatchOnce } from "../events/event-upload.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createStartupReconciler } from "../supervisor/startup-reconcile.js";

import type { FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import { FakeScheduler, RENEWAL_IDENTITY, makeRenewalHandoff } from "./support/renewal-fixtures.js";
import { startFakeControlPlane } from "./support/fake-control-plane.js";
import { enrollmentCodeConfig } from "./support/poll-fixtures.js";
import { eventIdentity, samplePayloadFor, stampEvent } from "./support/event-fixtures.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

const KEK = Buffer.alloc(32, 13);
const WRONG_KEK = Buffer.alloc(32, 99);
const CODE = "startup-outbox-code";
const SELECTOR = { organizationId: "org-1", targetId: "target-1", workerId: "worker-1" };

const OWNED_LEASE = "00000000-0000-4000-8000-00000000a101";
const DEAD_LEASE = "00000000-0000-4000-8000-00000000a102";
const OWNED_JOB = "00000000-0000-4000-8000-00000000a201";
const DEAD_JOB = "00000000-0000-4000-8000-00000000a202";

let dir: string;
let fake: FakeControlPlane;
let clock: { ms: number };
let scheduler: FakeScheduler;
let enrolled: Awaited<ReturnType<typeof enrollFixtureWorker>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aoa-startup-outbox-"));
  clock = { ms: 1_000 };
  scheduler = new FakeScheduler();
  fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)], now: () => clock.ms });
  enrolled = await enrollFixtureWorker(fake, CODE);
});
afterEach(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeDrain(store: DurableEventStore) {
  return createEventOutboxDrain({
    store,
    client: enrolled.client,
    session: { get: async () => enrolled.session, recover: async () => enrolled.session },
    key: enrolled.key,
    kek: KEK,
    now: () => clock.ms,
    rng: () => 0,
  });
}

function reconcilerFor(store: DurableEventStore, drain: ReturnType<typeof makeDrain>, provider = createFakeSandboxProvider()) {
  return createStartupReconciler({
    provider,
    ownershipSelector: SELECTOR,
    makeCtx: () => makeCtx(),
    client: enrolled.client,
    session: { get: async () => enrolled.session, recover: async () => enrolled.session },
    key: enrolled.key,
    identity: RENEWAL_IDENTITY,
    leaseCandidates: [makeRenewalHandoff({ leaseId: OWNED_LEASE }).offer, makeRenewalHandoff({ leaseId: DEAD_LEASE }).offer],
    outbox: { store, drain },
    now: () => scheduler.now(),
  });
}

describe("startup-outbox-reconcile — owned streams resume-drain; dead-lease streams are abandoned", () => {
  it("resume-drains the owned stream (server dedups) and eagerly stops the dead-lease stream", async () => {
    fake.seedLeaseAuthority(OWNED_LEASE, { live: true });
    fake.seedLeaseAuthority(DEAD_LEASE, { live: false, deadReason: "target_revoked" });

    const ownedId = eventIdentity({ leaseId: OWNED_LEASE, jobId: OWNED_JOB });
    const deadId = eventIdentity({ leaseId: DEAD_LEASE, jobId: DEAD_JOB });
    const ownedKey = deriveStreamKey(ownedId);
    const deadKey = deriveStreamKey(deadId);

    const store = await openEventOutboxStore({ path: join(dir, "events.db"), now: () => clock.ms });
    const sink = new DurableWorkerEventSink({ store, kek: KEK, now: () => clock.ms });

    // Owned stream: 3 events reached the server (watermark=3) but the worker crashed
    // before applying the ACK — rows stay `uploading`, cursor stays 0.
    const ownedEvents = [1, 2, 3].map((seq) => stampEvent(ownedId, seq, "log", samplePayloadFor("log")));
    for (const e of ownedEvents) sink.emit(e);
    store.markUploading(ownedKey, [1, 2, 3]);
    const pre = await uploadEventBatchOnce({
      client: enrolled.client,
      session: enrolled.session,
      identity: ownedId,
      events: ownedEvents,
      key: enrolled.key,
      idempotencyKey: "00000000-0000-4000-8000-00000000b001",
    });
    expect(pre.kind).toBe("accepted");

    // Dead-lease stream: 2 pending events under a revoked fence.
    [1, 2].forEach((seq) => sink.emit(stampEvent(deadId, seq, "log", samplePayloadFor("log"))));

    const drain = reconcileDrain(store);
    const result = await drain.reconciler.run();

    // Owned stream: recovered (uploading→pending, no attempts bump), resent, DEDUP'd
    // by the server (watermark unchanged), rows pruned.
    expect(result.streamsResumed).toBe(1);
    expect(store.getStream(ownedKey)!.acceptedThroughSeq).toBe(3);
    expect(store.allRows(ownedKey)).toHaveLength(0);

    // Dead-lease stream: eagerly stopped, its events NEVER uploaded.
    expect(result.streamsAbandoned).toBe(1);
    expect(store.getStream(deadKey)!.stopped).toBe(true);
    const deadUploads = fake.eventUploads().filter((u) => u.streamKey === deadKey);
    expect(deadUploads).toHaveLength(0);

    expect(result.streamOutcomes.find((s) => s.streamKey === deadKey)?.disposition).toBe("abandoned");
    expect(result.streamOutcomes.find((s) => s.streamKey === ownedKey)?.disposition).toBe("resume_drain");
    store.close();
  });

  it("a poison row stops ITS stream (corrupt_row, no zombie) and does NOT block the sandbox kill pass", async () => {
    fake.seedLeaseAuthority(OWNED_LEASE, { live: true });
    fake.seedLeaseAuthority(DEAD_LEASE, { live: false });

    const ownedId = eventIdentity({ leaseId: OWNED_LEASE, jobId: OWNED_JOB });
    const ownedKey = deriveStreamKey(ownedId);
    const store = await openEventOutboxStore({ path: join(dir, "events.db"), now: () => clock.ms });
    const sink = new DurableWorkerEventSink({ store, kek: KEK, now: () => clock.ms });
    const wrongSink = new DurableWorkerEventSink({ store, kek: WRONG_KEK, now: () => clock.ms });
    sink.emit(stampEvent(ownedId, 1, "log", samplePayloadFor("log")));
    wrongSink.emit(stampEvent(ownedId, 2, "log", samplePayloadFor("log"))); // poison (undecryptable)
    sink.emit(stampEvent(ownedId, 3, "terminal", samplePayloadFor("terminal"))); // post-poison terminal

    // A stale sandbox under a DEAD lease that the sandbox pass must still reclaim.
    const provider = createFakeSandboxProvider({
      seededResources: [
        { sandboxId: "sbx-stale", labels: sampleLabels({ jobId: "j-stale", leaseId: DEAD_LEASE }), hasLiveLease: true, state: "running" },
      ],
    });

    const drain = reconcileDrain(store, provider);
    const result = await drain.reconciler.run();

    // The poison stream stopped itself fail-closed; it is NOT a forever-relisted zombie.
    expect(store.getRow(ownedKey, 2)!.status).toBe("quarantined");
    expect(store.getStream(ownedKey)!.stopped).toBe(true);
    expect(store.getStream(ownedKey)!.stopReason).toBe("corrupt_row");
    expect(store.listActiveStreams()).toHaveLength(0);

    // The sandbox pass STILL ran — the stale sandbox was reclaimed despite the poison.
    expect(result.sandboxesKilled).toBe(1);
    expect(provider.peek("sbx-stale")?.state).toBe("destroyed");
    expect(provider.processTreeAlive("sbx-stale")).toBe(false);
    store.close();
  });
});

/** Build a drain + a reconciler that shares it (kept out of the `it` bodies). */
function reconcileDrain(store: DurableEventStore, provider = createFakeSandboxProvider()) {
  const drain = makeDrain(store);
  const reconciler = reconcilerFor(store, drain, provider);
  return { drain, reconciler };
}
