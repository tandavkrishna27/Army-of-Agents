// server/src/__tests__/provider-resolution-resolve.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => ({
  providerConnections: {}, providerAssignments: {}, companyMemberships: {},
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }), eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  or: (...a: unknown[]) => ({ or: a }), isNull: (a: unknown) => ({ isNull: a }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));

import { resolveProviderCredential } from "../services/provider-resolution.js";
import { ProviderCredentialBindingError } from "../services/provider-credential-bindings.js";
import { SecretCandidateUnavailableError } from "../secrets/secret-candidate-errors.js";

// Minimal deps double: no assignment rows → must fall back to the legacy path.
function makeDeps(overrides: Partial<Parameters<typeof resolveProviderCredential>[2]> = {}) {
  return {
    loadCandidateRows: vi.fn(async () => []),
    resolveSecretValueForConnection: vi.fn(async () => null),
    resolveSubscriptionEnv: vi.fn(async () => ({})),
    envVarForProvider: () => "ANTHROPIC_API_KEY",
    // legacy hooks: return a REAL env delta so a legacy company key produces a
    // non-empty patch (empty → host_login_fallback, which contradicts the "legacy"
    // assertion below — M9). Tests that want host_login_fallback override this.
    legacyResolveConfig: vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: "sk-legacy" } })),
    legacySubscriptionEnv: vi.fn(async () => null),
    selfHostedSingleTenant: true,
    ...overrides,
  };
}

const args = {
  organizationId: null, companyId: "co1", agentId: "ag1", actorKind: "crew" as const,
  adapterType: "claude_local", provider: "anthropic", executionTargetId: "control-plane",
  currentEnv: {} as Record<string, string>,
  context: { consumerType: "agent" as const, consumerId: "ag1", actorType: "agent" as const, actorId: "ag1" },
};

describe("resolveProviderCredential", () => {
  it("agent already carries the api key → agent_env_override, no injection", async () => {
    const deps = makeDeps();
    const r = await resolveProviderCredential(
      {} as never,
      { ...args, currentEnv: { ANTHROPIC_API_KEY: "sk-mine" } },
      deps as never,
    );
    expect(r.source).toBe("agent_env_override");
    expect(deps.loadCandidateRows).not.toHaveBeenCalled();
  });

  it("no new-model assignment → falls back to legacy path", async () => {
    const deps = makeDeps();
    const r = await resolveProviderCredential({} as never, args, deps as never);
    expect(r.source).toBe("legacy");
    expect(deps.legacyResolveConfig).toHaveBeenCalled();
  });

  it("passes the POST-legacy env into legacySubscriptionEnv (BUG C fix — company-key-present ordering)", async () => {
    // legacyResolveConfig injects ANTHROPIC_API_KEY; the subscription-home closure
    // must receive that POST-fallback env so a company-key-present run skips the
    // subscription home (pre-P4 ordering), not the raw pre-fallback env.
    const deps = makeDeps();
    await resolveProviderCredential({} as never, args, deps as never);
    expect(deps.legacySubscriptionEnv).toHaveBeenCalledWith({ ANTHROPIC_API_KEY: "sk-legacy" });
  });

  it("verified company_default api_key → connection env patch", async () => {
    const deps = makeDeps({
      loadCandidateRows: vi.fn(async () => [{
        connectionId: "conn1", authMethod: "api_key", scopeType: "company_default",
        priority: 0, connectionUpdatedAt: 1, state: "verified", termsAttestedAt: new Date(),
        sharingPolicy: "company_agents", connectionCompanyId: "co1", connectionOwnerUserId: null,
        executionTargetId: null, config: {}, secretRef: "sec1",
      }]),
      resolveSecretValueForConnection: vi.fn(async () => "sk-company"),
    });
    const r = await resolveProviderCredential({} as never, args, deps as never);
    expect(r.source).toBe("connection");
    if (r.source === "connection") expect(r.envPatch).toEqual({ ANTHROPIC_API_KEY: "sk-company" });
  });

  it("higher-priority secretRef throws (deleted secret) → skips + resolves via valid company_default (dead-key lockout fix — Codex ②)", async () => {
    const deps = makeDeps({
      loadCandidateRows: vi.fn(async () => [
        {
          connectionId: "conn-dead", authMethod: "api_key", scopeType: "agent_override",
          priority: 0, connectionUpdatedAt: 2, state: "verified", termsAttestedAt: new Date(),
          sharingPolicy: "company_agents", connectionCompanyId: "co1", connectionOwnerUserId: null,
          executionTargetId: null, config: {}, secretRef: "deleted-sec",
        },
        {
          connectionId: "conn-ok", authMethod: "api_key", scopeType: "company_default",
          priority: 0, connectionUpdatedAt: 1, state: "verified", termsAttestedAt: new Date(),
          sharingPolicy: "company_agents", connectionCompanyId: "co1", connectionOwnerUserId: null,
          executionTargetId: null, config: {}, secretRef: "sec-ok",
        },
      ]),
      resolveSecretValueForConnection: vi.fn(
        async (_db: unknown, row: { secretRef: string | null }) => {
          if (row.secretRef === "deleted-sec") {
            throw new SecretCandidateUnavailableError("secret_missing", "Secret not found");
          }
          return "sk-company";
        },
      ),
    });
    const r = await resolveProviderCredential({} as never, args, deps as never);
    expect(r.source).toBe("connection");
    if (r.source === "connection") {
      expect(r.connectionId).toBe("conn-ok");
      expect(r.envPatch).toEqual({ ANTHROPIC_API_KEY: "sk-company" });
    }
  });

  it("sole secretRef candidate throws → continues to legacy fallback, never aborts (Codex ②)", async () => {
    const deps = makeDeps({
      loadCandidateRows: vi.fn(async () => [
        {
          connectionId: "conn-dead", authMethod: "api_key", scopeType: "company_default",
          priority: 0, connectionUpdatedAt: 1, state: "verified", termsAttestedAt: new Date(),
          sharingPolicy: "company_agents", connectionCompanyId: "co1", connectionOwnerUserId: null,
          executionTargetId: null, config: {}, secretRef: "deleted-sec",
        },
      ]),
      resolveSecretValueForConnection: vi.fn(async () => {
        throw new SecretCandidateUnavailableError("secret_missing", "Secret not found");
      }),
    });
    const r = await resolveProviderCredential({} as never, args, deps as never);
    // makeDeps default selfHostedSingleTenant:true → a dead key falls through to
    // the legacy ladder instead of aborting the resolver.
    expect(r.source).toBe("legacy");
  });

  it("generic secret failures abort without trying lower candidates or legacy", async () => {
    const infrastructureFailure = new Error("database unavailable");
    const resolveSecretValueForConnection = vi.fn(async () => {
      throw infrastructureFailure;
    });
    const deps = makeDeps({
      loadCandidateRows: vi.fn(async () => [
        {
          connectionId: "conn-high", authMethod: "api_key", scopeType: "agent_override",
          priority: 10, connectionUpdatedAt: 2, state: "verified", termsAttestedAt: new Date(),
          sharingPolicy: "company_agents", connectionCompanyId: "co1", connectionOwnerUserId: null,
          executionTargetId: null, config: {}, secretRef: "sec-high",
        },
        {
          connectionId: "conn-low", authMethod: "api_key", scopeType: "company_default",
          priority: 0, connectionUpdatedAt: 1, state: "verified", termsAttestedAt: new Date(),
          sharingPolicy: "company_agents", connectionCompanyId: "co1", connectionOwnerUserId: null,
          executionTargetId: null, config: {}, secretRef: "sec-low",
        },
      ]),
      resolveSecretValueForConnection,
    });

    await expect(resolveProviderCredential({} as never, args, deps as never)).rejects.toBe(infrastructureFailure);
    expect(resolveSecretValueForConnection).toHaveBeenCalledTimes(1);
    expect(deps.legacyResolveConfig).not.toHaveBeenCalled();
  });

  it("only typed subscription binding failures fall through", async () => {
    const candidate = {
      connectionId: "conn-sub", authMethod: "personal_subscription", scopeType: "agent_override",
      priority: 0, connectionUpdatedAt: 1, state: "verified", termsAttestedAt: new Date(),
      sharingPolicy: "owner_only", connectionCompanyId: "co1", connectionOwnerUserId: "owner-1",
      executionTargetId: "control-plane", config: {}, secretRef: null,
    };
    const typedDeps = makeDeps({
      loadCandidateRows: vi.fn(async () => [candidate]),
      resolveSubscriptionEnv: vi.fn(async () => {
        throw new ProviderCredentialBindingError("binding_missing", "No binding");
      }),
    });
    await expect(resolveProviderCredential({} as never, args, typedDeps as never)).resolves.toMatchObject({ source: "legacy" });

    const filesystemFailure = new Error("EACCES");
    const genericDeps = makeDeps({
      loadCandidateRows: vi.fn(async () => [candidate]),
      resolveSubscriptionEnv: vi.fn(async () => {
        throw filesystemFailure;
      }),
    });
    await expect(resolveProviderCredential({} as never, args, genericDeps as never)).rejects.toBe(filesystemFailure);
    expect(genericDeps.legacyResolveConfig).not.toHaveBeenCalled();
  });
});
