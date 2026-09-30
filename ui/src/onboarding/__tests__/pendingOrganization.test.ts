import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingOrganization,
  pendingOrganizationKey,
  readPendingOrganization,
  writePendingOrganization,
} from "../pendingOrganization";

describe("pendingOrganization durability", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips confirmed companies and unconfirmed attempts", () => {
    writePendingOrganization("u1", { id: "company-1", name: "Acme" });
    expect(readPendingOrganization("u1")).toEqual({ id: "company-1", name: "Acme" });

    const attempt = {
      creationRequestId: "d259a6f1-d10a-4f79-a057-d47d3ef11152",
      name: "Acme",
      organizationId: "00000000-0000-0000-0000-0000000000a1",
    };
    writePendingOrganization("u1", attempt);
    expect(readPendingOrganization("u1")).toEqual(attempt);
  });

  it("rejects malformed records and clears a valid hint", () => {
    localStorage.setItem(pendingOrganizationKey("u1"), JSON.stringify({ name: "Acme" }));
    expect(readPendingOrganization("u1")).toBeNull();
    localStorage.setItem(
      pendingOrganizationKey("u1"),
      JSON.stringify({ name: "Acme", creationRequestId: "not-a-uuid" }),
    );
    expect(readPendingOrganization("u1")).toBeNull();
    writePendingOrganization("u1", { id: "company-1", name: "Acme" });
    clearPendingOrganization("u1");
    expect(readPendingOrganization("u1")).toBeNull();
  });
});
