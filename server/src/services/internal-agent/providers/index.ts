import type { Db } from "@armyofagents/db";
import { secretService } from "../../secrets.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createOpenAIProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

export type { LLMProvider, ChatParams, ChatStreamChunk, ProviderToolDef, ChatMessage } from "./types.js";

/** Env var key per provider */
const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_AI_API_KEY",
};

/** Secret names used by the UI's LLM Providers settings */
export const PROVIDER_SECRET_NAMES: Record<string, string[]> = {
  anthropic: ["llm:anthropic", "ANTHROPIC_API_KEY"],
  openai: ["llm:openai", "OPENAI_API_KEY"],
  google: ["llm:google", "GOOGLE_AI_API_KEY"],
};

/**
 * Resolve an API key for a provider.
 *
 * Checks company_secrets first (both "llm:" prefixed names from the UI and
 * legacy env-style names), then falls back to environment variables.
 * Throws if no key is found anywhere.
 */
export async function getProviderApiKey(
  db: Db,
  companyId: string,
  provider: string,
): Promise<string> {
  const secretNames = PROVIDER_SECRET_NAMES[provider] ?? [];

  // Try company_secrets first — check all known secret name variants
  const svc = secretService(db);
  for (const name of secretNames) {
    try {
      return await svc.resolveByName(companyId, name, {
        consumerType: "system",
        consumerId: `llm-provider:${provider}`,
        actorType: "system",
        configPath: `provider.${provider}`,
      });
    } catch {
      // Secret not found under this name — try next
    }
  }

  // Fallback to env var
  const envKey = PROVIDER_ENV_KEYS[provider] ?? `${provider.toUpperCase()}_API_KEY`;
  const envValue = process.env[envKey];
  if (!envValue) {
    throw new Error(
      `No API key configured for provider "${provider}". ` +
      `Set it in Settings → LLM Providers or as the ${envKey} environment variable.`,
    );
  }
  return envValue;
}

/**
 * Non-resolving existence check: does a provider key EXIST for this company,
 * via a configured Settings secret or an env var? Unlike getProviderApiKey this
 * does NOT decrypt the secret value, so it has no side effects — no
 * `secretAccessEvents` audit row, no `lastResolvedAt` bump. Use it for boolean
 * "is semantic search available" probes that run on passive page views
 * (resolveSemanticAvailable), so normal viewing doesn't mutate secret metadata
 * or bloat the access-audit log (P2, Codex). Mirrors the same name candidates +
 * env fallback as getProviderApiKey, so the boolean agrees with what a real
 * resolution would find.
 */
export async function hasProviderKey(
  db: Db,
  companyId: string,
  provider: string,
): Promise<boolean> {
  const secretNames = PROVIDER_SECRET_NAMES[provider] ?? [];
  const svc = secretService(db);
  for (const name of secretNames) {
    const row = await svc.getByName(companyId, name);
    // Only an ACTIVE secret counts (P2, Codex): getByName returns any non-deleted
    // row, but the real resolver rejects non-active (disabled/archived) secrets,
    // so counting them here would falsely report availability for a key that
    // query embedding + the worker cannot actually use.
    if (row && row.status === "active") return true;
  }
  const envKey = PROVIDER_ENV_KEYS[provider] ?? `${provider.toUpperCase()}_API_KEY`;
  return Boolean(process.env[envKey]);
}

/** Default model per provider — used when falling back to a provider the caller
 *  didn't configure a model for. */
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  google: "gemini-2.0-flash",
};

/**
 * Resolve a usable provider for a company: prefer `preferred`, but if it has no
 * key, fall back to the first provider (anthropic → openai → google) that does.
 * Throws only if NO provider has a key anywhere (DB secret or env var).
 */
export async function resolveAvailableProvider(
  db: Db,
  companyId: string,
  preferred?: string,
): Promise<{ provider: string; apiKey: string; model: string }> {
  const order = [preferred, "anthropic", "openai", "google"].filter(
    (v, i, a): v is string => Boolean(v) && a.indexOf(v) === i,
  );
  for (const provider of order) {
    try {
      const apiKey = await getProviderApiKey(db, companyId, provider);
      return { provider, apiKey, model: DEFAULT_MODELS[provider] ?? DEFAULT_MODELS.anthropic };
    } catch {
      // No key for this provider — try the next.
    }
  }
  throw new Error(
    "No LLM provider configured. Set one in Settings → LLM Providers, or set ANTHROPIC_API_KEY / OPENAI_API_KEY.",
  );
}

/** Create an LLMProvider instance for the given provider name and API key */
export function createProvider(provider: string, apiKey: string): LLMProvider {
  switch (provider) {
    case "anthropic":
      return createAnthropicProvider(apiKey);
    case "openai":
      return createOpenAIProvider(apiKey);
    case "google":
      return createGeminiProvider(apiKey);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
