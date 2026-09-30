/**
 * Bounded jittered backoff (WRK-003).
 *
 * `nextBackoff` computes the sleep before the next poll attempt. It HONORS an
 * explicit server `retryAfterMs` (a `no_work` cadence or a `throttled`/
 * `internal_unavailable` hint), clamped to `maxMs` so a buggy/hostile server can
 * never stall the loop unbounded. Absent an explicit value it grows the delay
 * exponentially from `baseMs`, capped at `maxMs`, plus bounded additive jitter —
 * and NEVER returns a zero-spin delay on the growth path (the floor is `baseMs`).
 *
 * Pure + deterministic: the randomness source is injected (`rng`), so tests pin
 * the jitter. `backoffBucket` maps a sleep to a bounded low-cardinality metric
 * label token (the metrics surface forbids unbounded label values).
 */

export interface BackoffConfig {
  readonly baseMs: number;
  readonly maxMs: number;
  /** Jitter fraction in [0,1]: additive jitter is up to `exp * jitter`. */
  readonly jitter: number;
}

export interface BackoffState {
  /** Consecutive backoff count; drives the exponential growth. */
  readonly attempt: number;
}

export interface BackoffResult {
  readonly delayMs: number;
  readonly nextState: BackoffState;
}

export const INITIAL_BACKOFF_STATE: BackoffState = Object.freeze({ attempt: 0 });

export interface NextBackoffOptions {
  readonly config: BackoffConfig;
  /** An explicit server-directed wait; honored (clamped to maxMs) when finite ≥ 0. */
  readonly retryAfterMs?: number | null;
  /** Injectable uniform [0,1) source; defaults to `Math.random`. */
  readonly rng?: () => number;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/**
 * Compute the next backoff delay + advanced state. An explicit `retryAfterMs`
 * (finite, ≥ 0) is honored — clamped to `maxMs` AND floored at `min(baseMs,
 * maxMs)`, so a larger server hint is still honored while a `retryAfterMs: 0`
 * (the frozen schema permits it on `no_work`/`throttled`/`internal_unavailable`)
 * can never collapse to a zero-spin re-poll flood. Otherwise the delay grows as
 * `min(baseMs * 2^attempt, maxMs)` plus additive jitter in `[0, exp * jitter)`,
 * capped at `maxMs` and floored at `baseMs` (never zero). Every honored delay on
 * every path therefore stays within `[min(baseMs, maxMs), maxMs]`.
 */
export function nextBackoff(state: BackoffState, opts: NextBackoffOptions): BackoffResult {
  const { baseMs, maxMs, jitter } = opts.config;
  const attempt = Number.isFinite(state.attempt) && state.attempt > 0 ? Math.floor(state.attempt) : 0;
  const rng = opts.rng ?? Math.random;

  let delayMs: number;
  const explicit = opts.retryAfterMs;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) {
    // Honor a LARGER server-directed wait (clamped to maxMs) but never dip below
    // the base floor: a hostile/overloaded server returning 0 cannot zero-spin.
    delayMs = Math.max(Math.min(explicit, maxMs), Math.min(baseMs, maxMs));
  } else {
    // `2 ** attempt` can overflow to Infinity for a large attempt; `Math.min`
    // with `maxMs` collapses it to the cap, so the growth stays bounded.
    const exp = Math.min(baseMs * 2 ** attempt, maxMs);
    const jitterSpan = exp * clampUnit(jitter) * rng();
    delayMs = Math.min(exp + jitterSpan, maxMs);
    delayMs = Math.max(delayMs, Math.min(baseMs, maxMs));
  }

  return { delayMs, nextState: { attempt: attempt + 1 } };
}

/**
 * Map a backoff sleep (ms) to a bounded low-cardinality bucket token for the
 * `backoff_sleep_ms{bucket}` metric. The four tokens are a CLOSED set — the
 * metrics surface rejects any label value outside its registered vocabulary.
 */
export function backoffBucket(delayMs: number): "lt_1s" | "lt_5s" | "lt_30s" | "gte_30s" {
  if (delayMs < 1_000) return "lt_1s";
  if (delayMs < 5_000) return "lt_5s";
  if (delayMs < 30_000) return "lt_30s";
  return "gte_30s";
}

export const BACKOFF_BUCKETS = ["lt_1s", "lt_5s", "lt_30s", "gte_30s"] as const;
