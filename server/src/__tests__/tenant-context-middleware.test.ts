import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request } from "express";
import { actorMiddleware } from "../middleware/auth.js";
import { tenantContextMiddleware } from "../middleware/tenant-context.js";

// Promise.all order in auth.ts session path: [instanceUserRoles, companyMemberships, organizationMemberships]
function fakeDb(isAdmin: boolean, companyIds: string[], orgIds: string[]) {
  const chain = (rows: any[]) => ({ from: () => ({ where: () => ({ then: (r: any) => Promise.resolve(rows).then(r) }) }) });
  const calls: any[] = [];
  return {
    select: (cols: any) => {
      calls.push(cols);
      const idx = calls.length - 1;
      if (idx === 0) return chain(isAdmin ? [{ id: "role-1" }] : []);
      if (idx === 1) return chain(companyIds.map((companyId) => ({ companyId })));
      return chain(orgIds.map((organizationId) => ({ organizationId })));
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as any;
}

async function run(db: any, mode: any) {
  const mw = actorMiddleware(db, { deploymentMode: mode, resolveSession: async () => ({ user: { id: "u1" } }) as any });
  const req = { header: () => undefined } as unknown as Request;
  await new Promise<void>((resolve) => mw(req, {} as any, () => resolve()));
  return req.actor;
}

describe("actorMiddleware org + operator + admin clamp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("carries organizationIds and operator=true for an instance admin", async () => {
    const actor = await run(fakeDb(true, ["c1"], ["org-1", "org-2"]), "cloud_auth");
    expect(actor.organizationIds).toEqual(["org-1", "org-2"]);
    expect(actor.operator).toBe(true);
  });

  it("clamps isInstanceAdmin to FALSE in cloud_auth (data bypass removed)", async () => {
    const actor = await run(fakeDb(true, ["c1"], ["org-1"]), "cloud_auth");
    expect(actor.isInstanceAdmin).toBe(false);
    expect(actor.operator).toBe(true); // operator plane preserved
  });

  it("preserves isInstanceAdmin=true in authenticated (self-hosted)", async () => {
    const actor = await run(fakeDb(true, ["c1"], ["org-1"]), "authenticated");
    expect(actor.isInstanceAdmin).toBe(true);
  });
});

describe("tenantContextMiddleware", () => {
  it("sets a reserved req.tenant hint (organizationId null until resolved)", () => {
    const req = {} as any;
    tenantContextMiddleware()(req, {} as any, () => {});
    expect(req.tenant).toEqual({ organizationId: null });
  });
});
