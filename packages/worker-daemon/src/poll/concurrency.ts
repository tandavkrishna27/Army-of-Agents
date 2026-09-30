/**
 * Bounded local-concurrency limiter (WRK-003).
 *
 * The worker enforces a hard per-workload-class ceiling on how many leases it
 * will run at once. A class whose local slots are exhausted is SATURATED: the
 * limiter refuses to acquire another slot, and `measureCapacity` advertises zero
 * free slots for it — the worker exerts backpressure by advertising no capacity
 * rather than fetching work it cannot run (the server's placement matcher then
 * never offers that class). Slots are released when a lease completes, re-opening
 * the class for polling.
 *
 * The three closed classes mirror the frozen `WorkerCapacity` slot fields
 * (`batchSlots`/`browserSessionSlots`/`serviceSlots`) and the protocol
 * `workloadType` enum (`batch`/`browser_session`/`service`).
 */

export const WORKLOAD_CLASSES = ["batch", "browser_session", "service"] as const;
export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];

/** Per-class local concurrency ceilings (0 disables a class entirely). */
export type ConcurrencyLimits = Readonly<Record<WorkloadClass, number>>;

/** Free slots per class (the shape `measureCapacity` consumes). */
export type WorkloadSlotSnapshot = Readonly<Record<WorkloadClass, number>>;

export class ConcurrencyLimiter {
  readonly #limits: Record<WorkloadClass, number>;
  readonly #inFlight: Record<WorkloadClass, number> = { batch: 0, browser_session: 0, service: 0 };

  constructor(limits: ConcurrencyLimits) {
    this.#limits = {
      batch: clampNonNegInt(limits.batch),
      browser_session: clampNonNegInt(limits.browser_session),
      service: clampNonNegInt(limits.service),
    };
  }

  limitFor(cls: WorkloadClass): number {
    return this.#limits[cls];
  }

  inFlight(cls: WorkloadClass): number {
    return this.#inFlight[cls];
  }

  /** Slots currently available for `cls` (never negative). */
  freeSlots(cls: WorkloadClass): number {
    return Math.max(0, this.#limits[cls] - this.#inFlight[cls]);
  }

  /** True iff no slot is available for `cls` (a zero-limit class is always saturated). */
  isSaturated(cls: WorkloadClass): boolean {
    return this.freeSlots(cls) === 0;
  }

  /** True iff at least one class has a free slot (else fully back-pressured). */
  hasAnyFreeSlot(): boolean {
    return WORKLOAD_CLASSES.some((cls) => this.freeSlots(cls) > 0);
  }

  /**
   * Reserve a slot for `cls`. Returns false (and reserves nothing) when the class
   * is saturated — the caller must NOT accept the lease.
   */
  tryAcquire(cls: WorkloadClass): boolean {
    if (this.isSaturated(cls)) return false;
    this.#inFlight[cls] += 1;
    return true;
  }

  /** Release a previously-acquired slot; an over-release never goes below zero. */
  release(cls: WorkloadClass): void {
    this.#inFlight[cls] = Math.max(0, this.#inFlight[cls] - 1);
  }

  /** Free slots per class — the exact shape `measureCapacity` advertises. */
  snapshot(): WorkloadSlotSnapshot {
    return {
      batch: this.freeSlots("batch"),
      browser_session: this.freeSlots("browser_session"),
      service: this.freeSlots("service"),
    };
  }
}

function clampNonNegInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
