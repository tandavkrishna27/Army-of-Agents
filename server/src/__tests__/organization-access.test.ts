import { describe, it, expect } from "vitest";
import {
  organizationAccessService,
  orgRoleCan,
} from "../services/organization-access.js";

describe("orgRoleCan (role x capability matrix)", () => {
  it("owner can do everything org-scoped", () => {
    for (const cap of [
      "company:create", "company:delete", "org:member:manage",
      "org:role:set", "org:transfer", "org:dissolve", "billing:manage", "company:list:all",
    ] as const) {
      expect(orgRoleCan("owner", cap)).toBe(true);
    }
  });
  it("admin can create/delete companies + manage members but not transfer/billing", () => {
    expect(orgRoleCan("admin", "company:create")).toBe(true);
    expect(orgRoleCan("admin", "org:member:manage")).toBe(true);
    expect(orgRoleCan("admin", "org:transfer")).toBe(false);
    expect(orgRoleCan("admin", "billing:manage")).toBe(false);
  });
  it("member cannot create companies", () => {
    expect(orgRoleCan("member", "company:create")).toBe(false);
    expect(orgRoleCan("member", "company:list:scoped")).toBe(true);
  });
  it("billing can only manage billing + read metadata", () => {
    expect(orgRoleCan("billing", "billing:manage")).toBe(true);
    expect(orgRoleCan("billing", "company:create")).toBe(false);
    expect(orgRoleCan("billing", "company:list:metadata")).toBe(true);
  });
});

describe("ensureOrgMembership authority preservation", () => {
  it("reactivates genuine access and clears break-glass provenance without downgrading", async () => {
    const membership = {
      id: "membership-1",
      organizationId: "org-1",
      userId: "user-1",
      role: "admin",
      status: "suspended",
      createdByBreakGlass: true,
    };
    const conflictUpdates: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
            conflictUpdates.push(config.set);
            return { returning: async () => [{ id: membership.id }] };
          },
        }),
      }),
    };

    await organizationAccessService(db as never).ensureOrgMembership(
      "org-1",
      "user-1",
      "member",
      "active",
    );

    expect(conflictUpdates).toHaveLength(1);
    expect(conflictUpdates[0]).toMatchObject({
      status: "active",
      createdByBreakGlass: false,
    });
    expect(conflictUpdates[0]).toHaveProperty("role");
  });
});

describe("listOrgMemberships", () => {
  it("returns active memberships with their organization display fields", async () => {
    const row = {
      id: "membership-1",
      organizationId: "org-1",
      organizationName: "Acme Holdings",
      organizationSlug: "acme-holdings",
      userId: "user-1",
      role: "owner",
      status: "active",
    };
    const calls: string[] = [];
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => {
            calls.push("innerJoin");
            return { where: async () => [row] };
          },
        }),
      }),
    };

    await expect(organizationAccessService(db as never).listOrgMemberships("user-1"))
      .resolves.toEqual([row]);
    expect(calls).toEqual(["innerJoin"]);
  });
});
