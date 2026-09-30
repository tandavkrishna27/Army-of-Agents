import { describe, expect, it } from "vitest";
import { createAwsSecretsManagerProvider, type AwsSecretsManagerGateway } from "../secrets/aws-secrets-manager-provider.js";
import { SecretCandidateUnavailableError } from "../secrets/secret-candidate-errors.js";

function config(extra: Record<string, unknown> = {}) {
  return {
    id: "cfg-1",
    provider: "aws_secrets_manager" as const,
    status: "ready",
    config: { region: "us-east-1", secretNamePrefix: "aoa/prod", ...extra },
  };
}

function gateway(overrides: Partial<AwsSecretsManagerGateway> = {}) {
  const calls: Record<string, unknown[]> = {
    createSecret: [],
    putSecretValue: [],
    getSecretValue: [],
    listSecrets: [],
    deleteSecret: [],
  };
  const g: AwsSecretsManagerGateway = {
    async createSecret(input) { calls.createSecret.push(input); return { ARN: "arn:secret", VersionId: "v1" }; },
    async putSecretValue(input) { calls.putSecretValue.push(input); return { ARN: String(input.SecretId), VersionId: "v2" }; },
    async getSecretValue(input) { calls.getSecretValue.push(input); return { SecretString: "resolved", VersionId: "v1" }; },
    async listSecrets(input) { calls.listSecrets.push(input); return { SecretList: [{ ARN: "arn:remote", Name: "remote/key" }], NextToken: "next" }; },
    async deleteSecret(input) { calls.deleteSecret.push(input); return {}; },
    ...overrides,
  };
  return { g, calls };
}

describe("aws secrets manager provider", () => {
  it("creates managed secrets with AoA namespace and tags", async () => {
    const { g, calls } = gateway();
    const provider = createAwsSecretsManagerProvider({ gatewayFactory: () => g });

    const prepared = await provider.createVersion({
      value: "secret-value",
      externalRef: null,
      providerConfig: config(),
      context: {
        companyId: "company-1",
        secretKey: "OPENAI_API_KEY",
        secretName: "OpenAI API Key",
        version: 1,
      },
    });

    expect(prepared.externalRef).toBe("arn:secret");
    expect(calls.createSecret[0]).toMatchObject({
      Name: "aoa/prod/company-1/OPENAI_API_KEY",
      Tags: expect.arrayContaining([{ Key: "managed-by", Value: "aoa" }]),
    });
  });

  it("resolves AWSCURRENT by externalRef", async () => {
    const { g, calls } = gateway();
    const provider = createAwsSecretsManagerProvider({ gatewayFactory: () => g });
    await expect(provider.resolveVersion({
      material: { scheme: "aws_secrets_manager_v1", externalRef: "arn:secret" },
      externalRef: "arn:secret",
      providerConfig: config(),
      versionSelector: "latest",
    })).resolves.toBe("resolved");
    expect(calls.getSecretValue[0]).toMatchObject({ SecretId: "arn:secret", VersionStage: "AWSCURRENT" });
  });

  it("lists remote secrets with pagination", async () => {
    const { g } = gateway();
    const provider = createAwsSecretsManagerProvider({ gatewayFactory: () => g });
    const listed = await provider.listRemoteSecrets?.({
      providerConfig: config(),
      query: "remote",
      nextToken: "old",
      pageSize: 10,
    });
    expect(listed?.nextToken).toBe("next");
    expect(listed?.candidates[0]?.externalRef).toBe("arn:remote");
  });

  it("rejects missing region and namespace for managed create", async () => {
    const provider = createAwsSecretsManagerProvider({ gatewayFactory: () => gateway().g });
    await expect(provider.healthCheck?.({ providerConfig: config({ region: "" }) })).rejects.toThrow(/region/);
    await expect(provider.createVersion({
      value: "secret",
      externalRef: null,
      providerConfig: config({ secretNamePrefix: "" }),
      context: { companyId: "c", secretKey: "K", secretName: "K", version: 1 },
    })).rejects.toThrow(/secretNamePrefix/);
  });

  it("does not include secret material in thrown errors", async () => {
    const { g } = gateway({
      async getSecretValue() {
        throw new Error("Authorization: signed SecretString=sk-live-secret AKIA1234567890ABCDEF");
      },
    });
    const provider = createAwsSecretsManagerProvider({ gatewayFactory: () => g });
    await expect(provider.resolveVersion({
      material: { scheme: "aws_secrets_manager_v1", externalRef: "arn:secret" },
      externalRef: "arn:secret",
      providerConfig: config(),
    })).rejects.not.toThrow(/sk-live-secret|AKIA1234567890ABCDEF/);
  });

  it("types only AWS resource-not-found as candidate unavailable", async () => {
    const missing = Object.assign(new Error("arn:aws:secretsmanager:secret:private-name"), {
      name: "ResourceNotFoundException",
    });
    const { g } = gateway({ async getSecretValue() { throw missing; } });
    const provider = createAwsSecretsManagerProvider({ gatewayFactory: () => g });
    const resolution = provider.resolveVersion({
      material: { scheme: "aws_secrets_manager_v1", externalRef: "arn:secret" },
      externalRef: "arn:secret",
      providerConfig: config(),
    });

    await expect(resolution).rejects.toBeInstanceOf(SecretCandidateUnavailableError);
    await expect(resolution).rejects.toMatchObject({ code: "aws_secret_not_found" });
    await expect(resolution).rejects.not.toThrow(/private-name/);
  });

  it("keeps non-not-found AWS failures systemic after sanitization", async () => {
    const throttled = Object.assign(new Error("Authorization: signed SecretString=sk-private"), {
      name: "ThrottlingException",
    });
    const { g } = gateway({ async getSecretValue() { throw throttled; } });
    const provider = createAwsSecretsManagerProvider({ gatewayFactory: () => g });

    try {
      await provider.resolveVersion({
        material: { scheme: "aws_secrets_manager_v1", externalRef: "arn:secret" },
        externalRef: "arn:secret",
        providerConfig: config(),
      });
      expect.fail("expected resolveVersion to reject");
    } catch (error) {
      expect(error).not.toBeInstanceOf(SecretCandidateUnavailableError);
      expect(error).toMatchObject({ status: 422 });
      expect(String(error)).not.toContain("sk-private");
    }
  });
});
