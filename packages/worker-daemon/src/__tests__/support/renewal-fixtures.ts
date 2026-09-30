/**
 * Shared builders for the WRK-005 lease-renewal / fence-close / quarantine tests.
 * Boundary-clean (Node builtins + frozen worker-protocol + the worker's own
 * relative modules), so the `check:worker-daemon-boundary` scan of `src` passes.
 *
 * It provides a deterministic fake clock + timer scheduler (the driver's
 * `RenewalSchedule`), a lease handoff whose `offer.expiresAt` the driver captures,
 * static/controllable session providers, a recording supervisor + spy fence
 * proxy, and an in-memory event-sink spy.
 */

import { leaseOfferV1Schema, type LeaseOfferV1, type WorkerEventV1 } from "@armyofagents/worker-protocol";

import type { WorkloadClass } from "../../poll/concurrency.js";
import type { EffectFence } from "../../supervisor/effect-authority.js";
import type { EventDeliveryIdentity, WorkerEventSink } from "../../supervisor/events.js";
import type { WorkerSession } from "../../enrollment/enroll.js";
import { SessionTerminalError, type LeaseHandoff, type SessionProvider } from "../../poll/poll-loop.js";
import type {
  RenewalSchedule,
  RenewalSupervisor,
  RenewalTimer,
} from "../../lease/lease-renewal.js";
import type {
  EgressAttempt,
  FenceCloseReason,
  GovernedEffectAuthority,
} from "../../lease/fence-close-proxy.js";
import type { QuarantineArtifact, QuarantineIdentity } from "../../lease/quarantine.js";

import { startFakeControlPlane, type FakeControlPlane } from "./fake-control-plane.js";
import { FENCE_TOKEN, POLL_FIXTURE_IDS, compatibleOffer, enrollmentCodeConfig } from "./poll-fixtures.js";

/** A fixed epoch aligned with the poll fixtures' job timestamps (00:00 UTC). */
export const START_MS = Date.parse("2026-08-13T00:00:00.000Z");

export const RENEWAL_IDENTITY = { targetId: POLL_FIXTURE_IDS.target, deviceGeneration: 1 } as const;

export function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

// --- Deterministic clock + timer scheduler -----------------------------------

interface ScheduledTimer {
  readonly id: number;
  target: number;
  fn: () => void | Promise<void>;
}

export interface FakeSchedulerRecord {
  readonly delayMs: number;
  readonly targetMs: number;
}

export class FakeScheduler implements RenewalSchedule {
  #clock: number;
  #seq = 0;
  readonly #timers = new Map<number, ScheduledTimer>();
  /** Every `setTimer` call, in order (the schedule test asserts the first delay). */
  readonly setTimerLog: FakeSchedulerRecord[] = [];

  constructor(startMs: number = START_MS) {
    this.#clock = startMs;
  }

  now(): number {
    return this.#clock;
  }

  setTimer(fn: () => void | Promise<void>, delayMs: number): RenewalTimer {
    const id = (this.#seq += 1);
    const target = this.#clock + Math.max(0, delayMs);
    this.#timers.set(id, { id, target, fn });
    this.setTimerLog.push({ delayMs: Math.max(0, delayMs), targetMs: target });
    return { id };
  }

  clearTimer(timer: RenewalTimer): void {
    this.#timers.delete(timer.id);
  }

  /** Transient-retry wait: advance the clock WITHOUT firing timers. */
  sleep(ms: number): Promise<void> {
    this.#clock += Math.max(0, ms);
    return Promise.resolve();
  }

  /** Advance the clock without firing timers (test control). */
  advanceClock(ms: number): void {
    this.#clock += Math.max(0, ms);
  }

  /** Set the clock (test control). */
  setNow(ms: number): void {
    this.#clock = ms;
  }

  timerCount(): number {
    return this.#timers.size;
  }

  /** Set the clock to `to` and fire every timer due at or before it (target order),
   * awaiting each. A timer a fired callback re-schedules further out is not fired. */
  async advanceTo(to: number): Promise<void> {
    this.#clock = Math.max(this.#clock, to);
    const due = [...this.#timers.values()].filter((t) => t.target <= this.#clock).sort((a, b) => a.target - b.target);
    for (const timer of due) {
      if (this.#timers.has(timer.id)) {
        this.#timers.delete(timer.id);
        await timer.fn();
      }
    }
  }
}

// --- Lease handoff -----------------------------------------------------------

export interface MakeHandoffOptions {
  readonly nowMs?: number;
  readonly windowMs?: number;
  readonly ackWindowMs?: number;
  /** Override the offer's leaseId/fenceToken so a test can drive TWO distinct leases on one driver. */
  readonly leaseId?: string;
  readonly fenceToken?: string;
}

/** Build a lease handoff whose `offer.expiresAt` sits `windowMs` after `nowMs`. */
export function makeRenewalHandoff(options: MakeHandoffOptions = {}): LeaseHandoff {
  const nowMs = options.nowMs ?? START_MS;
  const windowMs = options.windowMs ?? 300_000;
  const ackWindowMs = options.ackWindowMs ?? Math.min(60_000, windowMs - 1_000);
  const expiresAt = isoAt(nowMs + windowMs);
  const ackDeadline = isoAt(nowMs + Math.min(ackWindowMs, windowMs - 1_000));
  const base = compatibleOffer({ ackDeadline, expiresAt });
  // Re-parse through the schema (not a spread) so an overridden leaseId/fenceToken is
  // re-branded (`string & BRAND<…>`) rather than widened back to a bare string.
  const offer: LeaseOfferV1 = leaseOfferV1Schema.parse(
    options.leaseId || options.fenceToken
      ? { ...base, leaseId: options.leaseId ?? base.leaseId, fenceToken: options.fenceToken ?? base.fenceToken }
      : base,
  );
  return {
    offer,
    leaseId: offer.leaseId,
    fenceToken: offer.fenceToken,
    workloadClass: offer.job.workloadType as WorkloadClass,
  };
}

// --- Session providers -------------------------------------------------------

export function staticSessionProvider(session: WorkerSession): SessionProvider {
  return {
    get: async () => session,
    recover: async () => session,
  };
}

export interface ControllableSessionProvider extends SessionProvider {
  recoverCount(): number;
  getCount(): number;
  setTerminal(on: boolean): void;
}

/** A session provider whose `get`/`recover` can be forced terminal + counted. */
export function controllableSessionProvider(session: WorkerSession): ControllableSessionProvider {
  let terminal = false;
  let recovers = 0;
  let gets = 0;
  return {
    get: async () => {
      gets += 1;
      if (terminal) throw new SessionTerminalError();
      return session;
    },
    recover: async () => {
      recovers += 1;
      if (terminal) throw new SessionTerminalError();
      return session;
    },
    recoverCount: () => recovers,
    getCount: () => gets,
    setTerminal: (on: boolean) => {
      terminal = on;
    },
  };
}

// --- Recording supervisor ----------------------------------------------------

export interface RecordingSupervisor {
  readonly supervisor: RenewalSupervisor;
  readonly calls: string[];
  /** Resolve the pending `accept` promise for a lease (simulate run completion). */
  completeAccept(leaseId: string): void;
  /** Reject the pending `accept` promise for a lease (simulate a run failure). */
  failAccept(leaseId: string, err?: unknown): void;
}

/** A supervisor whose `accept` stays PENDING (the run is in flight) until the test
 * completes/fails it, and whose `cancel`/`onLeaseLost` record into `log`. */
export function recordingSupervisor(log: string[] = []): RecordingSupervisor {
  const accepts = new Map<string, { resolve: () => void; reject: (e?: unknown) => void }>();
  const supervisor: RenewalSupervisor = {
    accept(handoff: LeaseHandoff): Promise<void> {
      log.push(`accept:${handoff.leaseId}`);
      return new Promise<void>((resolve, reject) => {
        accepts.set(handoff.leaseId, { resolve, reject });
      });
    },
    async cancel(leaseId: string, reason?: string): Promise<void> {
      log.push(`cancel:${leaseId}:${reason ?? ""}`);
    },
    async onLeaseLost(leaseId: string): Promise<void> {
      log.push(`onLeaseLost:${leaseId}`);
    },
  };
  return {
    supervisor,
    calls: log,
    completeAccept(leaseId: string): void {
      accepts.get(leaseId)?.resolve();
    },
    failAccept(leaseId: string, err?: unknown): void {
      accepts.get(leaseId)?.reject(err);
    },
  };
}

// --- Spy fence-close proxy ---------------------------------------------------

export interface SpyProxy extends GovernedEffectAuthority {
  readonly closes: FenceCloseReason[];
}

export interface SpyProxyFactory {
  readonly factory: (fence: EffectFence, identity: EventDeliveryIdentity) => GovernedEffectAuthority;
  readonly byLease: Map<string, SpyProxy>;
}

/** A fence-proxy factory whose `close` records the ORDER (into the shared `log`)
 * so a test can assert the proxy closes BEFORE `onLeaseLost`/`cancel`. */
export function spyProxyFactory(log: string[] = []): SpyProxyFactory {
  const byLease = new Map<string, SpyProxy>();
  const factory = (fence: EffectFence): GovernedEffectAuthority => {
    let active = true;
    const closes: FenceCloseReason[] = [];
    const proxy: SpyProxy = {
      closes,
      isActive: () => active,
      close(reason: FenceCloseReason = "lease_lost"): void {
        if (!active) return;
        active = false;
        closes.push(reason);
        log.push(`close:${fence.leaseId}:${reason}`);
      },
      commit: (effect) => (active ? Promise.resolve(effect()) : Promise.reject(new Error("closed"))),
      readSecret: (effect) => (active ? Promise.resolve(effect()) : Promise.reject(new Error("closed"))),
      complete: (effect) => (active ? Promise.resolve(effect()) : Promise.reject(new Error("closed"))),
      openEgress: (effect: () => unknown, _attempt?: EgressAttempt) =>
        active ? Promise.resolve(effect()) : Promise.reject(new Error("closed")),
    };
    byLease.set(fence.leaseId, proxy);
    return proxy;
  };
  return { factory, byLease };
}

// --- Event sink spy ----------------------------------------------------------

export interface CollectingEventSink extends WorkerEventSink {
  readonly events: WorkerEventV1[];
}

export function collectingEventSink(): CollectingEventSink {
  const events: WorkerEventV1[] = [];
  return {
    events,
    emit(event: WorkerEventV1): void {
      events.push(event);
    },
  };
}

// --- Fake plane whose clock tracks the scheduler -----------------------------

export const RENEWAL_CODE = "renew-code";

/** Start a fake control-plane whose `now` tracks `scheduler` (so its renew-expiry
 * + session-expiry math match the driver's clock) with a long session TTL so
 * advancing the lease clock across renewals never expires the session. */
export function startRenewalPlane(scheduler: FakeScheduler, code: string = RENEWAL_CODE): Promise<FakeControlPlane> {
  return startFakeControlPlane({
    enrollments: [enrollmentCodeConfig(code)],
    now: () => scheduler.now(),
    sessionTtlMs: 24 * 60 * 60 * 1_000,
  });
}

// --- Quarantine fixtures -----------------------------------------------------

/** A device identity + observed (non-authoritative) lease for the quarantine path. */
export function quarantineIdentity(): QuarantineIdentity {
  return {
    workerId: POLL_FIXTURE_IDS.worker,
    targetId: POLL_FIXTURE_IDS.target,
    deviceGeneration: 1,
    organizationId: POLL_FIXTURE_IDS.org,
    companyId: POLL_FIXTURE_IDS.company,
    jobId: POLL_FIXTURE_IDS.job,
    attempt: 1,
    observedLeaseId: POLL_FIXTURE_IDS.lease,
    observedFenceToken: FENCE_TOKEN,
  };
}

/** An orphan artifact with a fixed hash/size + a safe relative name. */
export function quarantineArtifact(): QuarantineArtifact {
  return {
    artifactId: POLL_FIXTURE_IDS.manifestArtifact,
    expectedSha256: "a".repeat(64),
    sizeBytes: 128,
    objectSuffix: "output.log",
    kind: "log",
    contentType: "text/plain",
  };
}
