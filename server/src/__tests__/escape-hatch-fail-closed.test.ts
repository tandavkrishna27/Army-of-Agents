import { describe, it, expect } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

/**
 * Security backstop for Stage A A6 (revA R5/R6): the synthetic loopback admin
 * (`local-board`, isInstanceAdmin) may ONLY be produced by the dev escape hatch
 * in local_trusted mode. In authenticated mode the flag must be refused —
 * fail-closed — so a stray AOA_DEV_LOCAL_IDENTITY can never mint an admin on a
 * hosted instance.
 */
function run(mw: ReturnType<typeof actorMiddleware>, req: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    void mw(req as never, {} as never, () => resolve((req as { actor: unknown }).actor));
  });
}
const baseReq = () => ({ header: () => undefined, method: "GET", originalUrl: "/api/companies" });

describe("escape hatch is fail-closed in authenticated mode (D7)", () => {
  it("authenticated + AOA_DEV_LOCAL_IDENTITY → NO synthetic admin (actor stays none)", async () => {
    const mw = actorMiddleware({} as never, { deploymentMode: "authenticated", devLocalIdentity: true });
    const actor = await run(mw, baseReq());
    expect(actor.type).toBe("none");
    expect(actor.isInstanceAdmin).not.toBe(true);
  });

  it("local_trusted + flag → synthetic loopback admin (dev path still works)", async () => {
    const mw = actorMiddleware({} as never, { deploymentMode: "local_trusted", devLocalIdentity: true });
    const actor = await run(mw, baseReq());
    expect(actor).toMatchObject({ type: "board", isInstanceAdmin: true, source: "local_implicit" });
  });

  it("local_trusted WITHOUT the flag → no synthetic admin (real identity required)", async () => {
    const mw = actorMiddleware({} as never, { deploymentMode: "local_trusted", devLocalIdentity: false });
    const actor = await run(mw, baseReq());
    expect(actor.type).toBe("none");
  });
});
