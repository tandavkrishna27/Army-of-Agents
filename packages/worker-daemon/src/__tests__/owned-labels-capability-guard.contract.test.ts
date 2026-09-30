// -----------------------------------------------------------------------------
// DEP-011 Slice 2a — the vendored owned-labels-capability shape-guard CONTRACT.
//
// worker-daemon runtime source may NOT import the leaf's `OwnedLabelsCapability`
// type (`check-worker-daemon-boundary` has no `import type` awareness — even a type
// import is a "forbidden runtime import"), and provider-wire's `isValidCapability`
// is module-PRIVATE. So worker-daemon VENDORS a local structural type
// (`OwnedLabelsCapabilityLike`) + a local shape-guard (`isOwnedLabelsCapabilityShape`).
//
// This contract PINS the vendored guard to the FROZEN real capability SHAPE — the
// ordered-7-label tuple + v/audience/expiresAt/sig of the exact primitive types that
// `provider-wire/codec.ts`'s private `isValidCapability` (and the leaf's
// `OwnedLabelsCapability`) require. The fixture is built to that exact shape; a guard
// that drifts (accepts a malformed cap, or rejects a real-shaped one) fails here.
//
// ★ The fixture is HAND-BUILT (not minted): the real mint lives in
// `@armyofagents/provider-capability`, and depending on it from worker-daemon would
// create a `pnpm -r build` ORDER cycle (that leaf builds FROM worker-daemon). The
// real cap↔real gate crossing is proven end-to-end in the adapter-manager component
// test (`dep-011-slice-2a-crossing.component.test.ts`), which already sits below that
// leaf with no cycle.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { isOwnedLabelsCapabilityShape } from "../lease/owned-labels-capability.js";
import type { ResourceLabels } from "../supervisor/provider.js";

const LABELS: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 3,
  leaseId: "lease-1",
  deviceGeneration: 7,
};

/** A capability of the EXACT frozen shape (`v:1`/`audience:"adapter-manager"`, the ordered
 * 7-label tuple, an integer `expiresAt`, a base64url `sig`). */
function realShapedCapability(): Record<string, unknown> {
  return { v: 1, audience: "adapter-manager", ownedLabels: { ...LABELS }, expiresAt: 1_000_000, sig: "c2ln" };
}

describe("isOwnedLabelsCapabilityShape — the vendored guard pinned to the frozen cap shape", () => {
  it("ACCEPTS a real-shaped capability", () => {
    expect(isOwnedLabelsCapabilityShape(realShapedCapability())).toBe(true);
  });

  it("REJECTS non-records", () => {
    expect(isOwnedLabelsCapabilityShape(null)).toBe(false);
    expect(isOwnedLabelsCapabilityShape(undefined)).toBe(false);
    expect(isOwnedLabelsCapabilityShape("x")).toBe(false);
    expect(isOwnedLabelsCapabilityShape([])).toBe(false);
  });

  it("REJECTS a capability missing or mistyping each top-level field", () => {
    const good = realShapedCapability();
    for (const drop of ["v", "audience", "expiresAt", "sig", "ownedLabels"] as const) {
      const bad: Record<string, unknown> = { ...good };
      delete bad[drop];
      expect(isOwnedLabelsCapabilityShape(bad), `missing ${drop}`).toBe(false);
    }
    expect(isOwnedLabelsCapabilityShape({ ...good, v: "1" })).toBe(false);
    expect(isOwnedLabelsCapabilityShape({ ...good, audience: 1 })).toBe(false);
    expect(isOwnedLabelsCapabilityShape({ ...good, expiresAt: "soon" })).toBe(false);
    expect(isOwnedLabelsCapabilityShape({ ...good, sig: 1 })).toBe(false);
    expect(isOwnedLabelsCapabilityShape({ ...good, ownedLabels: "x" })).toBe(false);
  });

  it("REJECTS a capability whose ownedLabels drop or mistype any of the 7 fields", () => {
    const good = realShapedCapability();
    for (const drop of Object.keys(LABELS) as (keyof ResourceLabels)[]) {
      const labels: Record<string, unknown> = { ...LABELS };
      delete labels[drop];
      expect(isOwnedLabelsCapabilityShape({ ...good, ownedLabels: labels }), `missing label ${drop}`).toBe(false);
    }
    // attempt/deviceGeneration are NUMBERS; a string is a forgery-adjacent drift.
    expect(isOwnedLabelsCapabilityShape({ ...good, ownedLabels: { ...LABELS, attempt: "3" } })).toBe(false);
    expect(isOwnedLabelsCapabilityShape({ ...good, ownedLabels: { ...LABELS, deviceGeneration: "7" } })).toBe(false);
    expect(isOwnedLabelsCapabilityShape({ ...good, ownedLabels: { ...LABELS, organizationId: 1 } })).toBe(false);
  });
});
