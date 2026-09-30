import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventSequencer } from "../supervisor/events.js";
import { decryptEventRow } from "../events/event-row-codec.js";
import {
  OutboxFullError,
  SeqCollisionError,
  deriveStreamKey,
  openEventOutboxStore,
  type DurableEventStore,
  type SqliteEventOutboxStore,
} from "../events/event-outbox-store.js";
import { DurableWorkerEventSink } from "../events/durable-event-sink.js";

import { POLL_FIXTURE_IDS } from "./support/poll-fixtures.js";
import { eventIdentity, stampEvent, samplePayloadFor } from "./support/event-fixtures.js";

const KEK = Buffer.alloc(32, 5);

let dir: string;
let dbPath: string;
let store: SqliteEventOutboxStore;
let sink: DurableWorkerEventSink;

const IDENTITY = eventIdentity();
const STREAM_KEY = deriveStreamKey(IDENTITY);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aoa-sink-"));
  dbPath = join(dir, "events.db");
  store = await openEventOutboxStore({ path: dbPath, now: () => 1000 });
  sink = new DurableWorkerEventSink({ store, kek: KEK, now: () => 1000 });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("durable-event-sink — verbatim persist + fsync-before-return (D3/D4)", () => {
  it("persists seq + eventDigest VERBATIM — never recomputed / re-stamped", async () => {
    const seq = new EventSequencer({ identity: IDENTITY, sink, redactionCanaries: [] });
    const event = await seq.attemptStarted(POLL_FIXTURE_IDS.runId);

    const row = store.getRow(STREAM_KEY, event.seq)!;
    expect(row).not.toBeNull();
    // The stored columns equal the STAMPED event's fields byte-for-byte.
    expect(row.seq).toBe(event.seq);
    expect(row.eventDigest).toBe(event.eventDigest);
    expect(row.eventId).toBe(event.eventId);
    expect(row.eventType).toBe("attempt_started");

    // Decrypting the ciphertext yields the EXACT event JSON — the seq/digest inside
    // match the stamped values (the outbox stored, it did not re-stamp).
    const plaintext = decryptEventRow(row.encrypted, KEK).toString("utf8");
    const replayed = JSON.parse(plaintext);
    expect(replayed.seq).toBe(event.seq);
    expect(replayed.eventDigest).toBe(event.eventDigest);
    expect(replayed).toEqual(JSON.parse(JSON.stringify(event)));
  });

  it("fsync-commits BEFORE returning — a second store handle sees the pending row", async () => {
    const event = stampEvent(IDENTITY, 1, "log", samplePayloadFor("log"));
    sink.emit(event); // synchronous: returns only after the row is durably committed

    // A SEPARATE connection to the same file observes the committed row — proving
    // durability happened before emit() returned (the crash-between-send/ACK window).
    const second = await openEventOutboxStore({ path: dbPath, now: () => 1000 });
    try {
      const row = second.getRow(STREAM_KEY, 1);
      expect(row).not.toBeNull();
      expect(row!.status).toBe("pending");
      expect(row!.eventDigest).toBe(event.eventDigest);
    } finally {
      second.close();
    }
  });

  it("accepts the FULL union — persists produced AND not-yet-produced kinds alike", () => {
    const kinds = ["attempt_started", "log", "progress", "network_denied", "terminal"] as const;
    kinds.forEach((kind, i) => {
      const event = stampEvent(IDENTITY, i + 1, kind, samplePayloadFor(kind));
      sink.emit(event);
    });
    const rows = store.allRows(STREAM_KEY);
    expect(rows.map((r) => r.eventType)).toEqual([...kinds]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("FAILS CLOSED on a producer seq-collision (D2) — surfaces SeqCollisionError to the producer", () => {
    sink.emit(stampEvent(IDENTITY, 1, "log", samplePayloadFor("log")));
    // A second producer stamps the SAME seq for the same delivery identity.
    expect(() => sink.emit(stampEvent(IDENTITY, 1, "progress", samplePayloadFor("progress")))).toThrow(
      SeqCollisionError,
    );
  });

  it("FAILS CLOSED on backpressure (D4) — never silently drops a terminal-class event", async () => {
    const capped = await openEventOutboxStore({
      path: join(dir, "capped.db"),
      now: () => 1000,
      limits: { maxPendingRows: 1, maxTotalBytes: 1_000_000 },
    });
    const cappedSink = new DurableWorkerEventSink({ store: capped, kek: KEK, now: () => 1000 });
    try {
      cappedSink.emit(stampEvent(IDENTITY, 1, "log", samplePayloadFor("log")));
      // The terminal event cannot be dropped — emit() throws instead.
      expect(() => cappedSink.emit(stampEvent(IDENTITY, 2, "terminal", samplePayloadFor("terminal")))).toThrow(
        OutboxFullError,
      );
    } finally {
      capped.close();
    }
  });

  it("FAILS CLOSED on a full-disk fault — a store append error propagates out of emit()", () => {
    // A fault-injecting store models ENOSPC: append throws. emit() must surface it
    // (fail closed / visible run) rather than swallow it (silent gap).
    const faultStore = {
      append() {
        throw new Error("SQLITE_FULL: database or disk is full");
      },
    } as unknown as DurableEventStore;
    const faultSink = new DurableWorkerEventSink({ store: faultStore, kek: KEK, now: () => 1000 });
    expect(() => faultSink.emit(stampEvent(IDENTITY, 1, "log", samplePayloadFor("log")))).toThrow(/disk is full/);
  });
});
