import { describe, expect, it, beforeEach, vi } from "vitest";
import { assertCompanyAccess } from "../routes/authz.js";
import { __resetTenantCache } from "../routes/authz-tenant.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

vi.mock("../services/operator-break-glass.js", () => ({ hasActiveBreakGlass: async () => false }));
const db = { select: () => ({ from: () => ({ where: () => ({ then: (r: any) => Promise.resolve([{ organizationId: "org-1" }]).then(r) }) }) }) } as any;

describe("assertCompanyAccess fails CLOSED without tenant middleware", () => {
  beforeEach(() => { __resetTenantCache(); setDeploymentMode("cloud_auth"); });
  it("403s a non-member even though req.tenant is undefined (middleware skipped)", async () => {
    const req = { actor: { type: "board", source: "session", userId: "u", companyIds: [], organizationIds: [] } } as any; // no req.tenant
    await expect(assertCompanyAccess(db, req, "c1")).rejects.toThrow();
  });
});
