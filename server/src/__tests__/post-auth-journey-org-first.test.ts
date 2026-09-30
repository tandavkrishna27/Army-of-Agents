import { describe, it, expect } from "vitest";
import { resolvePostAuthJourney } from "../services/post-auth-journey.js";

describe("org-first journey resolution", () => {
  it("returning when the user has an org membership even with zero companies", () => {
    const r = resolvePostAuthJourney({
      organizationMemberships: ["org1"], memberships: [], pendingInvitations: [], deepLinkCompanyId: null,
    });
    expect(r.journey).toBe("returning");
    expect(r.targetCompanyId).toBeNull();
  });
  it("founder when no org membership and no invite", () => {
    const r = resolvePostAuthJourney({
      organizationMemberships: [], memberships: [], pendingInvitations: [], deepLinkCompanyId: null,
    });
    expect(r.journey).toBe("founder");
  });
  it("invited when an org invitation exists but no membership", () => {
    const r = resolvePostAuthJourney({
      organizationMemberships: [], memberships: [],
      pendingInvitations: [{ companyId: "c1", companyName: "X", inviteId: "i1", role: "team_member", createdAt: "2026-01-01T00:00:00Z", filed: true }],
      deepLinkCompanyId: null,
    });
    expect(r.journey).toBe("invited");
    expect(r.targetCompanyId).toBe("c1");
  });
});
