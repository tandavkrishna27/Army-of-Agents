import { unprocessable } from "../errors.js";
import type { SecretProviderModule } from "./types.js";

function unavailableProvider(
  id: "gcp_secret_manager" | "vault",
  label: string,
): SecretProviderModule {
  return {
    id,
    descriptor: {
      id,
      label,
      requiresExternalRef: true,
      supportsManagedValues: false,
      supportsExternalReferences: false,
      configured: false,
      status: "coming_soon",
    },
    configured: false,
    supportsManagedValues: false,
    supportsExternalReferences: false,
    async createVersion() {
      throw unprocessable(`${id} provider is not configured in this deployment`);
    },
    async resolveVersion() {
      throw unprocessable(`${id} provider is not configured in this deployment`);
    },
  };
}

export const gcpSecretManagerProvider = unavailableProvider(
  "gcp_secret_manager",
  "GCP Secret Manager",
);
export const vaultProvider = unavailableProvider("vault", "HashiCorp Vault");
