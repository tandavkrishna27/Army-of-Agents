import { describe, expect, it, beforeEach } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";

// access.ts isInstanceAdmin() must return false in cloud even with an instance_user_roles row.
function db(hasAdminRow: boolean) {
  return {
    select: () => ({ from: () => ({ where: () => ({ then: (r: any) => Promise.resolve(hasAdminRow ? [{ id: "role-1" }] : []).then(r) }) }) }),
  } as any;
}
import { accessService } from "../services/access.js";

describe("access.isInstanceAdmin mode-aware (B1)", () => {
  beforeEach(() => setDeploymentMode("local_trusted"));
  it("true in self-hosted when the row exists", async () => {
    setDeploymentMode("authenticated");
    expect(await accessService(db(true)).isInstanceAdmin("op")).toBe(true);
  });
  it("FALSE in cloud_auth even when the row exists (no cross-tenant canUser)", async () => {
    setDeploymentMode("cloud_auth");
    const svc = accessService(db(true));
    expect(await svc.isInstanceAdmin("op")).toBe(false);
    // canUser must therefore NOT short-circuit to true for a non-member operator
    // (hasPermission returns false because getMembership finds no active membership).
    expect(await svc.canUser("cB", "op", "tasks:assign" as any)).toBe(false);
  });
});
