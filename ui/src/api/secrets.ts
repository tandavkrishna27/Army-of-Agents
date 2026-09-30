import type {
  CompanySecret,
  CompanySecretBinding,
  CompanySecretProviderConfig,
  CreateRuntimeProviderKey,
  RemoteSecretImportResult,
  RemoteSecretImportPreviewResult,
  RuntimeProviderKey,
  SecretAccessEvent,
  SecretProvider,
  SecretProviderConfigHealthResponse,
  SecretProviderDescriptor,
  UpdateRuntimeProviderKey,
} from "@armyofagents/shared";
import { api } from "./client";

export interface CreateSecretInput {
  name: string;
  key?: string | null;
  value?: string | null;
  provider?: SecretProvider;
  providerConfigId?: string | null;
  managedMode?: "aoa_managed" | "external_reference";
  description?: string | null;
  externalRef?: string | null;
  providerVersionRef?: string | null;
}

export interface RotateSecretInput {
  value: string;
  externalRef?: string | null;
  providerConfigId?: string | null;
  providerVersionRef?: string | null;
}

export interface UpdateSecretInput {
  name?: string;
  key?: string | null;
  description?: string | null;
  externalRef?: string | null;
  status?: "active" | "disabled" | "archived";
}

export interface CreateSecretProviderConfigInput {
  provider: SecretProvider;
  displayName: string;
  status?: "ready" | "warning" | "coming_soon" | "disabled";
  isDefault?: boolean;
  config?: Record<string, unknown>;
}

export interface UpdateSecretProviderConfigInput {
  displayName?: string;
  status?: "ready" | "warning" | "coming_soon" | "disabled";
  isDefault?: boolean;
  config?: Record<string, unknown>;
}

export interface CreateSecretBindingInput {
  targetType: CompanySecretBinding["targetType"];
  targetId: string;
  configPath: string;
  versionSelector?: CompanySecretBinding["versionSelector"];
  required?: boolean;
  label?: string | null;
}

export interface RemoteSecretImportPreviewInput {
  providerConfigId: string;
  query?: string | null;
  nextToken?: string | null;
  pageSize?: number;
}

export interface RemoteSecretImportCommitInput {
  providerConfigId: string;
  secrets: Array<{
    externalRef: string;
    name?: string | null;
    key?: string | null;
    providerVersionRef?: string | null;
    description?: string | null;
  }>;
}

export const secretsApi = {
  list: (companyId: string) => api.get<CompanySecret[]>(`/companies/${companyId}/secrets`),
  providers: (companyId: string) =>
    api.get<SecretProviderDescriptor[]>(`/companies/${companyId}/secret-providers`),
  providerConfigs: {
    list: (companyId: string) =>
      api.get<CompanySecretProviderConfig[]>(`/companies/${companyId}/secret-provider-configs`),
    create: (companyId: string, data: CreateSecretProviderConfigInput) =>
      api.post<CompanySecretProviderConfig>(`/companies/${companyId}/secret-provider-configs`, data),
    update: (id: string, data: UpdateSecretProviderConfigInput) =>
      api.patch<CompanySecretProviderConfig>(`/secret-provider-configs/${id}`, data),
    remove: (id: string) => api.delete<{ ok: true }>(`/secret-provider-configs/${id}`),
    check: (id: string) =>
      api.post<SecretProviderConfigHealthResponse>(`/secret-provider-configs/${id}/check`, {}),
  },
  runtimeProviderKeys: {
    list: (companyId: string) =>
      api.get<RuntimeProviderKey[]>(`/companies/${companyId}/runtime-provider-keys`),
    create: (companyId: string, data: CreateRuntimeProviderKey) =>
      api.post<RuntimeProviderKey>(`/companies/${companyId}/runtime-provider-keys`, data),
    update: (id: string, data: UpdateRuntimeProviderKey) =>
      api.patch<RuntimeProviderKey>(`/runtime-provider-keys/${id}`, data),
    remove: (id: string) => api.delete<{ ok: true }>(`/runtime-provider-keys/${id}`),
  },
  create: (companyId: string, data: CreateSecretInput) =>
    api.post<CompanySecret>(`/companies/${companyId}/secrets`, data),
  rotate: (id: string, data: RotateSecretInput) => api.post<CompanySecret>(`/secrets/${id}/rotate`, data),
  update: (id: string, data: UpdateSecretInput) => api.patch<CompanySecret>(`/secrets/${id}`, data),
  remove: (id: string) => api.delete<{ ok: true }>(`/secrets/${id}`),
  bindings: {
    list: (secretId: string) => api.get<CompanySecretBinding[]>(`/secrets/${secretId}/bindings`),
    create: (secretId: string, data: CreateSecretBindingInput) =>
      api.post<CompanySecretBinding>(`/secrets/${secretId}/bindings`, data),
    remove: (id: string) => api.delete<{ ok: true }>(`/secret-bindings/${id}`),
  },
  accessEvents: (secretId: string) =>
    api.get<SecretAccessEvent[]>(`/secrets/${secretId}/access-events`),
  remoteImport: {
    preview: (companyId: string, data: RemoteSecretImportPreviewInput) =>
      api.post<RemoteSecretImportPreviewResult>(`/companies/${companyId}/secrets/remote-import/preview`, data),
    commit: (companyId: string, data: RemoteSecretImportCommitInput) =>
      api.post<RemoteSecretImportResult>(`/companies/${companyId}/secrets/remote-import`, data),
  },
};
