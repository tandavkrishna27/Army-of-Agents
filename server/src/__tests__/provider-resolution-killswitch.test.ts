// server/src/__tests__/provider-resolution-killswitch.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@armyofagents/db", () => ({
  providerConnections: {},
  providerAssignments: {},
  companyMemberships: {},
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  or: (...a: unknown[]) => ({ or: a }),
  isNull: (a: unknown) => ({ isNull: a }),
}));
import { resolveProviderCredential } from "../services/provider-resolution.js";

const args = {
  organizationId: null,
  companyId: "co1",
  agentId: "ag1",
  actorKind: "crew" as const,
  adapterType: "claude_local",
  provider: "anthropic",
  executionTargetId: "control-plane",
  currentEnv: {} as Record<string, string>,
  context: {
    consumerType: "agent" as const,
    consumerId: "ag1",
    actorType: "agent" as const,
    actorId: "ag1",
  },
};

describe("AOA_PROVIDER_RESOLVER=legacy kill-switch", () => {
  it("bypasses the new-model candidate read and resolves via the legacy ladder", async () => {
    const loadCandidateRows = vi.fn(async () => [{ /* would-win connection */ }] as never);
    const r = await resolveProviderCredential({} as never, args, {
      loadCandidateRows,
      resolveSecretValueForConnection: vi.fn(async () => "sk-conn"),
      resolveSubscriptionEnv: vi.fn(async () => ({})),
      envVarForProvider: () => "ANTHROPIC_API_KEY",
      legacyResolveConfig: vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: "sk-legacy" } })),
      legacySubscriptionEnv: vi.fn(async () => null),
      selfHostedSingleTenant: true,
      bypassNewModel: true,
    } as never);
    expect(loadCandidateRows).not.toHaveBeenCalled();
    expect(r.source).toBe("legacy");
    if (r.source === "legacy") expect(r.envPatch).toEqual({ ANTHROPIC_API_KEY: "sk-legacy" });
  });
});
