// MIG-003 — pure, DB-free helpers for sequence-based reconnect/catch-up +
// backpressure on the WebSocket delivery path. Kept separate from the socket
// wiring so the acceptance invariants (dedup, snapshot fallback, backpressure
// bound) are unit-testable without a real socket or Postgres.

/**
 * Default per-socket outbound high-water-mark (bytes). Above this the socket is
 * dropped-to-snapshot rather than growing an unbounded kernel buffer (D5).
 */
export const DEFAULT_BUFFER_HIGH_WATER_MARK = 1_048_576; // 1 MiB

/**
 * Backpressure LOW-water-mark (hysteresis): once a socket has latched at the
 * high-water-mark it stays latched (payload sends skipped, cursor still advances)
 * until its buffer drains back below this, avoiding a `__resume` storm where every
 * dropped event re-triggers a blanket refetch (defect #6). Half the high-water.
 */
export const DEFAULT_BUFFER_LOW_WATER_MARK = DEFAULT_BUFFER_HIGH_WATER_MARK / 2;

/** Default page size for a `?sinceSeq=N` replay pull (bounded, not unbounded). */
export const DEFAULT_REPLAY_LIMIT = 500;

/**
 * The most durable events a per-socket replay latch will buffer while a
 * `?sinceSeq=N` replay is in flight (defect #2). Beyond this the socket falls back
 * to the bounded snapshot refetch instead of buffering unboundedly.
 */
export const DEFAULT_REPLAY_BUFFER_CAP = 1_000;

/**
 * Parse a client-supplied `?sinceSeq=N` cursor. Returns a non-negative integer,
 * or null when absent/invalid (fail-soft → treat as a fresh connect, no replay).
 */
export function parseSinceSeq(rawUrl: string | undefined): number | null {
  if (!rawUrl) return null;
  let search: URLSearchParams;
  try {
    search = new URL(rawUrl, "http://placeholder.invalid").searchParams;
  } catch {
    return null;
  }
  const raw = search.get("sinceSeq");
  if (raw === null || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Per-socket monotonic delivery cursor. Suppresses duplicates so an overlapping
 * replay + live stream (and at-least-once NOTIFY/poll redelivery) delivers each
 * `seq` at most once. Events with no `seq` (the ephemeral local-emit fast path,
 * e.g. presence) are ALWAYS delivered and never advance the cursor.
 */
export class SocketSeqCursor {
  private lastSeq: number;

  constructor(initial = 0) {
    this.lastSeq = initial;
  }

  /** The highest seq delivered so far (the value echoed on reconnect). */
  get value(): number {
    return this.lastSeq;
  }

  /**
   * Decide whether an event carrying `seq` should be delivered. Advances the
   * cursor on accept. `undefined` seq (non-durable/local-emit) → always deliver.
   */
  accept(seq: number | undefined): boolean {
    if (seq === undefined) return true;
    if (!Number.isFinite(seq) || seq <= this.lastSeq) return false;
    this.lastSeq = seq;
    return true;
  }

  /**
   * Move the cursor forward to at least `seq` WITHOUT delivering (used after a
   * replay to suppress overlapping live redelivery). Never regresses, so a live
   * event that landed during the replay read is not re-sent.
   */
  advanceTo(seq: number): void {
    if (Number.isFinite(seq) && seq > this.lastSeq) this.lastSeq = seq;
  }
}

/**
 * D5 backpressure gate: a socket whose already-buffered outbound bytes exceed the
 * high-water-mark is bounded — the caller stops live delivery and signals
 * `resume=snapshot` instead of enqueuing more.
 */
export function shouldDropForBackpressure(
  bufferedAmount: number,
  highWaterMark: number = DEFAULT_BUFFER_HIGH_WATER_MARK,
): boolean {
  return bufferedAmount > highWaterMark;
}

/**
 * D4 bounded snapshot fallback: a reconnect cursor older than the retained window
 * floor cannot be replayed exactly, so the server signals a bounded blanket
 * refetch. `retentionFloor` is the lowest still-retained seq (0 = nothing
 * trimmed, so any sinceSeq is replayable).
 */
export function needsSnapshotFallback(sinceSeq: number, retentionFloor: number): boolean {
  // The client has seen up-to-and-including `sinceSeq`; it needs seq > sinceSeq.
  // If the oldest retained row is already newer than sinceSeq+1, a gap was
  // trimmed and an exact replay is impossible → snapshot.
  return retentionFloor > sinceSeq + 1;
}

/** The server → client control frame that triggers the existing blanket refetch. */
export function buildSnapshotResumeFrame(): string {
  return JSON.stringify({ type: "__resume", payload: { resume: "snapshot" } });
}

/**
 * D4/Invariant 5 cursor authorization: re-run per-event RBAC across a replayed
 * range, in `seq` order, delivering ONLY the events the actor may see. An
 * unauthorized event is OMITTED (hide-don't-403) — the client never infers
 * existence from a gap because a missing `seq` is indistinguishable from an
 * unauthorized one (payloads are hints; the DB is truth). The authorize callback
 * is the SAME live company/thread/hub predicate used for live fan-out, so a
 * replay can never leak more than the live stream would.
 */
export async function filterAuthorizedReplay<T extends { seq: number }>(
  events: readonly T[],
  authorize: (event: T) => boolean | Promise<boolean>,
): Promise<T[]> {
  const authorized: T[] = [];
  for (const event of events) {
    // Sequential (not Promise.all) so ordering + hide-don't-403 semantics are
    // deterministic and a throwing predicate fails closed for that event only.
    let ok = false;
    try {
      ok = await authorize(event);
    } catch {
      ok = false;
    }
    if (ok) authorized.push(event);
  }
  return authorized;
}

/**
 * Defect #3 — the `?sinceSeq=N` replay pulled a FULL page (`limit` rows) but the
 * company's high-water is still beyond the page's last seq, so events past the
 * page were never replayed and the cursor must NOT be advanced past the hole.
 * When true the caller signals a bounded snapshot refetch instead of resuming
 * live at `pageMaxSeq` (which would silently skip `pageMaxSeq+1 .. currentSeq`).
 */
export function replayTruncatedBeyondPage(
  pageLength: number,
  pageMaxSeq: number,
  currentSeq: number,
  limit: number = DEFAULT_REPLAY_LIMIT,
): boolean {
  return pageLength >= limit && pageMaxSeq < currentSeq;
}

/**
 * Defect #2 — order a per-socket replay buffer for post-replay drain. Events that
 * arrived live DURING the async replay window are buffered (never sent inline, so
 * they cannot advance the client cursor past the replayed range and hide the
 * lower-seq replay). After the replay's `advanceTo(pageMaxSeq)`, drain them in
 * ascending seq order, dropping any `seq <= replayMaxSeq` (already covered by the
 * replay itself) — so the client sees `sinceSeq+1 .. pageMaxSeq` (replay) then the
 * strictly-newer buffered tail, with no gap and no duplicate.
 */
export function orderReplayBuffer<T extends { seq?: number }>(
  buffered: readonly T[],
  replayMaxSeq: number,
): T[] {
  return buffered
    .filter((e) => typeof e.seq === "number" && e.seq > replayMaxSeq)
    .sort((a, b) => (a.seq as number) - (b.seq as number));
}

/** The outcome of the per-socket backpressure hysteresis latch (defect #6). */
export interface BackpressureDecision {
  /** The socket's latched state AFTER this event. */
  latched: boolean;
  /** Send exactly one `__resume` control frame now (only on the latching edge). */
  signalResume: boolean;
  /** Deliver this event's payload now (false while latched/congested). */
  deliver: boolean;
}

/**
 * Defect #6 — per-socket backpressure hysteresis. A slow socket latches on the
 * rising edge at the high-water-mark (emit ONE `__resume`, then stop sending
 * payloads), and stays latched — without re-emitting `__resume` on every
 * subsequent event — until its buffer drains below the low-water-mark. The caller
 * still advances the per-socket seq cursor for skipped events (catch-up stays
 * consistent); this only decides the SEND, never the cursor.
 */
export function resolveBackpressure(
  prevLatched: boolean,
  bufferedAmount: number,
  highWaterMark: number = DEFAULT_BUFFER_HIGH_WATER_MARK,
  lowWaterMark: number = DEFAULT_BUFFER_LOW_WATER_MARK,
): BackpressureDecision {
  if (prevLatched) {
    // Stay latched until the buffer recovers below the low-water mark (hysteresis).
    if (bufferedAmount <= lowWaterMark) {
      return { latched: false, signalResume: false, deliver: true };
    }
    return { latched: true, signalResume: false, deliver: false };
  }
  if (shouldDropForBackpressure(bufferedAmount, highWaterMark)) {
    // Rising edge: latch + emit exactly one snapshot-resume hint.
    return { latched: true, signalResume: true, deliver: false };
  }
  return { latched: false, signalResume: false, deliver: true };
}
