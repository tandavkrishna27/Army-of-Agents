import { describe, it, expect } from "vitest";
import { organizationMemberships } from "@armyofagents/db";
import { ORGANIZATION_ROLES } from "@armyofagents/shared";

describe("Phase 1 org contract is present (Phase 2 consumes it)", () => {
  it("organization_memberships table is importable from @armyofagents/db", () => {
    expect(organizationMemberships).toBeDefined();
  });
  it("ORGANIZATION_ROLES is exactly owner/admin/member/billing (P1-owned)", () => {
    expect([...ORGANIZATION_ROLES]).toEqual(["owner", "admin", "member", "billing"]);
  });
});
