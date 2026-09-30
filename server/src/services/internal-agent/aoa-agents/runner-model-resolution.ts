import { readEnvBindingValue } from "@armyofagents/shared";
import { resolveModel, type ResolveModelStatus } from "../model-resolution.js";

/**
 * Apply model resolution + company OPENAI_API_KEY strip to an adapter config
 * before the crew runner spawns the CLI.
 *
 * Two concerns, both pure and testable:
 *  1. Model: delegates to resolveModel (shell-safe gate + adapter-specific logic).
 *     resolveModel throws ShellUnsafeModelError on unsafe input — callers must sit
 *     inside a try/catch that records a failed run (the runner's top-level catch).
 *  2. Env-strip hardening: the company-level OPENAI_API_KEY (inherited from
 *     process.env) must NEVER reach the codex CLI. Only a key the AGENT itself
 *     set in its own adapterConfig.env survives.
 */
export function applyModelResolutionToConfig(
  adapterType: string,
  baseConfig: Record<string, unknown>,
  status: ResolveModelStatus,
  opts: { inheritedEnvOpenAiKey?: string | null } = {},
): Record<string, unknown> {
  const next = { ...baseConfig };
  const resolved = resolveModel(adapterType, next.model as string | undefined, status);
  if (resolved.omitModelFlag) delete next.model; else next.model = resolved.model;

  if (adapterType === "codex_local") {
    const env = { ...((next.env as Record<string, unknown>) ?? {}) };
    // Binding-aware: saved env entries are normalized to binding objects, so a
    // string-only check would treat the agent's own key as absent and strip it
    // (Codex P2). readEnvBindingValue handles string / plain / secret_ref.
    const agentSetKey = readEnvBindingValue(env.OPENAI_API_KEY) != null;
    // Env-strip hardening: the company/extraction key must never reach the CLI.
    // Only a key the AGENT set in its own adapterConfig.env survives.
    if (!agentSetKey && opts.inheritedEnvOpenAiKey) delete env.OPENAI_API_KEY;
    next.env = env;
  }
  return next;
}
