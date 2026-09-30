import { describe, expect, it, beforeEach } from "vitest";
import { assertTenantMembership, resolveCompanyTenant, invalidateCompanyTenant, __resetTenantCache } from "../routes/authz-tenant.js";

function dbReturning(orgId: string | null) {
  const calls = { n: 0 };
  const db = { select: () => ({ from: () => ({ where: () => ({ then: (r: any) => { calls.n++; return Promise.resolve(orgId ? [{ organizationId: orgId }] : []).then(r); } }) }) }) } as any;
  return { db, calls };
}

describe("resolveCompanyTenant", () => {
  beforeEach(() => __resetTenantCache());
  it("caches (one DB hit for two calls)", async () => {
    const { db, calls } = dbReturning("org-1");
    expect(await resolveCompanyTenant(db, "c1")).toBe("org-1");
    expect(await resolveCompanyTenant(db, "c1")).toBe("org-1");
    expect(calls.n).toBe(1);
  });
  it("null for a missing company", async () => {
    const { db } = dbReturning(null);
    expect(await resolveCompanyTenant(db, "missing")).toBeNull();
  });
  it("invalidate forces re-fetch", async () => {
    const { db, calls } = dbReturning("org-1");
    await resolveCompanyTenant(db, "c1");
    invalidateCompanyTenant("c1");
    await resolveCompanyTenant(db, "c1");
    expect(calls.n).toBe(2);
  });
});

describe("assertTenantMembership", () => {
  it("passes for a member", () => expect(() => assertTenantMembership({ actor: { organizationIds: ["org-1"] } } as any, "org-1")).not.toThrow());
  it("403s a non-member", () => expect(() => assertTenantMembership({ actor: { organizationIds: ["org-2"] } } as any, "org-1")).toThrow(/organization/i));
  it("no-ops when tenantId null (missing company -> route 404)", () => expect(() => assertTenantMembership({ actor: { organizationIds: [] } } as any, null)).not.toThrow());
});
