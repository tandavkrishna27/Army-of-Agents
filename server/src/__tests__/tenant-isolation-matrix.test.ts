import { describe, expect, it, beforeEach, vi } from "vitest";
import { assertCompanyAccess } from "../routes/authz.js";
import { __resetTenantCache } from "../routes/authz-tenant.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { createStorageService } from "../storage/service.js";

// hasActiveBreakGlass is the live-TTL operator check. Only "op-granted" has an
// active grant; "op-expired"/"op-none" model no-grant and expired-grant (the
// TTL query returns zero rows either way).
vi.mock("../services/operator-break-glass.js", () => ({
  hasActiveBreakGlass: async (_db: unknown, u: string) => u === "op-granted",
}));

// resolveCompanyTenant reads companies.organization_id — return the owning org.
const db = (org: string) =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({ then: (r: any) => Promise.resolve([{ organizationId: org }]).then(r) }),
      }),
    }),
  }) as any;

const noQueryDb = () => ({
  select: () => {
    throw new Error("authorization must consume the middleware's live scope snapshot");
  },
}) as any;

const ORG_A = "org-A";
const ORG_B = "org-B";
const CO_A = "company-A";

/**
 * assertCompanyAccess is THE chokepoint every company-scoped route funnels
 * through (Task 8 codemod: ~538 awaited call sites across routes/, mcp/server.ts,
 * and the approvals/preview-proxy/thread-deliverables services). Proving the
 * chokepoint denies each cross-tenant vector proves the boundary for every
 * domain that uses it — issues, memory, artifacts, costs, secrets, agents,
 * discussions, and MCP inbound alike.
 */
describe("tenant isolation matrix — assertCompanyAccess chokepoint (cloud_auth)", () => {
  beforeEach(() => {
    __resetTenantCache();
    setDeploymentMode("cloud_auth");
  });

  it("passes an org member who also holds company membership (control)", async () => {
    const req = {
      actor: {
        type: "board",
        source: "session",
        userId: "u",
        companyIds: [CO_A],
        organizationIds: [ORG_A],
      },
    } as any;
    await expect(assertCompanyAccess(db(ORG_A), req, CO_A)).resolves.toBeUndefined();
  });

  it("IDOR: a member of a DIFFERENT org cannot read an org-A company", async () => {
    const req = {
      actor: {
        type: "board",
        source: "session",
        userId: "u",
        companyIds: [CO_A],
        organizationIds: [ORG_B],
      },
    } as any;
    await expect(assertCompanyAccess(db(ORG_A), req, CO_A)).rejects.toThrow(/organization/i);
  });

  it("fail-closed: a non-member is denied even when req.tenant middleware never ran", async () => {
    // No req.tenant on the request object — enforcement derives from the STATIC
    // deployment mode, not the mutable per-request hint (which would fail open).
    const req = {
      actor: {
        type: "board",
        source: "session",
        userId: "u",
        companyIds: [],
        organizationIds: [],
      },
    } as any;
    await expect(assertCompanyAccess(db(ORG_A), req, CO_A)).rejects.toThrow();
  });

  it("operator denied WITHOUT an active break-glass grant", async () => {
    const req = {
      actor: {
        type: "board",
        source: "session",
        userId: "op-none",
        companyIds: [],
        organizationIds: [],
        operator: true,
        isInstanceAdmin: false,
      },
    } as any;
    await expect(assertCompanyAccess(db(ORG_A), req, CO_A)).rejects.toThrow();
  });

  it("operator denied AFTER a grant expires (live TTL returns false)", async () => {
    const req = {
      actor: {
        type: "board",
        source: "session",
        userId: "op-expired",
        companyIds: [],
        organizationIds: [],
        operator: true,
        isInstanceAdmin: false,
      },
    } as any;
    await expect(assertCompanyAccess(db(ORG_A), req, CO_A)).rejects.toThrow();
  });

  it("operator allowed WITHIN a live break-glass grant", async () => {
    const req = {
      actor: {
        type: "board",
        source: "session",
        userId: "op-granted",
        companyIds: [],
        organizationIds: [],
        operator: true,
        isInstanceAdmin: false,
      },
    } as any;
    await expect(assertCompanyAccess(db(ORG_A), req, CO_A)).resolves.toBeUndefined();
  });

  it("agent key cannot cross into another company", async () => {
    const req = { actor: { type: "agent", source: "agent_key", companyId: "company-X" } } as any;
    await expect(assertCompanyAccess(db(ORG_A), req, CO_A)).rejects.toThrow(/another company/i);
  });

  it("mcp key cannot cross into another company", async () => {
    const req = { actor: { type: "mcp", source: "mcp_key", companyId: "company-X" } } as any;
    await expect(assertCompanyAccess(db(ORG_A), req, CO_A)).rejects.toThrow(/another company/i);
  });

  it("allows a same-company mcp key whose owner has active org and company memberships", async () => {
    const req = {
      actor: {
        type: "mcp",
        source: "mcp_key",
        userId: "mcp-active",
        companyId: CO_A,
        companyIds: [CO_A],
      },
    } as any;
    await expect(assertCompanyAccess(noQueryDb(), req, CO_A)).resolves.toBeUndefined();
  });

  it("denies a same-company mcp key after its owner's org membership is suspended", async () => {
    const req = {
      actor: {
        type: "mcp",
        source: "mcp_key",
        userId: "mcp-suspended",
        companyId: CO_A,
        companyIds: [],
      },
    } as any;
    await expect(assertCompanyAccess(noQueryDb(), req, CO_A)).rejects.toThrow(/active company access/i);
  });

  it("denies a same-company mcp key when the company membership is inactive", async () => {
    const req = {
      actor: {
        type: "mcp",
        source: "mcp_key",
        userId: "mcp-no-company",
        companyId: CO_A,
        companyIds: [],
      },
    } as any;
    await expect(assertCompanyAccess(noQueryDb(), req, CO_A)).rejects.toThrow(/active company access/i);
  });

  it("fails closed for a same-company mcp key without its owning user id", async () => {
    const req = {
      actor: { type: "mcp", source: "mcp_key", companyId: CO_A, companyIds: [CO_A] },
    } as any;
    await expect(assertCompanyAccess(noQueryDb(), req, CO_A)).rejects.toThrow(/active company access/i);
  });

  it("an unauthenticated actor is rejected", async () => {
    const req = { actor: { type: "none", source: "none" } } as any;
    await expect(assertCompanyAccess(db(ORG_A), req, CO_A)).rejects.toThrow();
  });
});

describe("tenant isolation matrix — self-hosted bypass preserved (not enforced)", () => {
  beforeEach(() => {
    __resetTenantCache();
    setDeploymentMode("authenticated");
  });

  it("instance_admin retains the data-plane bypass in self-hosted", async () => {
    const req = {
      actor: {
        type: "board",
        source: "session",
        userId: "op",
        companyIds: [],
        isInstanceAdmin: true,
      },
    } as any;
    await expect(assertCompanyAccess(db(ORG_A), req, CO_A)).resolves.toBeUndefined();
  });

  it("local_implicit loopback retains the bypass in self-hosted", async () => {
    const req = { actor: { type: "board", source: "local_implicit", userId: "local-board" } } as any;
    await expect(assertCompanyAccess(db(ORG_A), req, CO_A)).resolves.toBeUndefined();
  });

  it("same-company mcp keys retain their legacy self-hosted behavior without membership rows", async () => {
    const noQueryDb = {
      select: () => {
        throw new Error("self-hosted MCP access must not query cloud membership");
      },
    } as any;
    const req = {
      actor: {
        type: "mcp",
        source: "mcp_key",
        userId: "local-mcp-user",
        companyId: CO_A,
      },
    } as any;
    await expect(assertCompanyAccess(noQueryDb, req, CO_A)).resolves.toBeUndefined();
  });
});

describe("tenant isolation matrix — storage cross-tenant object keys", () => {
  function fakeProvider() {
    return {
      id: "local_disk" as const,
      putObject: async () => {},
      getObject: async () => ({ stream: undefined, contentLength: 1, lastModified: new Date() }) as any,
      headObject: async () => ({ exists: true }) as any,
      deleteObject: async () => {},
    };
  }

  it("denies serving another tenant's object key", async () => {
    await expect(
      createStorageService(fakeProvider()).getObject(
        ORG_A,
        CO_A,
        `${ORG_B}/${CO_A}/assets/2026/01/01/x.txt`,
      ),
    ).rejects.toThrow(/organization|tenant|belong/i);
  });

  it("denies a key belonging to a different company", async () => {
    await expect(
      createStorageService(fakeProvider()).getObject(ORG_A, CO_A, "company-Z/assets/x.txt"),
    ).rejects.toThrow(/belong/i);
  });
});
