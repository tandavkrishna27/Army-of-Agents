import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEventOutboxDrain } from "../events/event-outbox-drain.js";
import { uploadEventBatchOnce } from "../events/event-upload.js";
import { DurableWorkerEventSink } from "../events/durable-event-sink.js";
import {
  OutboxFullError,
  deriveStreamKey,
  openEventOutboxStore,
  type DurableEventStore,
  type SqliteEventOutboxStore,
} from "../events/event-outbox-store.js";
import { staticSessionProvider } from "./support/renewal-fixtures.js";
import { enrollFixtureWorker, enrollmentCodeConfig } from "./support/poll-fixtures.js";
import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import { eventIdentity, samplePayloadFor, stampEvent } from "./support/event-fixtures.js";

const KEK = Buffer.alloc(32, 13);
const WRONG_KEK = Buffer.alloc(32, 99);
const CODE = "rec-code";
const IDENTITY = eventIdentity();
const STREAM_KEY = deriveStreamKey(IDENTITY);

let dir: string;
let dbPath: string;
let fake: FakeControlPlane;
let clock: { ms: number };
let enrolled: Awaited<ReturnType<typeof enrollFixtureWorker>>;

function makeSink(store: DurableEventStore, kek = KEK): DurableWorkerEventSink {
  return new DurableWorkerEventSink({ store, kek, now: () => clock.ms });
}
function makeDrain(store: DurableEventStore) {
  return createEventOutboxDrain({
    store,
    client: enrolled.client,
    session: staticSessionProvider(enrolled.session),
    key: enrolled.key,
    kek: KEK,
    now: () => clock.ms,
    rng: () => 0,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aoa-rec-"));
  dbPath = join(dir, "events.db");
  clock = { ms: 1_000 };
  fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)], now: () => clock.ms });
  enrolled = await enrollFixtureWorker(fake, CODE);
});
afterEach(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("event-outbox-recovery — acceptance set (slice 5)", () => {
  it("crash between send/ACK + duplicate send: recover + resend, the server DEDUPS by seq (no double count)", async () => {
    const store = await openEventOutboxStore({ path: dbPath, now: () => clock.ms });
    const sink = makeSink(store);
    const events = [1, 2, 3].map((seq) => stampEvent(IDENTITY, seq, "log", samplePayloadFor("log")));
    for (const e of events) sink.emit(e);

    // The batch reaches the server (it advances its watermark) but the worker
    // "crashes" before applying the ACK: rows stay `uploading`, the cursor stays 0.
    store.markUploading(STREAM_KEY, [1, 2, 3]);
    const attempt = await uploadEventBatchOnce({
      client: enrolled.client,
      session: enrolled.session,
      identity: IDENTITY,
      events,
      key: enrolled.key,
      idempotencyKey: "00000000-0000-4000-8000-0000000000d0",
    });
    expect(attempt.kind).toBe("accepted");
    expect(fake.eventStreamAcceptedThrough(STREAM_KEY)).toBe(3);
    store.close();

    // Restart: reopen the same file, recover stalled uploads, drain.
    const restarted = await openEventOutboxStore({ path: dbPath, now: () => clock.ms });
    const drain = makeDrain(restarted);
    const recovered = drain.recover();
    expect(recovered).toBe(3);
    // Recovery reverts uploading → pending WITHOUT bumping attempts.
    expect(restarted.getRow(STREAM_KEY, 1)!.status).toBe("pending");
    expect(restarted.getRow(STREAM_KEY, 1)!.attempts).toBe(0);

    await drain.drainOnce();
    // The resend is a DUPLICATE the server dedups: watermark stays 3, not 6.
    expect(fake.eventStreamAcceptedThrough(STREAM_KEY)).toBe(3);
    expect(restarted.getStream(STREAM_KEY)!.acceptedThroughSeq).toBe(3);
    expect(restarted.allRows(STREAM_KEY)).toHaveLength(0);
    expect(fake.eventUploads()).toHaveLength(2); // pre-crash + resend
    restarted.close();
  });

  it("sequence recovery: a restart resumes uploads from acceptedThroughSeq + 1", async () => {
    const store = await openEventOutboxStore({ path: dbPath, now: () => clock.ms });
    const sink = makeSink(store);
    [1, 2, 3].forEach((seq) => sink.emit(stampEvent(IDENTITY, seq, "log", samplePayloadFor("log"))));
    await makeDrain(store).drainOnce();
    expect(store.getStream(STREAM_KEY)!.acceptedThroughSeq).toBe(3);
    store.close();

    // Restart: new events arrive; the drain resumes from seq 4 (not 1).
    const restarted = await openEventOutboxStore({ path: dbPath, now: () => clock.ms });
    const sink2 = makeSink(restarted);
    [4, 5].forEach((seq) => sink2.emit(stampEvent(IDENTITY, seq, "log", samplePayloadFor("log"))));
    await makeDrain(restarted).drainOnce();

    expect(restarted.getStream(STREAM_KEY)!.acceptedThroughSeq).toBe(5);
    expect(fake.eventUploads()[1]!).toMatchObject({ firstSeq: 4, lastSeq: 5 });
    restarted.close();
  });

  it("corrupt-row quarantine is NON-FATAL: prefix uploads, the poison stream stops, other streams still drain", async () => {
    const store = await openEventOutboxStore({ path: dbPath, now: () => clock.ms });
    // Poison stream: seq 2 sealed under a DIFFERENT KEK → the drain's KEK can't open it.
    const sink = makeSink(store);
    const wrongSink = makeSink(store, WRONG_KEK);
    sink.emit(stampEvent(IDENTITY, 1, "log", samplePayloadFor("log")));
    wrongSink.emit(stampEvent(IDENTITY, 2, "log", samplePayloadFor("log")));
    sink.emit(stampEvent(IDENTITY, 3, "log", samplePayloadFor("log")));

    // A co-resident HEALTHY stream (distinct job identity) must still drain.
    const healthy = eventIdentity({ jobId: "00000000-0000-4000-8000-0000000000b3" });
    const healthyKey = deriveStreamKey(healthy);
    sink.emit(stampEvent(healthy, 1, "log", samplePayloadFor("log")));

    const summary = await makeDrain(store).drainOnce();

    // Poison stream: seq 2 quarantined, prefix [1] uploaded (cursor=1), stream stopped.
    expect(store.getRow(STREAM_KEY, 2)!.status).toBe("quarantined");
    expect(store.getStream(STREAM_KEY)!.acceptedThroughSeq).toBe(1);
    expect(store.getStream(STREAM_KEY)!.stopped).toBe(true);
    expect(store.getStream(STREAM_KEY)!.stopReason).toBe("corrupt_row");
    // The healthy stream fully drained in the SAME pass (loop not stalled).
    expect(store.getStream(healthyKey)!.acceptedThroughSeq).toBe(1);
    expect(store.getStream(healthyKey)!.stopped).toBe(false);
    expect(summary.streamsStopped).toBe(1);
    store.close();
  });

  it("corrupt-row is fail-closed even when the prefix upload is NOT immediately accepted (transient) — no silent zombie stream", async () => {
    // Regression: the poison-row stream-stop must not depend on the SAME-pass prefix
    // upload returning `accepted`. On a transient (503/timeout/gap/401) the in-memory
    // poisonAfter flag is dropped on requeue; without durable-gap detection the stream
    // would strand post-poison events forever (stopped=0, no stop_reason).
    const store = await openEventOutboxStore({ path: dbPath, now: () => clock.ms });
    const sink = makeSink(store);
    const wrongSink = makeSink(store, WRONG_KEK);
    sink.emit(stampEvent(IDENTITY, 1, "log", samplePayloadFor("log")));
    wrongSink.emit(stampEvent(IDENTITY, 2, "log", samplePayloadFor("log"))); // poison
    // A post-poison TERMINAL-class event — design §8 says these must never silently vanish.
    sink.emit(stampEvent(IDENTITY, 3, "terminal", samplePayloadFor("terminal")));
    const drain = makeDrain(store);

    // Pass 1: prefix [1] flushed, server answers TRANSIENT → requeue, poisonAfter dropped.
    fake.enqueueEventUpload({ kind: "error", status: 503, code: "internal_unavailable", retryAfterMs: 1_000 });
    await drain.drainOnce();
    expect(store.getStream(STREAM_KEY)!.stopped).toBe(false); // not yet — prefix must retry

    // Pass 2 (past backoff): prefix [1] re-flushed + accepted (cursor→1); then the peek from
    // seq 2 is empty (poison quarantined) → durable-gap detection stops the stream fail-closed.
    clock.ms += 60_000;
    await drain.drainOnce();

    expect(store.getRow(STREAM_KEY, 2)!.status).toBe("quarantined");
    expect(store.getStream(STREAM_KEY)!.acceptedThroughSeq).toBe(1); // prefix delivered
    expect(store.getStream(STREAM_KEY)!.stopped).toBe(true);
    expect(store.getStream(STREAM_KEY)!.stopReason).toBe("corrupt_row");
    expect(store.listActiveStreams()).toHaveLength(0); // NOT a forever-relisted zombie
    store.close();
  });

  it("full disk (simulate): a store-append fault surfaces out of emit() — fail closed, never a silent drop", () => {
    const faultStore = {
      append() {
        const err = new Error("SQLITE_FULL: database or disk is full") as Error & { code: string };
        err.code = "SQLITE_FULL";
        throw err;
      },
    } as unknown as DurableEventStore;
    const sink = makeSink(faultStore);
    expect(() => sink.emit(stampEvent(IDENTITY, 1, "terminal", samplePayloadFor("terminal")))).toThrow(/disk is full/);
  });

  it("backpressure cap: the durable queue fails closed (OutboxFullError), never dropping the newest event", async () => {
    const capped = await openEventOutboxStore({
      path: join(dir, "capped.db"),
      now: () => clock.ms,
      limits: { maxPendingRows: 2, maxTotalBytes: 1_000_000_000 },
    });
    const sink = makeSink(capped);
    sink.emit(stampEvent(IDENTITY, 1, "log", samplePayloadFor("log")));
    sink.emit(stampEvent(IDENTITY, 2, "log", samplePayloadFor("log")));
    expect(() => sink.emit(stampEvent(IDENTITY, 3, "terminal", samplePayloadFor("terminal")))).toThrow(OutboxFullError);
    expect(capped.countPending()).toBe(2);
    capped.close();
  });
});
