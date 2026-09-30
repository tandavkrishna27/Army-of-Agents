/**
 * Short-lived session lifecycle (WRK-002; sustained renewal added by WRK-010 slice 2).
 *
 * Sessions are ~15-minute, opaque `aoa-worker-session` tokens. The worker keeps
 * one current session. WRK-010 slice 2 gives the store TWO distinct acquisition
 * dependencies, because there are two genuinely different situations and they use
 * two different server routes:
 *
 *   - `renew(current)` — SUSTAINED renewal. Present a STILL-LIVE session plus a
 *     fresh device proof to the WRK-010 renewal route
 *     (`POST /api/worker-control/session/renew`) and receive a NEW 15-minute
 *     session. No enrollment code, no 10-minute ceiling. The route REFUSES an
 *     expired session by construction (`worker-session-auth.ts:103`), so this
 *     is fired BEFORE expiry — see `ensureFresh` + `RENEWAL_HEADROOM_MS`.
 *   - `bootstrap()` — FIRST-session acquisition when the store holds none: the
 *     enrollment code REPLAY (re-enroll with the SAME code + retained idempotency
 *     key + a FRESH device proof; the server replays the stored identity and mints
 *     a new session with no double-consume). Succeeds only WHILE the code route is
 *     still live (`CODE_TTL_MS = 10 min`, E4-D11). This is the pre-slice-2 body of
 *     `renew`; it moved here because a device-proof renewal cannot mint from
 *     nothing (`E4-F012`). It is what `recover()` uses on an empty store.
 *
 * `forceRefresh` routes between them on whether a session is present: a non-null
 * current goes to `renew(current)`, an absent one to `bootstrap()`. The required
 * `bootstrap` dependency is what makes "no first session" a COMPILE error rather
 * than something a reviewer must catch (`E4-F012`, WRK-010 §9.1.1).
 *
 * `SessionStore` also owns:
 *
 *   - rotation detection — a refresh whose generation differs from the current
 *     one is a ROTATION (the device key/generation changed), recorded so the
 *     caller can rebuild downstream state;
 *   - terminal-401 handling — a stop-and-backoff failure from EITHER acquisition
 *     path (a revoked/replaced generation, an expired code route, or a renewal
 *     route that refuses the presented session — all 401) STOPS the store: the
 *     current session is dropped, every further call fails closed (so the worker
 *     never keeps using — or hammering the control plane with — a dead identity),
 *     and it surfaces a `reenrollment_required` signal (a warn log + the
 *     `session_reenrollment_required_total` metric). It does NOT spin retrying.
 */

import { EnrollmentError, type WorkerSession } from "../enrollment/enroll.js";
import type { Logger } from "../logging/logger.js";
import type { Metrics } from "../metrics/metrics.js";

/** Metric emitted once when the store goes terminal and re-enrollment is due. */
export const REENROLLMENT_REQUIRED_METRIC = "session_reenrollment_required_total";

/**
 * Renew this many milliseconds BEFORE the presented session expires. WRK-010 slice 2.
 *
 * ★ ≥5 MINUTES IS A SECURITY INVARIANT, not a scheduling preference. The renewal
 * route's authenticator writes the proof-replay row with the PRESENTED session's
 * expiry (`worker-session-auth.ts:153`), while a device proof stays skew-valid for
 * ±5 min (`worker-device-proof.ts:4`) and `recordProof` deletes an expired row
 * before inserting. Renewing INSIDE 5 minutes of expiry lets the replay row lapse
 * while the proof is still replayable — a window up to ~4.9 minutes (WRK-010
 * §3.5(i)). At the ⅔-TTL cadence (renew with 5 min left) the row outlives the
 * proof: window zero. It is deliberately AT the floor; the invariant test asserts
 * `>= 5 min` and `< DEFAULT_SESSION_TTL_MS`.
 */
export const RENEWAL_HEADROOM_MS = 5 * 60_000;

/** Thrown once the store has stopped (revoked/replaced identity, or a code route
 * that expired before the session could be recovered — all 401 on the enroll
 * route per E4-D11). */
export class SessionStoppedError extends Error {
  constructor(message = "session store stopped: re-enrollment required (identity revoked/replaced or code route expired)") {
    super(message);
    this.name = "SessionStoppedError";
  }
}

export interface SessionStoreDeps {
  readonly now: () => number;
  /** SUSTAINED renewal: present the CURRENT still-live session plus a fresh device
   * proof to the WRK-010 renewal route and receive a NEW bounded session. Requires
   * a live bearer — the route refuses an expired one — so it is fired before expiry
   * (`ensureFresh` + `RENEWAL_HEADROOM_MS`). Takes the session it is renewing
   * (WRK-010 §9.1.1 change 2). */
  readonly renew: (current: WorkerSession) => Promise<WorkerSession>;
  /** FIRST-session acquisition when the store holds none: the enrollment code
   * REPLAY (lost-response recovery). Succeeds only while the code route is live; a
   * lapsed code route surfaces as a stop-and-backoff `unauthorized` (E4-D11).
   * REQUIRED — a device-proof renewal cannot mint from nothing, so the composition
   * root must supply a bootstrap path or it does not compile (`E4-F012`). */
  readonly bootstrap: () => Promise<WorkerSession>;
  /** Optional metrics sink; the terminal-401 `reenrollment_required` counter is
   * emitted here (best-effort). */
  readonly metrics?: Metrics;
  /** Optional structured logger; the terminal-401 warn line is emitted here
   * (best-effort). */
  readonly logger?: Logger;
}

export class SessionStore {
  readonly #deps: SessionStoreDeps;
  #current: WorkerSession | null;
  #stopped = false;
  #lastRotated = false;

  constructor(deps: SessionStoreDeps, initial: WorkerSession | null = null) {
    this.#deps = deps;
    this.#current = initial;
  }

  current(): WorkerSession | null {
    return this.#current;
  }

  isStopped(): boolean {
    return this.#stopped;
  }

  /** Whether the most recent successful recovery changed the device generation. */
  lastRefreshRotated(): boolean {
    return this.#lastRotated;
  }

  set(session: WorkerSession): void {
    this.#current = session;
  }

  isExpired(): boolean {
    return this.#current === null || this.#deps.now() >= this.#current.expiresAtMs;
  }

  /**
   * Return the current session, refreshing when it is absent OR within
   * `RENEWAL_HEADROOM_MS` of expiry (WRK-010 slice 2). This IS now a near-expiry
   * renewal scheduler — a session with more than the headroom remaining is
   * returned unchanged; one inside the headroom (or absent) triggers `forceRefresh`,
   * which routes a live session to `renew(current)` (the renewal route) and an
   * absent one to `bootstrap()` (the code replay). The headroom is what keeps the
   * presented bearer LIVE on the route, which refuses an expired one.
   */
  async ensureFresh(): Promise<WorkerSession> {
    if (this.#stopped) throw new SessionStoppedError();
    if (this.#current !== null && this.#deps.now() < this.#current.expiresAtMs - RENEWAL_HEADROOM_MS) {
      return this.#current;
    }
    return this.forceRefresh();
  }

  /**
   * Recover a session now (lost-response / post-401). Delegates to `forceRefresh`,
   * which routes an absent session to `bootstrap()` (the code replay this method
   * historically was) and a still-present one to `renew(current)`. Terminal on a
   * stop-and-backoff 401 (see `forceRefresh`).
   */
  recover(): Promise<WorkerSession> {
    return this.forceRefresh();
  }

  /**
   * Force a refresh now. Routes on presence: a non-null current session is renewed
   * via `renew(current)` (the WRK-010 device-proof route); an absent one is
   * acquired via `bootstrap()` (the enrollment code replay). On a stop-and-backoff
   * error from EITHER path (a revoked/replaced generation, an expired code route,
   * or a renewal route that refuses the presented session — all 401) the store
   * STOPS: the current session is dropped, the `reenrollment_required` signal is
   * emitted once, and every further call fails closed. It never retries a dead
   * identity.
   */
  async forceRefresh(): Promise<WorkerSession> {
    if (this.#stopped) throw new SessionStoppedError();
    const prev = this.#current;
    try {
      const next = prev !== null ? await this.#deps.renew(prev) : await this.#deps.bootstrap();
      this.#lastRotated = prev !== null && next.deviceGeneration !== prev.deviceGeneration;
      this.#current = next;
      return next;
    } catch (err) {
      if (err instanceof EnrollmentError && err.stopAndBackoff) {
        this.#stopped = true;
        this.#current = null;
        this.#signalReenrollmentRequired(prev);
      }
      throw err;
    }
  }

  /** Emit the terminal-401 `reenrollment_required` signal exactly once (the stop
   * guard in `forceRefresh` ensures this runs only on the transition). */
  #signalReenrollmentRequired(prev: WorkerSession | null): void {
    // `reason` is a bounded low-cardinality token: on the enroll/renew path a
    // revoked/replaced generation and an expired code route both collapse to 401
    // `unauthorized` (E4-D11), so the observable cause is a single enroll-path
    // 401. Never a tenant identifier.
    this.#deps.metrics?.inc(REENROLLMENT_REQUIRED_METRIC, { reason: "enroll_unauthorized" });
    this.#deps.logger?.warn(
      { targetId: prev?.targetId ?? null, reason: "enroll_unauthorized" },
      "worker session terminal: operator re-enrollment required (fresh enrollment code needed)",
    );
  }
}
