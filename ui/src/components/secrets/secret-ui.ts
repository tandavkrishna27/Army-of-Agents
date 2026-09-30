import type {
  CompanySecret,
  CompanySecretProviderConfig,
  SecretProvider,
} from "@armyofagents/shared";

export function providerLabel(provider: SecretProvider): string {
  if (provider === "aws_secrets_manager") return "AWS Secrets Manager";
  if (provider === "gcp_secret_manager") return "GCP Secret Manager";
  if (provider === "vault") return "HashiCorp Vault";
  return "Local encrypted";
}

export function modeLabel(mode: CompanySecret["managedMode"]): string {
  return mode === "external_reference" ? "External reference" : "AoA managed";
}

export function providerConfigSummary(config: CompanySecretProviderConfig): string {
  if (config.provider === "aws_secrets_manager") {
    const region = typeof config.config.region === "string" && config.config.region.trim()
      ? config.config.region.trim()
      : "region unset";
    const prefix = typeof config.config.secretNamePrefix === "string" && config.config.secretNamePrefix.trim()
      ? config.config.secretNamePrefix.trim()
      : null;
    return prefix ? `${region} / ${prefix}` : region;
  }

  if (config.provider === "gcp_secret_manager") {
    const projectId = typeof config.config.projectId === "string" && config.config.projectId.trim()
      ? config.config.projectId.trim()
      : null;
    return projectId ? `${providerLabel(config.provider)} / ${projectId}` : providerLabel(config.provider);
  }

  return providerLabel(config.provider);
}

export function formatSecretDate(value: Date | string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function looksSensitiveKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return /(^|[_\-.])(api[_\-.]?key|token|secret|password|passwd|pwd|credential|private[_\-.]?key)([_\-.]|$)/i.test(key);
}
