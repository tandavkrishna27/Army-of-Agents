import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { actorMiddleware } from "../middleware/auth.js";
import { accessibleCompanyIdsForActor } from "../routes/authz.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

function fakeMcpDb(
  mcpKey: Record<string, unknown>,
  membership: {
    orgActive?: boolean;
    companyActive?: boolean;
    lookupError?: Error;
  } = {},
) {
  let selectCall = 0;
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        then: (resolve: (rows: unknown[]) => unknown) => {
          selectCall += 1;
          // Auth lookup order: board key, agent key, then MCP key.
          // Live cloud predicate: company tenant, org membership, company membership.
          if (selectCall === 4 && membership.lookupError) {
            return Promise.reject(membership.lookupError);
          }
          const rows =
            selectCall === 3 ? [mcpKey]
            : selectCall === 4 ? [{ organizationId: "org-1" }]
            : selectCall === 5 ? (membership.orgActive === false ? [] : [{ id: "org-member" }])
            : selectCall === 6 ? (membership.companyActive === false ? [] : [{ id: "company-member" }])
            : [];
          return Promise.resolve(rows).then(resolve);
        },
      })),
    })),
  }));
  return {
    db: {
      select,
      update,
    } as any,
    select,
    update,
  };
}

async function authenticate(db: any, deploymentMode: "cloud_auth" | "authenticated") {
  const middleware = actorMiddleware(db, { deploymentMode });
  const req = {
    method: "GET",
    originalUrl: "/api/issues/ACM-1",
    header: (name: string) => name.toLowerCase() === "authorization" ? "Bearer mcp-secret" : undefined,
  } as unknown as Request;
  const next = vi.fn();
  await (middleware as any)(req, {} as any, next);
  return { actor: req.actor, next };
}

describe("MCP authentication live cloud membership", () => {
  beforeEach(() => {
    setDeploymentMode("cloud_auth");
  });

  it("constructs a scoped MCP actor only after live cloud membership succeeds", async () => {
    const { db, select, update } = fakeMcpDb({
      id: "key-1",
      userId: "user-1",
      companyId: "company-1",
    });

    const { actor, next } = await authenticate(db, "cloud_auth");

    expect(select).toHaveBeenCalledTimes(6);
    expect(actor).toMatchObject({
      type: "mcp",
      userId: "user-1",
      companyId: "company-1",
      companyIds: ["company-1"],
    });
    expect(accessibleCompanyIdsForActor(actor)).toEqual(["company-1"]);
    expect(update).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("leaves a suspended MCP owner unscoped before bare-identifier resolution", async () => {
    const { db, select, update } = fakeMcpDb(
      {
        id: "key-stale",
        userId: "user-stale",
        companyId: "company-1",
      },
      { orgActive: false },
    );

    const { actor, next } = await authenticate(db, "cloud_auth");

    expect(actor).toEqual({ type: "none", source: "none" });
    expect(accessibleCompanyIdsForActor(actor)).toEqual([]);
    expect(select).toHaveBeenCalledTimes(6);
    expect(update).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("fails closed before membership lookup when a cloud MCP key has no owner", async () => {
    const { db, select, update } = fakeMcpDb({
      id: "key-ownerless",
      userId: null,
      companyId: "company-1",
    });

    const { actor } = await authenticate(db, "cloud_auth");

    expect(actor).toEqual({ type: "none", source: "none" });
    expect(select).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledOnce();
  });

  it("leaves an MCP owner with inactive company membership unscoped", async () => {
    const { db, select, update } = fakeMcpDb(
      {
        id: "key-no-company",
        userId: "user-1",
        companyId: "company-1",
      },
      { companyActive: false },
    );

    const { actor } = await authenticate(db, "cloud_auth");

    expect(actor).toEqual({ type: "none", source: "none" });
    expect(select).toHaveBeenCalledTimes(6);
    expect(update).toHaveBeenCalledOnce();
  });

  it("preserves self-hosted MCP authentication without cloud membership queries", async () => {
    setDeploymentMode("authenticated");
    const { db, select, update } = fakeMcpDb({
      id: "key-local",
      userId: "user-local",
      companyId: "company-1",
    });

    const { actor } = await authenticate(db, "authenticated");

    expect(actor).toMatchObject({
      type: "mcp",
      userId: "user-local",
      companyId: "company-1",
    });
    expect(actor.companyIds).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledOnce();
  });

  it("propagates membership-query failures after recording token presentation", async () => {
    const { db, update } = fakeMcpDb(
      {
        id: "key-1",
        userId: "user-1",
        companyId: "company-1",
      },
      { lookupError: new Error("membership database unavailable") },
    );

    await expect(authenticate(db, "cloud_auth")).rejects.toThrow(/membership database unavailable/i);
    expect(update).toHaveBeenCalledOnce();
  });
});
