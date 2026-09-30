import { describe, expect, it, beforeEach, vi } from "vitest";
import { assertCompanyAccess } from "../routes/authz.js";
import { __resetTenantCache } from "../routes/authz-tenant.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

const hasActiveBreakGlass = vi.fn();
vi.mock("../services/operator-break-glass.js", () => ({ hasActiveBreakGlass: (...a: any[]) => hasActiveBreakGlass(...a) }));

function db(orgId: string | null) {
  return { select: () => ({ from: () => ({ where: () => ({ then: (r: any) => Promise.resolve(orgId ? [{ organizationId: orgId }] : []).then(r) }) }) }) } as any;
}

describe("assertCompanyAccess — cloud_auth", () => {
  beforeEach(() => { __resetTenantCache(); hasActiveBreakGlass.mockReset(); setDeploymentMode("cloud_auth"); });

  it("passes an org member with company membership", async () => {
    const req = { actor: { type: "board", source: "session", userId: "u", companyIds: ["c1"], organizationIds: ["org-1"] } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).resolves.toBeUndefined();
  });
  it("403s an operator with no membership and NO active grant", async () => {
    hasActiveBreakGlass.mockResolvedValue(false);
    const req = { actor: { type: "board", source: "session", userId: "op", companyIds: [], organizationIds: [], operator: true, isInstanceAdmin: false } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).rejects.toThrow();
  });
  it("passes an operator WITH an active break-glass grant (live TTL)", async () => {
    hasActiveBreakGlass.mockResolvedValue(true);
    const req = { actor: { type: "board", source: "session", userId: "op", companyIds: [], organizationIds: [], operator: true, isInstanceAdmin: false } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).resolves.toBeUndefined();
    expect(hasActiveBreakGlass).toHaveBeenCalledWith(expect.anything(), "op", "c1", "org-1");
  });
  it("403s a member of a DIFFERENT org (IDOR)", async () => {
    const req = { actor: { type: "board", source: "session", userId: "u", companyIds: ["c1"], organizationIds: ["org-2"] } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).rejects.toThrow(/organization/i);
  });
  it("403s an agent key from another company", async () => {
    const req = { actor: { type: "agent", source: "agent_key", companyId: "c2" } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).rejects.toThrow(/another company/i);
  });
});

describe("assertCompanyAccess — self-hosted (not enforced)", () => {
  beforeEach(() => { __resetTenantCache(); setDeploymentMode("authenticated"); });
  it("preserves instance_admin bypass", async () => {
    const req = { actor: { type: "board", source: "session", userId: "op", companyIds: [], isInstanceAdmin: true } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).resolves.toBeUndefined();
  });
  it("preserves local_implicit bypass", async () => {
    const req = { actor: { type: "board", source: "local_implicit", userId: "local-board" } } as any;
    await expect(assertCompanyAccess(db("org-1"), req, "c1")).resolves.toBeUndefined();
  });
});
