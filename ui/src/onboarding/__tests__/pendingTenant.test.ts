import { describe, it, expect, beforeEach } from "vitest";
import {
  pendingTenantKey,
  readPendingTenant,
  writePendingTenant,
  clearPendingTenant,
} from "../pendingTenant";

describe("pendingTenant durability", () => {
  beforeEach(() => localStorage.clear());

  it("namespaces the storage key by userId", () => {
    expect(pendingTenantKey("u1")).toBe("aoa.onboarding.pendingTenant.u1");
  });

  it("round-trips a written tenant", () => {
    writePendingTenant("u1", { id: "org1", name: "Acme Org" });
    expect(readPendingTenant("u1")).toEqual({ id: "org1", name: "Acme Org" });
  });

  it("round-trips an unconfirmed creation attempt", () => {
    const attempt = {
      creationRequestId: "d259a6f1-d10a-4f79-a057-d47d3ef11152",
      name: "Acme Org",
    };
    writePendingTenant("u1", attempt);
    expect(readPendingTenant("u1")).toEqual(attempt);
  });

  it("returns null when nothing is stored", () => {
    expect(readPendingTenant("u1")).toBeNull();
  });

  it("returns null for malformed / partial JSON", () => {
    localStorage.setItem(pendingTenantKey("u1"), "not json");
    expect(readPendingTenant("u1")).toBeNull();
    localStorage.setItem(pendingTenantKey("u1"), JSON.stringify({ id: "org1" }));
    expect(readPendingTenant("u1")).toBeNull();
    localStorage.setItem(
      pendingTenantKey("u1"),
      JSON.stringify({ name: "Acme", creationRequestId: "not-a-uuid" }),
    );
    expect(readPendingTenant("u1")).toBeNull();
  });

  it("clear removes the hint", () => {
    writePendingTenant("u1", { id: "org1", name: "Acme Org" });
    clearPendingTenant("u1");
    expect(readPendingTenant("u1")).toBeNull();
  });
});
