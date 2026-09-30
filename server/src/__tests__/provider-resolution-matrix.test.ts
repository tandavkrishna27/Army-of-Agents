// server/src/__tests__/provider-resolution-matrix.test.ts
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
import {
  resolveProviderCredential,
  ProviderUnavailableError,
  candidateMatchesScope,
  type CandidateRow,
} from "../services/provider-resolution.js";

const row = (o: Partial<CandidateRow>): CandidateRow => ({
  connectionId: "c",
  authMethod: "api_key",
  scopeType: "company_default",
  priority: 0,
  connectionUpdatedAt: 1,
  state: "verified",
  termsAttestedAt: new Date(),
  sharingPolicy: "company_agents",
  connectionCompanyId: "co1",
  connectionOrganizationId: null,
  connectionOwnerUserId: null,
  scopeId: null,
  executionTargetId: null,
  config: {},
  secretRef: "sec",
  ...o,
});

const baseArgs = {
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
const deps = (rows: CandidateRow[], secret = "sk") => ({
  loadCandidateRows: vi.fn(async () => rows),
  resolveSecretValueForConnection: vi.fn(async () => secret),
  resolveSubscriptionEnv: vi.fn(async () => ({ HOME: "/h", CLAUDE_CONFIG_DIR: "/h/anthropic" })),
  envVarForProvider: () => "ANTHROPIC_API_KEY",
  legacyResolveConfig: vi.fn(async (c: Record<string, unknown>) => c),
  legacySubscriptionEnv: vi.fn(async () => null),
  selfHostedSingleTenant: true,
});

describe("multi_tenant personal_subscription backstop (BUG A fix)", () => {
  const subRow = () =>
    row({
      connectionId: "sub",
      scopeType: "agent_override",
      scopeId: "ag1",
      authMethod: "personal_subscription",
      sharingPolicy: "owner_only",
      connectionOwnerUserId: "u1", // CandidateRow field (owner_only self-match for agent runs)
      executionTargetId: "t1",
      secretRef: null,
    });

  it("NEVER resolves a personal_subscription in multi_tenant — fails closed, materialize not reached", async () => {
    const d = deps([subRow()]);
    d.selfHostedSingleTenant = false; // multi_tenant / shared host
    await expect(
      resolveProviderCredential({} as never, baseArgs, d as never),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    // The backstop skips BEFORE Step 3, so the subscription env is never materialized.
    expect(d.resolveSubscriptionEnv).not.toHaveBeenCalled();
  });

  it("does NOT let a backfill-revived agent_override sub resolve on a shared host", async () => {
    // Even a fully verified, terms-attested, owner-matched agent_override sub (the
    // exact shape the boot backfill mints from a legacy credential) is refused.
    const d = deps([subRow()]);
    d.selfHostedSingleTenant = false;
    await expect(
      resolveProviderCredential({} as never, baseArgs, d as never),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("the SAME personal_subscription DOES resolve on self-hosted single-tenant (backstop is topology-scoped)", async () => {
    const d = deps([subRow()]); // selfHostedSingleTenant defaults true
    const r = await resolveProviderCredential({} as never, baseArgs, d as never);
    expect(r.source).toBe("connection");
    expect(d.resolveSubscriptionEnv).toHaveBeenCalled();
  });
});

describe("precedence matrix", () => {
  it("agent_override wins over company + org", async () => {
    const r = await resolveProviderCredential(
      {} as never,
      baseArgs,
      deps([
        row({ connectionId: "org", scopeType: "org_default" }),
        row({ connectionId: "co", scopeType: "company_default" }),
        row({ connectionId: "ag", scopeType: "agent_override", scopeId: "ag1" }),
      ]) as never,
    );
    expect(r.source === "connection" && r.connectionId).toBe("ag");
  });

  it("company_default wins over org_default", async () => {
    const r = await resolveProviderCredential(
      {} as never,
      baseArgs,
      deps([
        row({ connectionId: "org", scopeType: "org_default" }),
        row({ connectionId: "co", scopeType: "company_default" }),
      ]) as never,
    );
    expect(r.source === "connection" && r.connectionId).toBe("co");
  });

  it("org_default personal_subscription is rejected (owner-only) → falls to legacy", async () => {
    const r = await resolveProviderCredential(
      {} as never,
      baseArgs,
      deps([
        row({
          connectionId: "orgSub",
          scopeType: "org_default",
          authMethod: "personal_subscription",
          ownerUserId: "u1",
          executionTargetId: "t1",
          secretRef: null,
        }),
      ]) as never,
    );
    expect(r.source).toBe("host_login_fallback"); // no legacy patch + self-hosted
  });

  it("suspended candidate is skipped", async () => {
    const r = await resolveProviderCredential(
      {} as never,
      baseArgs,
      deps([row({ connectionId: "susp", state: "suspended" })]) as never,
    );
    expect(r.source).not.toBe("connection");
  });

  it("business api_key inherits to org actor (Commander/crew/org all resolve it)", async () => {
    for (const actorKind of ["crew", "org", "commander"] as const) {
      const r = await resolveProviderCredential(
        {} as never,
        { ...baseArgs, actorKind },
        deps([row({ scopeType: "company_default", authMethod: "api_key" })]) as never,
      );
      expect(r.source).toBe("connection");
    }
  });

  it("LEAKAGE: company_agents connection for a different company is skipped", async () => {
    const r = await resolveProviderCredential(
      {} as never,
      baseArgs,
      deps([row({ connectionCompanyId: "OTHER_CO", sharingPolicy: "company_agents" })]) as never,
    );
    expect(r.source).not.toBe("connection");
  });

  it("LEAKAGE: empty secret value injects nothing → not a connection win", async () => {
    const r = await resolveProviderCredential(
      {} as never,
      baseArgs,
      deps([row({})], "") as never,
    );
    expect(r.source).not.toBe("connection");
  });

  it("multi-tenant with a rejected assignment THROWS ProviderUnavailableError (never host login)", async () => {
    const d = deps([row({ connectionId: "rev1", state: "revoked" })]);
    d.selfHostedSingleTenant = false;
    await expect(
      resolveProviderCredential({} as never, baseArgs, d as never),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("multi-tenant with NO assignment and no legacy also fails closed (never host login)", async () => {
    const d = deps([]);
    d.selfHostedSingleTenant = false;
    await expect(
      resolveProviderCredential({} as never, baseArgs, d as never),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("self-hosted single-tenant with no assignment → host_login_fallback (D4 preserved)", async () => {
    const r = await resolveProviderCredential({} as never, baseArgs, deps([]) as never);
    expect(r.source).toBe("host_login_fallback");
  });
});

describe("candidateMatchesScope — M1 cross-tenant leak guard", () => {
  it("companyB (org-2) does NOT match org-1's org_default connection", () => {
    const org1Default = {
      scopeType: "org_default" as const,
      scopeId: null,
      connectionOrganizationId: "org-1",
    };
    expect(candidateMatchesScope(org1Default, { agentId: "agB", organizationId: "org-2" })).toBe(
      false,
    );
  });
  it("companyA (org-1) DOES match org-1's org_default connection", () => {
    const org1Default = {
      scopeType: "org_default" as const,
      scopeId: null,
      connectionOrganizationId: "org-1",
    };
    expect(candidateMatchesScope(org1Default, { agentId: "agA", organizationId: "org-1" })).toBe(
      true,
    );
  });
  it("a run with no organization_id NEVER matches any org_default (fail-closed)", () => {
    const org1Default = {
      scopeType: "org_default" as const,
      scopeId: null,
      connectionOrganizationId: "org-1",
    };
    expect(candidateMatchesScope(org1Default, { agentId: "agX", organizationId: null })).toBe(
      false,
    );
  });
  it("agent_override matches only its own agent id", () => {
    const ovr = {
      scopeType: "agent_override" as const,
      scopeId: "ag1",
      connectionOrganizationId: null,
    };
    expect(candidateMatchesScope(ovr, { agentId: "ag1", organizationId: null })).toBe(true);
    expect(candidateMatchesScope(ovr, { agentId: "ag2", organizationId: null })).toBe(false);
  });
});
