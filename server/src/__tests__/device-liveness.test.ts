// E11 M2 — the device liveness classifier is a PURE function of two timestamps and a
// deadline. Every arm is driven with an injected `now`, and the two load-bearing
// properties — the NULL fail-open and the strict `>` boundary — are pinned by named cases,
// mirroring service-liveness-deadline.test.ts.

import { describe, expect, it } from "vitest";

import {
  DEVICE_LIVENESS_DEADLINE_ENV,
  DEVICE_LIVENESS_DEADLINE_MS_DEFAULT,
  classifyDeviceLiveness,
  resolveDeviceLivenessDeadlineMs,
} from "../services/device-liveness.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const DEADLINE = 1_800_000; // 30 min

describe("classifyDeviceLiveness", () => {
  it("★ FAIL-OPEN: a null lastSeenAt is never_seen, NEVER stale", () => {
    expect(classifyDeviceLiveness({ lastSeenAt: null, enrolledAt: null, now: NOW, deadlineMs: DEADLINE }))
      .toBe("never_seen");
  });

  it("★ FAIL-OPEN holds even with a tiny deadline — null is still never_seen, not stale", () => {
    // The defect this guards is treating a missing observation as infinitely old.
    expect(classifyDeviceLiveness({ lastSeenAt: null, enrolledAt: null, now: NOW, deadlineMs: 1 }))
      .toBe("never_seen");
  });

  it("a recent check-in (age < deadline) is healthy", () => {
    const lastSeenAt = new Date(NOW.getTime() - 60_000); // 1 min ago
    expect(classifyDeviceLiveness({ lastSeenAt, enrolledAt: null, now: NOW, deadlineMs: DEADLINE }))
      .toBe("healthy");
  });

  it("★ BOUNDARY: an age exactly equal to the deadline is still healthy (strict >)", () => {
    const lastSeenAt = new Date(NOW.getTime() - DEADLINE);
    expect(classifyDeviceLiveness({ lastSeenAt, enrolledAt: null, now: NOW, deadlineMs: DEADLINE }))
      .toBe("healthy");
  });

  it("★ BOUNDARY: one millisecond past the deadline is stale", () => {
    const lastSeenAt = new Date(NOW.getTime() - DEADLINE - 1);
    expect(classifyDeviceLiveness({ lastSeenAt, enrolledAt: null, now: NOW, deadlineMs: DEADLINE }))
      .toBe("stale");
  });

  it("an old check-in is stale", () => {
    const lastSeenAt = new Date(NOW.getTime() - 24 * 60 * 60_000); // a day ago
    expect(classifyDeviceLiveness({ lastSeenAt, enrolledAt: null, now: NOW, deadlineMs: DEADLINE }))
      .toBe("stale");
  });

  it("a future lastSeenAt (negative age, mild clock skew) is healthy, not stale", () => {
    const lastSeenAt = new Date(NOW.getTime() + 5_000);
    expect(classifyDeviceLiveness({ lastSeenAt, enrolledAt: null, now: NOW, deadlineMs: DEADLINE }))
      .toBe("healthy");
  });

  // ★ GENERATION BOUNDARY (Codex P2): `rotateWorker` re-enrols on the SAME row, bumping
  // `enrolledAt` and the key but PRESERVING the prior generation's `lastSeenAt`. A recent
  // `lastSeenAt` that predates the current `enrolledAt` must NOT read as healthy — the new
  // key has never checked in.
  it("★ a recent lastSeenAt that PREDATES enrolledAt (re-enrolled, new key unseen) is never_seen", () => {
    const lastSeenAt = new Date(NOW.getTime() - 60_000); // 1 min ago — recent on its own
    const enrolledAt = new Date(NOW.getTime() - 30_000); // but the current enrolment is newer
    expect(classifyDeviceLiveness({ lastSeenAt, enrolledAt, now: NOW, deadlineMs: DEADLINE }))
      .toBe("never_seen");
  });

  it("a lastSeenAt at/after enrolledAt classifies by age — recent is healthy", () => {
    const enrolledAt = new Date(NOW.getTime() - 120_000);
    const lastSeenAt = new Date(NOW.getTime() - 60_000); // after enrolment, within deadline
    expect(classifyDeviceLiveness({ lastSeenAt, enrolledAt, now: NOW, deadlineMs: DEADLINE }))
      .toBe("healthy");
  });

  it("a lastSeenAt after enrolledAt but older than the deadline is stale", () => {
    const enrolledAt = new Date(NOW.getTime() - 3 * DEADLINE);
    const lastSeenAt = new Date(NOW.getTime() - 2 * DEADLINE); // after enrolment, past deadline
    expect(classifyDeviceLiveness({ lastSeenAt, enrolledAt, now: NOW, deadlineMs: DEADLINE }))
      .toBe("stale");
  });

  it("a lastSeenAt exactly equal to enrolledAt is on-boundary — age-based, still healthy", () => {
    const t = new Date(NOW.getTime() - 60_000);
    expect(classifyDeviceLiveness({ lastSeenAt: t, enrolledAt: t, now: NOW, deadlineMs: DEADLINE }))
      .toBe("healthy");
  });
});

describe("resolveDeviceLivenessDeadlineMs", () => {
  it("returns the conservative default when the env var is unset", () => {
    expect(resolveDeviceLivenessDeadlineMs({})).toBe(DEVICE_LIVENESS_DEADLINE_MS_DEFAULT);
  });

  it("honours a valid positive-integer override", () => {
    expect(resolveDeviceLivenessDeadlineMs({ [DEVICE_LIVENESS_DEADLINE_ENV]: "600000" }))
      .toBe(600_000);
  });

  it.each(["", "  ", "not-a-number", "0", "-1", "1.5", "Infinity", "NaN"])(
    "ignores an invalid override %j and falls back to the default (never disables liveness)",
    (value) => {
      expect(resolveDeviceLivenessDeadlineMs({ [DEVICE_LIVENESS_DEADLINE_ENV]: value }))
        .toBe(DEVICE_LIVENESS_DEADLINE_MS_DEFAULT);
    },
  );

  it("trims surrounding whitespace on a valid value", () => {
    expect(resolveDeviceLivenessDeadlineMs({ [DEVICE_LIVENESS_DEADLINE_ENV]: "  900000 " }))
      .toBe(900_000);
  });
});
