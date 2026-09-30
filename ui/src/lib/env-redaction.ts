import { shouldRedactSecretValue } from "@armyofagents/shared";
import { asRecord } from "./run-metrics";

export const REDACTED_ENV_VALUE = "***REDACTED***";

// Env secret key/value patterns + shouldRedactSecretValue now live in the
// browser-safe shared package (packages/shared/src/redaction.ts) — single
// source of truth shared with the server adapters. The UI keeps the
// secret_ref-aware redactEnvValue + the display formatter as thin wrappers.
export { shouldRedactSecretValue };

export function redactEnvValue(key: string, value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref"
  ) {
    return "***SECRET_REF***";
  }
  if (shouldRedactSecretValue(key, value)) return REDACTED_ENV_VALUE;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatEnvForDisplay(envValue: unknown): string {
  const env = asRecord(envValue);
  if (!env) return "<unable-to-parse>";

  const keys = Object.keys(env);
  if (keys.length === 0) return "<empty>";

  return keys
    .sort()
    .map((key) => `${key}=${redactEnvValue(key, env[key])}`)
    .join("\n");
}
