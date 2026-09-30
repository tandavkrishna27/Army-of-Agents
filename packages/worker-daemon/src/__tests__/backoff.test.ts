import { describe, expect, it } from "vitest";

import {
  INITIAL_BACKOFF_STATE,
  backoffBucket,
  nextBackoff,
  type BackoffConfig,
} from "../poll/backoff.js";

const CONFIG: BackoffConfig = { baseMs: 1_000, maxMs: 30_000, jitter: 0.5 };

describe("nextBackoff — explicit retryAfterMs", () => {
  it("honors a server-provided retryAfterMs verbatim when within maxMs", () => {
    const result = nextBackoff(INITIAL_BACKOFF_STATE, { config: CONFIG, retryAfterMs: 7_500 });
    expect(result.delayMs).toBe(7_500);
  });

  it("bounds an over-large retryAfterMs to maxMs (never unbounded)", () => {
    const result = nextBackoff(INITIAL_BACKOFF_STATE, { config: CONFIG, retryAfterMs: 10_000_000 });
    expect(result.delayMs).toBe(30_000);
  });

  it("floors a zero retryAfterMs at min(baseMs,maxMs) so a server 0 can never zero-spin", () => {
    const result = nextBackoff(INITIAL_BACKOFF_STATE, { config: CONFIG, retryAfterMs: 0 });
    // A retryAfterMs of 0 is honored as "as soon as allowed" but floored at the
    // base cadence — never an immediate re-poll flood.
    expect(result.delayMs).toBe(Math.min(CONFIG.baseMs, CONFIG.maxMs));
    expect(result.delayMs).toBe(1_000);
  });

  it("floors a below-base retryAfterMs at min(baseMs,maxMs) but still honors a larger one", () => {
    // Below the floor → floored up to baseMs.
    expect(nextBackoff(INITIAL_BACKOFF_STATE, { config: CONFIG, retryAfterMs: 250 }).delayMs).toBe(1_000);
    // At/above the floor → honored verbatim (within maxMs).
    expect(nextBackoff(INITIAL_BACKOFF_STATE, { config: CONFIG, retryAfterMs: 3_000 }).delayMs).toBe(3_000);
  });
});

describe("nextBackoff — growth path (no explicit retryAfterMs)", () => {
  it("never zero-spins: the first backoff is at least baseMs even with rng()=0", () => {
    const result = nextBackoff(INITIAL_BACKOFF_STATE, { config: CONFIG, rng: () => 0 });
    expect(result.delayMs).toBeGreaterThanOrEqual(CONFIG.baseMs);
  });

  it("stays within [baseMs, maxMs] across the full jitter range", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const r of [0, 0.25, 0.5, 0.9999]) {
        const result = nextBackoff({ attempt }, { config: CONFIG, rng: () => r });
        expect(result.delayMs).toBeGreaterThanOrEqual(CONFIG.baseMs);
        expect(result.delayMs).toBeLessThanOrEqual(CONFIG.maxMs);
      }
    }
  });

  it("grows exponentially with the attempt count until capped at maxMs", () => {
    const a0 = nextBackoff({ attempt: 0 }, { config: CONFIG, rng: () => 0 }).delayMs;
    const a1 = nextBackoff({ attempt: 1 }, { config: CONFIG, rng: () => 0 }).delayMs;
    const a2 = nextBackoff({ attempt: 2 }, { config: CONFIG, rng: () => 0 }).delayMs;
    expect(a0).toBe(1_000);
    expect(a1).toBe(2_000);
    expect(a2).toBe(4_000);
    // A large attempt saturates at maxMs, never beyond.
    expect(nextBackoff({ attempt: 40 }, { config: CONFIG, rng: () => 0.9999 }).delayMs).toBe(30_000);
  });

  it("advances the attempt counter for the next call", () => {
    const first = nextBackoff(INITIAL_BACKOFF_STATE, { config: CONFIG, rng: () => 0 });
    expect(first.nextState.attempt).toBe(1);
    const second = nextBackoff(first.nextState, { config: CONFIG, rng: () => 0 });
    expect(second.nextState.attempt).toBe(2);
  });

  it("adds jitter above the exponential floor when rng() > 0", () => {
    const floor = nextBackoff({ attempt: 1 }, { config: CONFIG, rng: () => 0 }).delayMs; // 2000
    const jittered = nextBackoff({ attempt: 1 }, { config: CONFIG, rng: () => 1 }).delayMs;
    expect(jittered).toBeGreaterThan(floor);
    expect(jittered).toBeLessThanOrEqual(CONFIG.maxMs);
  });
});

describe("backoffBucket", () => {
  it("maps sleep durations to bounded low-cardinality tokens", () => {
    expect(backoffBucket(0)).toBe("lt_1s");
    expect(backoffBucket(999)).toBe("lt_1s");
    expect(backoffBucket(1_000)).toBe("lt_5s");
    expect(backoffBucket(4_999)).toBe("lt_5s");
    expect(backoffBucket(5_000)).toBe("lt_30s");
    expect(backoffBucket(29_999)).toBe("lt_30s");
    expect(backoffBucket(30_000)).toBe("gte_30s");
    expect(backoffBucket(600_000)).toBe("gte_30s");
  });

  it("only ever emits bounded metric-label tokens", () => {
    const token = /^[a-z][a-z0-9_]{0,39}$/;
    for (const ms of [0, 500, 1_000, 5_000, 30_000, 3_600_000]) {
      expect(backoffBucket(ms)).toMatch(token);
    }
  });
});
