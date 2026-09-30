import { describe, expect, it } from "vitest";
import {
  decideOutputTransfer,
  decideSharedStoreTransfer,
  SHARED_STORE_DESTINATION,
  type TransferDestination,
} from "../services/reconcile-locality.js";

// DAT-006 §6 (13)-(14) — PURE locality decision over the frozen PLACEMENT_MATRIX.

const OWNER_DEVICE: TransferDestination = { scope: "owner", sameOwner: true, sameOrganization: true };

describe("DAT-006 reconcile locality decision (pure)", () => {
  it("(13) owner_device_only output against the shared store is DENIED", () => {
    const decision = decideSharedStoreTransfer("owner_desktop", "owner_device_only");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("owner_device_only_denied");
  });

  it("(13b) owner_device_only against a differently-owned owner device is DENIED", () => {
    const decision = decideOutputTransfer({
      placementTargetClass: "owner_desktop",
      dataLocality: "owner_device_only",
      destination: { scope: "owner", sameOwner: false, sameOrganization: true },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("owner_device_only_denied");
  });

  it("(13c) owner_device_only to the SAME owner device is allowed", () => {
    const decision = decideOutputTransfer({
      placementTargetClass: "owner_desktop",
      dataLocality: "owner_device_only",
      destination: OWNER_DEVICE,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("same_owner_device");
  });

  it("(14) transfer_allowed output promotes to the shared store", () => {
    for (const cls of ["managed_cloud", "organization_dedicated", "owner_desktop"]) {
      const decision = decideSharedStoreTransfer(cls, "transfer_allowed");
      expect(decision.allowed, cls).toBe(true);
      expect(decision.reason).toBe("transfer_allowed");
    }
  });

  it("organization_target_only denies transfer to the shared platform store", () => {
    const decision = decideSharedStoreTransfer("organization_dedicated", "organization_target_only");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("organization_target_only_denied");
  });

  it("organization_target_only allows a same-org non-platform target", () => {
    const decision = decideOutputTransfer({
      placementTargetClass: "organization_dedicated",
      dataLocality: "organization_target_only",
      destination: { scope: "organization", sameOwner: false, sameOrganization: true },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("same_organization_target");
  });

  it("fails closed on an unknown target class", () => {
    expect(decideSharedStoreTransfer("bogus_class", "transfer_allowed"))
      .toEqual({ allowed: false, reason: "unknown_target_class" });
  });

  it("fails closed on a locality outside the frozen matrix row (incoherent placement)", () => {
    // managed_cloud only permits `transfer_allowed`; owner_device_only is incoherent.
    expect(decideSharedStoreTransfer("managed_cloud", "owner_device_only"))
      .toEqual({ allowed: false, reason: "incoherent_placement" });
    // A garbage locality string is also incoherent.
    expect(decideSharedStoreTransfer("owner_desktop", "not_a_locality"))
      .toEqual({ allowed: false, reason: "incoherent_placement" });
  });

  it("the shared-store destination is platform / not-owner / cross-org", () => {
    expect(SHARED_STORE_DESTINATION).toEqual({ scope: "platform", sameOwner: false, sameOrganization: false });
  });
});
