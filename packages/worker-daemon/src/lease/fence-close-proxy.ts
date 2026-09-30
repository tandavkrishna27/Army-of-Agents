/**
 * `FenceCloseProxy` — the local, defense-in-depth governed-effect authority
 * (WRK-005).
 *
 * It is the client-side positive gate over the four EXIT-gate governed effects an
 * agent run may perform against the control plane:
 *
 *   - `commit()`     — an ordinary (fenced) artifact commit,
 *   - `readSecret()` — secret materialization,
 *   - `complete()`   — task completion, and
 *   - `openEgress()` — governed network egress.
 *
 * It is bound to the run's {@link EffectFence} and the renewal driver's tracked
 * lease-liveness: while the fence is live it PASSES each effect through to the
 * (E5/DAT) executor thunk; the instant the fence closes (lease lost / renew
 * rejected / server-ordered cooperative cancel / normal completion) every effect
 * throws {@link FenceClosedError}. `close()` is terminal + idempotent — a
 * FenceCloseProxy can NEVER be re-opened (mirrors `EffectAuthority.withdraw()`).
 *
 * An `openEgress()` attempted after close ADDITIONALLY emits a `network_denied`
 * worker event into the injected sink — the positive counterpart of the
 * `CleanupAuthority.openEgress()` hard denial.
 *
 * The worker holds NO authority: the lease + fence is a revocable grant, and the
 * server `isActiveFence` predicate is the REAL gate. This proxy mirrors the server
 * `GOVERNED_FENCE_SURFACE` / `GUARDED_JOB_MUTATORS` as a READ-ONLY spec — it never
 * imports server code (the E4-D01 boundary). Enforcing that a live commit/secret/
 * completion/egress round-trip actually routes THROUGH this proxy is a downstream
 * E5/DAT integration concern; these four methods are the named seams.
 *
 * Runtime imports: relative modules + the frozen protocol type on the event —
 * the E4-D01 boundary.
 */

import type { EffectFence } from "../supervisor/effect-authority.js";
import {
  EventSequencer,
  type EventDeliveryIdentity,
  type NetworkDenialClass,
  type WorkerEventSink,
} from "../supervisor/events.js";
import { FENCE_CLOSE_METRIC, GOVERNED_EFFECT_DENIED_METRIC, type Metrics } from "../metrics/metrics.js";

/**
 * The four governed effects the exit gate covers — a READ-ONLY mirror of the
 * server `GOVERNED_FENCE_SURFACE` (`server/src/services/job-fencing.ts`) /
 * `GUARDED_JOB_MUTATORS` (`packages/db/src/repositories/tenant/job-fence.ts`).
 * NEVER imported from server code; kept here as a defense-in-depth spec.
 */
export const GOVERNED_EFFECTS = [
  "artifact_commit",
  "secret_materialization",
  "task_completion",
  "governed_egress",
] as const;
export type GovernedEffect = (typeof GOVERNED_EFFECTS)[number];

/** The reason a fence was closed (bounded local tokens for the `fence_close` metric). */
export type FenceCloseReason =
  | "lease_lost"
  | "cancel_requested"
  | "completed"
  | "deadline_lapse"
  | "clock_skew"
  | "shutdown";

/** Thrown by every governed effect once the fence-close proxy has been closed. */
export class FenceClosedError extends Error {
  readonly leaseId: string;
  readonly effect: GovernedEffect;
  constructor(leaseId: string, effect: GovernedEffect) {
    super(`fence closed for lease ${leaseId}; governed effect ${effect} is denied`);
    this.name = "FenceClosedError";
    this.leaseId = leaseId;
    this.effect = effect;
  }
}

/** An egress attempt's destination descriptor (for the `network_denied` event). */
export interface EgressAttempt {
  readonly destinationClass?: NetworkDenialClass;
  readonly reason?: string;
}

/** The local governed-effect authority contract the fence-close proxy implements. */
export interface GovernedEffectAuthority {
  isActive(): boolean;
  /** Close the fence (terminal + idempotent). After this every effect is denied. */
  close(reason?: FenceCloseReason): void;
  commit<T>(effect: () => Promise<T> | T): Promise<T>;
  readSecret<T>(effect: () => Promise<T> | T): Promise<T>;
  complete<T>(effect: () => Promise<T> | T): Promise<T>;
  openEgress<T>(effect: () => Promise<T> | T, attempt?: EgressAttempt): Promise<T>;
}

export interface FenceCloseProxyDeps {
  readonly fence: EffectFence;
  /** The delivery identity a `network_denied` event repeats verbatim. */
  readonly identity: EventDeliveryIdentity;
  /** Where a post-close egress denial emits its `network_denied` event. */
  readonly eventSink: WorkerEventSink;
  readonly metrics?: Metrics;
  readonly newEventId?: () => string;
  readonly now?: () => string;
  /**
   * DSK-002 Lane C (D5) — the lease deadline, as an absolute epoch-millis value.
   *
   * OPTIONAL: absent, the clock plays no part and `close()` remains the only gate, which
   * is exactly the pre-DSK-002 behaviour every existing construction relies on.
   *
   * CLOCK DISCIPLINE, stated because "monotonic" is the word the lease code uses and it
   * would be wrong here. `lease-renewal.ts` compares `Date.now()` against an absolute
   * `expiresAtMs` parsed from the server's `expiresAt`. That IS the right comparison —
   * the deadline is an absolute instant the server issued, so a true monotonic source
   * (`performance.now()`) would have to be anchored to wall time anyway and would then
   * drift across suspend/resume in the other direction. This uses the SAME discipline as
   * the renewal loop deliberately: two different notions of "expired" in one daemon would
   * be worse than one imperfect one.
   *
   * RESIDUAL: a device that sets its clock BACKWARD defeats this check. The server-side
   * fence (`guardActiveFence`) is the authoritative gate and is unaffected; this is
   * defense in depth, and a machine whose owner controls the clock is the same machine
   * whose owner controls the daemon binary.
   */
  readonly expiresAtMs?: number;
  /** Injected clock for {@link FenceCloseProxyDeps.expiresAtMs}. Defaults to `Date.now`. */
  readonly nowMs?: () => number;
  /** DAT-005 D4 — per-run secret canaries scrubbed from the proxy's `network_denied`
   * denial stream before the digest (defense in depth; a denial reason is
   * daemon-authored but the redaction chokepoint stays uniform across every sink). */
  /**
   * ★ REQUIRED, deliberately. This was `redactionCanaries?:` with a `?? []` fallback — an
   * OMISSION-BY-DEFAULT in a REDACTION mechanism: a caller that simply forgot got no
   * redaction at all, silently, and nothing anywhere would say so.
   *
   * A fail-open default in a security control is the worst kind of default, because the
   * failure is invisible in exactly the case it matters. Passing `[]` is still allowed —
   * but it now has to be TYPED OUT, which makes "this run has no canaries" a decision
   * someone made rather than one they omitted.
   */
  readonly redactionCanaries: readonly string[];
}

export class FenceCloseProxy implements GovernedEffectAuthority {
  readonly #fence: EffectFence;
  readonly #events: EventSequencer;
  readonly #metrics?: Metrics;
  readonly #expiresAtMs?: number;
  readonly #nowMs: () => number;
  #active = true;

  constructor(deps: FenceCloseProxyDeps) {
    this.#fence = deps.fence;
    this.#metrics = deps.metrics;
    this.#expiresAtMs = deps.expiresAtMs;
    this.#nowMs = deps.nowMs ?? (() => Date.now());
    // A dedicated sequencer for the proxy's defense-in-depth denial stream. In a
    // wired world the run's sequencer would carry the contiguous seq; while the
    // loop is inert (E4-D12) the proxy owns its own denial event stream.
    this.#events = new EventSequencer({
      identity: deps.identity,
      sink: deps.eventSink,
      newEventId: deps.newEventId,
      now: deps.now,
      redactionCanaries: deps.redactionCanaries,
    });
  }

  get fence(): EffectFence {
    return this.#fence;
  }

  isActive(): boolean {
    return this.#active;
  }

  /** Terminal + idempotent close. A closed proxy is never re-opened. */
  close(reason: FenceCloseReason = "lease_lost"): void {
    if (!this.#active) return; // idempotent — the metric fires once, on the transition
    this.#active = false;
    this.#metrics?.inc(FENCE_CLOSE_METRIC, { reason });
  }

  #denied(effect: GovernedEffect): FenceClosedError {
    this.#metrics?.inc(GOVERNED_EFFECT_DENIED_METRIC, { effect });
    return new FenceClosedError(this.#fence.leaseId, effect);
  }

  /**
   * DSK-002 Lane C (D5/I7/I8) — the single gate every governed effect passes through.
   *
   * `#active` alone was not enough. `lease-renewal.ts` DOES close the fence with
   * `deadline_lapse` and does so without needing the network — but only while its loop is
   * running, and only once its retry `sleep` returns. Between real expiry and that
   * closure every governed effect was permitted, and with the loop stopped, crashed or
   * never registered the window had no bound.
   *
   * A lapse CLOSES rather than vetoing per call, so the state stays terminal and honest:
   * `isActive()` must not keep claiming a live fence after the first refusal. `close()` is
   * idempotent, so the `deadline_lapse` metric fires exactly once on the transition.
   *
   * I8 falls out of the construction rather than needing enforcement: this reads a clock
   * and nothing else, so a reachable Internet cannot extend authority.
   */
  #gate(effect: GovernedEffect): FenceClosedError | null {
    if (this.#expiresAtMs !== undefined && this.#nowMs() >= this.#expiresAtMs) {
      this.close("deadline_lapse");
    }
    return this.#active ? null : this.#denied(effect);
  }

  commit<T>(effect: () => Promise<T> | T): Promise<T> {
    const denied = this.#gate("artifact_commit");
    if (denied) return Promise.reject(denied);
    return Promise.resolve(effect());
  }

  readSecret<T>(effect: () => Promise<T> | T): Promise<T> {
    const denied = this.#gate("secret_materialization");
    if (denied) return Promise.reject(denied);
    return Promise.resolve(effect());
  }

  complete<T>(effect: () => Promise<T> | T): Promise<T> {
    const denied = this.#gate("task_completion");
    if (denied) return Promise.reject(denied);
    return Promise.resolve(effect());
  }

  /**
   * Governed network egress. While the fence is live the executor runs; after
   * close the attempt is denied AND a `network_denied` event is emitted into the
   * injected sink (the positive counterpart of `CleanupAuthority.openEgress`'s
   * hard denial), then a {@link FenceClosedError} rejects.
   */
  async openEgress<T>(effect: () => Promise<T> | T, attempt: EgressAttempt = {}): Promise<T> {
    const denied = this.#gate("governed_egress");
    if (denied) {
      const err = denied;
      await this.#events.networkDenied({
        destinationClass: attempt.destinationClass ?? "not_allowlisted",
        reason: attempt.reason ?? "fence closed; governed egress denied",
      });
      throw err;
    }
    return effect();
  }
}
