// server/src/__tests__/worker-admission-rate-limit.test.ts
//
// DEP-009 — pure-unit coverage of the shared worker-poll rate limiter's config resolution
// and fixed-window boundary math (no DB). The embedded-PG behaviour (atomic increment,
// over-cap deny, window reset, fail-closed, shared counter) lives in the integration suite.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_POLL_RATE_LIMIT_MAX,
  DEFAULT_WORKER_POLL_RATE_LIMIT_WINDOW_MS,
  WORKER_POLL_RATE_LIMIT_MAX_ENV,
  WORKER_POLL_RATE_LIMIT_WINDOW_MS_ENV,
  resolveWorkerPollRateLimitConfig,
  windowStartFor,
} from "../services/worker-admission-rate-limit.js";

describe("DEP-009 worker-poll rate-limit config", () => {
  it("falls back to the generous defaults when unset", () => {
    const cfg = resolveWorkerPollRateLimitConfig({});
    expect(cfg.windowMs).toBe(DEFAULT_WORKER_POLL_RATE_LIMIT_WINDOW_MS);
    expect(cfg.max).toBe(DEFAULT_WORKER_POLL_RATE_LIMIT_MAX);
  });

  it("reads positive-integer overrides from env", () => {
    const cfg = resolveWorkerPollRateLimitConfig({
      [WORKER_POLL_RATE_LIMIT_WINDOW_MS_ENV]: "10000",
      [WORKER_POLL_RATE_LIMIT_MAX_ENV]: "25",
    });
    expect(cfg).toEqual({ windowMs: 10_000, max: 25 });
  });

  it("rejects a non-positive / non-integer override (fail-closed config)", () => {
    for (const bad of ["0", "-5", "1.5", "abc"]) {
      expect(() =>
        resolveWorkerPollRateLimitConfig({ [WORKER_POLL_RATE_LIMIT_MAX_ENV]: bad }),
      ).toThrow(/must be a positive integer/);
    }
  });
});

describe("DEP-009 fixed-window boundary", () => {
  it("floors an instant to the window start", () => {
    const windowMs = 60_000;
    const w = windowStartFor(new Date("2026-08-16T12:34:56.789Z"), windowMs);
    expect(w.toISOString()).toBe("2026-08-16T12:34:00.000Z");
  });

  it("keeps two instants in the same window on one boundary and splits across it", () => {
    const windowMs = 1_000;
    const a = windowStartFor(new Date(10_500), windowMs);
    const b = windowStartFor(new Date(10_999), windowMs);
    const c = windowStartFor(new Date(11_000), windowMs);
    expect(a.getTime()).toBe(10_000);
    expect(b.getTime()).toBe(10_000);
    expect(c.getTime()).toBe(11_000);
  });
});
