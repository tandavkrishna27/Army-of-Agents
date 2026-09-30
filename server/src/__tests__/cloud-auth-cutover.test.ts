import { describe, it, expect, vi } from "vitest";
import { buildBetterAuthConfig } from "../auth/better-auth.js";
import { resolveCompanyOrganizationId, assertCompanyCreateAuthorized } from "../routes/companies.js";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";

const cfg = (deploymentMode: any) => ({
  deploymentMode, deploymentExposure: "public", authBaseUrlMode: "explicit",
  authPublicBaseUrl: "https://a.example.com", googleClientId: "x", googleClientSecret: "y",
  headlessBootstrap: false,
} as any);

describe("first cloud_auth user does NOT become global admin", () => {
  it("wires NO first-user databaseHooks in cloud_auth", () => {
    const built = buildBetterAuthConfig({} as any, cfg("cloud_auth"), [], "secret") as any;
    // Hooks object exists but the user/session create hooks must be absent/no-op.
    expect(built.databaseHooks?.user?.create?.after).toBeUndefined();
    expect(built.databaseHooks?.session?.create?.after).toBeUndefined();
  });
  it("self-hosted STILL wires the first-user promotion hooks", () => {
    const built = buildBetterAuthConfig({} as any, cfg("authenticated"), [], "secret") as any;
    expect(typeof built.databaseHooks.user.create.after).toBe("function");
    expect(typeof built.databaseHooks.session.create.after).toBe("function");
  });
});

describe("company-create org gate (anti-tenant-hop)", () => {
  it("uses the SAME org for authz and for the written company row", async () => {
    const canOrg = vi.fn(async (orgId: string) => orgId === "orgA"); // caller authorized only for orgA
    await expect(
      assertCompanyCreateAuthorized({ canOrg } as any, "orgA", "u1"),
    ).resolves.toBeUndefined();
    await expect(
      assertCompanyCreateAuthorized({ canOrg } as any, "orgB", "u1"),
    ).rejects.toThrow(/organization/i);
    // The org written to the company is exactly the org that was authorized.
    expect(resolveCompanyOrganizationId({ organizationId: "orgA" } as any)).toBe("orgA");
  });
  it("explicitly resolves the Default Organization when the client omits organizationId (self-hosted)", () => {
    // TEN-006a / E2-D07: this is the PRESERVED explicit self-hosted resolution —
    // the non-enforced branch of resolveCompanyOrganizationId returns the Default
    // Org as a concrete, documented value (not a silent writer-side `??`).
    expect(resolveCompanyOrganizationId({} as any)).toBe(DEFAULT_ORGANIZATION_ID);
  });
});
