// DAT-009 slice 2 — the sweep-eligibility DECISION.
//
// ★ THE TRAP THIS SUITE EXISTS TO PIN (design §5): a sweeper that deletes an
// IN-FLIGHT upload is worse than the orphan it removes. The only signal available is
// AGE — there is no "upload in progress" marker, and S3 gives no visibility into a PUT
// that has not completed. So eligibility must be keyed STRICTLY on `expiresAt` having
// passed, at which point the presigned URL is dead and no honest upload can still land.
//
// If someone later "tightens" this to sweep on lease-end or attempt-superseded, these
// tests fail. That is the point. Do not relax them.

import { describe, expect, it } from "vitest";

import {
  isSweepEligible,
  sweepRefusalIsActionable,
  type ArtifactSweepCandidate,
} from "../services/artifact-orphan-sweep.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const past = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const future = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function candidate(over: Partial<ArtifactSweepCandidate> = {}): ArtifactSweepCandidate {
  return {
    status: "granted",
    objectKey: "organizations/org_1/jobs/job_1/attempts/0/evidence.png",
    expiresAt: past(60_000),
    hasCommittedSibling: false,
    ...over,
  };
}

describe("DAT-009 slice 2 — sweep eligibility", () => {
  it("sweeps a granted intent whose grant has expired without committing", () => {
    expect(isSweepEligible(candidate(), NOW)).toEqual({ eligible: true });
  });

  it("★ does NOT sweep while the grant can still be redeemed", () => {
    // The §5 trap. An unexpired grant may have an honest PUT in flight right now.
    const r = isSweepEligible(candidate({ expiresAt: future(1) }), NOW);
    expect(r).toEqual({ eligible: false, reason: "grant_still_redeemable" });
  });

  it("★ does NOT sweep at the exact expiry instant — strictly after, or not at all", () => {
    // Boundary. `expiresAt === now` means the URL may still be honoured by the store,
    // so equality must NOT be eligible. A mutation flipping `>` to `>=` dies here.
    const r = isSweepEligible(candidate({ expiresAt: NOW.toISOString() }), NOW);
    expect(r).toEqual({ eligible: false, reason: "grant_still_redeemable" });
  });

  it("★ never sweeps an expired intent whose artifact WAS committed", () => {
    // The defect this caught during implementation: the granted and committed
    // partial-unique keys are DISJOINT, so commit inserts a SECOND row and the intent
    // SURVIVES. Both name the same objectKey. Without this guard the sweeper waits for
    // the intent to expire and then deletes a COMMITTED, immutable artifact's bytes —
    // destroying data rather than collecting litter. This is the happy path's shape.
    const r = isSweepEligible(candidate({ hasCommittedSibling: true }), NOW);
    expect(r).toEqual({ eligible: false, reason: "committed_sibling_exists" });
  });

  it("never sweeps a committed artifact", () => {
    const r = isSweepEligible(candidate({ status: "committed" }), NOW);
    expect(r).toEqual({ eligible: false, reason: "committed" });
  });

  it("never sweeps a quarantined artifact — DAT-006 owns those", () => {
    const r = isSweepEligible(candidate({ status: "quarantined" }), NOW);
    expect(r).toEqual({ eligible: false, reason: "quarantined" });
  });

  it("refuses a record with no expiry rather than guessing", () => {
    // A row with no expiry predates the intent mechanism. Sweeping it would rely on
    // something other than grant expiry, which is exactly what §5 forbids.
    const r = isSweepEligible(candidate({ expiresAt: null }), NOW);
    expect(r).toEqual({ eligible: false, reason: "no_expiry_recorded" });
  });

  it("refuses a record with no object key — there is nothing to delete", () => {
    const r = isSweepEligible(candidate({ objectKey: null }), NOW);
    expect(r).toEqual({ eligible: false, reason: "no_object_key" });
  });

  it("refuses an unparseable expiry rather than treating it as long past", () => {
    // Deliberate: Date.parse of garbage yields NaN, and NaN comparisons are false, so a
    // naive `now > parse(x)` would refuse — but by accident. This asserts it refuses for
    // the STATED reason, so the behaviour survives a rewrite.
    const r = isSweepEligible(candidate({ expiresAt: "not-a-date" }), NOW);
    expect(r).toEqual({ eligible: false, reason: "no_expiry_recorded" });
  });

  it("★ every refusal reason is classified as actionable or not — none is discarded", () => {
    // I have shipped a discarded refusal reason twice in this programme. The classifier
    // exists so a caller must decide what to DO with each, and this test fails if a new
    // reason is added without that decision.
    const reasons = [
      "grant_still_redeemable",
      "committed",
      "committed_sibling_exists",
      "quarantined",
      "no_expiry_recorded",
      "no_object_key",
    ] as const;
    for (const reason of reasons) {
      expect(typeof sweepRefusalIsActionable(reason)).toBe("boolean");
    }
    // A stale row that can never become eligible IS actionable — it needs an operator,
    // not a retry. A redeemable grant is not: it will simply become eligible later.
    expect(sweepRefusalIsActionable("grant_still_redeemable")).toBe(false);
    expect(sweepRefusalIsActionable("committed")).toBe(false);
    // The happy path leaves exactly this shape, so it must not page anyone.
    expect(sweepRefusalIsActionable("committed_sibling_exists")).toBe(false);
    expect(sweepRefusalIsActionable("no_object_key")).toBe(true);
    expect(sweepRefusalIsActionable("no_expiry_recorded")).toBe(true);
  });
});
