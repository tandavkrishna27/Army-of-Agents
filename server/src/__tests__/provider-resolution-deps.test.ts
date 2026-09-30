// server/src/__tests__/provider-resolution-deps.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@armyofagents/db", () => ({ providerConnections: {}, providerAssignments: {}, companyMemberships: {} }));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }), eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  or: (...a: unknown[]) => ({ or: a }), isNull: (a: unknown) => ({ isNull: a }),
}));
import { buildResolveDeps } from "../services/provider-resolution-deps.js";

describe("buildResolveDeps", () => {
  it("marks self-hosted single-tenant from topology trustBoundary", () => {
    const deps = buildResolveDeps({} as never, {
      trustBoundary: "single_tenant",
    } as never);
    expect(deps.selfHostedSingleTenant).toBe(true);
    const multi = buildResolveDeps({} as never, { trustBoundary: "multi_tenant" } as never);
    expect(multi.selfHostedSingleTenant).toBe(false);
  });
});
