import { describe, it, expect, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { actorMiddleware } = await import("../middleware/auth.js");

function run(mw: ReturnType<typeof actorMiddleware>, req: any): Promise<any> {
  return new Promise((resolve) => mw(req, {} as any, (() => resolve(req.actor)) as any));
}

const baseReq = () => ({ header: (_: string) => undefined, method: "GET", originalUrl: "/" }) as any;

describe("default actor identity (Stage A / A6 + RB4)", () => {
  it("local_trusted WITHOUT escape hatch → type none (no auto-admin)", async () => {
    const mw = actorMiddleware({} as any, { deploymentMode: "local_trusted", devLocalIdentity: false });
    const actor = await run(mw, baseReq());
    expect(actor.type).toBe("none");
  });

  it("local_trusted WITH escape hatch → synthetic board admin", async () => {
    const mw = actorMiddleware({} as any, { deploymentMode: "local_trusted", devLocalIdentity: true });
    const actor = await run(mw, baseReq());
    expect(actor).toMatchObject({
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    });
  });

  it("authenticated + escape-hatch flag → flag ignored (type none)", async () => {
    const mw = actorMiddleware({} as any, { deploymentMode: "authenticated", devLocalIdentity: true });
    const actor = await run(mw, baseReq());
    expect(actor.type).toBe("none");
  });

  it("authenticated WITHOUT any auth → type none", async () => {
    const mw = actorMiddleware({} as any, { deploymentMode: "authenticated", devLocalIdentity: false });
    const actor = await run(mw, baseReq());
    expect(actor.type).toBe("none");
  });
});
