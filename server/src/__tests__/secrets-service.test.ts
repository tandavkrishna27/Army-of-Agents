import { describe, expect, it } from "vitest";
import {
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  runtimeProviderKeys,
  secretAccessEvents,
} from "@armyofagents/db";
import {
  normalizeProviderConfigDefault,
  normalizeProviderConfigStatus,
  secretService,
  shouldEnforceSecretBinding,
} from "../services/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { SecretCandidateUnavailableError } from "../secrets/secret-candidate-errors.js";

function makeThenable<T>(rows: T[]) {
  return {
    then<TResult1 = T[], TResult2 = never>(
      onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
      _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(rows).then(onfulfilled ?? ((value) => value as TResult1));
    },
    orderBy() {
      return this;
    },
  };
}

function makeFakeDb(input: {
  bindings?: unknown[];
  providerConfigs?: unknown[];
  providerKeys?: unknown[];
  secret: any;
  version: any;
}) {
  const inserted: Array<{ table: unknown; values: unknown }> = [];
  const updates: Array<{ table: unknown; values: unknown }> = [];
  const updatedRows = input.secret ? [{ ...input.secret, status: "deleted", deletedAt: new Date() }] : [];
  const db = {
    inserted,
    updates,
    select() {
      return {
        from(table: unknown) {
          const rows =
            table === companySecrets
              ? [input.secret]
              : table === companySecretVersions
                ? [input.version]
                : table === companySecretBindings
                  ? (input.bindings ?? [])
                  : table === companySecretProviderConfigs
                    ? (input.providerConfigs ?? [])
                    : table === runtimeProviderKeys
                      ? (input.providerKeys ?? [])
                      : [];
          return {
            where() {
              return makeThenable(rows);
            },
            orderBy() {
              return makeThenable(rows);
            },
            then: makeThenable(rows).then,
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: unknown) {
          inserted.push({ table, values });
          return Promise.resolve();
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: unknown) {
          updates.push({ table, values });
          return {
            where() {
              return {
                returning() {
                  return makeThenable(updatedRows);
                },
                then: makeThenable(updatedRows).then,
              };
            },
          };
        },
      };
    },
  };
  return db;
}

describe("secretService", () => {
  it("exposes vault, binding, import, and audited resolve APIs", () => {
    const svc = secretService({} as any);

    expect(typeof svc.listProviderConfigs).toBe("function");
    expect(typeof svc.createProviderConfig).toBe("function");
    expect(typeof svc.checkProviderConfig).toBe("function");
    expect(typeof svc.createBinding).toBe("function");
    expect(typeof svc.syncEnvBindingsForTarget).toBe("function");
    expect(typeof svc.normalizeEnvConfigForPersistence).toBe("function");
    expect(typeof svc.previewRemoteImport).toBe("function");
    expect(typeof svc.importRemoteSecrets).toBe("function");
    expect(typeof svc.resolveSecretValue).toBe("function");
  });

  it("rejects generic mutation and deletion of broker-owned OAuth credentials", async () => {
    const secret = {
      id: "secret-oauth",
      companyId: "company-1",
      name: "mcp:oauth:connector-1",
      provider: "local_encrypted",
      managedMode: "aoa_managed",
      latestVersion: 1,
      status: "active",
      deletedAt: null,
      providerMetadata: {
        purpose: "mcp_oauth",
        ownerConnectorId: "connector-1",
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
      },
    };
    const svc = secretService(makeFakeDb({ secret, version: null }) as any);

    await expect(svc.update(secret.id, { description: "tamper" })).rejects.toThrow("broker-managed");
    await expect(svc.rotate(secret.id, { value: "tamper" })).rejects.toThrow("broker-managed");
    await expect(svc.remove(secret.id)).rejects.toThrow("broker-managed");
    await expect(svc.delete(secret.companyId, secret.name)).rejects.toThrow("broker-managed");
  });

  it("rejects broker-owned OAuth credentials in generic env persistence and resolution", async () => {
    const secret = {
      id: "secret-oauth",
      companyId: "company-1",
      name: "mcp:oauth:connector-1",
      provider: "local_encrypted",
      providerConfigId: null,
      externalRef: null,
      managedMode: "aoa_managed",
      latestVersion: 1,
      status: "active",
      deletedAt: null,
      providerMetadata: {
        purpose: "mcp_oauth",
        ownerConnectorId: "connector-1",
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
      },
    };
    const db = makeFakeDb({ secret, version: null, bindings: [] });
    const svc = secretService(db as any);

    await expect(
      svc.normalizeEnvConfigForPersistence("company-1", {
        ATTACKER_TOKEN: {
          type: "secret_ref",
          secretId: "11111111-1111-4111-8111-111111111111",
          version: "latest",
        },
      }),
    ).rejects.toThrow("broker-managed");

    await expect(
      svc.createBinding({
        companyId: "company-1",
        secretId: secret.id,
        targetType: "agent",
        targetId: "attacker-agent",
        configPath: "env.ATTACKER_TOKEN",
      }),
    ).rejects.toThrow("broker-managed");

    await expect(
      svc.resolveSecretValue("company-1", secret.id, "latest", {
        consumerType: "system",
        consumerId: "llm-provider:attacker",
        actorType: "system",
        configPath: "provider.attacker",
      }),
    ).rejects.toThrow(/cannot be used by generic secret consumers/i);
  });

  it("allows only the exact owner through the internal OAuth broker capability", async () => {
    process.env.AOA_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    const prepared = await localEncryptedProvider.createVersion({
      value: "signed-oauth-bundle",
      externalRef: null,
      context: {
        companyId: "company-1",
        secretId: "secret-oauth",
        secretKey: "MCP_OAUTH_CONNECTOR_1",
        secretName: "mcp:oauth:connector-1",
        version: 1,
      },
    });
    const secret = {
      id: "secret-oauth",
      companyId: "company-1",
      name: "mcp:oauth:connector-1",
      provider: "local_encrypted",
      providerConfigId: null,
      externalRef: null,
      latestVersion: 1,
      status: "active",
      deletedAt: null,
      providerMetadata: {
        purpose: "mcp_oauth",
        ownerConnectorId: "connector-1",
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
      },
    };
    const db = makeFakeDb({
      secret,
      version: { secretId: secret.id, version: 1, material: prepared.material },
      bindings: [],
    });
    const svc = secretService(db as any);
    const context = {
      consumerType: "system" as const,
      consumerId: "oauth-broker",
      actorType: "system" as const,
      configPath: "mcp.connector.notion",
      mcpOAuthOwner: {
        connectorId: "connector-1",
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
      },
    };

    await expect(
      svc.resolveSecretValue("company-1", secret.id, "latest", context),
    ).resolves.toBe("signed-oauth-bundle");
    await expect(
      svc.resolveSecretValue("company-1", secret.id, "latest", {
        ...context,
        mcpOAuthOwner: { ...context.mcpOAuthOwner, connectorId: "attacker" },
      }),
    ).rejects.toThrow(/owned by another resource/i);
  });

  it("normalizes env config for persistence with strict validation", async () => {
    await expect(secretService({} as any).normalizeEnvConfigForPersistence("company-1", {
      NODE_ENV: "production",
    }, { strictMode: true })).resolves.toEqual({
      NODE_ENV: { type: "plain", value: "production" },
    });

    await expect(secretService({} as any).normalizeEnvConfigForPersistence("company-1", {
      "1BAD": "value",
    }, { strictMode: true })).rejects.toThrow("Invalid environment variable name");

    await expect(secretService({} as any).normalizeEnvConfigForPersistence("company-1", {
      API_KEY: "sk-test",
    }, { strictMode: true })).rejects.toThrow("Strict secret mode requires secret references");
  });

  it("keeps legacy system reads audited but unbound while enforcing runtime env bindings", () => {
    expect(shouldEnforceSecretBinding({
      consumerType: "system",
      consumerId: "github:auto-push",
      actorType: "system",
      configPath: "github.pat",
    })).toBe(false);

    expect(shouldEnforceSecretBinding({
      consumerType: "routine",
      consumerId: "routine-1",
      actorType: "system",
      configPath: "routine.triggerSecret",
    })).toBe(false);

    expect(shouldEnforceSecretBinding({
      consumerType: "plugin",
      consumerId: "plugin-1",
      actorType: "plugin",
      configPath: "plugin.config.apiKey",
    })).toBe(false);

    expect(shouldEnforceSecretBinding({
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      configPath: "env.OPENAI_API_KEY",
    })).toBe(true);
  });

  it("forces non-AWS external providers to stay coming soon", () => {
    expect(normalizeProviderConfigStatus("gcp_secret_manager", "ready")).toBe("coming_soon");
    expect(normalizeProviderConfigStatus("vault", "disabled")).toBe("coming_soon");
    expect(normalizeProviderConfigStatus("aws_secrets_manager", undefined)).toBe("ready");
    expect(normalizeProviderConfigStatus("aws_secrets_manager", "warning")).toBe("warning");
    expect(normalizeProviderConfigDefault("coming_soon", undefined, true)).toBe(false);
    expect(normalizeProviderConfigDefault("ready", undefined, true)).toBe(true);
  });

  it("audits system reads without requiring legacy binding rows", async () => {
    process.env.AOA_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    const prepared = await localEncryptedProvider.createVersion({
      value: "sk-test",
      externalRef: null,
      context: {
        companyId: "company-1",
        secretId: "secret-1",
        secretKey: "OPENAI_API_KEY",
        secretName: "OpenAI",
        version: 1,
      },
    });
    const db = makeFakeDb({
      secret: {
        id: "secret-1",
        companyId: "company-1",
        provider: "local_encrypted",
        providerConfigId: null,
        externalRef: null,
        latestVersion: 1,
        status: "active",
      },
      version: { secretId: "secret-1", version: 1, material: prepared.material },
      bindings: [],
    });

    await expect(secretService(db as any).resolveSecretValue("company-1", "secret-1", "latest", {
      consumerType: "system",
      consumerId: "llm-provider:openai",
      actorType: "system",
      configPath: "provider.openai",
    })).resolves.toBe("sk-test");

    expect(db.inserted).toEqual([
      expect.objectContaining({
        table: secretAccessEvents,
        values: expect.objectContaining({
          companyId: "company-1",
          secretId: "secret-1",
          consumerType: "system",
          configPath: "provider.openai",
          outcome: "success",
        }),
      }),
    ]);
  });

  it("preserves local encrypted external references for display metadata", async () => {
    process.env.AOA_SECRETS_MASTER_KEY = "12345678901234567890123456789012";

    const prepared = await localEncryptedProvider.createVersion({
      value: "ghp_test",
      externalRef: "octocat",
      context: {
        companyId: "company-1",
        secretId: "secret-1",
        secretKey: "GITHUB_PAT",
        secretName: "GitHub PAT",
        version: 1,
      },
    });

    expect(prepared.externalRef).toBe("octocat");
  });

  it("rejects unbound agent env reads and audits the failure", async () => {
    process.env.AOA_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    const prepared = await localEncryptedProvider.createVersion({
      value: "sk-test",
      externalRef: null,
      context: {
        companyId: "company-1",
        secretId: "secret-1",
        secretKey: "OPENAI_API_KEY",
        secretName: "OpenAI",
        version: 1,
      },
    });
    const db = makeFakeDb({
      secret: {
        id: "secret-1",
        companyId: "company-1",
        provider: "local_encrypted",
        providerConfigId: null,
        externalRef: null,
        latestVersion: 1,
        status: "active",
      },
      version: { secretId: "secret-1", version: 1, material: prepared.material },
      bindings: [],
    });

    const resolution = secretService(db as any).resolveSecretValue("company-1", "secret-1", "latest", {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
      configPath: "env.OPENAI_API_KEY",
    });
    await expect(resolution).rejects.toBeInstanceOf(SecretCandidateUnavailableError);
    await expect(resolution).rejects.toMatchObject({ code: "secret_unbound" });

    expect(db.inserted).toEqual([
      expect.objectContaining({
        table: secretAccessEvents,
        values: expect.objectContaining({
          companyId: "company-1",
          secretId: "secret-1",
          consumerType: "agent",
          consumerId: "agent-1",
          configPath: "env.OPENAI_API_KEY",
          outcome: "failure",
          errorCode: "secret_unbound",
        }),
      }),
    ]);
  });

  it.each([
    {
      label: "missing",
      secret: null,
      version: null,
      providerConfigs: [],
      code: "secret_missing",
      status: 404,
    },
    {
      label: "deleted",
      secret: { id: "secret-1", companyId: "company-1", provider: "local_encrypted", providerConfigId: null, latestVersion: 1, status: "active", deletedAt: new Date() },
      version: null,
      providerConfigs: [],
      code: "secret_missing",
      status: 404,
    },
    {
      label: "inactive",
      secret: { id: "secret-1", companyId: "company-1", provider: "local_encrypted", providerConfigId: null, latestVersion: 1, status: "disabled", deletedAt: null },
      version: null,
      providerConfigs: [],
      code: "secret_inactive",
      status: 422,
    },
    {
      label: "missing version",
      secret: { id: "secret-1", companyId: "company-1", provider: "local_encrypted", providerConfigId: null, latestVersion: 1, status: "active", deletedAt: null },
      version: null,
      providerConfigs: [],
      code: "secret_version_missing",
      status: 404,
    },
    {
      label: "disabled provider config",
      secret: { id: "secret-1", companyId: "company-1", provider: "aws_secrets_manager", providerConfigId: "cfg-1", externalRef: "arn:secret", latestVersion: 1, status: "active", deletedAt: null },
      version: { secretId: "secret-1", version: 1, material: { externalRef: "arn:secret" } },
      providerConfigs: [{ id: "cfg-1", companyId: "company-1", provider: "aws_secrets_manager", status: "disabled", disabledAt: new Date(), config: { region: "us-east-1" } }],
      code: "provider_config_disabled",
      status: 422,
    },
  ])("types $label as a candidate-local resolution failure", async ({ secret, version, providerConfigs, code, status }) => {
    const db = makeFakeDb({ secret, version, providerConfigs });
    const resolution = secretService(db as any).resolveSecretValue("company-1", "secret-1", "latest", {
      consumerType: "system",
      consumerId: "provider-resolution",
      actorType: "system",
    });

    await expect(resolution).rejects.toBeInstanceOf(SecretCandidateUnavailableError);
    await expect(resolution).rejects.toMatchObject({ code, status, expose: true });
  });

  it("rejects remote import preview for disabled provider configs before provider calls", async () => {
    const db = makeFakeDb({
      secret: null,
      version: null,
      providerConfigs: [{
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        provider: "aws_secrets_manager",
        status: "disabled",
        disabledAt: new Date(),
        config: { region: "us-east-1" },
      }],
    });

    await expect(secretService(db as any).previewRemoteImport("company-1", {
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      query: "OPENAI",
    })).rejects.toThrow("Provider vault is disabled");
  });

  it("blocks deleting a secret referenced by an active runtime provider key", async () => {
    const db = makeFakeDb({
      secret: {
        id: "secret-1",
        companyId: "company-1",
        provider: "local_encrypted",
        providerConfigId: null,
        externalRef: null,
        latestVersion: 1,
        status: "active",
      },
      version: null,
      providerKeys: [{
        id: "runtime-key-1",
        companyId: "company-1",
        provider: "e2b",
        secretId: "secret-1",
        status: "active",
      }],
    });

    await expect(secretService(db as any).remove("secret-1")).rejects.toMatchObject({ status: 409 });
  });

  it("blocks disabling a secret referenced by an active runtime provider key", async () => {
    const db = makeFakeDb({
      secret: {
        id: "secret-1",
        companyId: "company-1",
        provider: "local_encrypted",
        providerConfigId: null,
        externalRef: null,
        latestVersion: 1,
        status: "active",
      },
      version: null,
      providerKeys: [{
        id: "runtime-key-1",
        companyId: "company-1",
        provider: "e2b",
        secretId: "secret-1",
        status: "active",
      }],
    });

    await expect(secretService(db as any).update("secret-1", { status: "disabled" }))
      .rejects.toMatchObject({ status: 409 });
  });
});
