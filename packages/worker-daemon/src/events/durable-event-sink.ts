/**
 * Durable, encrypted `WorkerEventSink` (WRK-006, slice 2).
 *
 * Replaces the inert sink seam (`supervisor/events.ts`): every already-stamped
 * `WorkerEventV1` the sequencer hands to `emit()` is serialized VERBATIM,
 * sealed with `aes-256-gcm`, and durably (fsync) committed to the
 * {@link DurableEventStore} BEFORE `emit()` returns — the window the
 * "crash between send/ACK" test guards.
 *
 * INVARIANT (load-bearing): `seq` and `eventDigest` are read straight off the
 * incoming event and stored as-is; they are NEVER recomputed or re-stamped
 * (re-canonicalizing + re-hashing risks a divergent digest → server
 * `event_hash_mismatch`). The store persists the full event JSON encrypted; the
 * separately-indexed `seq`/`eventDigest`/`eventId` columns are copies for
 * ordering + the D2 `UNIQUE(stream_key, seq)` backstop.
 *
 * FAIL CLOSED (D2/D4): a producer seq-collision ({@link SeqCollisionError}), a
 * backpressure-cap breach ({@link OutboxFullError}), or a disk/store fault
 * propagates OUT of `emit()` to the producer — a visible failed run beats a
 * silent gap in the control plane's view. It is kind-agnostic: it reads only the
 * generic delivery + envelope fields, so it accepts the full 19-kind union.
 *
 * Runtime imports: relative modules + the frozen protocol type — the E4-D01 boundary.
 */

import type { WorkerEventV1 } from "@armyofagents/worker-protocol";

import type { EventDeliveryIdentity, WorkerEventSink } from "../supervisor/events.js";
import { encryptEventRow } from "./event-row-codec.js";
import { deriveStreamKey, type DurableEventStore, type EventStreamIdentity } from "./event-outbox-store.js";

export interface DurableWorkerEventSinkDeps {
  readonly store: DurableEventStore;
  /** The 32-byte KEK (from `MountedSecretKekStore` / `deriveKekFromDeviceKey`). */
  readonly kek: Buffer;
  readonly now?: () => number;
}

/** Pull the delivery identity out of the event's OWN fields (never re-derived). */
function identityOf(event: WorkerEventV1): EventStreamIdentity {
  return {
    organizationId: event.organizationId,
    companyId: event.companyId,
    workerId: event.workerId,
    jobId: event.jobId,
    attempt: event.attempt,
    leaseId: event.leaseId,
    fenceToken: event.fenceToken,
  };
}

export class DurableWorkerEventSink implements WorkerEventSink {
  readonly #store: DurableEventStore;
  readonly #kek: Buffer;
  readonly #now: () => number;

  constructor(deps: DurableWorkerEventSinkDeps) {
    this.#store = deps.store;
    this.#kek = deps.kek;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Persist one stamped event. Synchronous: the store's `append` fsync-commits
   * before this returns. Any store fault (collision, backpressure, disk) throws —
   * `emit()` fails closed rather than silently dropping an event.
   */
  emit(event: WorkerEventV1): void {
    const identity = identityOf(event);
    const streamKey = deriveStreamKey(identity);
    // Serialize the WHOLE event verbatim, then seal it. seq/eventDigest are copied
    // from the event, never recomputed — the store round-trips them byte-for-byte.
    const plaintext = Buffer.from(JSON.stringify(event), "utf8");
    const encrypted = encryptEventRow(plaintext, this.#kek);
    this.#store.append({
      streamKey,
      identity,
      seq: event.seq,
      eventId: event.eventId,
      eventDigest: event.eventDigest,
      eventType: event.eventType,
      encrypted,
      nowMs: this.#now(),
    });
  }
}

/** Narrowing helper for callers that still hold a bare `EventDeliveryIdentity`. */
export function toStreamKey(identity: EventDeliveryIdentity): string {
  return deriveStreamKey(identity);
}
