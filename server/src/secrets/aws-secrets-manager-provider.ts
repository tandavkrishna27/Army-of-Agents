import { createHash } from "node:crypto";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  FilterNameStringType,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
  type SecretListEntry,
} from "@aws-sdk/client-secrets-manager";
import { unprocessable } from "../errors.js";
import { SecretCandidateUnavailableError } from "./secret-candidate-errors.js";
import type {
  PreparedSecretVersion,
  SecretProviderModule,
  SecretProviderRemoteListResult,
  SecretProviderVaultRuntimeConfig,
  StoredSecretVersionMaterial,
} from "./types.js";

const AWS_SECRETS_MANAGER_SCHEME = "aws_secrets_manager_v1";
const DEFAULT_PREFIX = "aoa";
const DEFAULT_OWNER_TAG = "aoa";
const AOA_PENDING_VERSION_STAGE = "AOA_PENDING";

export type AwsSecretsManagerGateway = {
  createSecret(input: {
    Name: string;
    SecretString: string;
    Description?: string;
    KmsKeyId?: string;
    Tags?: Array<{ Key: string; Value: string }>;
  }): Promise<{ ARN?: string; VersionId?: string }>;
  putSecretValue(input: {
    SecretId: string;
    SecretString: string;
    VersionStages?: string[];
  }): Promise<{ ARN?: string; VersionId?: string }>;
  getSecretValue(input: {
    SecretId: string;
    VersionId?: string;
    VersionStage?: string;
  }): Promise<{ SecretString?: string; VersionId?: string }>;
  listSecrets(input: {
    NextToken?: string;
    MaxResults?: number;
    Filters?: Array<{ Key: string; Values: string[] }>;
  }): Promise<{ SecretList?: SecretListEntry[]; NextToken?: string }>;
  deleteSecret(input: {
    SecretId: string;
    RecoveryWindowInDays?: number;
    ForceDeleteWithoutRecovery?: boolean;
  }): Promise<unknown>;
};

class AwsSdkSecretsManagerGateway implements AwsSecretsManagerGateway {
  private readonly client: SecretsManagerClient;

  constructor(region: string) {
    this.client = new SecretsManagerClient({ region });
  }

  createSecret(input: Parameters<AwsSecretsManagerGateway["createSecret"]>[0]) {
    return this.client.send(new CreateSecretCommand(input));
  }

  putSecretValue(input: Parameters<AwsSecretsManagerGateway["putSecretValue"]>[0]) {
    return this.client.send(new PutSecretValueCommand(input));
  }

  getSecretValue(input: Parameters<AwsSecretsManagerGateway["getSecretValue"]>[0]) {
    return this.client.send(new GetSecretValueCommand(input));
  }

  listSecrets(input: Parameters<AwsSecretsManagerGateway["listSecrets"]>[0]) {
    return this.client.send(new ListSecretsCommand(input as any));
  }

  deleteSecret(input: Parameters<AwsSecretsManagerGateway["deleteSecret"]>[0]) {
    return this.client.send(new DeleteSecretCommand(input));
  }
}

class FakeAwsSecretsManagerGateway implements AwsSecretsManagerGateway {
  private readonly secrets = new Map<string, { value: string; versionId: string; description?: string }>([
    [
      "arn:aws:secretsmanager:us-east-1:111111111111:secret:OPENAI_API_KEY",
      { value: "fake-openai-key", versionId: "v1", description: "E2E OpenAI API key" },
    ],
  ]);

  async createSecret(input: Parameters<AwsSecretsManagerGateway["createSecret"]>[0]) {
    const arn = `arn:aws:secretsmanager:us-east-1:111111111111:secret:${input.Name}`;
    this.secrets.set(arn, { value: input.SecretString, versionId: "v1", description: input.Description });
    return { ARN: arn, VersionId: "v1" };
  }

  async putSecretValue(input: Parameters<AwsSecretsManagerGateway["putSecretValue"]>[0]) {
    const existing = this.secrets.get(input.SecretId);
    const version = existing ? `v${Number(existing.versionId.replace(/^v/, "")) + 1}` : "v1";
    this.secrets.set(input.SecretId, { value: input.SecretString, versionId: version, description: existing?.description });
    return { ARN: input.SecretId, VersionId: version };
  }

  async getSecretValue(input: Parameters<AwsSecretsManagerGateway["getSecretValue"]>[0]) {
    const row = this.secrets.get(input.SecretId);
    if (!row) throw unprocessable("Fake AWS secret not found");
    return { SecretString: row.value, VersionId: row.versionId };
  }

  async listSecrets(input: Parameters<AwsSecretsManagerGateway["listSecrets"]>[0]): ReturnType<AwsSecretsManagerGateway["listSecrets"]> {
    const query = input.Filters?.find((filter) => filter.Key === FilterNameStringType.name)?.Values?.[0]?.toLowerCase();
    const SecretList = [...this.secrets.entries()]
      .filter(([arn]) => !query || arn.toLowerCase().includes(query))
      .slice(0, input.MaxResults ?? 100)
      .map(([arn, row]) => ({
        ARN: arn,
        Name: arn.split(":secret:")[1] ?? arn,
        Description: row.description,
      }) satisfies SecretListEntry);
    return { SecretList };
  }

  async deleteSecret() {
    return {};
  }
}

const fakeAwsSecretsManagerGateway = new FakeAwsSecretsManagerGateway();

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeAwsError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted]")
    .replace(/SecretString[=:]\s*[^,\s}]+/gi, "SecretString=[redacted]")
    .replace(/Authorization:\s*[^\n]+/gi, "Authorization: [redacted]");
  return unprocessable(`AWS Secrets Manager operation failed: ${cleaned}`);
}

function isAwsResourceNotFound(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "name" in err &&
      (err as { name?: unknown }).name === "ResourceNotFoundException",
  );
}

function configRecord(providerConfig?: SecretProviderVaultRuntimeConfig | null) {
  const config = providerConfig?.config ?? {};
  const region = typeof config.region === "string" ? config.region.trim() : "";
  if (!region) throw unprocessable("AWS Secrets Manager provider requires region");
  return {
    region,
    namespace: typeof config.namespace === "string" ? config.namespace.trim() : DEFAULT_PREFIX,
    secretNamePrefix:
      typeof config.secretNamePrefix === "string" ? config.secretNamePrefix.trim().replace(/\/+$/, "") : "",
    kmsKeyId: typeof config.kmsKeyId === "string" ? config.kmsKeyId.trim() : undefined,
    ownerTag: typeof config.ownerTag === "string" ? config.ownerTag.trim() : DEFAULT_OWNER_TAG,
    environmentTag: typeof config.environmentTag === "string" ? config.environmentTag.trim() : undefined,
  };
}

function managedSecretName(providerConfig: SecretProviderVaultRuntimeConfig | null | undefined, companyId: string, key: string) {
  const cfg = configRecord(providerConfig);
  if (!cfg.secretNamePrefix) {
    throw unprocessable("AWS managed secrets require secretNamePrefix");
  }
  const safeKey = key.replace(/[^A-Za-z0-9/_+=.@-]/g, "_").replace(/^\/+/, "");
  return `${cfg.secretNamePrefix}/${companyId}/${safeKey}`;
}

function materialFor(externalRef: string, providerVersionRef?: string | null): StoredSecretVersionMaterial {
  return {
    scheme: AWS_SECRETS_MANAGER_SCHEME,
    externalRef,
    providerVersionRef: providerVersionRef ?? null,
  };
}

function externalRefFromMaterial(material: StoredSecretVersionMaterial, fallback: string | null) {
  const ref = typeof material.externalRef === "string" ? material.externalRef : fallback;
  if (!ref) throw unprocessable("AWS secret version is missing external reference");
  return ref;
}

export function createAwsSecretsManagerProvider(opts?: {
  gatewayFactory?: (config: SecretProviderVaultRuntimeConfig) => AwsSecretsManagerGateway;
}): SecretProviderModule {
  const gatewayFor = (providerConfig: SecretProviderVaultRuntimeConfig) =>
    opts?.gatewayFactory?.(providerConfig) ??
    (process.env.AOA_E2E_FAKE_AWS_SECRETS_MANAGER === "1"
      ? fakeAwsSecretsManagerGateway
      : new AwsSdkSecretsManagerGateway(configRecord(providerConfig).region));

  return {
    id: "aws_secrets_manager",
    descriptor: {
      id: "aws_secrets_manager",
      label: "AWS Secrets Manager",
      requiresExternalRef: true,
      supportsManagedValues: true,
      supportsExternalReferences: true,
      configured: false,
      status: "warning",
    },
    configured: true,
    supportsManagedValues: true,
    supportsExternalReferences: true,

    async createVersion(input): Promise<PreparedSecretVersion> {
      if (!input.providerConfig) throw unprocessable("AWS provider config is required");
      if (typeof input.value !== "string") throw unprocessable("AWS managed secrets require a value");
      const cfg = configRecord(input.providerConfig);
      const gateway = gatewayFor(input.providerConfig);
      const name = input.externalRef ?? managedSecretName(input.providerConfig, input.context.companyId, input.context.secretKey);
      const valueSha256 = sha256Hex(input.value);
      try {
        if (input.context.version <= 1 && !input.externalRef) {
          const created = await gateway.createSecret({
            Name: name,
            SecretString: input.value,
            Description: input.context.secretName,
            KmsKeyId: cfg.kmsKeyId,
            Tags: [
              { Key: "owner", Value: cfg.ownerTag },
              { Key: "managed-by", Value: DEFAULT_OWNER_TAG },
              ...(cfg.environmentTag ? [{ Key: "environment", Value: cfg.environmentTag }] : []),
            ],
          });
          const externalRef = created.ARN ?? name;
          return {
            material: materialFor(externalRef, created.VersionId),
            valueSha256,
            fingerprintSha256: valueSha256,
            externalRef,
            providerVersionRef: created.VersionId ?? null,
          };
        }
        const put = await gateway.putSecretValue({
          SecretId: name,
          SecretString: input.value,
          VersionStages: [AOA_PENDING_VERSION_STAGE, "AWSCURRENT"],
        });
        const externalRef = put.ARN ?? name;
        return {
          material: materialFor(externalRef, put.VersionId),
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef,
          providerVersionRef: put.VersionId ?? null,
        };
      } catch (err) {
        throw sanitizeAwsError(err);
      }
    },

    async resolveVersion(input) {
      if (!input.providerConfig) throw unprocessable("AWS provider config is required");
      const gateway = gatewayFor(input.providerConfig);
      try {
        const resolved = await gateway.getSecretValue({
          SecretId: externalRefFromMaterial(input.material, input.externalRef),
          VersionId: typeof input.material.providerVersionRef === "string" ? input.material.providerVersionRef : undefined,
          VersionStage: input.versionSelector === "latest" ? "AWSCURRENT" : undefined,
        });
        if (typeof resolved.SecretString !== "string") {
          throw unprocessable("AWS secret value is binary or empty");
        }
        return resolved.SecretString;
      } catch (err) {
        if (isAwsResourceNotFound(err)) {
          throw new SecretCandidateUnavailableError(
            "aws_secret_not_found",
            "AWS secret is unavailable",
          );
        }
        throw sanitizeAwsError(err);
      }
    },

    async linkExternalSecret(input) {
      if (!input.providerConfig) throw unprocessable("AWS provider config is required");
      const canonicalRef = input.externalRef.trim();
      if (!canonicalRef) throw unprocessable("External secret reference is required");
      return {
        name: input.name?.trim() || canonicalRef.split(/[/:]/).filter(Boolean).at(-1) || canonicalRef,
        key: input.key?.trim() || null,
        description: input.description ?? null,
        material: materialFor(canonicalRef, input.providerVersionRef ?? null),
        valueSha256: sha256Hex(canonicalRef),
        fingerprintSha256: sha256Hex(canonicalRef),
        externalRef: canonicalRef,
        providerVersionRef: input.providerVersionRef ?? null,
        providerMetadata: { linked: true },
      };
    },

    async listRemoteSecrets(input): Promise<SecretProviderRemoteListResult> {
      const gateway = gatewayFor(input.providerConfig);
      try {
        const listed = await gateway.listSecrets({
          NextToken: input.nextToken ?? undefined,
          MaxResults: input.pageSize,
          Filters: input.query ? [{ Key: FilterNameStringType.name, Values: [input.query] }] : undefined,
        });
        return {
          nextToken: listed.NextToken ?? null,
          candidates: (listed.SecretList ?? []).map((secret) => ({
            externalRef: secret.ARN ?? secret.Name ?? "",
            name: secret.Name ?? secret.ARN ?? "AWS secret",
            key: null,
            providerVersionRef: null,
            description: secret.Description ?? null,
            status: "ready" as const,
            metadata: {
              lastChangedDate: secret.LastChangedDate?.toISOString?.() ?? null,
              lastAccessedDate: secret.LastAccessedDate?.toISOString?.() ?? null,
            },
          })).filter((candidate) => candidate.externalRef.length > 0),
        };
      } catch (err) {
        throw sanitizeAwsError(err);
      }
    },

    async deleteOrArchive(input) {
      if (!input.providerConfig || !input.externalRef || input.managedMode !== "aoa_managed") return;
      const gateway = gatewayFor(input.providerConfig);
      try {
        await gateway.deleteSecret({ SecretId: input.externalRef, RecoveryWindowInDays: 7 });
      } catch (err) {
        throw sanitizeAwsError(err);
      }
    },

    async healthCheck(input) {
      configRecord(input.providerConfig);
      return { status: "ready", message: "AWS Secrets Manager config is valid", details: null };
    },
  };
}

export const awsSecretsManagerProvider = createAwsSecretsManagerProvider();
