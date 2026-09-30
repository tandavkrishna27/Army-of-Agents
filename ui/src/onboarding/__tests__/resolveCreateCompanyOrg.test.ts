import { describe, it, expect } from "vitest";
import { resolveCreateCompanyOrg } from "../resolveCreateCompanyOrg";
import type { OrganizationMembership } from "../../api/organizations";

const m = (over: Partial<OrganizationMembership>): OrganizationMembership => ({
  id: "mem-1",
  organizationId: "org",
  organizationName: "Organization",
  organizationSlug: "organization",
  userId: "u1",
  role: "owner",
  status: "active",
  ...over,
});

describe("resolveCreateCompanyOrg", () => {
  it("one create-capable org among mixed roles -> auto-picks it (orgA owner, orgB member)", () => {
    expect(
      resolveCreateCompanyOrg([
        m({ id: "m1", organizationId: "orgA", role: "owner" }),
        m({ id: "m2", organizationId: "orgB", role: "member" }),
      ]),
    ).toEqual({ kind: "org", organizationId: "orgA" });
  });

  it("admin also counts as create-capable", () => {
    expect(resolveCreateCompanyOrg([m({ organizationId: "orgA", role: "admin" })])).toEqual({
      kind: "org",
      organizationId: "orgA",
    });
  });

  it("no create-capable orgs (member + billing) -> needs-org", () => {
    expect(
      resolveCreateCompanyOrg([
        m({ id: "m1", organizationId: "orgB", role: "member" }),
        m({ id: "m2", organizationId: "orgC", role: "billing" }),
      ]),
    ).toEqual({ kind: "needs-org" });
  });

  it("empty memberships -> needs-org", () => {
    expect(resolveCreateCompanyOrg([])).toEqual({ kind: "needs-org" });
  });

  it("two or more create-capable orgs -> ambiguous (no picker)", () => {
    expect(
      resolveCreateCompanyOrg([
        m({ id: "m1", organizationId: "orgA", role: "owner" }),
        m({ id: "m2", organizationId: "orgB", role: "admin" }),
      ]),
    ).toEqual({ kind: "ambiguous", organizationIds: ["orgA", "orgB"] });
  });

  it("excludes a non-active (suspended) owner, so it is never miscounted as create-capable", () => {
    expect(
      resolveCreateCompanyOrg([
        m({ id: "m1", organizationId: "orgA", role: "owner", status: "suspended" }),
        m({ id: "m2", organizationId: "orgB", role: "owner", status: "active" }),
      ]),
    ).toEqual({ kind: "org", organizationId: "orgB" });
  });

  it("dedupes multiple create-capable memberships in the same org", () => {
    expect(
      resolveCreateCompanyOrg([
        m({ id: "m1", organizationId: "orgA", role: "owner" }),
        m({ id: "m2", organizationId: "orgA", role: "admin" }),
      ]),
    ).toEqual({ kind: "org", organizationId: "orgA" });
  });
});
