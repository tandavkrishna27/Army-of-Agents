import type {
  RemoteSecretImportCandidate,
  SecretProvider,
  SecretProviderConfigHealthResponse,
  SecretProviderDescriptor,
} from "@armyofagents/shared";

export interface StoredSecretVersionMaterial {
  [key: string]: unknown;
}

export interface SecretProviderVaultRuntimeConfig {
  id: string;
  provider: SecretProvider;
  status: string;
  config: Record<string, unknown>;
}

export interface SecretProviderWriteContext {
  companyId: string;
  secretId?: string;
  secretKey: string;
  secretName: string;
  version: number;
}

export interface PreparedSecretVersion {
  material: StoredSecretVersionMaterial;
  valueSha256: string;
  fingerprintSha256?: string;
  externalRef: string | null;
  providerVersionRef?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}

export interface SecretProviderRemoteListResult {
  candidates: RemoteSecretImportCandidate[];
  nextToken: string | null;
}

export interface SecretProviderModule {
  id: SecretProvider;
  descriptor: SecretProviderDescriptor;
  configured?: boolean;
  supportsManagedValues?: boolean;
  supportsExternalReferences?: boolean;
  createVersion(input: {
    value?: string | null;
    externalRef: string | null;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
    context: SecretProviderWriteContext;
  }): Promise<PreparedSecretVersion>;
  resolveVersion(input: {
    material: StoredSecretVersionMaterial;
    externalRef: string | null;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
    versionSelector?: number | "latest";
  }): Promise<string>;
  healthCheck?(input: {
    providerConfig: SecretProviderVaultRuntimeConfig;
  }): Promise<Omit<SecretProviderConfigHealthResponse, "providerConfigId" | "provider" | "checkedAt">>;
  listRemoteSecrets?(input: {
    providerConfig: SecretProviderVaultRuntimeConfig;
    query?: string | null;
    nextToken?: string | null;
    pageSize?: number;
  }): Promise<SecretProviderRemoteListResult>;
  linkExternalSecret?(input: {
    providerConfig: SecretProviderVaultRuntimeConfig;
    externalRef: string;
    name?: string | null;
    key?: string | null;
    providerVersionRef?: string | null;
    description?: string | null;
  }): Promise<PreparedSecretVersion & {
    name: string;
    key: string | null;
    description: string | null;
  }>;
  deleteOrArchive?(input: {
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
    material: StoredSecretVersionMaterial | null;
    externalRef: string | null;
    managedMode: string;
  }): Promise<void>;
}
