// server/src/__tests__/provider-connections-shared.test.ts
import { describe, it, expect } from "vitest";
import {
  AUTH_METHODS,
  SHAREABLE_AUTH_METHODS,
  providerConnectionCreateSchema,
} from "@armyofagents/shared";

describe("provider-connections shared", () => {
  it("lists the three beta auth methods and the two shareable ones", () => {
    expect(AUTH_METHODS).toEqual(["api_key", "personal_subscription", "enterprise_gateway"]);
    expect(SHAREABLE_AUTH_METHODS).not.toContain("personal_subscription");
    expect(SHAREABLE_AUTH_METHODS).toContain("enterprise_gateway");
  });

  it("rejects a personal_subscription create with a secretRef", () => {
    const parsed = providerConnectionCreateSchema.safeParse({
      provider: "anthropic",
      authMethod: "personal_subscription",
      ownerUserId: "u1",
      executionTargetId: "t1",
      secretRef: "s1",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an enterprise_gateway create with baseUrl", () => {
    const parsed = providerConnectionCreateSchema.safeParse({
      provider: "anthropic",
      authMethod: "enterprise_gateway",
      config: { baseUrl: "https://gw.corp.example/v1" },
      secretRef: "s1",
    });
    expect(parsed.success).toBe(true);
  });
});
