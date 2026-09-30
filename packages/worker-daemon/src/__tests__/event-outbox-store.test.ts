import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encryptEventRow } from "../events/event-row-codec.js";
import {
  OutboxFullError,
  SeqCollisionError,
  SqliteEventOutboxStore,
  deriveStreamKey,
  openEventOutboxStore,
  type EventStreamIdentity,
} from "../events/event-outbox-store.js";

const KEK = Buffer.alloc(32, 3);

const IDENTITY: EventStreamIdentity = {
  organizationId: "org-1",
  companyId: "company-1",
  workerId: "worker-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  fenceToken: "fence-1",
};
const STREAM_KEY = deriveStreamKey(IDENTITY);

let dir: string;
let dbPath: string;
let store: SqliteEventOutboxStore;

function appendEvent(seq: number, overrides: Partial<{ eventId: string; payload: string; eventType: string }> = {}): void {
  const payload = overrides.payload ?? JSON.stringify({ seq, hello: "world" });
  store.append({
    streamKey: STREAM_KEY,
    identity: IDENTITY,
    seq,
    eventId: overrides.eventId ?? `evt-${seq}`,
    eventDigest: "a".repeat(64),
    eventType: overrides.eventType ?? "log",
    encrypted: encryptEventRow(Buffer.from(payload, "utf8"), KEK),
    nowMs: 1000 + seq,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aoa-outbox-"));
  dbPath = join(dir, "events.db");
  store = await openEventOutboxStore({ path: dbPath, now: () => 1000 });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("event-outbox-store — durable node:sqlite persistence + D2 backstop", () => {
  it("appends a pending row that round-trips ciphertext components verbatim", () => {
    const enc = encryptEventRow(Buffer.from(JSON.stringify({ seq: 1 }), "utf8"), KEK);
    store.append({
      streamKey: STREAM_KEY,
      identity: IDENTITY,
      seq: 1,
      eventId: "evt-1",
      eventDigest: "b".repeat(64),
      eventType: "attempt_started",
      encrypted: enc,
      nowMs: 1000,
    });
    const row = store.getRow(STREAM_KEY, 1);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    expect(row!.seq).toBe(1);
    expect(row!.eventId).toBe("evt-1");
    expect(row!.eventDigest).toBe("b".repeat(64));
    expect(row!.eventType).toBe("attempt_started");
    // BLOB columns come back byte-identical.
    expect(Buffer.compare(row!.encrypted.ciphertext, enc.ciphertext)).toBe(0);
    expect(Buffer.compare(row!.encrypted.iv, enc.iv)).toBe(0);
    expect(Buffer.compare(row!.encrypted.authTag, enc.authTag)).toBe(0);
    expect(Buffer.compare(row!.encrypted.salt, enc.salt)).toBe(0);
  });

  it("ENFORCES UNIQUE(stream_key, seq) — a producer seq-collision fails CLOSED (D2)", () => {
    appendEvent(1, { eventId: "from-supervisor" });
    // A second producer (fence-close proxy) mints the SAME seq for the same stream.
    expect(() => appendEvent(1, { eventId: "from-fence-proxy" })).toThrow(SeqCollisionError);
    // The collision did NOT corrupt or overwrite the first row.
    const row = store.getRow(STREAM_KEY, 1);
    expect(row!.eventId).toBe("from-supervisor");
    expect(store.allRows(STREAM_KEY)).toHaveLength(1);
  });

  it("peeks CONTIGUOUS pending rows from watermark+1 and marks the actual batch uploading", () => {
    appendEvent(1);
    appendEvent(2);
    appendEvent(3);
    const peeked = store.peekContiguous(STREAM_KEY, 500, 2000);
    expect(peeked.map((r) => r.seq)).toEqual([1, 2, 3]);
    store.markUploading(STREAM_KEY, [1, 2]);
    expect(store.getRow(STREAM_KEY, 1)!.status).toBe("uploading");
    expect(store.getRow(STREAM_KEY, 3)!.status).toBe("pending");
  });

  it("advanceCursor prunes rows <= watermark and reverts the un-accepted remainder to pending", () => {
    appendEvent(1);
    appendEvent(2);
    appendEvent(3);
    store.markUploading(STREAM_KEY, [1, 2, 3]);
    // Server accepted only through seq 2 (partial).
    store.advanceCursor(STREAM_KEY, 2);
    expect(store.getStream(STREAM_KEY)!.acceptedThroughSeq).toBe(2);
    expect(store.getRow(STREAM_KEY, 1)).toBeNull();
    expect(store.getRow(STREAM_KEY, 2)).toBeNull();
    const remainder = store.getRow(STREAM_KEY, 3);
    expect(remainder!.status).toBe("pending");
    expect(remainder!.nextRetryAt).toBeNull();
    // Next peek resumes from watermark+1 = 3.
    expect(store.peekContiguous(STREAM_KEY, 500, 3000).map((r) => r.seq)).toEqual([3]);
  });

  it("recoverStalledUploading reverts uploading -> pending WITHOUT bumping attempts (crash != logic failure)", () => {
    appendEvent(1);
    store.markUploading(STREAM_KEY, [1]);
    const before = store.getRow(STREAM_KEY, 1)!;
    expect(before.status).toBe("uploading");
    const recovered = store.recoverStalledUploading();
    expect(recovered).toBe(1);
    const after = store.getRow(STREAM_KEY, 1)!;
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(before.attempts); // NOT bumped
  });

  it("requeue bumps attempts + sets next_retry_at; the head is gated until eligible", () => {
    appendEvent(1);
    store.markUploading(STREAM_KEY, [1]);
    store.requeue(STREAM_KEY, 5000, true);
    const row = store.getRow(STREAM_KEY, 1)!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.nextRetryAt).toBe(5000);
    // Not eligible yet (now < next_retry_at) → empty peek.
    expect(store.peekContiguous(STREAM_KEY, 500, 4000)).toEqual([]);
    // Eligible now.
    expect(store.peekContiguous(STREAM_KEY, 500, 5000).map((r) => r.seq)).toEqual([1]);
  });

  it("quarantineEvent isolates a poison event by id and stopStream converges the stream", () => {
    appendEvent(1);
    appendEvent(2);
    store.quarantineEvent(STREAM_KEY, "evt-2");
    expect(store.getRow(STREAM_KEY, 2)!.status).toBe("quarantined");
    // A quarantined row is no longer peekable.
    expect(store.peekContiguous(STREAM_KEY, 500, 9000).map((r) => r.seq)).toEqual([1]);
    store.stopStream(STREAM_KEY, "hash_mismatch");
    expect(store.getStream(STREAM_KEY)!.stopped).toBe(true);
    expect(store.getStream(STREAM_KEY)!.stopReason).toBe("hash_mismatch");
    // A stopped stream is excluded from the active-stream drain set.
    expect(store.listActiveStreams().map((s) => s.streamKey)).not.toContain(STREAM_KEY);
  });

  it("enforces the backpressure cap — append FAILS CLOSED at the pending-row limit (D4, never drops)", async () => {
    const capped = await openEventOutboxStore({
      path: join(dir, "capped.db"),
      now: () => 1000,
      limits: { maxPendingRows: 2, maxTotalBytes: 1_000_000_000 },
    });
    try {
      const enc = () => encryptEventRow(Buffer.from("x"), KEK);
      const base = { streamKey: STREAM_KEY, identity: IDENTITY, eventDigest: "a".repeat(64), eventType: "log", nowMs: 1000 };
      capped.append({ ...base, seq: 1, eventId: "e1", encrypted: enc() });
      capped.append({ ...base, seq: 2, eventId: "e2", encrypted: enc() });
      expect(() => capped.append({ ...base, seq: 3, eventId: "e3", encrypted: enc() })).toThrow(OutboxFullError);
      // The cap fails CLOSED — it never silently drops the 3rd event.
      expect(capped.countPending()).toBe(2);
    } finally {
      capped.close();
    }
  });

  it("creates the DB file with 0600 custody on POSIX (fail-closed key/DB perms)", () => {
    if (process.platform === "win32") return; // Windows ACL default enforces this; chmod bits are not representable.
    const mode = statSync(dbPath).mode & 0o777;
    expect(mode & 0o077).toBe(0); // no group/other bits
  });
});
