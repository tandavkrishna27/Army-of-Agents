import type {
  AdapterExecutionResult,
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestResult,
} from "./types.js";

// ── Context → Messages ──────────────────────────────────────────────

interface MemoryItem {
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
}

interface DependencyOutput {
  taskTitle?: string;
  taskDescription?: string;
  status?: string;
}

export function buildSystemPrompt(context: Record<string, unknown>): string {
  const parts: string[] = [];

  // Company identity
  const company = context.company as { name?: string; description?: string } | undefined;
  if (company?.name) {
    parts.push(`# Company: ${company.name}`);
    if (company.description) {
      parts.push(company.description);
    }
  }

  // Memory items
  const memory = context.memory as MemoryItem[] | undefined;
  if (memory && memory.length > 0) {
    parts.push("\n# Memory\nRelevant company knowledge:");
    for (const item of memory) {
      const label = item.title || "Untitled";
      const cat = item.category ? ` [${item.category}]` : "";
      parts.push(`- **${label}**${cat}: ${item.content || ""}`);
    }
  }

  // Agent identity
  parts.push(
    "\n# Instructions",
    "You are an AI agent working for this company. Complete the assigned task thoroughly and provide your full response as text output.",
  );

  return parts.join("\n");
}

export function buildUserMessage(context: Record<string, unknown>): string {
  const parts: string[] = [];

  const title = (context.issueTitle as string) || (context.taskTitle as string) || "";
  const description =
    (context.issueDescription as string) || (context.taskDescription as string) || "";

  if (title) {
    parts.push(`# Task: ${title}`);
  }
  if (description) {
    parts.push(description);
  }

  // Dependency outputs
  const deps = context.dependency_outputs as DependencyOutput[] | undefined;
  if (deps && deps.length > 0) {
    parts.push("\n# Completed Dependency Tasks");
    for (const dep of deps) {
      parts.push(`## ${dep.taskTitle || "Untitled"}`);
      if (dep.taskDescription) {
        parts.push(dep.taskDescription);
      }
    }
  }

  if (parts.length === 0) {
    return "Complete the assigned task.";
  }

  return parts.join("\n");
}

// ── API Key Resolution ──────────────────────────────────────────────

const PROVIDER_SECRET_NAMES: Record<string, string> = {
  anthropic: "llm:anthropic",
  openai: "llm:openai",
  google: "llm:google",
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

type SecretResolver = (companyId: string, name: string) => Promise<string>;
let _defaultResolver: SecretResolver | null = null;

/**
 * Register the default secret resolver. Called once at server startup
 * (e.g., from heartbeatService) so API adapters can resolve secrets
 * without a direct DB dependency.
 */
export function setSecretResolver(resolver: SecretResolver): void {
  _defaultResolver = resolver;
}

export async function resolveApiKey(
  companyId: string,
  provider: string,
  _resolveByName?: SecretResolver,
): Promise<string> {
  const secretName = PROVIDER_SECRET_NAMES[provider];
  if (!secretName) throw new Error(`Unknown LLM provider: ${provider}`);

  const resolve = _resolveByName ?? _defaultResolver;
  if (!resolve) {
    throw new Error("Secret resolver not configured. Call setSecretResolver() at startup.");
  }

  try {
    return await resolve(companyId, secretName);
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.message?.includes("not found")) {
      const label = PROVIDER_LABELS[provider] || provider;
      const keyError = new Error(
        `Configure your ${label} API key in Settings > LLM Providers`,
      );
      (keyError as any).errorCode = "missing_api_key";
      throw keyError;
    }
    throw err;
  }
}

// ── Cost Estimation ─────────────────────────────────────────────────

interface PricingEntry {
  input: number; // USD per 1M tokens
  output: number; // USD per 1M tokens
}

const PRICING_TABLE: Record<string, PricingEntry> = {
  // Anthropic
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "o3": { input: 10.0, output: 40.0 },
  "o4-mini": { input: 1.1, output: 4.4 },
  // Google
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
};

export function estimateCostUsd(
  _provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING_TABLE[model];
  if (!pricing) return 0;
  return (inputTokens * pricing.input) / 1_000_000 + (outputTokens * pricing.output) / 1_000_000;
}

// ── Error Mapping ───────────────────────────────────────────────────

export function mapErrorToResult(
  error: unknown,
  provider: string,
): AdapterExecutionResult {
  const label = PROVIDER_LABELS[provider] || provider;
  const err = error instanceof Error ? error : new Error(String(error));
  const code = (err as any).errorCode || (err as any).code || (err as any).status;
  const msg = err.message || "Unknown error";

  // Missing API key (our own thrown error)
  if (code === "missing_api_key" || msg.includes("API key in Settings")) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: msg,
      errorCode: "missing_api_key",
      provider,
    };
  }

  // Authentication errors (SDK-thrown)
  if (
    code === 401 ||
    msg.toLowerCase().includes("authentication") ||
    /invalid.*api.*key/i.test(msg) ||
    err.constructor.name.includes("Authentication")
  ) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Invalid API key. Check Settings > LLM Providers`,
      errorCode: "authentication_error",
      provider,
    };
  }

  // Rate limiting
  if (
    code === 429 ||
    msg.toLowerCase().includes("rate") ||
    err.constructor.name.includes("RateLimit")
  ) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Rate limited by ${label}. Try again shortly.`,
      errorCode: "rate_limit",
      provider,
    };
  }

  // Context length
  if (
    msg.toLowerCase().includes("context_length") ||
    msg.toLowerCase().includes("max_tokens") ||
    msg.toLowerCase().includes("too many tokens") ||
    msg.toLowerCase().includes("token limit") ||
    msg.toLowerCase().includes("context window")
  ) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Task context exceeds model's token limit. Try a model with larger context.",
      errorCode: "context_length_exceeded",
      provider,
    };
  }

  // Network errors
  if (
    msg.toLowerCase().includes("connect") ||
    msg.toLowerCase().includes("network") ||
    msg.toLowerCase().includes("enotfound") ||
    err.constructor.name.includes("Connection")
  ) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Could not reach ${label} API. Check your internet connection.`,
      errorCode: "network_error",
      provider,
    };
  }

  // Fallback
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: msg,
    errorCode: "unknown_error",
    provider,
  };
}

// ── Test Environment Helper ─────────────────────────────────────────

export function buildTestResult(
  adapterType: string,
  status: "pass" | "warn" | "fail",
  checks: AdapterEnvironmentCheck[] = [],
): AdapterEnvironmentTestResult {
  return {
    adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
