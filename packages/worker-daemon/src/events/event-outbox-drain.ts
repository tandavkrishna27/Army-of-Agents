/**
 * Durable event-outbox drain loop (WRK-006, slices 4–5).
 *
 * A non-blocking tick loop (mirroring `embeddings-worker` / `mention-outbox-worker`:
 * deferred first tick, per-tick errors swallowed, `.unref()` timer, cooperative
 * `stop()`) that, per active stream, uploads pending rows IN STRICT `seq` ORDER
 * from `acceptedThroughSeq + 1`, advances the durable cursor on ACK, and prunes.
 *
 * Ordering + fail-closed rules (design §5/§6):
 *  - Rows drain in contiguous `seq` order (no out-of-order SKIP LOCKED). A batch is
 *    ≤500 events / ≤ a byte ceiling under the 4 MiB request cap.
 *  - `accepted` advances the durable `acceptedThroughSeq` + prunes ≤ watermark.
 *  - `gap` resends from `expectedNextSeq`; `hash_mismatch` quarantines the named
 *    event + stops the stream; `stale_fence`/`target_revoked`/`terminal` stop it.
 *  - A transient failure re-queues with a persisted capped full-jitter backoff and
 *    reuses the SAME idempotency key (D6); a fresh key is minted per real flush.
 *  - `401` recovers the session under a PER-STREAM cap (WRK-005's cross-lease
 *    lesson) and retries the same key; the cap stops the stream.
 *  - A row that fails authenticated decryption is quarantined (poison-row backstop);
 *    the contiguous decryptable prefix still uploads, then the stream stops at the
 *    poison — the drain loop + other streams keep progressing (non-fatal).
 *  - Any unclassified throw is caught per-stream (the loop never crashes).
 *
 * Runtime imports: relative modules + node:crypto — the E4-D01 boundary.
 */

import { randomUUID } from "node:crypto";

import type { WorkerEventV1 } from "@armyofagents/worker-protocol";

import type { DeviceKey } from "../identity/device-key.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import type { Logger } from "../logging/logger.js";
import { INITIAL_BACKOFF_STATE, nextBackoff, type BackoffConfig, type BackoffState } from "../poll/backoff.js";
import { SessionTerminalError, type OperationRandomness, type SessionProvider } from "../poll/poll-loop.js";
import type { ControlPlaneClient } from "../transport/client.js";
import { RowDecryptError, decryptEventRow } from "./event-row-codec.js";
import type { DurableEventStore, StoredEventRow, StreamCursor } from "./event-outbox-store.js";
import { uploadEventBatchOnce } from "./event-upload.js";

const MiB = 1024 * 1024;

export interface EventOutboxDrainTuning {
  /** Max events per batch (frozen ceiling is 500). */
  readonly maxBatchEvents?: number;
  /** Max summed event bytes per batch — kept under the 4 MiB request cap so the
   * envelope + identity repetition still fit. */
  readonly maxBatchBytes?: number;
  /** Per-stream transient-retry backoff. */
  readonly backoff?: BackoffConfig;
  /** Safety bound on flushes per stream per tick (prevents a hot loop). */
  readonly maxFlushesPerStreamPerTick?: number;
  /** Interval between ticks once idle. */
  readonly intervalMs?: number;
  /** Deferred first-tick delay (non-blocking startup). */
  readonly initialDelayMs?: number;
}

const DEFAULT_TUNING: Required<Omit<EventOutboxDrainTuning, "backoff">> & { backoff: BackoffConfig } = {
  maxBatchEvents: 500,
  maxBatchBytes: Math.floor(3.75 * MiB),
  backoff: { baseMs: 1_000, maxMs: 30_000, jitter: 0.5 },
  maxFlushesPerStreamPerTick: 1_000,
  intervalMs: 2_000,
  initialDelayMs: 1_500,
};

export interface EventOutboxDrainDeps {
  readonly store: DurableEventStore;
  readonly client: ControlPlaneClient;
  readonly session: SessionProvider;
  readonly key: DeviceKey;
  /** The KEK used to decrypt rows before upload. */
  readonly kek: Buffer;
  readonly now?: () => number;
  readonly tuning?: EventOutboxDrainTuning;
  readonly logger?: Logger;
  readonly randomness?: OperationRandomness;
  readonly maxConsecutiveRecoveries?: number;
  /** Injectable jitter source (tests pin the backoff). */
  readonly rng?: () => number;
}

export interface DrainTickSummary {
  readonly streamsProcessed: number;
  readonly batchesUploaded: number;
  readonly eventsAccepted: number;
  readonly streamsStopped: number;
}

export interface EventOutboxDrain {
  /** Boot recovery: revert `uploading` → `pending` (no attempts bump). Returns count. */
  recover(): number;
  /** Start the background tick loop (deferred first tick). */
  start(): void;
  /** Stop the loop (idempotent, cooperative). */
  stop(): void;
  /** Run ONE full drain pass over all active streams (deterministic; used by the
   * loop, the shutdown final-flush, and tests). */
  drainOnce(): Promise<DrainTickSummary>;
  /** Shutdown final-flush attempt (a single best-effort drain pass). */
  flush(): Promise<void>;
}

/** Per-stream in-memory drain state (NOT persisted — the seq cursor is the durable
 * dedup, so a restart safely mints fresh keys, D6). */
interface StreamDrainState {
  recoveries: number;
  flushKey: string | null;
  flushFromSeq: number | null;
  backoff: BackoffState;
}

export function createEventOutboxDrain(deps: EventOutboxDrainDeps): EventOutboxDrain {
  const store = deps.store;
  const now = deps.now ?? (() => Date.now());
  const tuning = { ...DEFAULT_TUNING, ...deps.tuning, backoff: deps.tuning?.backoff ?? DEFAULT_TUNING.backoff };
  const maxRecoveries = deps.maxConsecutiveRecoveries ?? 3;
  const rng = deps.rng ?? Math.random;
  const newIdempotencyKey = deps.randomness?.newIdempotencyKey ?? randomUUID;

  const states = new Map<string, StreamDrainState>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function stateFor(streamKey: string): StreamDrainState {
    let st = states.get(streamKey);
    if (st === undefined) {
      st = { recoveries: 0, flushKey: null, flushFromSeq: null, backoff: INITIAL_BACKOFF_STATE };
      states.set(streamKey, st);
    }
    return st;
  }

  /** Recover the session after a 401. Returns `ok` (retry same key), `capped`
   * (recovery bound tripped), or `terminal` (re-enrollment required). Per-stream. */
  async function tryRecover(st: StreamDrainState): Promise<"ok" | "capped" | "terminal"> {
    try {
      await deps.session.recover();
    } catch (err) {
      if (err instanceof SessionTerminalError) return "terminal";
      return "terminal";
    }
    st.recoveries += 1;
    if (st.recoveries >= maxRecoveries) return "capped";
    return "ok";
  }

  interface AssembledBatch {
    readonly events: WorkerEventV1[];
    readonly seqs: number[];
    readonly poisonAfter: boolean;
  }

  /** Decrypt the contiguous prefix into a batch, honoring the byte cap and
   * quarantining the FIRST undecryptable row (poison-row backstop). */
  function assembleBatch(rows: readonly StoredEventRow[]): AssembledBatch {
    const events: WorkerEventV1[] = [];
    const seqs: number[] = [];
    let bytes = 0;
    let poisonAfter = false;
    for (const row of rows) {
      let plaintext: Buffer;
      try {
        plaintext = decryptEventRow(row.encrypted, deps.kek);
      } catch (err) {
        if (err instanceof RowDecryptError) {
          store.quarantineRow(row.id);
          poisonAfter = true;
          break;
        }
        throw err;
      }
      if (events.length > 0 && bytes + plaintext.byteLength > tuning.maxBatchBytes) break;
      events.push(JSON.parse(plaintext.toString("utf8")) as WorkerEventV1);
      seqs.push(row.seq);
      bytes += plaintext.byteLength;
    }
    return { events, seqs, poisonAfter };
  }

  async function drainStream(
    stream: StreamCursor,
    summary: { batches: number; accepted: number; stopped: number },
    final: boolean,
  ): Promise<void> {
    const st = stateFor(stream.streamKey);
    for (let flush = 0; flush < tuning.maxFlushesPerStreamPerTick; flush += 1) {
      if (stopped && !final) return;
      const nowMs = now();
      const peeked = store.peekContiguous(stream.streamKey, tuning.maxBatchEvents, nowMs);
      if (peeked.length === 0) {
        // A PERMANENT contiguity gap: the next expected seq is absent because a poison
        // row was quarantined mid-batch, yet later pending rows remain. peekContiguous
        // can never cross it, so those events would otherwise strand as a silent,
        // signal-less zombie (stopped=0, re-listed every tick, no stop_reason). Fail
        // closed: stop the stream at the poison (corrupt_row). This is DURABLE-STATE
        // detection (head seq vs the current cursor), so it fires no matter how the
        // prefix upload resolved (accepted / gap / transient / 401-recovered) — the
        // in-memory `poisonAfter` flag is lost across a requeue, this is not. A merely
        // backed-off head is `head === cursor+1` (not a gap) → we just wait.
        const cursor = store.getStream(stream.streamKey);
        if (cursor !== null && !cursor.stopped) {
          const head = store.firstUnackedSeq(stream.streamKey);
          if (head !== null && head > cursor.acceptedThroughSeq + 1) {
            store.stopStream(stream.streamKey, "corrupt_row");
            summary.stopped += 1;
          }
        }
        return;
      }

      const batch = assembleBatch(peeked);
      if (batch.events.length === 0) {
        // Poison at the head with no decryptable prefix → stop the stream (cannot
        // cross the gap); the loop + other streams keep progressing.
        if (batch.poisonAfter) {
          store.stopStream(stream.streamKey, "corrupt_row");
          summary.stopped += 1;
        }
        return;
      }

      const fromSeq = batch.seqs[0]!;
      if (st.flushKey === null || st.flushFromSeq !== fromSeq) {
        st.flushKey = newIdempotencyKey();
        st.flushFromSeq = fromSeq;
      }

      let session: WorkerSession;
      try {
        session = await deps.session.get();
      } catch {
        // A session we cannot obtain is fail-closed loss for this stream.
        store.stopStream(stream.streamKey, "reenrollment_required");
        summary.stopped += 1;
        return;
      }
      if (stopped && !final) return;

      store.markUploading(stream.streamKey, batch.seqs);
      const attempt = await uploadEventBatchOnce({
        client: deps.client,
        session,
        identity: stream.identity,
        events: batch.events,
        key: deps.key,
        idempotencyKey: st.flushKey,
        now: deps.now,
        newCorrelationId: deps.randomness?.newCorrelationId,
        newProofId: deps.randomness?.newProofId,
        newNonce: deps.randomness?.newNonce,
      });
      summary.batches += 1;

      if (attempt.kind === "accepted") {
        store.advanceCursor(stream.streamKey, attempt.acceptedThroughSeq);
        summary.accepted += 1;
        st.flushKey = null;
        st.flushFromSeq = null;
        st.recoveries = 0;
        st.backoff = INITIAL_BACKOFF_STATE;
        if (batch.poisonAfter) {
          store.stopStream(stream.streamKey, "corrupt_row");
          summary.stopped += 1;
          return;
        }
        continue; // more contiguous rows may remain
      }
      if (attempt.kind === "gap") {
        // The server accepted through acceptedThroughSeq; resend from expectedNextSeq.
        store.advanceCursor(stream.streamKey, attempt.acceptedThroughSeq);
        st.flushKey = null;
        st.flushFromSeq = null;
        st.recoveries = 0;
        st.backoff = INITIAL_BACKOFF_STATE;
        return; // next tick resumes from the new watermark
      }
      if (attempt.kind === "hash_mismatch") {
        store.quarantineEvent(stream.streamKey, attempt.rejectedEventId);
        store.stopStream(stream.streamKey, "hash_mismatch");
        summary.stopped += 1;
        return;
      }
      if (attempt.kind === "stream_lost") {
        store.stopStream(stream.streamKey, attempt.reason);
        summary.stopped += 1;
        return;
      }
      if (attempt.kind === "unauthorized") {
        const recovery = await tryRecover(st);
        if (recovery === "ok") continue; // retry the SAME key (uploading rows re-peeked)
        store.stopStream(stream.streamKey, "reenrollment_required");
        summary.stopped += 1;
        return;
      }
      if (attempt.kind === "transient") {
        const result = nextBackoff(st.backoff, {
          config: tuning.backoff,
          retryAfterMs: attempt.retryAfterMs,
          rng,
        });
        st.backoff = result.nextState;
        store.requeue(stream.streamKey, nowMs + result.delayMs, true);
        return; // retry next tick after the persisted backoff
      }
      // terminal — stop the stream (a batch that cannot succeed).
      store.stopStream(stream.streamKey, `terminal_${attempt.code}`.slice(0, 64));
      summary.stopped += 1;
      return;
    }
  }

  async function drainOnce(final = false): Promise<DrainTickSummary> {
    const active = store.listActiveStreams();
    const summary = { batches: 0, accepted: 0, stopped: 0 };
    let processed = 0;
    for (const stream of active) {
      if (stopped && !final) break;
      processed += 1;
      try {
        await drainStream(stream, summary, final);
      } catch (err) {
        // Fail-closed per stream: log + continue so one bad stream never crashes
        // the loop or stalls the others.
        deps.logger?.error({ err, streamKey: stream.streamKey }, "event-outbox: stream drain failed");
      }
    }
    return {
      streamsProcessed: processed,
      batchesUploaded: summary.batches,
      eventsAccepted: summary.accepted,
      streamsStopped: summary.stopped,
    };
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      await drainOnce();
    } catch (err) {
      deps.logger?.error({ err }, "event-outbox: drain tick failed");
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), tuning.intervalMs);
      timer.unref?.();
    }
  }

  return {
    recover(): number {
      return store.recoverStalledUploading();
    },
    start(): void {
      if (timer !== null) return;
      timer = setTimeout(() => void tick(), tuning.initialDelayMs);
      timer.unref?.();
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    drainOnce,
    async flush(): Promise<void> {
      // The graceful-shutdown final flush runs a FULL pass even though stop() has
      // latched `stopped` (the shutdown order is stop → flush → close): `final = true`
      // bypasses the loop's cooperative-cancel guard so the last durably-persisted
      // events get one delivery attempt instead of waiting for the next boot.
      await drainOnce(true);
    },
  };
}
