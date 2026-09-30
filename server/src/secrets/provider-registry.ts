import type { SecretProvider, SecretProviderDescriptor } from "@armyofagents/shared";
import { localEncryptedProvider } from "./local-encrypted-provider.js";
import {
  gcpSecretManagerProvider,
  vaultProvider,
} from "./external-stub-providers.js";
import { awsSecretsManagerProvider } from "./aws-secrets-manager-provider.js";
import type { SecretProviderModule, SecretProviderVaultRuntimeConfig } from "./types.js";
import { unprocessable } from "../errors.js";

const providers: SecretProviderModule[] = [
  localEncryptedProvider,
  awsSecretsManagerProvider,
  gcpSecretManagerProvider,
  vaultProvider,
];

const providerById = new Map<SecretProvider, SecretProviderModule>(
  providers.map((provider) => [provider.id, provider]),
);

export function getSecretProvider(id: SecretProvider): SecretProviderModule {
  const provider = providerById.get(id);
  if (!provider) throw unprocessable(`Unsupported secret provider: ${id}`);
  return provider;
}

export function listSecretProviders(): SecretProviderDescriptor[] {
  return providers.map((provider) => provider.descriptor);
}

export async function checkSecretProviders(configs: SecretProviderVaultRuntimeConfig[] = []) {
  const result: SecretProviderDescriptor[] = [];
  for (const provider of providers) {
    if (provider.id === "local_encrypted") {
      result.push({ ...provider.descriptor, configured: true, status: "ready" });
      continue;
    }
    const config = configs.find((candidate) => candidate.provider === provider.id);
    if (!config || !provider.healthCheck) {
      result.push({
        ...provider.descriptor,
        configured: false,
        status: provider.id === "aws_secrets_manager" ? "warning" : "coming_soon",
      });
      continue;
    }
    try {
      const health = await provider.healthCheck({ providerConfig: config });
      result.push({
        ...provider.descriptor,
        configured: health.status === "ready" || health.status === "warning",
        status: health.status === "error" ? "warning" : health.status,
      });
    } catch {
      result.push({ ...provider.descriptor, configured: false, status: "warning" });
    }
  }
  return result;
}
