// DSK-002 Lane A / I1 + I3 — a folder grant is bound to the DEVICE that presents it.
//
// `folder-grant.ts` resolve() filters on `folderGrantId` + `revokedAt IS NULL`, inside the
// org's RLS scope. It SELECTS `executionTargetId`, `deviceGeneration` and `ownerUserId`,
// returns all three — and compares none of them. So today:
//
//   * a grant issued for desktop A is usable by desktop B in the same organization;
//   * a grant survives the re-enrolment of the device it was issued for; and
//   * a grant survives its owner losing membership.
//
// The precedent for the right behaviour is already in the tree:
// `execution-target-resolver.ts:137` fails closed on exactly this mismatch —
// `if (profile.deviceGeneration !== row.deviceGeneration) return null;`.
// Folder grants simply did not follow it.
//
// D1: this module is the DECLARATION CHECK. It validates the identity a device CLAIMS
// against the grant on record. It is NOT the symlink/containment defence — that is `lstat`
// on the device (`build-manifest.ts`), and no test here may be cited as evidence for it.

import { describe, expect, it } from "vitest";

import {
  bindGrantToDevice,
  GRANT_BINDING_REJECTIONS,
  type PresentedDeviceIdentity,
  type BindableGrant,
} from "../services/folder-grant-binding.js";

const GRANT: BindableGrant = {
  folderGrantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerUserId: "user-1",
  executionTargetId: "11111111-1111-4111-8111-111111111111",
  deviceGeneration: 3,
  declaredBasePath: "work/project",
};

const PRESENTED: PresentedDeviceIdentity = {
  ownerUserId: "user-1",
  executionTargetId: "11111111-1111-4111-8111-111111111111",
  deviceGeneration: 3,
};

describe("DSK-002/I3 — the grant binds to the device presenting it", () => {
  it("binds when target, generation and owner all match", () => {
    expect(bindGrantToDevice(GRANT, PRESENTED)).toEqual({ bound: true });
  });

  it("refuses a grant issued for ANOTHER desktop in the same organization", () => {
    // The org RLS scope is not a device scope. Two desktops in one org both pass RLS.
    const other = { ...PRESENTED, executionTargetId: "22222222-2222-4222-8222-222222222222" };
    expect(bindGrantToDevice(GRANT, other)).toEqual({ bound: false, reason: "wrong_target" });
  });

  it("refuses a grant issued to a PREVIOUS generation of this device", () => {
    // A re-enrolled device is a different device for authority purposes — the whole
    // reason DSK-001 surfaced deviceGeneration in the operator listing.
    expect(bindGrantToDevice(GRANT, { ...PRESENTED, deviceGeneration: 4 }))
      .toEqual({ bound: false, reason: "stale_device_generation" });
  });

  it("refuses a generation LOWER than the grant's, not just higher", () => {
    // A replayed old enrolment must not slip through an `only reject if newer` test.
    expect(bindGrantToDevice(GRANT, { ...PRESENTED, deviceGeneration: 2 }))
      .toEqual({ bound: false, reason: "stale_device_generation" });
  });

  it("refuses a different owner", () => {
    expect(bindGrantToDevice(GRANT, { ...PRESENTED, ownerUserId: "user-2" }))
      .toEqual({ bound: false, reason: "wrong_owner" });
  });

  it("refuses an absent grant without dereferencing it", () => {
    expect(bindGrantToDevice(null, PRESENTED)).toEqual({ bound: false, reason: "grant_absent" });
  });

  it("checks EVERY field — no single match is sufficient", () => {
    // Guards against an implementation joined with `||`. Each case below matches on two
    // of the three fields and must still be refused.
    const wrong = [
      { ...PRESENTED, executionTargetId: "33333333-3333-4333-8333-333333333333" },
      { ...PRESENTED, deviceGeneration: 99 },
      { ...PRESENTED, ownerUserId: "someone-else" },
    ];
    for (const presented of wrong) {
      expect(bindGrantToDevice(GRANT, presented).bound, JSON.stringify(presented)).toBe(false);
    }
  });
});

describe("DSK-002/I3 — the rejection vocabulary is closed and honest", () => {
  it("every reason a binding can return is in the declared vocabulary", () => {
    const produced = [
      bindGrantToDevice(null, PRESENTED),
      bindGrantToDevice(GRANT, { ...PRESENTED, executionTargetId: "x" }),
      bindGrantToDevice(GRANT, { ...PRESENTED, deviceGeneration: 9 }),
      bindGrantToDevice(GRANT, { ...PRESENTED, ownerUserId: "x" }),
    ];
    for (const result of produced) {
      expect(result.bound).toBe(false);
      if (!result.bound) expect(GRANT_BINDING_REJECTIONS).toContain(result.reason);
    }
    // Non-vacuity: the vocabulary is not empty and not a single catch-all.
    expect(GRANT_BINDING_REJECTIONS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(produced.map((r) => (r.bound ? "" : r.reason))).size).toBe(4);
  });
});
