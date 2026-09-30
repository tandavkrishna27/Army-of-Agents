import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEventOutboxDrain, type EventOutboxDrain } from "../events/event-outbox-drain.js";
import { DurableWorkerEventSink } from "../events/durable-event-sink.js";
import {
  deriveStreamKey,
  openEventOutboxStore,
  type SqliteEventOutboxStore,
} from "../events/event-outbox-store.js";
import { staticSessionProvider } from "./support/renewal-fixtures.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollmentCodeConfig } from "./support/poll-fixtures.js";
import { eventIdentity, samplePayloadFor, stampEvent } from "./support/event-fixtures.js";

const KEK = Buffer.alloc(32, 11);
const CODE = "evt-code";
const IDENTITY = eventIdentity();
const STREAM_KEY = deriveStreamKey(IDENTITY);

let dir: string;
let fake: FakeControlPlane;
let store: SqliteEventOutboxStore;
let sink: DurableWorkerEventSink;
let clock: { ms: number };
let drain: EventOutboxDrain;
let session: Awaited<ReturnType<typeof enrollFixtureWorker>>["session"];
let key: Awaited<ReturnType<typeof enrollFixtureWorker>>["key"];
let client: Awaited<ReturnType<typeof enrollFixtureWorker>>["client"];

async function buildDrain(sessionProvider = staticSessionProvider(session), maxRecoveries?: number): Promise<EventOutboxDrain> {
  return createEventOutboxDrain({
    store,
    client,
    session: sessionProvider,
    key,
    kek: KEK,
    now: () => clock.ms,
    rng: () => 0, // pin backoff jitter
    maxConsecutiveRecoveries: maxRecoveries,
    tuning: { backoff: { baseMs: 1_000, maxMs: 30_000, jitter: 0 } },
  });
}

function emit(seq: number, eventType: "log" | "terminal" = "log"): void {
  sink.emit(stampEvent(IDENTITY, seq, eventType, samplePayloadFor(eventType)));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aoa-drain-"));
  clock = { ms: 1_000 };
  fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)], now: () => clock.ms });
  const enrolled = await enrollFixtureWorker(fake, CODE);
  session = enrolled.session;
  key = enrolled.key;
  client = enrolled.client;
  store = await openEventOutboxStore({ path: join(dir, "events.db"), now: () => clock.ms });
  sink = new DurableWorkerEventSink({ store, kek: KEK, now: () => clock.ms });
  drain = await buildDrain();
});
afterEach(async () => {
  store.close();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("event-outbox-drain — upload in seq order, advance cursor, classify (slice 4)", () => {
  it("accepted → advances the durable cursor + prunes; builds a valid contiguous batch", async () => {
    emit(1);
    emit(2);
    emit(3);
    const summary = await drain.drainOnce();

    expect(summary.eventsAccepted).toBe(1);
    // The plane received ONE contiguous batch (1..3) — the frozen schema validated it.
    expect(fake.eventUploads()).toHaveLength(1);
    expect(fake.eventUploads()[0]!).toMatchObject({ firstSeq: 1, lastSeq: 3, count: 3 });
    // Durable cursor advanced + rows pruned.
    expect(store.getStream(STREAM_KEY)!.acceptedThroughSeq).toBe(3);
    expect(store.allRows(STREAM_KEY)).toHaveLength(0);
    expect(fake.eventStreamAcceptedThrough(STREAM_KEY)).toBe(3);
  });

  it("gap → advances to acceptedThroughSeq and resends from expectedNextSeq next tick", async () => {
    emit(1);
    emit(2);
    emit(3);
    // Server already holds seq 1; it expects the next batch to start at 2.
    fake.enqueueEventUpload({ kind: "gap", acceptedThroughSeq: 1 });
    await drain.drainOnce();
    expect(store.getStream(STREAM_KEY)!.acceptedThroughSeq).toBe(1);
    expect(store.getRow(STREAM_KEY, 1)).toBeNull(); // pruned
    expect(store.getRow(STREAM_KEY, 2)!.status).toBe("pending"); // reverted, resendable

    // Next pass (default accept) resends from seq 2 and finishes.
    await drain.drainOnce();
    expect(store.getStream(STREAM_KEY)!.acceptedThroughSeq).toBe(3);
    expect(fake.eventUploads()[1]!).toMatchObject({ firstSeq: 2, lastSeq: 3 });
  });

  it("hash_mismatch → quarantines the rejected event id and STOPS the stream", async () => {
    emit(1);
    const evt2 = stampEvent(IDENTITY, 2, "log", samplePayloadFor("log"));
    sink.emit(evt2);
    emit(3);
    fake.enqueueEventUpload({ kind: "hash_mismatch", rejectedEventId: evt2.eventId });
    await drain.drainOnce();

    expect(store.getRow(STREAM_KEY, 2)!.status).toBe("quarantined");
    expect(store.getStream(STREAM_KEY)!.stopped).toBe(true);
    expect(store.getStream(STREAM_KEY)!.stopReason).toBe("hash_mismatch");
    expect(store.listActiveStreams()).toHaveLength(0);
  });

  it("stale_fence / target_revoked / terminal ACK → stop the stream (converge)", async () => {
    for (const reason of ["stale_fence", "target_revoked", "terminal"] as const) {
      const d = mkdtempSync(join(tmpdir(), "aoa-stop-"));
      const s = await openEventOutboxStore({ path: join(d, "e.db"), now: () => clock.ms });
      const sk = new DurableWorkerEventSink({ store: s, kek: KEK, now: () => clock.ms });
      const dr = createEventOutboxDrain({ store: s, client, session: staticSessionProvider(session), key, kek: KEK, now: () => clock.ms });
      sk.emit(stampEvent(IDENTITY, 1, "log", samplePayloadFor("log")));
      fake.enqueueEventUpload({ kind: reason });
      await dr.drainOnce();
      expect(s.getStream(STREAM_KEY)!.stopped, reason).toBe(true);
      expect(s.getStream(STREAM_KEY)!.stopReason, reason).toBe(reason);
      s.close();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("transient → re-queues with a persisted backoff and REUSES the same idempotency key (D6)", async () => {
    emit(1);
    emit(2);
    fake.enqueueEventUpload({ kind: "error", status: 503, code: "internal_unavailable", retryAfterMs: 5_000 });
    await drain.drainOnce();

    // Re-queued (not stopped, not accepted): pending, attempts bumped, next_retry_at set.
    const row1 = store.getRow(STREAM_KEY, 1)!;
    expect(row1.status).toBe("pending");
    expect(row1.attempts).toBe(1);
    expect(row1.nextRetryAt).toBe(clock.ms + 5_000);
    // Not eligible yet (backoff in force) → no upload this tick.
    await drain.drainOnce();
    expect(fake.eventUploadCount()).toBe(1);

    // Advance past the backoff → the retry uses the SAME idempotency key.
    clock.ms += 6_000;
    await drain.drainOnce();
    expect(store.getStream(STREAM_KEY)!.acceptedThroughSeq).toBe(2);
    expect(fake.eventUploadKeys()).toHaveLength(1); // one key across the transient retry
  });

  it("graceful-shutdown flush() delivers pending events EVEN AFTER stop() (the final flush is not a no-op)", async () => {
    // Regression: the shutdown order is stop → flush → close. stop() latches the loop's
    // cooperative-cancel guard; flush() must still run one full pass (final=true) so the
    // last durably-persisted events get a delivery attempt instead of waiting for reboot.
    emit(1);
    emit(2);
    emit(3);
    drain.stop();
    await drain.flush();

    expect(store.getStream(STREAM_KEY)!.acceptedThroughSeq).toBe(3);
    expect(store.allRows(STREAM_KEY)).toHaveLength(0); // pruned after ACK
    expect(fake.eventUploads()).toHaveLength(1); // the final flush actually uploaded
  });

  it("401 → recovers under a PER-STREAM cap, then stops the stream when capped", async () => {
    emit(1);
    const controllable = {
      get: async () => session,
      recover: (() => {
        let n = 0;
        return async () => {
          n += 1;
          (controllable as { recovers: number }).recovers = n;
          return session;
        };
      })(),
      recovers: 0,
    } as unknown as ReturnType<typeof staticSessionProvider> & { recovers: number };

    const d = await buildDrain(controllable, 3);
    fake.forceEventUploadUnauthorized(true);
    await d.drainOnce();

    expect((controllable as unknown as { recovers: number }).recovers).toBe(3);
    expect(store.getStream(STREAM_KEY)!.stopped).toBe(true);
    expect(store.getStream(STREAM_KEY)!.stopReason).toBe("reenrollment_required");
  });
});
