import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@armyofagents/shared";
import {
  buildDurableNotifyPayload,
  isDurableEligible,
  parseDurableNotifyPayload,
  publishLiveEvent,
  setLiveEventLogStore,
  subscribeCompanyLiveEvents,
  wasLocallyPublished,
  __resetLocalPublishTrackingForTests,
  type DurableAppendRecord,
  type DurableLiveEvent,
  type LiveEventLogStore,
} from "../services/live-events.js";
import {
  DEFAULT_BUFFER_HIGH_WATER_MARK,
  DEFAULT_BUFFER_LOW_WATER_MARK,
  SocketSeqCursor,
  filterAuthorizedReplay,
  needsSnapshotFallback,
  orderReplayBuffer,
  parseSinceSeq,
  replayTruncatedBeyondPage,
  resolveBackpressure,
  shouldDropForBackpressure,
} from "../realtime/live-event-catchup.js";
import { createBrokerDrainer } from "../services/live-event-broker-listener.js";

// ── An in-memory durable-log store that faithfully simulates the SQL contract
// (contiguous per-company seq, eventId idempotency, since ordering, retention
// floor) so the broker + catch-up invariants are provable without Postgres. The
// real SQL runs on the Linux CI DB lane.
class InMemoryLiveEventLogStore implements LiveEventLogStore {
  private seqByCompany = new Map<string, number>();
  private rows: DurableLiveEvent[] = [];
  private byEvent = new Map<string, number>();
  private floorByCompany = new Map<string, number>();
  public notifications: Array<{ companyId: string; seq: number }> = [];

  async append(record: DurableAppendRecord): Promise<number | null> {
    const existing = this.byEvent.get(record.eventId);
    if (existing !== undefined) return existing; // idempotent redelivery
    const next = (this.seqByCompany.get(record.companyId) ?? 0) + 1;
    this.seqByCompany.set(record.companyId, next);
    this.byEvent.set(record.eventId, next);
    this.rows.push({
      id: next,
      companyId: record.companyId,
      type: record.type,
      createdAt: new Date().toISOString(),
      payload: record.payload,
      seq: next,
      eventId: record.eventId,
    });
    return next;
  }

  async notify(companyId: string, seq: number): Promise<void> {
    this.notifications.push({ companyId, seq });
  }

  async since(companyId: string, sinceSeq: number, limit = 500): Promise<DurableLiveEvent[]> {
    return this.rows
      .filter((r) => r.companyId === companyId && r.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  async retentionFloor(companyId: string): Promise<number> {
    return this.floorByCompany.get(companyId) ?? 0;
  }

  async currentSeq(companyId: string): Promise<number> {
    return this.seqByCompany.get(companyId) ?? 0;
  }

  setFloor(companyId: string, floor: number): void {
    this.floorByCompany.set(companyId, floor);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  setLiveEventLogStore(null);
  __resetLocalPublishTrackingForTests();
  vi.restoreAllMocks();
});

describe("MIG-003 durable eligibility (D1/D6)", () => {
  it("excludes presence and admits every invalidation-bearing family", () => {
    expect(isDurableEligible("thread.presence")).toBe(false);
    expect(isDurableEligible("hub.item.changed")).toBe(true);
    expect(isDurableEligible("issue.status_changed")).toBe(true);
    expect(isDurableEligible("thread.entry.created")).toBe(true);
    expect(isDurableEligible("memory.item.created")).toBe(true);
    expect(isDurableEligible("heartbeat.run.status")).toBe(true);
  });
});

describe("MIG-003 data-free NOTIFY payload (D7 redaction)", () => {
  it("carries only companyId + seq — never the event payload", () => {
    const raw = buildDurableNotifyPayload("co-1", 42);
    expect(JSON.parse(raw)).toEqual({ companyId: "co-1", seq: 42 });
    expect(raw).not.toContain("payload");
    expect(parseDurableNotifyPayload(raw)).toEqual({ companyId: "co-1", seq: 42 });
  });

  it("fails soft on a malformed wake", () => {
    expect(parseDurableNotifyPayload("not json")).toBeNull();
    expect(parseDurableNotifyPayload(JSON.stringify({ companyId: "x" }))).toBeNull();
    expect(parseDurableNotifyPayload(JSON.stringify({ seq: 1 }))).toBeNull();
  });
});

describe("MIG-003 broker at the publish chokepoint (D2)", () => {
  it("appends a durable-eligible event and NOTIFYs a data-free wake, plus local emit", async () => {
    const store = new InMemoryLiveEventLogStore();
    setLiveEventLogStore(store);
    const received: LiveEvent[] = [];
    const off = subscribeCompanyLiveEvents("co-1", (e) => received.push(e));

    const event = publishLiveEvent({
      companyId: "co-1",
      type: "hub.item.changed",
      payload: { itemId: "i-1" },
    });
    // Local emit is synchronous (fast path) and carries no seq.
    expect(received).toHaveLength(1);
    expect(received[0]!.seq).toBeUndefined();
    expect(event.payload).toEqual({ itemId: "i-1" });

    await flush();
    const rows = await store.since("co-1", 0);
    expect(rows.map((r) => ({ seq: r.seq, type: r.type, payload: r.payload }))).toEqual([
      { seq: 1, type: "hub.item.changed", payload: { itemId: "i-1" } },
    ]);
    expect(store.notifications).toEqual([{ companyId: "co-1", seq: 1 }]);
    off();
  });

  it("does NOT log presence, but still local-emits it (ephemeral, per-replica)", async () => {
    const store = new InMemoryLiveEventLogStore();
    setLiveEventLogStore(store);
    const received: LiveEvent[] = [];
    const off = subscribeCompanyLiveEvents("co-1", (e) => received.push(e));

    publishLiveEvent({ companyId: "co-1", type: "thread.presence", payload: { threadId: "t" } });
    await flush();

    expect(received).toHaveLength(1);
    expect(await store.since("co-1", 0)).toHaveLength(0);
    expect(store.notifications).toHaveLength(0);
    off();
  });

  it("assigns contiguous per-company seq, independent across companies", async () => {
    const store = new InMemoryLiveEventLogStore();
    setLiveEventLogStore(store);
    publishLiveEvent({ companyId: "co-1", type: "issue.status_changed", payload: {} });
    publishLiveEvent({ companyId: "co-2", type: "issue.status_changed", payload: {} });
    publishLiveEvent({ companyId: "co-1", type: "issue.status_changed", payload: {} });
    await flush();
    expect((await store.since("co-1", 0)).map((r) => r.seq)).toEqual([1, 2]);
    expect((await store.since("co-2", 0)).map((r) => r.seq)).toEqual([1]);
  });

  it("is best-effort: a failing append never throws into the caller and local emit still fires", async () => {
    const store = new InMemoryLiveEventLogStore();
    vi.spyOn(store, "append").mockRejectedValue(new Error("db down"));
    setLiveEventLogStore(store);
    const received: LiveEvent[] = [];
    const off = subscribeCompanyLiveEvents("co-1", (e) => received.push(e));

    expect(() =>
      publishLiveEvent({ companyId: "co-1", type: "hub.item.changed", payload: {} }),
    ).not.toThrow();
    await flush();
    expect(received).toHaveLength(1); // local emit survived the broker failure
    expect(store.notifications).toHaveLength(0); // no NOTIFY without a committed seq
    off();
  });

  it("idempotent append on the same eventId returns the original seq and burns no extra row", async () => {
    const store = new InMemoryLiveEventLogStore();
    const record: DurableAppendRecord = {
      companyId: "co-1",
      type: "hub.item.changed",
      payload: {},
      eventId: "fixed-uuid",
    };
    expect(await store.append(record)).toBe(1);
    expect(await store.append(record)).toBe(1);
    expect(await store.since("co-1", 0)).toHaveLength(1);
  });
});

describe("MIG-003 sequence catch-up + duplicate suppression (D3/D4)", () => {
  it("replays exactly seq > sinceSeq in order", async () => {
    const store = new InMemoryLiveEventLogStore();
    for (let i = 0; i < 5; i += 1) {
      await store.append({ companyId: "co-1", type: "issue.status_changed", payload: { i }, eventId: `e${i}` });
    }
    const tail = await store.since("co-1", 2);
    expect(tail.map((r) => r.seq)).toEqual([3, 4, 5]);
  });

  it("SocketSeqCursor delivers each seq once across overlapping replay + live", () => {
    const cursor = new SocketSeqCursor(0);
    // replay 1..3
    expect([1, 2, 3].map((s) => cursor.accept(s))).toEqual([true, true, true]);
    // live redelivery of 2,3 (overlap) is suppressed; 4 is new
    expect(cursor.accept(2)).toBe(false);
    expect(cursor.accept(3)).toBe(false);
    expect(cursor.accept(4)).toBe(true);
    expect(cursor.value).toBe(4);
  });

  it("SocketSeqCursor always delivers seq-less (ephemeral) events without advancing", () => {
    const cursor = new SocketSeqCursor(7);
    expect(cursor.accept(undefined)).toBe(true);
    expect(cursor.value).toBe(7);
  });
});

describe("MIG-003 cursor authorization — hide-don't-403 (Invariant 5)", () => {
  it("omits unauthorized events from the replayed range, preserving order", async () => {
    const events = [1, 2, 3, 4].map((seq) => ({ seq, threadId: seq % 2 === 0 ? "denied" : "ok" }));
    const authorized = await filterAuthorizedReplay(events, (e) => e.threadId === "ok");
    expect(authorized.map((e) => e.seq)).toEqual([1, 3]);
  });

  it("fails closed for an event whose authorize check throws", async () => {
    const events = [{ seq: 1 }, { seq: 2 }];
    const authorized = await filterAuthorizedReplay(events, (e) => {
      if (e.seq === 2) throw new Error("boom");
      return true;
    });
    expect(authorized.map((e) => e.seq)).toEqual([1]);
  });
});

describe("MIG-003 bounded snapshot fallback (D4) + backpressure (D5)", () => {
  it("signals snapshot only when the cursor is older than the retained floor", () => {
    // floor 0 (nothing trimmed) → any cursor is replayable
    expect(needsSnapshotFallback(0, 0)).toBe(false);
    expect(needsSnapshotFallback(50, 0)).toBe(false);
    // client saw up to seq 5; oldest retained is 6 → seq 6.. replayable exactly
    expect(needsSnapshotFallback(5, 6)).toBe(false);
    // client saw up to seq 5 but oldest retained is 10 → 6..9 were trimmed → snapshot
    expect(needsSnapshotFallback(5, 10)).toBe(true);
  });

  it("bounds a slow socket at the high-water-mark", () => {
    expect(shouldDropForBackpressure(DEFAULT_BUFFER_HIGH_WATER_MARK - 1)).toBe(false);
    expect(shouldDropForBackpressure(DEFAULT_BUFFER_HIGH_WATER_MARK + 1)).toBe(true);
    expect(shouldDropForBackpressure(50, 10)).toBe(true);
  });
});

describe("MIG-003 per-replica drainer (D3 / broker-loss Invariant 2)", () => {
  it("on first sight fans only NEW events (never full history) — no fresh-socket flood", async () => {
    const store = new InMemoryLiveEventLogStore();
    // Pre-existing history the replica must NOT replay to a freshly-connected socket.
    for (let i = 0; i < 4; i += 1) {
      await store.append({ companyId: "co-1", type: "issue.status_changed", payload: {}, eventId: `h${i}` });
    }
    const fanned: number[] = [];
    const drainer = createBrokerDrainer({ store, fanout: (_c, e) => fanned.push(e.seq) });

    // A new event lands (seq 5) → NOTIFY triggers a drain anchored just below it.
    await store.append({ companyId: "co-1", type: "issue.status_changed", payload: {}, eventId: "new" });
    await drainer.drain("co-1", 5);
    expect(fanned).toEqual([5]); // seq 1..4 history NOT re-fanned
  });

  it("safety-poll delivers the tail when a NOTIFY is dropped (delay, not loss)", async () => {
    const store = new InMemoryLiveEventLogStore();
    const fanned: number[] = [];
    const drainer = createBrokerDrainer({ store, fanout: (_c, e) => fanned.push(e.seq) });

    // Anchor the drainer (first NOTIFY seen).
    await store.append({ companyId: "co-1", type: "issue.status_changed", payload: {}, eventId: "a" });
    await drainer.drain("co-1", 1);
    expect(fanned).toEqual([1]);

    // Two more events land but BOTH their NOTIFYs are dropped.
    await store.append({ companyId: "co-1", type: "issue.status_changed", payload: {}, eventId: "b" });
    await store.append({ companyId: "co-1", type: "issue.status_changed", payload: {}, eventId: "c" });
    // The safety poll (no triggerSeq) pulls the missed tail.
    await drainer.drain("co-1");
    expect(fanned).toEqual([1, 2, 3]);

    // Idempotent: a redundant poll fans nothing new (high-water advanced).
    await drainer.drain("co-1");
    expect(fanned).toEqual([1, 2, 3]);
  });
});

describe("MIG-003 sinceSeq parsing (D4)", () => {
  it("parses a valid non-negative cursor and rejects junk", () => {
    expect(parseSinceSeq("/ws?sinceSeq=42")).toBe(42);
    expect(parseSinceSeq("/ws?sinceSeq=0")).toBe(0);
    expect(parseSinceSeq("/ws")).toBeNull();
    expect(parseSinceSeq("/ws?sinceSeq=-1")).toBeNull();
    expect(parseSinceSeq("/ws?sinceSeq=abc")).toBeNull();
    expect(parseSinceSeq(undefined)).toBeNull();
  });
});

// ── Defect #1 (HIGH): robust model — emitter ALWAYS delivers, even when a later
// append rejects. Under the old health-flag design the emitter suppressed the
// same-replica copy once the flag flipped true, so a subsequent append failure
// SILENTLY DROPPED the event on every replica. The robust model has no flag: the
// synchronous local emit already delivered it before the async append ran.
describe("MIG-003 robust pipeline — suppress-then-append-fail never drops (defect #1)", () => {
  it("delivers to the local subscriber even when append succeeds once then throws", async () => {
    const store = new InMemoryLiveEventLogStore();
    let calls = 0;
    vi.spyOn(store, "append").mockImplementation(async (record: DurableAppendRecord) => {
      calls += 1;
      if (calls === 1) return calls; // first append "proves healthy" (old flag→true)
      throw new Error("pool exhausted"); // the second append rejects
    });
    setLiveEventLogStore(store);
    const received: LiveEvent[] = [];
    const off = subscribeCompanyLiveEvents("co-1", (e) => received.push(e));

    publishLiveEvent({ companyId: "co-1", type: "hub.item.changed", payload: { n: 1 } });
    await flush();
    // Event A (second publish) — the append rejects, but the emitter still delivers.
    publishLiveEvent({ companyId: "co-1", type: "hub.item.changed", payload: { n: 2 } });
    await flush();

    expect(received).toHaveLength(2);
    expect(received.map((e) => e.payload.n)).toEqual([1, 2]);
    off();
  });

  it("records every locally-published durable eventId (drainer same-replica dedup)", async () => {
    const store = new InMemoryLiveEventLogStore();
    setLiveEventLogStore(store);
    publishLiveEvent({ companyId: "co-1", type: "issue.status_changed", payload: {} });
    await flush();
    const [row] = await store.since("co-1", 0);
    expect(row).toBeDefined();
    expect(row!.eventId).toBeTruthy();
    expect(wasLocallyPublished(row!.eventId)).toBe(true);
    expect(wasLocallyPublished("some-peer-replica-event-id")).toBe(false);
    // Presence is not durable → no eventId is tracked for it.
    publishLiveEvent({ companyId: "co-1", type: "thread.presence", payload: { threadId: "t" } });
    await flush();
    expect(store.notifications).toHaveLength(1);
  });
});

// ── Defect #1/robust: the drainer suppresses same-replica-origin events (already
// emitted seq-less) but delivers PEER-replica events — no same-replica double, no
// health-flag fragility, cross-replica delivery intact.
describe("MIG-003 drainer same-replica suppression (robust model)", () => {
  it("skips locally-published eventIds and fans peer-replica events", async () => {
    const store = new InMemoryLiveEventLogStore();
    const local = new Set<string>(["local-a", "local-b"]);
    const fanned: string[] = [];
    const drainer = createBrokerDrainer({
      store,
      fanout: (_c, e) => fanned.push(e.eventId ?? "?"),
      isLocallyPublished: (id) => id !== undefined && local.has(id),
    });
    await store.append({ companyId: "co-1", type: "issue.status_changed", payload: {}, eventId: "local-a" });
    await store.append({ companyId: "co-1", type: "issue.status_changed", payload: {}, eventId: "peer-x" });
    await store.append({ companyId: "co-1", type: "issue.status_changed", payload: {}, eventId: "local-b" });
    await store.append({ companyId: "co-1", type: "issue.status_changed", payload: {}, eventId: "peer-y" });

    await drainer.drain("co-1", 1); // low anchor so the whole tail is considered
    // Only the peer events are fanned; local-origin events were already emitted.
    expect(fanned).toEqual(["peer-x", "peer-y"]);
  });
});

// ── Defect #5 (MEDIUM): a poll-driven first sight must NOT anchor at currentSeq
// (which skips an already-appended tail whose NOTIFY was lost under LISTEN loss).
// It anchors at the retention floor so the safety poll truly recovers the tail.
describe("MIG-003 poll first-sight anchor (defect #5)", () => {
  it("delivers the appended tail on a first-sight POLL (no triggerSeq), not skips it", async () => {
    const store = new InMemoryLiveEventLogStore();
    // Events landed while this replica's LISTEN was down — their NOTIFYs are lost.
    for (let i = 0; i < 3; i += 1) {
      await store.append({ companyId: "co-1", type: "issue.status_changed", payload: {}, eventId: `x${i}` });
    }
    const fanned: number[] = [];
    const drainer = createBrokerDrainer({ store, fanout: (_c, e) => fanned.push(e.seq) });

    // First sight is a POLL (no triggerSeq). The old code anchored at currentSeq(=3)
    // → since(3) → nothing → the tail is lost. The fix anchors at retentionFloor.
    await drainer.drain("co-1");
    expect(fanned).toEqual([1, 2, 3]);

    // Idempotent: a redundant poll fans nothing new.
    await drainer.drain("co-1");
    expect(fanned).toEqual([1, 2, 3]);
  });
});

// ── Defect #3 (HIGH): a full replay page whose last seq is behind the company
// high-water means events past the page were never replayed — signal snapshot.
describe("MIG-003 replay truncation beyond a full page (defect #3)", () => {
  it("flags truncation only when the page is full AND more remains", () => {
    // 500-row page, high-water 1200 → 700 events past the page → snapshot.
    expect(replayTruncatedBeyondPage(500, 500, 1200, 500)).toBe(true);
    // Full page but it IS the whole tail (page max == current) → exact replay.
    expect(replayTruncatedBeyondPage(500, 1200, 1200, 500)).toBe(false);
    // Short page → exact replay, never truncated.
    expect(replayTruncatedBeyondPage(120, 120, 900, 500)).toBe(false);
    // Empty page → not truncated.
    expect(replayTruncatedBeyondPage(0, 0, 0, 500)).toBe(false);
  });
});

// ── Defect #2 (HIGH): live events buffered during replay drain in ascending seq,
// dropping any already covered by the replayed range (no gap, no duplicate).
describe("MIG-003 replay buffer ordering (defect #2)", () => {
  it("drains buffered live events after the replay range, ascending, deduping overlap", () => {
    // Replay covered up to seq 99; a live seq-100 arrived during the window, plus
    // an out-of-order 101 and a redundant 98 (already in the replay).
    const buffered = [
      { seq: 100, payload: {} },
      { seq: 98, payload: {} }, // <= replayMax → already replayed, drop
      { seq: 101, payload: {} },
    ];
    const ordered = orderReplayBuffer(buffered, 99);
    expect(ordered.map((e) => e.seq)).toEqual([100, 101]);
  });

  it("keeps seq-less (ephemeral) events out of the durable replay drain", () => {
    const ordered = orderReplayBuffer([{ seq: undefined }, { seq: 5 }], 3);
    expect(ordered.map((e) => e.seq)).toEqual([5]);
  });
});

// ── Defect #6 (MEDIUM): backpressure hysteresis latch — ONE __resume on the
// rising edge, then skip payloads until the buffer recovers (no __resume storm).
describe("MIG-003 backpressure hysteresis (defect #6)", () => {
  it("latches once above high-water and resumes only below low-water", () => {
    // Below high-water, unlatched → deliver, no resume.
    let d = resolveBackpressure(false, DEFAULT_BUFFER_HIGH_WATER_MARK - 1);
    expect(d).toEqual({ latched: false, signalResume: false, deliver: true });

    // Rising edge above high-water → latch + ONE resume, skip delivery.
    d = resolveBackpressure(false, DEFAULT_BUFFER_HIGH_WATER_MARK + 1);
    expect(d).toEqual({ latched: true, signalResume: true, deliver: false });

    // Still congested (above low-water) → stay latched, NO further resume, skip.
    d = resolveBackpressure(true, DEFAULT_BUFFER_LOW_WATER_MARK + 1);
    expect(d).toEqual({ latched: true, signalResume: false, deliver: false });

    // Recovered below low-water → unlatch + resume delivery, no resume frame.
    d = resolveBackpressure(true, DEFAULT_BUFFER_LOW_WATER_MARK);
    expect(d).toEqual({ latched: false, signalResume: false, deliver: true });
  });
});
