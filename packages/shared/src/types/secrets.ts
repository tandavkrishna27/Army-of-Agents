import type {
  SecretAccessOutcome,
  SecretBindingTargetType,
  SecretManagedMode,
  SecretProvider,
  SecretProviderConfigHealthStatus,
  SecretProviderConfigStatus,
  SecretStatus,
  RuntimeProviderKeyProvider,
  RuntimeProviderKeyStatus,
} from "../constants.js";

export type { SecretProvider };

export type SecretVersionSelector = number | "latest";

export interface EnvPlainBinding {
  type: "plain";
  value: string;
}

export interface EnvSecretRefBinding {
  type: "secret_ref";
  secretId: string;
  version?: SecretVersionSelector;
}

// Backward-compatible: legacy plaintext string values are still accepted.
export type EnvBinding = string | EnvPlainBinding | EnvSecretRefBinding;

export type AgentEnvConfig = Record<string, EnvBinding>;

export interface CompanySecret {
  id: string;
  companyId: string;
  name: string;
  key: string | null;
  status: SecretStatus;
  managedMode: SecretManagedMode;
  provider: SecretProvider;
  providerConfigId: string | null;
  providerMetadata: Record<string, unknown> | null;
  externalRef: string | null;
  latestVersion: number;
  description: string | null;
  lastResolvedAt: Date | null;
  lastRotatedAt: Date | null;
  deletedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretProviderDescriptor {
  id: SecretProvider;
  label: string;
  requiresExternalRef: boolean;
  supportsManagedValues?: boolean;
  supportsExternalReferences?: boolean;
  configured?: boolean;
  status?: SecretProviderConfigStatus;
}

export interface CompanySecretProviderConfig {
  id: string;
  companyId: string;
  provider: SecretProvider;
  displayName: string;
  status: SecretProviderConfigStatus;
  isDefault: boolean;
  config: Record<string, unknown>;
  healthStatus: SecretProviderConfigHealthStatus | null;
  healthCheckedAt: Date | null;
  healthMessage: string | null;
  healthDetails: Record<string, unknown> | null;
  disabledAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretProviderConfigHealthResponse {
  providerConfigId: string;
  provider: SecretProvider;
  status: SecretProviderConfigHealthStatus;
  message: string | null;
  details?: Record<string, unknown> | null;
  checkedAt: Date;
}

export interface CompanySecretBinding {
  id: string;
  companyId: string;
  secretId: string;
  targetType: SecretBindingTargetType;
  targetId: string;
  configPath: string;
  versionSelector: SecretVersionSelector;
  required: boolean;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanySecretUsageBinding extends CompanySecretBinding {
  secret?: CompanySecret;
}

export interface SecretAccessEvent {
  id: string;
  companyId: string;
  secretId: string;
  version: number | null;
  provider: SecretProvider;
  actorType: string;
  actorId: string | null;
  consumerType: SecretBindingTargetType;
  consumerId: string;
  configPath: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;
  pluginId: string | null;
  outcome: SecretAccessOutcome;
  errorCode: string | null;
  createdAt: Date;
}

export interface RemoteSecretImportCandidate {
  externalRef: string;
  name: string;
  key: string | null;
  providerVersionRef: string | null;
  description: string | null;
  status: "ready" | "duplicate" | "conflict";
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RemoteSecretImportPreviewResult {
  providerConfigId: string;
  candidates: RemoteSecretImportCandidate[];
  nextToken: string | null;
}

export interface RemoteSecretImportResult {
  providerConfigId: string;
  results: Array<{
    externalRef: string;
    name: string | null;
    status: "imported" | "skipped" | "error";
    secretId?: string | null;
    error?: string | null;
  }>;
}

export interface RuntimeProviderKey {
  id: string;
  companyId: string;
  provider: RuntimeProviderKeyProvider;
  displayName: string;
  secretId: string;
  status: RuntimeProviderKeyStatus;
  isDefault: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}
