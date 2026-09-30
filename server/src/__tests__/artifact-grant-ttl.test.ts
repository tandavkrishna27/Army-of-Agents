// DAT-009 slice 2 §4.1 — the artifact-transfer grant TTL is CLAMPED, not merely defaulted.
//
// Measured before this change: `Math.max(30, input.grantTtlSeconds ?? 300)` — a floor of
// 30s, a default of 300s, and NO upper clamp. No caller passed the parameter, so the
// effective TTL was always 300s and the knob was dead configuration.
//
// That matters because the TTL is the ONLY revocation mechanism this system has: the
// issued grant carries no fence material, nothing re-checks between mint and commit, and
// no grant-revocation concept exists anywhere in the repo. A longer TTL is a longer window
// in which a dead fence's presigned PUT still lands.
//
// The frozen schema would accept a SEVEN-DAY ordinary upload grant — `addOrdinaryGrantIssues`
// asserts only `expiresAt > issuedAt` — while the quarantine grant is capped at five
// minutes in two places. This clamp mirrors that ceiling on the ordinary path without
// touching the frozen schema (which would be an E4-D02 STOP).

import { describe, expect, it } from "vitest";

import { MAX_GRANT_TTL_SECONDS, MIN_GRANT_TTL_SECONDS, resolveGrantTtlSeconds } from "../services/artifact-grant-ttl.js";

describe("DAT-009 slice 2 — grant TTL clamp", () => {
  it("keeps the established default when nothing is requested", () => {
    // 300s was the effective value before the clamp existed. Preserving it means this
    // change is a bound, not a behaviour change.
    expect(resolveGrantTtlSeconds(undefined)).toBe(300);
  });

  it("★ clamps an over-long request DOWN to the ceiling", () => {
    // The defect being closed: nothing stopped a caller (or a future config) asking for a
    // week. A mutation removing the Math.min dies here.
    expect(resolveGrantTtlSeconds(7 * 24 * 60 * 60)).toBe(MAX_GRANT_TTL_SECONDS);
    expect(resolveGrantTtlSeconds(301)).toBe(MAX_GRANT_TTL_SECONDS);
  });

  it("keeps the existing floor so a caller cannot mint an unusable grant", () => {
    expect(resolveGrantTtlSeconds(1)).toBe(MIN_GRANT_TTL_SECONDS);
    expect(resolveGrantTtlSeconds(0)).toBe(MIN_GRANT_TTL_SECONDS);
    expect(resolveGrantTtlSeconds(-100)).toBe(MIN_GRANT_TTL_SECONDS);
  });

  it("passes a value through untouched when it is already inside the band", () => {
    expect(resolveGrantTtlSeconds(120)).toBe(120);
    expect(resolveGrantTtlSeconds(MIN_GRANT_TTL_SECONDS)).toBe(MIN_GRANT_TTL_SECONDS);
    expect(resolveGrantTtlSeconds(MAX_GRANT_TTL_SECONDS)).toBe(MAX_GRANT_TTL_SECONDS);
  });

  it("★ refuses a non-finite request rather than propagating NaN into an expiry", () => {
    // `issuedAt + NaN * 1000` produces an Invalid Date, and the frozen schema's only
    // temporal assertion (`expiresAt > issuedAt`) is FALSE for NaN — so this would fail
    // at parse time with an opaque message instead of here with a clear one.
    expect(resolveGrantTtlSeconds(Number.NaN)).toBe(300);
    expect(resolveGrantTtlSeconds(Number.POSITIVE_INFINITY)).toBe(MAX_GRANT_TTL_SECONDS);
  });

  it("★ the ceiling matches the quarantine grant's frozen five-minute cap", () => {
    // Pins the intent: the ordinary path is being brought into line with the path that
    // was already capped. If someone raises this, the asymmetry returns silently.
    expect(MAX_GRANT_TTL_SECONDS).toBe(300);
    expect(MIN_GRANT_TTL_SECONDS).toBe(30);
  });
});
