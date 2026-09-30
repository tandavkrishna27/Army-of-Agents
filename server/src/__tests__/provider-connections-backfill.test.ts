// server/src/__tests__/provider-connections-backfill.test.ts
import { describe, it, expect } from "vitest";
import { planBackfill } from "../services/provider-connections-backfill.js";

describe("planBackfill", () => {
  it("maps a provider:<id> company secret to an api_key connection + company_default assignment", () => {
    const plan = planBackfill({
      companyKeySecrets: [
        { organizationId: "org1", companyId: "co1", secretId: "sec1", providerId: "anthropic" },
      ],
      subscriptionBindings: [],
    });
    expect(plan.connections).toContainEqual(
      expect.objectContaining({
        organizationId: "org1",
        companyId: "co1",
        provider: "anthropic",
        authMethod: "api_key",
        secretRef: "sec1",
        sharingPolicy: "company_agents",
      }),
    );
    expect(plan.assignments).toContainEqual(
      expect.objectContaining({
        organizationId: "org1",
        companyId: "co1",
        provider: "anthropic",
        scopeType: "company_default",
        scopeId: null,
      }),
    );
  });

  it("maps a verified subscription binding to a personal_subscription connection + agent_override", () => {
    const plan = planBackfill({
      companyKeySecrets: [],
      subscriptionBindings: [
        {
          organizationId: "org1",
          companyId: "co1",
          provider: "anthropic",
          ownerUserId: "u1",
          executionTargetId: "t1",
          agentId: "ag1",
        },
      ],
    });
    expect(plan.connections).toContainEqual(
      expect.objectContaining({
        organizationId: "org1",
        authMethod: "personal_subscription",
        secretRef: null,
        ownerUserId: "u1",
        executionTargetId: "t1",
        sharingPolicy: "owner_only",
      }),
    );
    expect(plan.assignments).toContainEqual(
      expect.objectContaining({
        organizationId: "org1",
        scopeType: "agent_override",
        scopeId: "ag1",
      }),
    );
  });
});
